/* Annota · local learning-card export. Loaded before core.js. */
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

  function capabilities() {
    // TODO: wire the native Tauri window.vaCapture driver in app/annota/src/main.rs;
    // the Rust bridge is out of scope here (see docs/architecture.md ADR-6).
    try { if (typeof root.vaCapture === 'function') return { capture: 'tauri' }; } catch (e) {}
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        return { capture: 'extension' };
      }
    } catch (e) {}
    return { capture: 'canvas' };
  }

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

  function readCompleted(mediaId) {
    try {
      const ids = JSON.parse(localStorage.getItem(EXPORT_PREFIX + mediaId) || '[]');
      return new Set(Array.isArray(ids) ? ids.map(String) : []);
    } catch (e) { return new Set(); }
  }

  function persistCompleted(mediaId, completed) {
    try { localStorage.setItem(EXPORT_PREFIX + mediaId, JSON.stringify(Array.from(completed))); } catch (e) {}
  }

  function stableDeckId(mediaId) {
    const value = String(mediaId || 'media');
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return 'annota-' + value.replace(/[^\w.-]+/g, '_').slice(0, 48) + '-' + (hash >>> 0).toString(36);
  }

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

  function trainingRows(entries, media) {
    return entries.map((entry) => ({
      word: entry.word || '', label: entry.label || '', pos: entry.pos || '', tags: entry.tags || [],
      t: entry.t, dur: entry.dur, box: entry.box || null,
      mediaId: media.mediaId || media.videoId || '', url: media.url || '',
    }));
  }

  function download(text, format, mediaId) {
    const mime = format === 'csv' ? 'text/csv;charset=utf-8' : 'application/json;charset=utf-8';
    const ext = format === 'jsonl' ? 'jsonl' : format;
    const blob = new Blob([text], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'annota_' + String(mediaId || 'cards').replace(/[^\w.-]+/g, '_') + '.' + ext;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function exportClient(entries, media, format) {
    const rows = trainingRows(entries, media);
    if (format === 'csv') {
      const keys = ['word', 'label', 'pos', 'tags', 't', 'dur', 'box', 'mediaId', 'url'];
      const cell = (value) => '"' + String(value == null ? '' : (typeof value === 'object' ? JSON.stringify(value) : value)).replace(/"/g, '""') + '"';
      download([keys.join(','), ...rows.map((row) => keys.map((key) => cell(row[key])).join(','))].join('\r\n'), format, media.mediaId);
    } else if (format === 'jsonl') download(rows.map((row) => JSON.stringify(row)).join('\n') + '\n', format, media.mediaId);
    else download(JSON.stringify({ media, cards: rows }, null, 2), format, media.mediaId);
  }

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

  // 手动确认截图：seek 好、暂停、只显示本条框；条上实时显示当前时间码，
  // 用户可自行拖动画面 → 点「截图」（以当前帧为准并回写 t）/「跳过」（Enter=截图，Esc=跳过）
  function confirmShot(entry, idx, total, binding, videoEl) {
    return new Promise((resolve) => {
      const doc = (core.uiRoot && core.uiRoot.ownerDocument) || document;
      const el2 = (tag, style, ...kids) => {
        const n = doc.createElement(tag);
        if (style) for (const k in style) n.style[k] = style[k];
        for (const c of kids) if (c != null && c !== false) n.append(typeof c === 'string' ? String(c) : c);
        return n;
      };
      const fmt = (t) => { t = Math.max(0, Number(t) || 0); const m = Math.floor(t / 60); const s = (t % 60).toFixed(2); return m + ':' + (s.length < 5 ? '0' + s : s); };
      const pop = el2('div'); pop.className = 'va-export-confirm';
      pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', '确认截图');
      const txt = el2('span', null, '第 ' + (idx + 1) + '/' + total + ' 条 · ' + entryTitle(entry) + '：画面到位后点截图');
      txt.className = 'va-export-confirm-text';
      const clock = el2('span', null, 't=' + fmt(entry.t)); clock.className = 'va-export-clock';
      const bUse = el2('button'); bUse.type = 'button'; bUse.textContent = '回到标注点';
      const bShot = el2('button'); bShot.type = 'button'; bShot.textContent = '截图';
      const bSkip = el2('button'); bSkip.type = 'button'; bSkip.textContent = '跳过';
      let done = false;
      let tick = null;
      const finish = () => {
        if (done) return; done = true;
        doc.removeEventListener('keydown', onKey, true);
        if (tick) clearInterval(tick);
        pop.remove();
        resolve(Number(videoEl && videoEl.currentTime) || Number(entry.t) || 0);
      };
      const abort = () => { if (done) return; done = true; doc.removeEventListener('keydown', onKey, true); if (tick) clearInterval(tick); pop.remove(); resolve(null); };
      const onKey = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); finish(); } else if (ev.key === 'Escape') { ev.preventDefault(); abort(); } };
      bUse.onclick = () => { seekToAnnot(binding, entry.t); };
      bShot.onclick = () => finish();
      bSkip.onclick = () => abort();
      tick = setInterval(() => { if (videoEl) clock.textContent = 't=' + fmt(videoEl.currentTime); }, 120);
      pop.append(txt, clock, bUse, bShot, bSkip);
      doc.addEventListener('keydown', onKey, true);
      core.uiRoot.appendChild(pop);
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
      if (shot && overlay) shot = await canvasOverlay(shot, entry);   // 勾选时才叠当前框
      return shot || null;
    } catch (e) { return null; }
    finally {
      try { core.render(); } catch (e) {}
      try { core.setChromeHidden(false); } catch (e) {}
      try { if (resume && videoEl && videoEl.play) videoEl.play(); } catch (e) {}
    }
  }

  // 手动模式：seek(entry.t+0.15) + 暂停 + 只显示本条框 → 等确认 → 截图。
  // 用户若自己拖过画面，则以当前帧为准：回写该条 t + updated（所见即所得）。
  async function captureEntryManual(entry, idx, total, overlay) {
    const binding = core.binding();
    const videoEl = binding.el;
    try { if (videoEl && videoEl.play) videoEl.pause(); } catch (e) {}
    seekToAnnot(binding, entry.t);
    core.renderOnly(entry);                 // 先只显示本条，让你看清要标的是哪一帧
    // 立即弹确认条（不阻塞等待）——支持一条接一条连续截图；框随 seek 立即按当帧重算
    let chosen = null;
    try { chosen = await confirmShot(entry, idx, total, binding, videoEl); } catch (e) { chosen = null; }
    if (chosen == null) return null;        // 跳过
    try {
      // 以用户确认时的当前帧为准：写回 t（含 updated）——所见即所得
      const cur = Math.max(0, Number(videoEl && videoEl.currentTime) || chosen);
      if (isFinite(cur) && Math.abs(cur - Number(entry.t)) > 0.01) {
        entry.t = Math.round(cur * 100) / 100;
        entry.updated = new Date().toISOString();
      }
      core.renderOnly(entry);
      core.setChromeHidden(true);
      let shot = await core.captureFrame();
      if (shot && overlay) shot = await canvasOverlay(shot, entry);
      return shot || null;
    } catch (e) { return null; }
    finally {
      try { core.render(); } catch (e) {}
      try { core.setChromeHidden(false); } catch (e) {}
    }
  }

  async function run(opts, entries, media, mediaId, completed, deckId) {
    const format = ['apkg', 'csv', 'json', 'jsonl'].includes(opts.format) ? opts.format : 'apkg';
    try {
      if (format !== 'apkg') {
        state = 'running';
        for (let i = 0; i < entries.length; i++) {
          await waitIfPaused();
          if (cancelled) break;
          current = String(entries[i].word || '标注'); done = i + 1; paintProgress();
          if (typeof opts.onProgress === 'function') { try { opts.onProgress(status()); } catch (e) {} }
        }
        if (!cancelled) {
          exportClient(entries, media, format);
          state = 'complete';
          core.showToast('已导出 ' + entries.length + ' 条 · ' + format.toUpperCase());
        } else state = 'cancelled';
        return;
      }

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
        const shot = opts.manual
          ? await captureEntryManual(entry, item.index, todo.length, !!opts.overlay)
          : await captureEntry(entry, prior, firstShot, opts.settle, !!opts.overlay);
        firstShot = false;
        if (opts.manual && core.save) { try { core.save(); } catch (e) {} }   // 手动模式可能回写了 t
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
        if (typeof opts.onProgress === 'function') { try { opts.onProgress(status()); } catch (e) {} }
      }
      if (cancelled) { state = 'cancelled'; core.showToast('批量导出已取消 · 可再次运行以续跑'); return; }
      const base = await core.resolveBase();
      const result = await core.httpJson('POST', base + '/api/export/finalize', {
        deck_id: deckId,
        deck_name: String(opts.deckName || media.title || 'Annota 学习卡'),
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

  async function start(opts) {
    opts = opts && typeof opts === 'object' ? opts : {};
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
  root.VAExport = {
    install(coreApi) {
      core = coreApi;
      root.__ANNOTA_EXPORT__ = api;
    },
  };
})(typeof window !== 'undefined' ? window : this);
