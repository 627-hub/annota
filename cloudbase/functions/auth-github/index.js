/* Annota · GitHub OAuth 云函数（HTTP 云函数）
 * 路由（按 event.path 前缀）：
 *   GET /auth/github/start    → 302 到 GitHub authorize
 *   GET /auth/github/callback → code 换 token → /user 取 id/login → 签 CloudBase ticket → 302 回前端带 ticket
 * 环境变量：
 *   GITHUB_CLIENT_ID          GitHub OAuth App Client ID
 *   GITHUB_CLIENT_SECRET      GitHub OAuth App Client Secret（经 sec 注入，勿明文落盘）
 *   OAUTH_REDIRECT_BASE       本函数对外的公网 base（回调地址前缀），默认由请求 Host 推断
 *   ANNOTA_APP_URL            登录成功后跳回的前端页（默认 index.html 所在托管域名）
 * 自定义登录私钥：同目录 tcb_custom_login.json（tcb.init credentials 读取）
 * 纯服务端，产出 ticket；前端用 auth.customAuthProvider().signIn(ticket)。
 */
'use strict';

const tcb = require('@cloudbase/node-sdk');
const fs = require('fs');
const path = require('path');

const ENV_ID = process.env.TCB_ENV || 'tencentcloudtest-d2eg4lu85c76fb0';
const CLIENT_ID = process.env.GITHUB_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || '';

let app = null;

// 私钥规范化：兼容 PEM / JSON(tcb_custom_login.json) / hex 编码的 PEM / base64(DER)
function normalizePrivateKey(raw) {
  if (!raw) return '';
  let k = String(raw).trim();
  if (k.startsWith('{')) { try { k = String(JSON.parse(k).private_key || '').trim(); } catch (e) {} }
  // 纯 hex 且解码后得到 PEM（有些存储把 PEM 存成 hex）
  if (/^[0-9a-fA-F\s]+$/.test(k) && k.replace(/\s+/g, '').length % 2 === 0) {
    const dec = Buffer.from(k.replace(/\s+/g, ''), 'hex').toString('utf8');
    if (dec.includes('-----BEGIN')) k = dec;
  }
  if (k.includes('-----BEGIN')) return k.replace(/\\n/g, '\n');
  // base64(DER) → PEM
  try {
    const crypto = require('crypto');
    const der = Buffer.from(k.replace(/\s+/g, ''), 'base64');
    for (const type of ['pkcs8', 'pkcs1']) {
      try { return crypto.createPrivateKey({ key: der, format: 'der', type }).export({ type: 'pkcs8', format: 'pem' }); } catch (e) {}
    }
  } catch (e) {}
  return k;
}

function getApp() {
  if (app) return app;
  // 凭据来源优先级：环境变量（推荐，不落盘）→ 同目录 tcb_custom_login.json（本地调试/旧格式）
  let creds;
  const pk = process.env.TCB_CUSTOM_LOGIN_KEY || '';
  const pkId = process.env.TCB_CUSTOM_LOGIN_KEY_ID || '';
  if (pk) {
    creds = { env_id: ENV_ID, private_key_id: pkId, private_key: normalizePrivateKey(pk) };
    // 若存的是整份 tcb_custom_login.json，则用其中的 private_key_id / env_id（重生成后 key id 会变）
    if (String(pk).trim().startsWith('{')) {
      try {
        const j = JSON.parse(pk);
        if (j.private_key_id) creds.private_key_id = j.private_key_id;
        if (j.env_id) creds.env_id = j.env_id;
      } catch (e) {}
    }
  } else {
    const credPath = path.join(__dirname, 'tcb_custom_login.json');
    if (fs.existsSync(credPath)) creds = require(credPath);
  }
  app = tcb.init({ env: ENV_ID, credentials: creds });
  return app;
}

function resp(statusCode, headers, body) {
  return { statusCode, headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers), body };
}
function redirect(location, extra) {
  return { statusCode: 302, headers: Object.assign({ Location: location }, extra || {}), body: '' };
}

// event 兼容 HTTP 云函数（含 event.path / event.queryStringParameters / event.headers）
function parseReq(event) {
  const e = event || {};
  const headers = {};
  for (const k of Object.keys(e.headers || {})) headers[k.toLowerCase()] = e.headers[k];
  const host = headers['x-forwarded-host'] || headers.host || '';
  const proto = headers['x-forwarded-proto'] || 'https';
  const pathName = e.path || e.pathParameters || (e.requestContext && e.requestContext.path) || '/';
  const qs = e.queryStringParameters || {};
  return { host, proto, pathName: String(pathName), qs, headers };
}

function baseFromReq(req) {
  if (process.env.OAUTH_REDIRECT_BASE) return process.env.OAUTH_REDIRECT_BASE.replace(/\/$/, '');
  return `${req.proto}://${req.host}`;
}

// 前端把「登录成功后要回到的页面」base64url 编码后放进 OAuth state；
// callback 解码后带上 ticket 回跳，使登录不依赖固定的 ANNOTA_APP_URL。
function decodeStateUrl(state) {
  try {
    const s = String(state || '').trim();
    if (!s) return null;
    let b = s.replace(/-/g, '+').replace(/_/g, '/');
    b += '='.repeat((4 - (b.length % 4)) % 4);
    const target = new URL(Buffer.from(b, 'base64').toString('utf8'));
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
    return target;
  } catch (e) { return null; }
}

async function signTicket(customUserId) {
  const auth = getApp().auth();
  // 24h 有效 ticket；refresh 1h
  return auth.createTicket(customUserId, { refresh: 3600 * 1000, expire: 24 * 3600 * 1000 });
}

exports.main = async (event) => {
  const req = parseReq(event);
  const base = baseFromReq(req);

  try {
    // 精确路由：兼容带/不带公共前缀（如 /auth/github/...）
    const p = req.pathName;
    if (/\/auth\/github\/start\/?$/.test(p)) {
      if (!CLIENT_ID) return resp(500, {}, JSON.stringify({ error: 'GITHUB_CLIENT_ID 未配置' }));
      const redirectUri = `${base}/auth/github/callback`;
      const url = 'https://github.com/login/oauth/authorize'
        + `?client_id=${encodeURIComponent(CLIENT_ID)}`
        + `&redirect_uri=${encodeURIComponent(redirectUri)}`
        + '&scope=read:user%20user:email'
        + `&state=${encodeURIComponent(req.qs.state || '')}`;
      return redirect(url);
    }

    if (/\/auth\/github\/callback\/?$/.test(p)) {
      const code = req.qs.code;
      if (!code) return resp(400, {}, JSON.stringify({ error: '缺少 code' }));
      if (!CLIENT_ID || !CLIENT_SECRET) return resp(500, {}, JSON.stringify({ error: 'OAuth 未配置完整' }));

      // 1) code → access_token
      const tokRes = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
      });
      const tok = await tokRes.json();
      if (!tok.access_token) return resp(401, {}, JSON.stringify({ error: '换取 token 失败', detail: tok.error || '' }));

      // 2) /user → id/login/name
      const uRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Annota' },
      });
      const u = await uRes.json();
      if (!u.id) return resp(401, {}, JSON.stringify({ error: '读取用户失败' }));

      // customUserId：稳定、合规字符（字母数字 _-#@(){}[]:.,<>+#~），4–32 位
      const customUserId = `gh-${u.id}`;
      const ticket = await signTicket(customUserId);

      // 3) 回前端：优先 302 带 ticket；回跳目标 = ANNOTA_APP_URL 或 state 携带的页面
      const appUrl = process.env.ANNOTA_APP_URL || '';
      const target = appUrl ? new URL(appUrl) : decodeStateUrl(req.qs.state);
      if (target) {
        target.searchParams.set('ticket', ticket);
        target.searchParams.set('uid', customUserId);
        target.searchParams.set('name', u.login || u.name || '');
        return redirect(target.href);
      }
      return resp(200, {}, JSON.stringify({ ticket, uid: customUserId, name: u.login || u.name || '' }));
    }

    return resp(404, {}, JSON.stringify({ error: 'not found', path: p }));
  } catch (err) {
    return resp(500, {}, JSON.stringify({ error: String((err && err.message) || err) }));
  }
};
