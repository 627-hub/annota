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
  // 两者都用 Authorization header 传 token（Gitee 亦支持），避免 token 进 URL（历史/日志/Referer）
  async function request(hostKind, method, url, token, body) {
    const plat = api[hostKind];
    let headers = { Accept: plat.accept };
    if (token) headers = Object.assign(headers, plat.auth(token));
    if (body != null) headers['Content-Type'] = 'application/json';
    const r = await fetch(url, { method, headers, body: body != null ? JSON.stringify(body) : undefined });
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
    // 冲突（409/422）→ 重取内容重合并重试（最多 3 次）。
    // build(obj|current): 返回要写的内容。传函数时，每次重试会用「最新远端内容 current」重新生成，
    //   避免把并发期间别人的写入覆盖掉（obj 传入则固定不变）。
    async write(bind, path, builder, message) {
      const url = api[bind.kind].contents(bind.repo, path);
      const build = typeof builder === 'function' ? builder : () => builder;
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const cur = await request(bind.kind, 'GET', url + (bind.branch ? `?ref=${encodeURIComponent(bind.branch)}` : ''), bind.token);
        const exists = cur.ok && cur.json && cur.json.sha;
        const sha = exists ? cur.json.sha : null;
        let remoteContent = null;
        try { if (exists && cur.json.content) remoteContent = JSON.parse(b64decode(cur.json.content)); } catch (e) {}
        const obj = build(remoteContent, exists);   // 用最新远端内容重新生成
        const payload = { message: message || commitMessage('update', path), content: b64encode(JSON.stringify(obj, null, 1)) };
        if (bind.branch) payload.branch = bind.branch;
        let res;
        if (!exists && bind.kind === 'gitee') {
          res = await request(bind.kind, 'POST', url, bind.token, payload);   // Gitee 新建
        } else {
          if (sha) payload.sha = sha;   // GitHub 新建可省略；更新必须带
          res = await request(bind.kind, 'PUT', url, bind.token, payload);
        }
        if (res.ok) return { result: res.json, content: obj };
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

    // 写 pack：用 builder 在读到的「最新远端内容」上 merge（复用 core）→ 写回；
    // 409 重试时会用重新读到的远端内容再 merge，不覆盖并发写入。
    async writePack(bind, mediaKey, incomingPack) {
      const path = `packs/${mediaKey}.json`;
      const mergeFn = (cur) => {
        const base = (cur && Array.isArray(cur.entries)) ? cur : { format: 'video-annotate/0.1', media: incomingPack.media || { videoId: mediaKey }, entries: [] };
        const merged = core && core.mergePack ? core.mergePack(base.entries || [], incomingPack.entries || []) : (incomingPack.entries || []);
        return { format: base.format || 'video-annotate/0.1', media: incomingPack.media || base.media || { videoId: mediaKey }, entries: merged };
      };
      const { content } = await GitStore.write(bind, path, (remote) => mergeFn(remote), commitMessage('+', mediaKey));
      return content;
    },

    async readGroup(bind) { const r = await GitStore.read(bind, 'group.json'); return r.missing ? null : r.content; },
    async writeGroup(bind, doc) { return (await GitStore.write(bind, 'group.json', doc, commitMessage('group', bind.gid))).content; },
  };

  // ---------- HubStore：CloudBase PG（浏览器直连 app.rdb()，RLS 鉴权）----------
  // bind = { kind:'hub' }（身份来自 CloudBase 会话，不需要 repo/token）
  // 依赖 window.cloudbase（vendor/cloudbase.full.js）+ Publishable Key（公开）。
  const CB_ENV = 'tencentcloudtest-d2eg4lu85c76fb0';
  const CB_REGION = 'ap-shanghai';
  const CB_PK_KEY = 'annota:cloudbase:pk';   // Publishable Key 存本地（公开值）
  const HUB_BASE = 'https://tencentcloudtest-d2eg4lu85c76fb0-1414056833.ap-shanghai.app.tcloudbase.com';
  const HUB_ME_KEY = 'annota:hub:me';        // 登录后的云端身份缓存（uid/name）
  let cbApp = null, cbDb = null;

  function cbPublishableKey() {
    try { return root.__ANNOTA_CB_PK__ || localStorage.getItem(CB_PK_KEY) || ''; } catch (e) { return root.__ANNOTA_CB_PK__ || ''; }
  }
  function setPublishableKey(pk) { try { localStorage.setItem(CB_PK_KEY, String(pk || '')); } catch (e) {} }
  function cbInit() {
    if (cbDb) return cbDb;
    const cb = root.cloudbase;
    if (!cb || typeof cb.init !== 'function') throw new Error('CloudBase SDK 未加载（vendor/cloudbase.full.js）');
    const pk = cbPublishableKey();
    if (!pk) throw new Error('缺少 Publishable Key（设置 → 组 → 连接云开发）');
    cbApp = cb.init({ env: CB_ENV, region: CB_REGION, accessKey: pk, auth: { detectSessionInUrl: false } });
    cbDb = cbApp.rdb();
    return cbDb;
  }

  // ---------- 登录态（CloudBase 自定义登录，GitHub OAuth 经云函数签 ticket）----------
  function cbAppObj() { if (!cbApp) cbInit(); return cbApp; }
  // v3：app.auth 直接就是认证实例（typeof 恰为 function，但不可当方法调用）。
  function cbAuth() { return cbAppObj().auth; }

  function b64url(str) {
    const bytes = new TextEncoder().encode(String(str == null ? '' : str));
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function hubMe() {
    try { return JSON.parse(localStorage.getItem(HUB_ME_KEY) || 'null'); } catch (e) { return null; }
  }
  function setHubMe(identity) {
    try { identity ? localStorage.setItem(HUB_ME_KEY, JSON.stringify(identity)) : localStorage.removeItem(HUB_ME_KEY); } catch (e) {}
  }

  // 登录跳转地址：把「回到哪一页」base64url 编进 state，云函数 callback 原样带回并附 ticket。
  function loginUrl(returnUrl) {
    const back = returnUrl || (root.location && root.location.href) || '';
    return HUB_BASE + '/auth/github/start?state=' + encodeURIComponent(b64url(back));
  }
  function startLogin(returnUrl) {
    const url = loginUrl(returnUrl);
    if (root.location && typeof root.location.assign === 'function') root.location.assign(url);
    return url;
  }

  // 若当前 URL 带 ?ticket=：兑换 CloudBase 会话、缓存身份、清理地址栏。返回 user 或 null。
  async function handleTicket() {
    const loc = root.location;
    if (!loc) return null;
    let url;
    try { url = new URL(loc.href); } catch (e) { return null; }
    const ticket = url.searchParams.get('ticket');
    if (!ticket) return null;
    const uidParam = url.searchParams.get('uid') || '';
    const nameParam = url.searchParams.get('name') || '';
    const auth = cbAuth();
    let res;
    if (auth && typeof auth.signInWithCustomTicket === 'function') {
      res = await auth.signInWithCustomTicket(() => Promise.resolve(ticket));
    } else if (auth && typeof auth.customAuthProvider === 'function') {
      res = await auth.customAuthProvider().signIn(ticket);
    } else {
      throw new Error('当前 SDK 不支持自定义登录');
    }
    ['ticket', 'uid', 'name'].forEach((k) => url.searchParams.delete(k));
    try { root.history.replaceState({}, '', url.href); } catch (e) {}
    if (res && res.error) throw res.error;
    const user = (res && res.data && res.data.user) || null;
    const identity = { id: uidParam || (user && user.id) || '', name: nameParam || (user && (user.name || user.username || user.id)) || '' };
    if (identity.id) setHubMe(identity);
    return user;
  }

  async function session() {
    const auth = cbAuth();
    if (!auth || typeof auth.getSession !== 'function') return null;
    try {
      const r = await auth.getSession();
      if (r && r.error) return null;
      return (r && r.data && r.data.session) || null;
    } catch (e) { return null; }
  }
  async function currentUser() { const s = await session(); return (s && s.user) || null; }
  async function signOut() {
    const auth = cbAuth();
    if (auth && typeof auth.signOut === 'function') { try { await auth.signOut(); } catch (e) {} }
    setHubMe(null);
  }

  const HubStore = {
    kind: 'hub',
    db() { return cbInit(); },

    // 组清单（含片单/成员）—— 从 groups + members 组装成与 GitStore 同形的 doc
    async readGroup(bind) {
      const db = cbInit();
      const g = await db.from('groups').select('*').eq('id', bind.gid).single();
      if (g.error || !g.data) return null;
      const mem = await db.from('members').select('user_id,name,role').eq('group_id', bind.gid);
      const doc = g.data;
      doc.members = (mem.data || []).map((m) => ({ id: m.user_id, name: m.name, role: m.role }));
      doc.contentList = doc.content_list || { items: [] };
      return doc;
    },

    async writeGroup(bind, doc) {
      const db = cbInit();
      await db.from('groups').upsert({
        id: bind.gid, name: doc.name || '未命名组', visibility: doc.visibility || 'private',
        content_list: doc.contentList || { items: [] }, pack_index: doc.packIndex || {},
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      return doc;
    },

    async readPack(bind, mediaKey) {
      const db = cbInit();
      const r = await db.from('packs').select('media,entries').eq('group_id', bind.gid).eq('media_key', mediaKey).single();
      if (r.error || !r.data) return { format: 'video-annotate/0.1', media: { videoId: mediaKey }, entries: [] };
      return { format: 'video-annotate/0.1', media: r.data.media || { videoId: mediaKey }, entries: r.data.entries || [] };
    },

    async writePack(bind, mediaKey, incomingPack) {
      const db = cbInit();
      const cur = await HubStore.readPack(bind, mediaKey);
      const merged = core && core.mergePack ? core.mergePack(cur.entries || [], incomingPack.entries || []) : (incomingPack.entries || []);
      await db.from('packs').upsert({
        group_id: bind.gid, media_key: mediaKey,
        media: incomingPack.media || cur.media || { videoId: mediaKey },
        entries: merged, updated_at: new Date().toISOString(),
      }, { onConflict: 'group_id,media_key' });
      return { format: 'video-annotate/0.1', media: incomingPack.media || cur.media, entries: merged };
    },

    // 建组：groups + owner member
    async createGroup(bind, doc, identity) {
      const db = cbInit();
      await db.from('groups').insert({
        id: bind.gid, name: doc.name, visibility: doc.visibility || 'private',
        content_list: doc.contentList || { items: [] },
      });
      await db.from('members').insert({ group_id: bind.gid, user_id: identity.id, role: 'owner', name: identity.name });
      return doc;
    },
    async joinGroup(bind, identity) {
      const db = cbInit();
      const r = await db.from('members').insert({ group_id: bind.gid, user_id: identity.id, role: 'member', name: identity.name });
      const err = r && r.error;
      // 主键冲突 = 已经是成员，视为成功；其它错误（组不存在 / 未登录）抛出。
      if (err && !/duplicate|unique|conflict|23505/i.test(String(err.message || err.code || ''))) {
        throw new Error(err.message || '加入失败');
      }
    },
    // 我加入的组 gid 列表
    async myGroups() {
      const db = cbInit();
      const r = await db.from('members').select('group_id');
      return (r.data || []).map((m) => m.group_id);
    },
    // 把云端「我加入的组」合并进本地注册表（跨设备入组后本机可见/可同步）
    async syncFromHub() {
      try {
        const db = cbInit();
        const mem = await db.from('members').select('group_id');
        const ids = new Set((mem.data || []).map((m) => m.group_id));
        if (!ids.size) return listGroups();
        const gs = await db.from('groups').select('id, name, visibility');
        const list = listGroups();
        let changed = false;
        for (const g of (gs.data || [])) {
          if (!ids.has(g.id)) continue;
          if (!list.some((x) => x.gid === g.id)) {
            list.push({ host: 'hub', gid: g.id, name: g.name || '', visibility: g.visibility || 'private', role: '成员', addedAt: new Date().toISOString() });
            changed = true;
          }
        }
        if (changed) saveGroups(list);
        return list;
      } catch (e) { return listGroups(); }
    },
  };

  // 按 host 分发到对应 store（R4a: git；R4b: hub）
  function storeFor(host) {
    if (host === 'hub' || host === 'cloudbase') return HubStore;
    return GitStore;
  }

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

  function bindOf(rec) {
    if (rec.host === 'hub' || rec.host === 'cloudbase') return { kind: 'hub', gid: rec.gid };
    return { kind: rec.host, repo: rec.repo, branch: rec.branch || 'main', token: rec.token, gid: rec.gid };
  }

  // ---------- 组模型 / 建组 / 邀请链接 ----------
  function newGid() {
    const a = new Uint8Array(6);
    try { (root.crypto && root.crypto.getRandomValues) ? root.crypto.getRandomValues(a) : a.forEach((_, i) => a[i] = (Math.random() * 256) | 0); }
    catch (e) { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; }
    return 'grp_' + Array.from(a).map((b) => b.toString(36)).join('').slice(0, 8);
  }

  function me() { return (root.VAIdentity && root.VAIdentity.current()) || { id: 'urn:hash:anon', name: '匿名标注者' }; }

  // hub 操作的身份：登录后以 CloudBase uid（gh-…）署名；未登录退回本地身份。
  function hubIdentity() {
    const hub = hubMe();
    if (hub && hub.id) return { id: hub.id, name: hub.name || hub.id };
    return me();
  }

  // 建组。host='hub' → CloudBase（需已登录）；host='github'|'gitee' → 需 repo/branch/token（进阶）。
  async function createGroup({ host, repo, branch, token, name, contentItems, visibility }) {
    const identity = (host === 'hub' || host === 'cloudbase') ? hubIdentity() : me();
    const gid = newGid();
    const now = new Date().toISOString();
    const doc = {
      type: 'va:Group', id: gid, name: String(name || '未命名组').slice(0, 60),
      created: now, updated: now, visibility: visibility || 'private',
      owner: { id: identity.id, name: identity.name },
      members: [{ id: identity.id, name: identity.name, role: 'owner', addedAt: now }],
      contentList: { id: 'list_' + gid.slice(4), label: '共同片单', items: contentItems || [] },
      packIndex: {},
    };
    let rec;
    if (host === 'hub' || host === 'cloudbase') {
      const bind = { kind: 'hub', gid };
      await HubStore.createGroup(bind, doc, identity);
      // 本地记录带 doc（含片单）→ groupsForMedia 立即能识别，无需等一次拉取
      rec = { gid, name: doc.name, host: 'hub', role: 'owner', joinedAt: now, doc };
    } else {
      doc.host = { kind: host, repo, branch: branch || 'main' };
      const bind = { kind: host, repo, branch: branch || 'main', token, gid };
      await GitStore.writeGroup(bind, doc);
      rec = { gid, name: doc.name, host, repo, branch: branch || 'main', token, role: 'owner', joinedAt: now, doc };
    }
    addGroup(rec);
    return { doc, rec };
  }

  // 邀请链接。
  //  hub：annota://join?host=hub&gid=…  （无需 token；加入即成员，靠 CloudBase 登录）
  //  git：annota://join?host=github&repo=…&gid=…#t=<token>
  function inviteLink(rec, token) {
    if (rec.host === 'hub' || rec.host === 'cloudbase') {
      return `annota://join?host=hub&gid=${encodeURIComponent(rec.gid)}`;
    }
    const q = `host=${encodeURIComponent(rec.host)}&repo=${encodeURIComponent(rec.repo)}&gid=${encodeURIComponent(rec.gid)}&branch=${encodeURIComponent(rec.branch || 'main')}`;
    return `annota://join?${q}#t=${encodeURIComponent(token || rec.token || '')}`;
  }

  // 解析邀请链接 → 注册记录（不含校验；真正可用性由后续 read 试探）
  function parseInvite(link) {
    try {
      const s = String(link || '').trim();
      const m = s.match(/annota:\/\/join\?(.*?)(?:#t=(.*))?$/i) || s.match(/[?#&]annota-group=([A-Za-z0-9_-]+)/);
      if (!m) return null;
      let host, repo, gid, branch = 'main', token = '';
      if (s.indexOf('annota://join') === 0) {
        const params = new URLSearchParams(m[1]);
        host = params.get('host'); repo = params.get('repo'); gid = params.get('gid'); branch = params.get('branch') || 'main';
        token = decodeURIComponent(m[2] || '');
      } else {
        const raw = m[1].replace(/-/g, '+').replace(/_/g, '/');
        const obj = JSON.parse(b64decode(raw + '='.repeat((4 - raw.length % 4) % 4)));
        host = obj.host; repo = obj.repo; gid = obj.gid; branch = obj.branch || 'main'; token = obj.token;
      }
      if (!host || !gid) return null;
      if (host !== 'hub' && host !== 'cloudbase' && !repo) return null;
      return { gid, host, repo, branch, token: token || '' };
    } catch (e) { return null; }
  }

  // 加入组：hub → 直接写 members；git → 读 group.json 取名称后注册
  async function joinGroup(invite) {
    const rec0 = typeof invite === 'string' ? parseInvite(invite) : invite;
    if (!rec0) throw new Error('邀请链接无效');
    if (rec0.host === 'hub' || rec0.host === 'cloudbase') {
      const identity = hubIdentity();
      const bind = { kind: 'hub', gid: rec0.gid };
      // 先自助加入（RLS：user_id = auth.uid() 可 insert），再读组（此时已是成员可读）
      await HubStore.joinGroup(bind, identity);
      let doc = null;
      try { doc = await HubStore.readGroup(bind); } catch (e) { doc = null; }
      if (!doc) throw new Error('读取失败：组不存在');
      const rec = { gid: rec0.gid, name: doc.name, host: 'hub', role: 'member', joinedAt: new Date().toISOString(), doc };
      addGroup(rec);
      return { rec, doc };
    }
    const bind = { kind: rec0.host, repo: rec0.repo, branch: rec0.branch, token: rec0.token, gid: rec0.gid };
    let doc = null;
    try { doc = await GitStore.readGroup(bind); } catch (e) { doc = null; }
    if (!doc) throw new Error('读取失败：仓库/权限/口令可能不对');
    const rec = { gid: doc.id || rec0.gid, name: doc.name || rec0.gid, host: rec0.host, repo: rec0.repo, branch: rec0.branch, token: rec0.token, role: 'member', joinedAt: new Date().toISOString(), doc };
    addGroup(rec);
    return { rec, doc };
  }

  // ---------- 客户端组同步（与个人同步正交；复用 core 的合并/缓存）----------
  const CACHE_PREFIX = 'va:group:';
  function mediaKey(mediaId) { return String(mediaId || '').replace(/[^\w.-]+/g, '_'); }
  function readCache(gid, mediaId) { try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + gid + ':' + mediaId) || 'null'); } catch (e) { return null; } }
  function writeCache(gid, mediaId, pack) { try { localStorage.setItem(CACHE_PREFIX + gid + ':' + mediaId, JSON.stringify(pack)); } catch (e) {} }

  // 组是否把该媒体列进了片单（contentList）；缓存里存过的也认（兼容先前行为）
  // 媒体 id 形态不一：workspace 片单项存裸 id（BV1…），userscript adapter 存带平台前缀（bilibili:BV1…）。
  // 一侧带 `平台:` 前缀、另一侧没有时视为同一媒体；两测都带前缀（或都不带）则须严格相等。
  function sameMediaId(a, b) {
    const x = String(a || ''), y = String(b || '');
    if (!x || !y) return false;
    if (x === y) return true;
    const isUrl = (s) => /^https?:\/\//i.test(s);
    const canonUrl = (s) => s.replace(/^https?:\/\//i, '').replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    // URL ↔ URL：去协议/查询串/末尾斜杠后比较
    if (isUrl(x) && isUrl(y)) return canonUrl(x) === canonUrl(y);
    // 平台前缀剥离：platform:id ↔ id；http(s):// 开头不算前缀（URL 里自带冒号）
    const pref = (s) => (!isUrl(s) && /^[a-z][a-z0-9+.-]*:/i.test(s)) ? s.slice(s.indexOf(':') + 1) : null;
    const px = pref(x), py = pref(y);
    const urlEndsWithId = (url, id) => !id.includes('/') && id.length >= 6 && canonUrl(url).endsWith('/' + id.toLowerCase());
    if (px !== null && py === null) {
      if (px === y) return true;
      if (isUrl(px) && isUrl(y)) return canonUrl(px) === canonUrl(y); // generic:https://a/p ↔ https://a/p?q
      if (isUrl(y) && urlEndsWithId(y, px)) return true;              // douyin:123 ↔ …/video/123
      return false;
    }
    if (py !== null && px === null) {
      if (py === x) return true;
      if (isUrl(py) && isUrl(x)) return canonUrl(py) === canonUrl(x);
      if (isUrl(x) && urlEndsWithId(x, py)) return true;
      return false;
    }
    if (px !== null && py !== null) {
      if (px === py) return true;
      if (isUrl(px) && isUrl(py)) return canonUrl(px) === canonUrl(py); // web:https://a/p ↔ generic:https://a/p
      return false;
    }
    return false;
  }
  function groupHasMedia(g, mediaId) {
    const doc = g.doc;
    const target = String(mediaId || '');
    if (doc && doc.contentList && Array.isArray(doc.contentList.items)) {
      return doc.contentList.items.some((it) => {
        const m = it && it.media ? it.media : it;
        const id = m && (m.mediaId || m.videoId || m.url);
        return (id && sameMediaId(id, target)) || (m && m.url && sameMediaId(m.url, target));
      });
    }
    return readCache(g.gid, mediaId) != null;   // 没记片单信息时退回"有缓存"
  }

  // 当前媒体真正相关的组：必须把该媒体列进了片单（不对无关组推送/展示）
  function groupsForMedia(mediaId) {
    return listGroups().filter((g) => groupHasMedia(g, mediaId));
  }

  // 拉：把组内该媒体的 pack 拉到本地缓存（组来源条目）；返回是否变化
  // 只拉「该媒体确在组片单里」的组，避免无关组写上缓存造成误关联。
  async function pullForMedia(mediaId) {
    let changed = false;
    for (const g of listGroups()) {
      try {
        const bind = bindOf(g);
        const store = storeFor(g.host);
        // 片单信息：优先用已缓存的 group doc（createGroup/joinGroup 后可存），否则拉一次并记忆
        if (!g.doc) {
          try { g.doc = await store.readGroup(bind); saveGroups(listGroups().map((x) => x.gid === g.gid ? Object.assign({}, x, { doc: g.doc }) : x)); } catch (e) {}
        }
        if (!groupHasMedia(g, mediaId)) continue;   // 不在本组片单 → 跳过
        const pack = await store.readPack(bind, mediaKey(mediaId));
        const cur = readCache(g.gid, mediaId);
        if (!cur || JSON.stringify(cur) !== JSON.stringify(pack)) { writeCache(g.gid, mediaId, pack); changed = true; }
      } catch (e) { /* 组不可达：跳过，不影响个人 */ }
    }
    return changed;
  }

  // 推：把我锚点属于组片单媒体的实线条目，按组推送（每组各推一次）
  async function pushForMedia(mediaId, entries) {
    const out = { pushed: 0, groups: [] };
    for (const g of groupsForMedia(mediaId)) {      // 只推「该媒体确在片单里」的组
      try {
        const clean = (entries || []).map((e) => { const c = Object.assign({}, e); delete c.__group; delete c.__gid; delete c.__author; return c; });
        const merged = await storeFor(g.host).writePack(bindOf(g), mediaKey(mediaId), { media: (core && core.mediaMeta ? core.mediaMeta() : { videoId: mediaId }), entries: clean });
        writeCache(g.gid, mediaId, merged);
        out.pushed += clean.length; out.groups.push(g.gid);
      } catch (e) { /* 单组失败不影响其它组 */ }
    }
    return out;
  }

  root.VAGroup = {
    GitStore, HubStore, storeFor,
    install(coreApi) { core = coreApi; root.__ANNOTA_GROUP__ = root.VAGroup; },
    listGroups, addGroup, findGroup, saveGroups, bindOf,
    newGid, createGroup, inviteLink, parseInvite, joinGroup, me,
    pullForMedia, pushForMedia, groupsForMedia,
    setPublishableKey, cbPublishableKey, myGroups: () => HubStore.myGroups(),
    syncFromHub: () => HubStore.syncFromHub(),
    // 登录态（GitHub OAuth → CloudBase 自定义登录）
    HUB_BASE, loginUrl, startLogin, handleTicket,
    session, currentUser, signOut, hubMe, setHubMe, hubIdentity,
    _b64: { encode: b64encode, decode: b64decode },
  };
})(typeof self !== 'undefined' ? self : this);
