// ESI：多角色令牌（按服务器分开存在本机）、PKCE 登录、令牌刷新、带授权的请求（含分页）
// 登录与网站相同：用本站的 ESI 应用，CCP / 网易登录完跳到本站回调地址，用户复制地址栏粘贴回程序；
// 授权码由程序直接向 CCP 换令牌（国服经本站原样转发，与网站一致），令牌只存在本机。
import { http, store, openUrl } from './platform.js';
import { SERVER, SITE, SCOPES, serverQs } from './servers.js';

const ACC_KEY = 'lite-accounts-' + SERVER.id;
const ACTIVE_KEY = 'lite-active-' + SERVER.id;
const PKCE_KEY = 'lite-pkce';
const PKCE_TTL = 15 * 60e3;

// ---------- 账号 ----------
export const accounts = () => store.get(ACC_KEY, []).filter((a) => a?.character_id && a.refresh_token);
export function activeAccount() {
  const list = accounts();
  const id = store.get(ACTIVE_KEY, 0);
  return list.find((a) => a.character_id === id) || list[0] || null;
}
export function setActive(id) { store.set(ACTIVE_KEY, id); }
function saveAccount(acc) {
  const list = accounts();
  const i = list.findIndex((a) => a.character_id === acc.character_id);
  if (i >= 0) list[i] = acc; else list.push(acc);
  store.set(ACC_KEY, list);
}
export function removeAccount(id) {
  store.set(ACC_KEY, accounts().filter((a) => a.character_id !== id));
  if (store.get(ACTIVE_KEY, 0) === id) store.set(ACTIVE_KEY, null);
}
export const hasScope = (acc, scope) => !!acc && (acc.scopes || []).includes(scope);

// ---------- PKCE ----------
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomToken = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
function readPkce() {
  const all = store.get(PKCE_KEY, {});
  for (const k of Object.keys(all)) if (!(Date.now() - all[k].at < PKCE_TTL)) delete all[k];
  return all;
}

let cfgPromise = null;
export function ssoConfig() {
  cfgPromise ||= (async () => {
    const res = await http(SITE + '/api/esi/config' + serverQs());
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.client_id) throw new Error(data.error || '读取应用配置失败（HTTP ' + res.status + '）');
    return data;
  })().catch((e) => { cfgPromise = null; throw e; });
  return cfgPromise;
}

// 生成授权链接并用系统浏览器打开
export async function startLogin() {
  const cfg = await ssoConfig();
  const verifier = randomToken(48);
  const state = randomToken(24);
  const pending = readPkce();
  pending[state] = { verifier, at: Date.now(), server: SERVER.id };
  store.set(PKCE_KEY, pending);
  let device = {};
  if (SERVER.needDevice) {
    const res = await http(SITE + '/api/esi/sso/device' + serverQs());
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.device_id) throw new Error(d.error || '网易设备初始化失败，请稍后重试');
    device = { device_id: d.device_id };
  }
  const allowed = new Set(cfg.scopes || []);
  const authorize = SERVER.sso + '/authorize?' + new URLSearchParams({
    response_type: 'code', redirect_uri: cfg.redirect_uri, client_id: cfg.client_id,
    scope: SCOPES.filter((s) => !allowed.size || allowed.has(s)).join(' '),
    state, code_challenge: b64url(await sha256(verifier)), code_challenge_method: 'S256',
    ...SERVER.authParams, ...device
  });
  // 国服先经网易登出旧会话再回到授权页（与网站相同），避免 Missing Netease token
  const url = SERVER.id === 'tq' ? authorize
    : SERVER.sso.replace(/\/v2\/oauth$/, '') + '/account/logoff?returnUrl=' + encodeURIComponent('/v2/oauth/authorize?' + authorize.split('?')[1]);
  await openUrl(url);
  return url;
}

async function ssoToken(params) {
  const cfg = await ssoConfig();
  let res;
  try {
    res = await http(SERVER.tokenProxy ? SITE + '/api/esi/sso/token' + serverQs() : SERVER.sso + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: cfg.client_id }).toString()
    });
  } catch {
    throw new Error('无法连接 EVE 登录服务器，请检查网络后重试');
  }
  const text = await res.text();
  let data = {};
  try { data = JSON.parse(text); } catch { /* HTML 错误页 */ }
  if (!res.ok || !data.access_token) {
    const reason = data.error_description || data.error || (SERVER.id !== 'tq' && res.status === 500 ? '授权码无效或已过期，请重新登录' : text.startsWith('<') ? '授权码无效或已被使用' : 'HTTP ' + res.status);
    const err = new Error(reason);
    err.status = res.status;
    throw err;
  }
  return data;
}

function identity(accessToken) {
  const part = accessToken.split('.')[1] || '';
  const claims = JSON.parse(decodeURIComponent(escape(atob(part.replace(/-/g, '+').replace(/_/g, '/')))));
  const id = Number(String(claims.sub || '').split(':').pop());
  if (!id) throw new Error('令牌中没有角色信息');
  return { character_id: id, character_name: claims.name || '角色 ' + id, scopes: [].concat(claims.scp || []) };
}
const record = (data, base = {}) => ({ ...base, access_token: data.access_token, refresh_token: data.refresh_token || base.refresh_token, expires_at: Date.now() + (data.expires_in || 1199) * 1000 });

// 用户粘贴回来的回调地址 → 换令牌、保存角色
export async function finishLogin(raw) {
  let params;
  try { params = new URL(raw.trim()).searchParams; } catch { throw new Error('地址格式不正确，请复制浏览器地址栏的完整地址'); }
  if (params.get('error')) throw new Error('授权失败：' + params.get('error'));
  const code = params.get('code'), state = params.get('state');
  if (!code || !state) throw new Error('地址里缺少 code 或 state，请复制登录后的完整地址');
  const pending = readPkce();
  const entry = pending[state];
  if (!entry) throw new Error('授权已过期或不是本程序发起的，请重新点「添加角色」');
  if (entry.server !== SERVER.id) throw new Error('这是另一个服务器的授权，请切换服务器后重试');
  let data;
  try {
    const extra = SERVER.manualCallback ? { redirect_uri: (await ssoConfig()).redirect_uri } : {};
    data = await ssoToken({ grant_type: 'authorization_code', code, code_verifier: entry.verifier, ...extra });
  } finally {
    delete pending[state];
    store.set(PKCE_KEY, pending);
  }
  const acc = { ...record(data), ...identity(data.access_token) };
  saveAccount(acc);
  setActive(acc.character_id);
  return acc;
}

// 刷新令牌：同一角色并发请求只刷新一次（CCP 的刷新令牌用一次就换新的）
const refreshing = new Map();
async function token(acc) {
  const cur = accounts().find((a) => a.character_id === acc.character_id) || acc;
  if (Date.now() < (cur.expires_at || 0) - 60e3) return cur;
  if (!refreshing.has(cur.character_id)) {
    refreshing.set(cur.character_id, (async () => {
      try {
        const data = await ssoToken({ grant_type: 'refresh_token', refresh_token: cur.refresh_token });
        const fresh = record(data, cur);
        try { Object.assign(fresh, identity(data.access_token)); } catch { /* 保留原身份 */ }
        saveAccount(fresh);
        return fresh;
      } catch (e) {
        if (e.status >= 400 && e.status < 500) {
          removeAccount(cur.character_id);
          throw new Error(`${cur.character_name} 的登录已失效，请重新添加角色（${e.message}）`);
        }
        throw e;
      }
    })().finally(() => refreshing.delete(cur.character_id)));
  }
  return refreshing.get(cur.character_id);
}

// ---------- 请求 ----------
const url = (path, page) => SERVER.esi + path + (path.includes('?') ? '&' : '?') + 'datasource=' + SERVER.datasource + (page ? '&page=' + page : '');

async function request(path, acc, { page, method = 'GET', body } = {}) {
  const headers = { 'Accept-Language': 'zh' };
  if (acc) headers.Authorization = 'Bearer ' + (await token(acc)).access_token;
  if (body) headers['Content-Type'] = 'application/json';
  for (let attempt = 0; ; attempt++) {
    let res = null;
    try { res = await http(url(path, page), { method, headers, body: body ? JSON.stringify(body) : undefined }); } catch (e) {
      if (attempt < 2) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
      throw new Error('连不上 ESI，请检查网络（' + e.message + '）');
    }
    if (res.ok) return res;
    if ((res.status >= 500 || res.status === 420 || res.status === 429) && attempt < 2) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
    const err = new Error('ESI ' + res.status + (res.status === 403 ? '（没有这项权限，请重新添加角色授权）' : ''));
    err.status = res.status;
    throw err;
  }
}

// GET 结果缓存在内存里（按服务器 + 角色 + 路径）：切换页面时直接用，不重复请求。
// 有效期按 ESI 的 Expires 头（ESI 自己的缓存时间，位置 5 秒、钱包 2 分钟、资产 1 小时…），没有这个头时位置类 5 秒、其余 2 分钟；
// 同一个请求正在进行时共用一个。顶部「刷新」清空缓存。
const cache = new Map();
const expiry = (res, path) => {
  const exp = Date.parse(res.headers.get('Expires') || '');
  return Number.isFinite(exp) && exp > Date.now() ? exp : Date.now() + (/\/(location|ship|online)\/$/.test(path) ? 5e3 : 12e4);
};
function cached(key, load) {
  const hit = cache.get(key);
  if (hit && (hit.p || hit.exp > Date.now())) return hit.p || Promise.resolve(hit.data);
  const p = load().then(({ data, exp }) => { cache.set(key, { data, exp }); return data; }, (e) => { cache.delete(key); throw e; });
  cache.set(key, { p });
  return p;
}
export function clearEsiCache() { cache.clear(); }
const ckey = (acc, path) => SERVER.id + ':' + (acc?.character_id || 0) + ':' + path;

export const esiPublic = (path, opts) => (opts?.page ? request(path, null, opts).then((r) => r.json())
  : cached(ckey(null, path), async () => { const r = await request(path, null, opts); return { data: await r.json(), exp: expiry(r, path) }; }));
export const esiAuth = (acc, path) => cached(ckey(acc, path), async () => { const r = await request(path, acc); return { data: await r.json(), exp: expiry(r, path) }; });
export function esiPaged(acc, path, max = 30) {
  return cached(ckey(acc, path) + '#' + max, async () => {
    const first = await request(path, acc, { page: 1 });
    const pages = Math.min(Number(first.headers.get('X-Pages')) || 1, max);
    const all = [await first.json()];
    for (let p = 2; p <= pages; p++) all.push(await (await request(path, acc, { page: p })).json());
    return { data: all.flat(), exp: expiry(first, path) };
  });
}
export const esiPost = async (path, body, acc = null) => (await request(path, acc, { method: 'POST', body })).json();
