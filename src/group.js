/* Annota · 组（R4a）——GroupStore 抽象 + GitStore（GitHub / Gitee Contents API）
 * 组 = 一个 git 仓库：group.json（组清单/片单/成员/packIndex）+ packs/<mediaKey>.json（现有 Pack）。
 * 读：raw / contents GET；写：GET sha → 本地 merge → PUT；409 冲突重取 sha 重试。
 * 纯客户端 + 第三方 API，零自建服务器。用户侧不依赖命令行/sec/env：token 由 UI 粘贴、存 localStorage。
 *
 * 三形态通用（build.py 并入产物）；网络用 fetch（GitHub/Gitee API 允许 CORS）。
 * 合并复用 core 注入的 mergePack（mergeLocal/validEntries），与个人同步同一规则。
 */
(function (root) {
  'use strict';

  let core = null;                       // coreApi（VAGroup.install 注入）
  const api = (function () {
    return {
      github: {
        contents: (repo, path) => `https://api.github.com/repos/${repo}/contents/${path}`,
        accept: 'application/vnd.github+json',
        auth: (t) => ({ Authorization: 'Bearer ' + t, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }),
      },
      gitee: {
        contents: (repo, path) => `https://gitee.com/api/v5/repos/${repo}/contents/${path}`,
        accept: 'application/json',
        // Gitee 用 access_token query 或 header 均可；用 header 更干净
        auth: (t) => ({ Authorization: 'token ' + t, Accept: 'application/json' }),
      },
    };
  })();

  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function b64decode(b64) {
    const clean = String(b64 || '').replace(/\n/g, '');
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // 底层调用：直接用 fetch（GitHub/Gitee 允许跨域）。返回 {ok,status,json}
  // Gitee：token 走 access_token query（官方推荐，header 亦可）；GitHub：Authorization header
  async function request(hostKind, method, url, token, body) {
    const plat = api[hostKind];
    let full = url;
    let headers = { Accept: plat.accept };
    if (token && hostKind === 'gitee') {
      full += (url.indexOf('?') >= 0 ? '&' : '?') + 'access_token=' + encodeURIComponent(token);
    } else if (token) {
      headers = Object.assign(headers, plat.auth(token));
    }
    if (body != null) headers['Content-Type'] = 'application/json';
    const r = await fetch(full, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
    let json = null;
    try { json = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, json };
  }

  function commitMessage(action, mediaKey, extra) {
    const who = (root.VAIdentity && root.VAIdentity.current() && root.VAIdentity.current().name) || 'member';
    return `annota: ${action} ${mediaKey || ''}${extra ? ' ' + extra : ''} by ${who}`.trim();
  }

  // ---------- GroupStore 抽象（R4a 仅 GitStore） ----------
  // 绑定 = { kind:'github'|'gitee', repo, branch, token, gid }
  const GitStore = {
    kind: 'git',

    // 读 JSON 文件；不存在返回 null
    async read(bind, path) {
      const plat = api[bind.kind];
      const url = plat.contents(bind.repo, path) + (bind.branch ? `?ref=${encodeURIComponent(bind.branch)}` : '');
      const r = await request(bind.kind, 'GET', url, bind.token);
      if (r.status === 404) return { missing: true, content: null, sha: null };
      if (!r.ok) throw new Error(`read ${path}: HTTP ${r.status}`);
      const content = r.json && r.json.content ? JSON.parse(b64decode(r.json.content)) : null;
      return { missing: false, content, sha: (r.json && r.json.sha) || null };
    },

    // 写 JSON 文件。存在 → PUT+sha 更新；不存在 → 新建：
    //   GitHub：PUT（可省 sha）；Gitee：POST /contents（PUT 对不存在文件会 "sha is empty"）。
    // 冲突（409/422）→ 重取 sha 重合并重试（最多 3 次）
    async write(bind, path, obj, message) {
      const plat = api[bind.kind];
      const url = plat.contents(bind.repo, path);
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await request(bind.kind, 'GET', url + (bind.branch ? `?ref=${encodeURIComponent(bind.branch)}` : ''), bind.token);
        const exists = cur.ok && cur.json && cur.json.sha;
        const sha = exists ? cur.json.sha : null;
        const payload = { message: message || commitMessage('update', path), content: b64encode(JSON.stringify(obj, null, 1)) };
        if (bind.branch) payload.branch = bind.branch;
        let res;
        if (!exists && bind.kind === 'gitee') {
          res = await request(bind.kind, 'POST', url, bind.token, payload);   // Gitee 新建
        } else {
          if (sha) payload.sha = sha;   // GitHub 新建可省略；更新必须带
          res = await request(bind.kind, 'PUT', url, bind.token, payload);
        }
        if (res.ok) return res.json;
        lastErr = `write ${path}: HTTP ${res.status} ${(res.json && (res.json.message || res.json.error || (res.json.messages && res.json.messages.join(';')))) || ''}`;
        if (res.status !== 409 && res.status !== 422) break;   // 非冲突不重试
      }
      throw new Error(lastErr || 'write failed');
    },

    // 读 pack（组内某媒体），不存在 = 空 pack
    async readPack(bind, mediaKey) {
      const r = await GitStore.read(bind, `packs/${mediaKey}.json`);
      return r.missing || !r.content ? { format: 'video-annotate/0.1', media: { videoId: mediaKey }, entries: [] } : r.content;
    },

    // 写 pack：读现有 → merge（复用 core）→ 写回
    async writePack(bind, mediaKey, incomingPack) {
      const path = `packs/${mediaKey}.json`;
      const r = await GitStore.read(bind, path);
      const cur = (r.content && Array.isArray(r.content.entries)) ? r.content : { format: 'video-annotate/0.1', media: incomingPack.media || { videoId: mediaKey }, entries: [] };
      const merged = core && core.mergePack
        ? core.mergePack(cur.entries, incomingPack.entries || [])
        : (incomingPack.entries || []);
      const out = { format: cur.format || 'video-annotate/0.1', media: incomingPack.media || cur.media || { videoId: mediaKey }, entries: merged };
      await GitStore.write(bind, path, out, commitMessage('+', mediaKey, `+${Math.max(0, merged.length - (cur.entries || []).length)}`));
      return out;
    },

    async readGroup(bind) { const r = await GitStore.read(bind, 'group.json'); return r.missing ? null : r.content; },
    async writeGroup(bind, doc) { return GitStore.write(bind, 'group.json', doc, commitMessage('group', bind.gid)); },
  };

  // ---------- 组注册表（本地） ----------
  const GROUPS_KEY = 'annota:groups';
  function listGroups() {
    try { const a = JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function saveGroups(list) { try { localStorage.setItem(GROUPS_KEY, JSON.stringify(list)); } catch (e) {} }
  function addGroup(rec) {
    const list = listGroups().filter((g) => g.gid !== rec.gid);
    list.push(rec); saveGroups(list); return list;
  }
  function findGroup(gid) { return listGroups().find((g) => g.gid === gid) || null; }

  function bindOf(rec) { return { kind: rec.host, repo: rec.repo, branch: rec.branch || 'main', token: rec.token, gid: rec.gid }; }

  // ---------- 组模型 / 建组 / 邀请链接 ----------
  function newGid() {
    const a = new Uint8Array(6);
    try { (root.crypto && root.crypto.getRandomValues) ? root.crypto.getRandomValues(a) : a.forEach((_, i) => a[i] = (Math.random() * 256) | 0); }
    catch (e) { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; }
    return 'grp_' + Array.from(a).map((b) => b.toString(36)).join('').slice(0, 8);
  }

  function me() { return (root.VAIdentity && root.VAIdentity.current()) || { id: 'urn:hash:anon', name: '匿名标注者' }; }

  // 建组：doc = 组清单；rec = 本地注册记录（含 repo/token）
  // 调用方需传入已建好的空仓（host/repo/branch/token）。
  async function createGroup({ host, repo, branch, token, name, contentItems, visibility }) {
    const identity = me();
    const gid = newGid();
    const now = new Date().toISOString();
    const doc = {
      type: 'va:Group', id: gid, name: String(name || '未命名组').slice(0, 60),
      created: now, updated: now, visibility: visibility || 'private',
      host: { kind: host, repo, branch: branch || 'main' },
      owner: { id: identity.id, name: identity.name },
      members: [{ id: identity.id, name: identity.name, role: 'owner', addedAt: now }],
      contentList: { id: 'list_' + gid.slice(4), label: '共同片单', items: contentItems || [] },
      packIndex: {},
    };
    const bind = { kind: host, repo, branch: branch || 'main', token, gid };
    await GitStore.writeGroup(bind, doc);
    const rec = { gid, name: doc.name, host, repo, branch: branch || 'main', token, role: 'owner', joinedAt: now };
    addGroup(rec);
    return { doc, rec };
  }

  // 邀请链接：annota://join?host=…&repo=…&gid=…#t=<token>
  // token 走 fragment（不进服务器日志/Referer）。readOnly 组将来可只带只读凭据。
  function inviteLink(rec, token) {
    const q = `host=${encodeURIComponent(rec.host)}&repo=${encodeURIComponent(rec.repo)}&gid=${encodeURIComponent(rec.gid)}&branch=${encodeURIComponent(rec.branch || 'main')}`;
    return `annota://join?${q}#t=${encodeURIComponent(token || rec.token || '')}`;
  }

  // 解析邀请链接 → 注册记录（不含校验；真正可用性由后续 read 试探）
  function parseInvite(link) {
    try {
      const s = String(link || '').trim();
      const m = s.match(/annota:\/\/join\?(.*?)#t=(.*)$/i) || s.match(/[?#&]annota-group=([A-Za-z0-9_-]+)/);
      if (!m) return null;
      let host, repo, gid, branch = 'main', token;
      if (s.indexOf('annota://join') === 0) {
        const params = new URLSearchParams(m[1]);
        host = params.get('host'); repo = params.get('repo'); gid = params.get('gid'); branch = params.get('branch') || 'main';
        token = decodeURIComponent(m[2] || '');
      } else {
        const raw = m[1].replace(/-/g, '+').replace(/_/g, '/');
        const obj = JSON.parse(b64decode(raw + '='.repeat((4 - raw.length % 4) % 4)));
        host = obj.host; repo = obj.repo; gid = obj.gid; branch = obj.branch || 'main'; token = obj.token;
      }
      if (!host || !repo || !gid) return null;
      return { gid, host, repo, branch, token: token || '' };
    } catch (e) { return null; }
  }

  // 加入组：读 group.json 拿名称 → 注册本地
  async function joinGroup(invite) {
    const rec0 = typeof invite === 'string' ? parseInvite(invite) : invite;
    if (!rec0) throw new Error('邀请链接无效');
    const bind = { kind: rec0.host, repo: rec0.repo, branch: rec0.branch, token: rec0.token, gid: rec0.gid };
    let doc = null;
    try { doc = await GitStore.readGroup(bind); } catch (e) { doc = null; }
    if (!doc) throw new Error('读取失败：仓库/权限/口令可能不对');
    const rec = { gid: doc.id || rec0.gid, name: doc.name || rec0.gid, host: rec0.host, repo: rec0.repo, branch: rec0.branch, token: rec0.token, role: 'member', joinedAt: new Date().toISOString() };
    addGroup(rec);
    return { rec, doc };
  }

  // ---------- 客户端组同步（与个人同步正交；复用 core 的合并/缓存）----------
  const CACHE_PREFIX = 'va:group:';
  function mediaKey(mediaId) { return String(mediaId || '').replace(/[^\w.-]+/g, '_'); }
  function readCache(gid, mediaId) { try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + gid + ':' + mediaId) || 'null'); } catch (e) { return null; } }
  function writeCache(gid, mediaId, pack) { try { localStorage.setItem(CACHE_PREFIX + gid + ':' + mediaId, JSON.stringify(pack)); } catch (e) {} }

  // 当前媒体是否在某组片单里
  function groupsForMedia(mediaId) {
    return listGroups().filter((g) => {
      const pack = readCache(g.gid, mediaId);
      return pack != null;   // 已可见/已加入该媒体的组
    });
  }

  // 拉：把组内该媒体的 pack 拉到本地缓存（组来源条目）；返回是否变化
  async function pullForMedia(mediaId) {
    let changed = false;
    for (const g of listGroups()) {
      try {
        const pack = await GitStore.readPack(bindOf(g), mediaKey(mediaId));
        const cur = readCache(g.gid, mediaId);
        if (!cur || JSON.stringify(cur) !== JSON.stringify(pack)) { writeCache(g.gid, mediaId, pack); changed = true; }
      } catch (e) { /* 组不可达：跳过，不影响个人 */ }
    }
    return changed;
  }

  // 推：把我锚点属于组片单媒体的实线条目，按组推送（每组各推一次）
  async function pushForMedia(mediaId, entries) {
    const out = { pushed: 0, groups: [] };
    for (const g of listGroups()) {
      try {
        const clean = (entries || []).map((e) => { const c = Object.assign({}, e); delete c.__group; delete c.__gid; delete c.__author; return c; });
        const merged = await GitStore.writePack(bindOf(g), mediaKey(mediaId), { media: (core && core.mediaMeta ? core.mediaMeta() : { videoId: mediaId }), entries: clean });
        writeCache(g.gid, mediaId, merged);
        out.pushed += clean.length; out.groups.push(g.gid);
      } catch (e) { /* 单组失败不影响其它组 */ }
    }
    return out;
  }

  root.VAGroup = {
    GitStore,
    install(coreApi) { core = coreApi; root.__ANNOTA_GROUP__ = root.VAGroup; },
    listGroups, addGroup, findGroup, saveGroups, bindOf,
    newGid, createGroup, inviteLink, parseInvite, joinGroup, me,
    pullForMedia, pushForMedia, groupsForMedia,
    _b64: { encode: b64encode, decode: b64decode },
  };
})(typeof self !== 'undefined' ? self : this);
