/* Annota · Anki 导出插件（apkg 单路径）。插件契约见 core.js 的 __VA_PLUGIN_DEFS__。 */
(function (root) {
  'use strict';

  const EXPORT_PREFIX = 'va:export:';
  let core = null;
  let state = 'idle';
  let done = 0;
  let total = 0;
  let current = '';
  let paused = false;
  let cancelled = false;
  let running = false;
  let progressEl = null;
  let progressText = null;
  let progressFill = null;
  let cancelButton = null;
  let warnedCapture = false;

  /* ---------- 能力探测 ---------- */
  function capabilities() {
    try { if (typeof root.vaCapture === 'function') return { capture: 'tauri' }; } catch (e) {}
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        return { capture: 'extension' };
      }
    } catch (e) {}
    return { capture: 'canvas' };
  }

  /* ---------- 进度条 UI（class 与结构需与 smoke / CSS 保持一致） ---------- */
  function ensureProgress() {
    if (!core || !core.uiRoot || progressEl) return;
    try {
      const doc = core.uiRoot.ownerDocument || document;
      progressEl = doc.createElement('div');
      progressEl.className = 'va-export-progress';
      progressEl.setAttribute('role', 'status');
      progressEl.setAttribute('aria-live', 'polite');
      progressText = doc.createElement('span');
      const progressBar = doc.createElement('i');
      progressBar.className = 'va-export-progress-track';
      progressFill = doc.createElement('i');
      progressFill.className = 'va-export-progress-fill';
      progressBar.appendChild(progressFill);
      cancelButton = doc.createElement('button');
      cancelButton.type = 'button';
      cancelButton.textContent = '取消';
      cancelButton.setAttribute('aria-label', '取消批量导出');
      cancelButton.onclick = () => {
        if (running) cancel();
        else if (progressEl) { progressEl.remove(); progressEl = null; progressText = null; progressFill = null; cancelButton = null; }
      };
      progressEl.append(progressText, progressBar, cancelButton);
      core.uiRoot.appendChild(progressEl);
    } catch (e) { progressEl = null; }
  }

  function paintProgress() {
    ensureProgress();
    if (!progressEl) return;
    const word = current ? ' · ' + current : '';
    progressText.textContent = (state === 'paused' ? '已暂停 · ' : '') + done + '/' + total + word;
    if (progressFill) progressFill.style.width = (total ? Math.min(100, done / total * 100) : 0) + '%';
    cancelButton.textContent = running ? '取消' : '关闭';
    cancelButton.setAttribute('aria-label', running ? '取消批量导出' : '关闭导出进度');
  }

  function status() { return { state, done, total, current }; }

  /* ---------- 断点续跑（localStorage: va:export:<mediaId>，已成功 POST 的 entry id 集合） ---------- */
  function readCompleted(mediaId) {
    try {
      const ids = JSON.parse(localStorage.getItem(EXPORT_PREFIX + mediaId) || '[]');
      return new Set(Array.isArray(ids) ? ids.map(String) : []);
    } catch (e) { return new Set(); }
  }

  function persistCompleted(mediaId, completed) {
    try { localStorage.setItem(EXPORT_PREFIX + mediaId, JSON.stringify(Array.from(completed))); } catch (e) {}
  }

  // FNV-1a：同一视频多次导出得到同一 deck_id，服务端可复用牌组
  function stableDeckId(mediaId) {
    const value = String(mediaId || 'media');
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return 'annota-' + value.replace(/[^\w.-]+/g, '_').slice(0, 48) + '-' + (hash >>> 0).toString(36);
  }

  /* ---------- 帧等待 / 画面叠加 ---------- */
  function waitForFrame(videoEl, t, seekChanged, timeoutMs) {
    return new Promise((resolve) => {
      let timer = null, seekHandler = null, videoFrameId = null, finished = false;
      const finish = (ok) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (seekHandler && videoEl && videoEl.removeEventListener) videoEl.removeEventListener('seeked', seekHandler);
        if (videoFrameId != null && videoEl && videoEl.cancelVideoFrameCallback) {
          try { videoEl.cancelVideoFrameCallback(videoFrameId); } catch (e) {}
        }
        resolve(!!ok);
      };
      const waitFrame = () => {
        if (videoEl && typeof videoEl.requestVideoFrameCallback === 'function') {
          const next = () => {
            if (finished) return;
            try {
              videoFrameId = videoEl.requestVideoFrameCallback((_now, metadata) => {
                videoFrameId = null;
                const mediaTime = metadata && Number(metadata.mediaTime);
                const observed = Number.isFinite(mediaTime) ? mediaTime : Number(videoEl.currentTime);
                if (Number.isFinite(observed) && observed >= Number(t) - 0.05) finish(true);
                else next();
              });
            } catch (e) { fallbackFrames(); }
          };
          next();
        } else fallbackFrames();
      };
      const fallbackFrames = () => {
        const raf = typeof root.requestAnimationFrame === 'function'
          ? root.requestAnimationFrame.bind(root) : (cb) => setTimeout(cb, 16);
        raf(() => raf(() => finish(true)));
      };
      timer = setTimeout(() => finish(false), timeoutMs || 1500);
      if (seekChanged && videoEl && videoEl.addEventListener) {
        seekHandler = () => { seekHandler = null; waitFrame(); };
        videoEl.addEventListener('seeked', seekHandler, { once: true });
      } else waitFrame();
    });
  }

  // 连续等 n 个视频帧回调（无 rVFC 时退化为 rAF），确保截到 seek 目标之后的稳定帧
  function waitFrames(videoEl, n) {
    return new Promise((resolve) => {
      if (videoEl && typeof videoEl.requestVideoFrameCallback === 'function') {
        let left = n;
        const step = () => {
          if (left-- <= 0) { resolve(); return; }
          try { videoEl.requestVideoFrameCallback(step); } catch (e) { resolve(); }
        };
        step();
      } else {
        const raf = (root.requestAnimationFrame || ((cb) => setTimeout(cb, 16))).bind(root);
        let left = n;
        const step = () => { if (left-- <= 0) resolve(); else raf(step); };
        step();
      }
    });
  }

  // 可选：在截图上叠当前这条的热力框 + 标签（仅当 opts.overlay 勾选时）。纯画面为默认。
  function canvasOverlay(dataUrl, entry) {
    if (!dataUrl || !entry || !entry.box) return Promise.resolve(dataUrl);
    return new Promise((resolve) => {
      try {
        const image = new root.Image();
        image.onload = () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = image.width; canvas.height = image.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) { resolve(dataUrl); return; }
            ctx.drawImage(image, 0, 0);
            const b = entry.box, x = Number(b.x) * canvas.width, y = Number(b.y) * canvas.height;
            const w = Number(b.w) * canvas.width, h = Number(b.h) * canvas.height;
            ctx.strokeStyle = '#F5A623'; ctx.lineWidth = Math.max(2, canvas.width * 0.002);
            ctx.fillStyle = 'rgba(245,166,35,.10)'; ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
            const label = entryTitle(entry);
            if (label) {
              const fontSize = Math.max(12, Math.round(canvas.width * 0.018));
              ctx.font = '600 ' + fontSize + 'px sans-serif';
              const pad = Math.max(5, Math.round(fontSize * .55));
              const labelW = Math.min(canvas.width - 2, ctx.measureText(label).width + pad * 2);
              const labelH = fontSize + pad * 1.5;
              const labelY = Math.max(labelH, y);
              ctx.fillStyle = 'rgba(18,20,24,.94)'; ctx.fillRect(x, labelY - labelH, labelW, labelH);
              ctx.strokeStyle = 'rgba(245,166,35,.55)'; ctx.lineWidth = 1; ctx.strokeRect(x, labelY - labelH, labelW, labelH);
              ctx.fillStyle = '#f3d4a2'; ctx.fillText(label, x + pad, labelY - pad * .45, labelW - pad * 2);
            }
            resolve(canvas.toDataURL('image/png'));
          } catch (e) { resolve(null); }
        };
        image.onerror = () => resolve(null);
        image.src = dataUrl;
      } catch (e) { resolve(null); }
    });
  }

  /* ---------- 条目文案与载荷 ---------- */
  function entryTitle(entry) {
    const word = String(entry.word || '').trim();
    if (word) return word;
    const tags = entry.tags || [];
    if (tags.length) return String(tags[0]);
    const label = String(entry.label || '').trim();
    return label ? label.slice(0, 40) : '标注';
  }

  function entryPayload(entry) {
    return {
      id: entry.id, word: entry.word || '', label: entry.label || '', pos: entry.pos || '',
      tags: entry.tags || [], t: entry.t, dur: entry.dur, box: entry.box || null,
    };
  }

  // 牌组名回退链（调用方已先判断 opts.deckName）：含雅思标签 → Annota::IELTS；否则视频标题；兜底通用名
  function defaultDeckName(entries, media) {
    const ielts = entries.some((e) => (e.tags || []).some((t) => /雅思|ielts/i.test(String(t))));
    return ielts ? 'Annota::IELTS' : (media.title || 'Annota 学习卡');
  }

  /* ---------- 播放控制 ---------- */
  async function waitIfPaused() {
    while (paused && !cancelled) await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // seek 时加一点点提前量（+0.15s）：isVisible 有提前浮现，且落帧有延迟，
  // 直接 seek(t) 常常"框还没出现"或停在上一条。
  const SEEK_LEAD = 0.15;
  function seekToAnnot(binding, t, lead) {
    const target = Math.max(0, (Number(t) || 0) + (lead == null ? SEEK_LEAD : lead));
    try { binding.seek(target); } catch (e) {}
  }

  /* ---------- 自动截图：暂停 → seek → 隔离渲染 → 截帧 → 恢复 ---------- */
  async function captureEntry(entry, previousTime, first, settleMs, overlay) {
    const binding = core.binding();
    const videoEl = binding.el;
    let resume = false;
    try {
      try { if (videoEl && videoEl.paused === false) { videoEl.pause(); resume = true; } } catch (e) {}
      seekToAnnot(binding, entry.t);
      const s = Number(settleMs);
      if (Number.isFinite(s)) {
        await sleep(s);   // 测试/快速模式：跳过等帧
      } else if (first) {
        // 首次截图最容易"滞后一个点"：空跳一次再回目标点，抖掉播放器残留帧，然后等 2 帧稳定
        seekToAnnot(binding, entry.t);
        await waitForFrame(videoEl, Number(entry.t) + SEEK_LEAD, true, 2500);
        await sleep(400);
        seekToAnnot(binding, entry.t);
        await waitForFrame(videoEl, Number(entry.t) + SEEK_LEAD, true, 2500);
        await sleep(1500);
      } else {
        await waitForFrame(videoEl, Number(entry.t) + SEEK_LEAD, Math.abs(Number(previousTime) - Number(entry.t)) > 0.05, 2500);
        await sleep(1200);
      }
      if (!Number.isFinite(s)) await waitFrames(videoEl, 2);   // 再等两帧，确保画面已更新到目标帧
      core.renderOnly(entry);
      core.setChromeHidden(true);
      let shot = await core.captureFrame();
      if (shot && overlay) shot = await canvasOverlay(shot, entry);
      return shot || null;
    } catch (e) { return null; }
    finally {
      try { core.render(); } catch (e) {}
      try { core.setChromeHidden(false); } catch (e) {}
      try { if (resume && videoEl && videoEl.play) videoEl.play(); } catch (e) {}
    }
  }

  /* ---------- 主驱动：逐条截图 → POST card → finalize → 下载 apkg ---------- */
  async function run(opts, entries, media, mediaId, completed, deckId) {
    try {
      const sorted = entries.map((entry, index) => ({ entry, index }))
        .sort((a, b) => (Number(a.entry.t) || 0) - (Number(b.entry.t) || 0));
      const todo = opts.onlyMissing ? sorted.filter(({ entry }) => !completed.has(String(entry.id))) : sorted;
      core.state.renderLock = true;
      // Let the core's first layout tick establish the media/content rect before isolating marks.
      await new Promise((resolve) => (root.requestAnimationFrame || ((cb) => setTimeout(cb, 16)))(resolve));
      let firstShot = true;
      for (const item of todo) {
        await waitIfPaused();
        if (cancelled) break;
        const entry = item.entry;
        current = entryTitle(entry); paintProgress();
        const binding = core.binding();
        if (!binding || binding.kind !== 'video' || !binding.timed) throw new Error('当前绑定不是视频');
        const prior = binding.time();
        const shot = await captureEntry(entry, prior, firstShot, opts.settle, !!opts.overlay);
        firstShot = false;
        if (!shot && !warnedCapture) {
          warnedCapture = true;
          core.setSyncStatus('当前环境无法截取视频画面，将导出纯文字卡');
        }
        const response = await core.httpJson('POST', (await core.resolveBase()) + '/api/export/card', {
          deck_id: deckId,
          idx: item.index,
          media,
          entry: entryPayload(entry),
          screenshot: shot,
        });
        if (!response.ok || !response.json || response.json.ok !== true) {
          throw new Error((response.json && response.json.error) || ('HTTP ' + response.status));
        }
        completed.add(String(entry.id));
        persistCompleted(mediaId, completed);
        done += 1;
        paintProgress();
      }
      if (cancelled) { state = 'cancelled'; core.showToast('批量导出已取消 · 可再次运行以续跑'); return; }
      const base = await core.resolveBase();
      const deckName = String(opts.deckName || defaultDeckName(entries, media));
      const result = await core.httpJson('POST', base + '/api/export/finalize', {
        deck_id: deckId,
        deck_name: deckName,
        format: 'apkg',
      });
      if (!result.ok || !result.json || result.json.ok !== true || !result.json.url) {
        throw new Error((result.json && result.json.error) || ('HTTP ' + result.status));
      }
      state = 'complete';
      const target = base.replace(/\/$/, '') + result.json.url;
      const a = document.createElement('a'); a.href = target; a.download = ''; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.click();
      core.showToast('Anki 牌组已生成 · ' + result.json.cards + ' 张卡');
    } catch (error) {
      state = 'error';
      core.setSyncStatus('批量导出失败：' + String(error && error.message || error));
    } finally {
      paused = false; running = false; current = '';
      try { core.state.renderLock = false; core.render(); core.setChromeHidden(false); } catch (e) {}
      paintProgress();
    }
  }

  /* ---------- 对外 API：start / pause / resume / cancel / status ---------- */
  async function start(opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
    // 只支持 apkg：旧 intent 可能带 csv/json/jsonl，这里静默 coerce，不报错
    if (opts.format && opts.format !== 'apkg') console.info('[annota] 批量导出仅支持 apkg，已忽略 format=' + opts.format);
    opts = Object.assign({}, opts, { format: 'apkg' });
    if (running) return { total, resumed: done };
    const binding = core && core.binding();
    const media = core ? core.mediaMeta() : {};
    if (!binding || binding.kind !== 'video' || !binding.timed) {
      state = 'error';
      if (core) core.showToast('批量导出仅支持视频');
      return { total: 0, resumed: 0 };
    }
    const mediaId = String(media.mediaId || media.videoId || binding.mediaId());
    const entries = (core.entries() || []).filter((entry) => entry && entry.box)
      .slice().sort((a, b) => (Number(a.t) || 0) - (Number(b.t) || 0));
    total = entries.length;
    const completed = readCompleted(mediaId);
    const resumed = opts.onlyMissing ? entries.filter((entry) => completed.has(String(entry.id))).length : 0;
    done = resumed;
    current = '';
    paused = false; cancelled = false; warnedCapture = false;
    state = 'running'; running = true;
    ensureProgress(); paintProgress();
    if (!entries.length) {
      running = false; state = 'complete'; paintProgress();
      core.showToast('当前视频没有可导出的区域标注');
      return { total: 0, resumed: 0 };
    }
    if (capabilities().capture === 'canvas') {
      // Canvas 兜底：跨域视频常拿不到帧，会导出纯文字卡，提前告知用户
      core.setSyncStatus('当前环境截图能力有限（canvas 兜底），可能导出纯文字卡');
    }
    const deckId = stableDeckId(mediaId);
    run(opts, entries, media, mediaId, completed, deckId);
    return { total, resumed };
  }

  function pause() { if (running) { paused = true; state = 'paused'; paintProgress(); } }
  function resume() { if (running) { paused = false; state = 'running'; paintProgress(); } }
  function cancel() { if (running) { cancelled = true; paused = false; } }

  const api = { capabilities, start, pause, resume, cancel, status };

  /* ---------- 注册 ---------- */
  const install = (coreApi) => {
    core = coreApi;
    root.__ANNOTA_EXPORT__ = api;      // intent 链路（core decodeExportIntent）依赖此兼容别名，勿删
  };
  root.VAExport = { install };
  (root.__VA_PLUGIN_DEFS__ = root.__VA_PLUGIN_DEFS__ || []).push({
    id: 'anki-export', name: 'Anki 导出', viewOnly: false, install,
  });
})(typeof window !== 'undefined' ? window : this);
