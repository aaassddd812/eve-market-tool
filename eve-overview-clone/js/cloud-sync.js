// ===== 个人中心 · 云同步 =====
// 用户名 + 密码把本站的本地设置（localStorage 里 eve- 开头的键：ESI 绑定的角色令牌、收藏、税费技能、规划、排除列表、订单账本等）存到服务器，
// 换个浏览器登录同一个账号就能取回，之后定时双向同步。多标签页协调、授权中的临时数据、各种可重新下载的缓存不同步。
// ESI 令牌：CCP 的刷新令牌用一次就换，所以刷新前先拉一次（别的浏览器可能已经刷新过，直接用它的），刷新后马上上传（pullTokens / pushSoon，
// 由 modern-app.js 的 ensureEsiToken / accountToken 调用）；两边都改了同一个令牌时取过期时间晚的，账号列表按角色逐个取晚的。
// 密码不出浏览器：PBKDF2(密码, "eve-sync:" + 用户名) 派生 512 位，前一半是登录密钥（发给服务器校验），后一半是 AES-GCM 加密密钥；
// 服务器只存密文（server/kb_service.py 的 SettingsSync），忘记密码无法找回。登录后两把密钥存在本机，不存密码。
// 合并：本机记着上次同步时每个键的哈希（shadow），本机改了的用本机、服务器改了的用服务器、两边都改了以本机为准
// （第一次登录以服务器为准，等于导入）；删除也按同样规则同步。每分钟检查本机有没有改动，每 5 分钟和回到页面时拉一次。
// 拉到别处的改动写进 localStorage 后，正在运行的页面要刷新才用上，所以弹一个「刷新」提示。

let ctx;   // showToast, esc, onApplied(改了的键)：拉到别处的改动写进本机后通知页面（如重读 ESI 令牌）
const STATE_KEY = 'eve-sync-v1';   // { user, auth, key, ver, shadow: { 键: 哈希 }, at }
const SYNC_KEY = /^(?:[a-z]+:)?eve-/;
const SKIP = /(?:^|:)eve-(?:esi-pkce|sync-|server$|kill-alert-(?:leader|ring)|hub-prices|structure-names|public-structures|dscan-types|intel-en-names|page-visits|demo-)/;
const MAX_VALUE = 512 * 1024;      // 单个值太大的多是缓存，不同步
const CHECK_MS = 60e3, PULL_MS = 5 * 60e3;
const S = { busy: null, lastPull: 0, modal: null, msg: '', pending: 0 };

const enc = new TextEncoder(), dec = new TextDecoder();
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); }
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function hash(v) { let h = 0x811c9dc5; for (let i = 0; i < v.length; i++) { h ^= v.charCodeAt(i); h = Math.imul(h, 0x01000193); } return v.length + ':' + (h >>> 0).toString(36); }
const tr = (t) => (window.I18N?.lang === 'en' && window.I18N.t ? window.I18N.t(t) : t);   // confirm 里的文字不走自动翻译
const supported = () => Boolean(window.crypto?.subtle && window.isSecureContext);

function state() { try { return JSON.parse(localStorage.getItem(STATE_KEY)) || null; } catch { return null; } }
function saveState(st) { try { if (st) localStorage.setItem(STATE_KEY, JSON.stringify(st)); else localStorage.removeItem(STATE_KEY); } catch { /* 存不了就只在这次有效 */ } }

// 本机要同步的键值
function collect() {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!SYNC_KEY.test(k) || SKIP.test(k)) continue;
      const v = localStorage.getItem(k);
      if (v != null && v.length <= MAX_VALUE) out[k] = v;
    }
  } catch { /* 读不了 */ }
  return out;
}
const hashes = (items) => Object.fromEntries(Object.entries(items).map(([k, v]) => [k, hash(v)]));
const sameHashes = (a, b) => { const ka = Object.keys(a); return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]); };

// 两边都改了的值：令牌取过期时间晚的，账号列表按角色取晚的，其他按 preferRemote
const TOKEN_KEY = /(?:^|:)eve-esi-token$/, ACCOUNTS_KEY = /(?:^|:)eve-esi-accounts$/;
const parse = (v) => { try { return JSON.parse(v); } catch { return null; } };
const exp = (t) => t?.expires_at || 0;
function resolve(k, l, r, preferRemote) {
  if (l !== undefined && r !== undefined) {
    if (TOKEN_KEY.test(k)) return exp(parse(l)) >= exp(parse(r)) ? l : r;
    if (ACCOUNTS_KEY.test(k)) {
      const a = parse(l), b = parse(r);
      if (Array.isArray(a) && Array.isArray(b)) {
        const out = new Map();
        for (const t of [...a, ...b]) if (t?.character_id && exp(t) >= exp(out.get(t.character_id))) out.set(t.character_id, t);
        return JSON.stringify([...out.values()]);
      }
    }
  }
  return preferRemote ? r : l;
}
// 三方合并：shadow 是上次同步时的哈希
function merge(local, remote, shadow, preferRemote) {
  const out = {};
  for (const k of new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(shadow)])) {
    const l = local[k], r = remote[k], s = shadow[k] ?? null;
    const lc = (l === undefined ? null : hash(l)) !== s, rc = (r === undefined ? null : hash(r)) !== s;
    const v = lc && rc ? resolve(k, l, r, preferRemote) : rc ? r : l;
    if (v !== undefined) out[k] = v;
  }
  return out;
}
// 写回本机，返回改了几项
function apply(local, merged) {
  const keys = [];
  try {
    for (const [k, v] of Object.entries(merged)) if (local[k] !== v) { localStorage.setItem(k, v); keys.push(k); }
    for (const k of Object.keys(local)) if (!(k in merged)) { localStorage.removeItem(k); keys.push(k); }
  } catch { /* 空间不够等 */ }
  if (keys.length) try { ctx.onApplied?.(keys); } catch { /* 页面自己处理 */ }
  return keys.filter((k) => !TOKEN_KEY.test(k) && !ACCOUNTS_KEY.test(k)).length;   // 令牌页面会直接换上，不算「要刷新」的改动
}

// ---------- 加密 ----------
async function derive(user, password) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('eve-sync:' + user.toLowerCase()), iterations: 200000 }, base, 512));
  return { auth: hex(bits.slice(0, 32)), key: b64(bits.slice(32)) };
}
const aesKey = (st) => crypto.subtle.importKey('raw', unb64(st.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
async function pipe(bytes, stream) { return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer()); }
async function seal(st, items) {
  let bytes = enc.encode(JSON.stringify({ v: 1, items }));
  const gz = typeof CompressionStream === 'function';
  if (gz) bytes = await pipe(bytes, new CompressionStream('gzip'));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(st), bytes));
  return `${gz ? 'g1' : 'p1'}.${b64(iv)}.${b64(ct)}`;
}
async function open(st, data) {
  if (!data) return {};
  const [kind, iv, ct] = data.split('.');
  let bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await aesKey(st), unb64(ct)));
  if (kind === 'g1') bytes = await pipe(bytes, new DecompressionStream('gzip'));
  return JSON.parse(dec.decode(bytes)).items || {};
}

async function call(op, body) {
  const r = await fetch('/api/kb/sync/' + op, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: op === 'push' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error || 'HTTP ' + r.status); e.status = r.status; throw e; }
  return d;
}

// ---------- 同步 ----------
// first：刚登录 / 注册，冲突以服务器为准；返回写回本机的项数
async function syncNow(first = false) {
  if (S.busy) return S.busy;
  S.busy = (async () => {
    let st = state();
    if (!st) return 0;
    let changed = 0;
    let res = await call('pull', { user: st.user, auth: st.auth, have: first ? -1 : st.ver });
    S.lastPull = Date.now();
    for (let tries = 0; tries < 4; tries++) {
      const local = collect();
      // res.same：服务器版本和上次一样，没回传数据，服务器上的内容就是 shadow
      const remote = res.same ? null : await open(st, res.data);
      const merged = remote ? merge(local, remote, first ? {} : st.shadow || {}, first) : local;
      changed += apply(local, merged);
      const sh = hashes(merged);
      if (sameHashes(sh, remote ? hashes(remote) : st.shadow || {})) { st = { ...st, ver: res.ver, shadow: sh, at: Date.now() }; break; }   // 不用上传
      const out = await call('push', { user: st.user, auth: st.auth, base: res.ver, data: await seal(st, merged) });
      if (!out.conflict) { st = { ...st, ver: out.ver, shadow: sh, at: Date.now() }; break; }
      res = out;   // 别处刚提交过：拿最新的再合并一次
    }
    if (state()) saveState(st);   // 同步途中退出登录就不再写回
    return changed;
  })().finally(() => { S.busy = null; });
  return S.busy;
}

// 后台同步：出错只记在窗口里，不打扰；拉到别处的改动提示刷新
async function background(force) {
  const st = state();
  if (!st || !supported() || document.hidden && !force) return;
  const localDirty = JSON.stringify(hashes(collect())) !== JSON.stringify(st.shadow || {});
  if (!localDirty && !force && Date.now() - S.lastPull < PULL_MS) return;
  try {
    const n = await syncNow();
    if (S.err) { S.msg = ''; S.err = false; }   // 只清掉之前的错误提示
    if (n) notifyReload(n);
  } catch (e) {
    S.err = true;
    S.msg = e.status === 403 ? '登录已失效：' + e.message : '同步失败：' + e.message;
    if (e.status === 403) saveState(null);
  }
  render();
}
function notifyReload(n) {
  S.pending += n;
  ctx.showToast(`已同步其他浏览器的 ${S.pending} 项设置，刷新页面后生效`, 'success', 6000);
}

export function initCloudSync(context) {
  ctx = context;
  if (!state() || S.started) return;
  S.started = true;
  setTimeout(() => background(true), 3000);
  setInterval(() => background(false), CHECK_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - S.lastPull > 30e3) background(true); else if (document.hidden) background(true); });
}
export const cloudUser = () => state()?.user || '';
// 刷新 ESI 令牌前调用：已登录云同步就先拉一次（最多等 5 秒），返回是否拉成功
export async function pullTokens() {
  if (!state() || !supported()) return false;
  try { await Promise.race([syncNow(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 5000))]); return true; } catch { return false; }
}
// 刷新令牌后调用：马上上传
export function pushSoon() { if (state() && supported()) setTimeout(() => background(true), 300); }

// ---------- 窗口 ----------
export function openCloudSync() {
  if (!S.modal) {
    const m = document.createElement('div');
    m.className = 'modal';
    m.hidden = true;
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-labelledby', 'csTitle');
    m.innerHTML = `<div class="modal-backdrop" data-cs-close></div>
      <div class="modal-content cs-modal">
        <div class="modal-header"><h3 id="csTitle">云同步</h3>
          <button class="modal-close" data-cs-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
        </div>
        <div class="modal-body" id="csBody"></div>
      </div>`;
    document.body.appendChild(m);
    m.addEventListener('click', onClick);
    m.addEventListener('submit', (e) => { e.preventDefault(); login(e.submitter?.dataset.csOp || 'login'); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !m.hidden) { e.stopImmediatePropagation(); m.hidden = true; } }, true);
    S.modal = m;
  }
  S.modal.hidden = false;
  render();
  S.modal.querySelector('input, [data-cs-sync]')?.focus();
}

function render() {
  const body = S.modal?.querySelector('#csBody');
  if (!body || S.modal.hidden) return;
  const { esc } = ctx;
  const st = state();
  const msg = S.msg ? `<p class="cs-msg${S.err ? ' down' : ''}">${esc(S.msg)}</p>` : '';
  if (!supported()) { body.innerHTML = '<p class="text-muted">需要通过 HTTPS 打开本站才能使用云同步</p>'; return; }
  if (!st) {
    body.innerHTML = `<p class="cs-intro">把本站的设置和 ESI 绑定的角色存到服务器，在别的浏览器登录同一个账号就能同步，不用重新绑定。</p>
      <form class="cs-form" autocomplete="on">
        <label><span>用户名</span><input class="pi-input" name="username" autocomplete="username" maxlength="24" required></label>
        <label><span>密码</span><input class="pi-input" type="password" name="password" autocomplete="current-password" minlength="6" required></label>
        <div class="cs-actions"><button type="submit" class="btn btn-primary" data-cs-op="login"${S.working ? ' disabled' : ''}>登录</button><button type="submit" class="btn btn-ghost" data-cs-op="register"${S.working ? ' disabled' : ''}>注册新账号</button></div>
      </form>${msg}
      <p class="cs-tip">数据用密码在本机加密后才上传，服务器看不到内容；忘记密码就找不回来了。</p>`;
    return;
  }
  const at = st.at ? new Date(st.at).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
  body.innerHTML = `<div class="cs-who"><b translate="no">${esc(st.user)}</b><span class="text-muted">上次同步 ${at}</span></div>
    <p class="cs-intro">每分钟检查一次本机有没有改动，有就上传；别的浏览器改了会自动拉下来，刷新页面后生效。</p>
    <div class="cs-actions"><button type="button" class="btn btn-primary" data-cs-sync${S.working ? ' disabled' : ''}>立即同步</button>${S.pending ? '<button type="button" class="btn btn-ghost" data-cs-reload>刷新页面</button>' : ''}<span class="toolbar-spacer"></span><button type="button" class="btn btn-ghost" data-cs-logout>退出登录</button></div>
    ${msg}
    <p class="cs-tip"><button type="button" class="link-btn" data-cs-delete>删除云端数据</button></p>`;
}

async function login(op) {
  const form = S.modal.querySelector('.cs-form');
  const user = form.username.value.trim(), password = form.password.value;
  if (!/^[A-Za-z0-9_\-.一-鿿]{2,24}$/.test(user)) { setMsg('用户名为 2–24 个字母、数字、汉字或 _ - .', true); return; }
  if (password.length < 6) { setMsg('密码至少 6 位', true); return; }
  S.working = true; setMsg(op === 'register' ? '正在注册…' : '正在登录…');
  try {
    const { auth, key } = await derive(user, password);
    await call(op === 'register' ? 'register' : 'pull', { user, auth });
    saveState({ user: user.toLowerCase(), auth, key, ver: -1, shadow: {}, at: 0 });
    const n = await syncNow(true);
    S.working = false;
    S.pending = n;
    setMsg(op === 'register' ? '注册成功，本机设置已上传' : n ? `已导入 ${n} 项设置，刷新页面后生效` : '登录成功，已同步');
    initCloudSync(ctx);
  } catch (e) {
    S.working = false;
    if (state()?.ver === -1) saveState(null);
    setMsg(e.message, true);
  }
}
function setMsg(t, err = false) { S.msg = t; S.err = err; render(); }

async function onClick(e) {
  if (e.target.closest('[data-cs-close]')) { S.modal.hidden = true; return; }
  if (e.target.closest('[data-cs-reload]')) { location.reload(); return; }
  if (e.target.closest('[data-cs-sync]')) {
    S.working = true; setMsg('正在同步…');
    try { const n = await syncNow(); S.pending += n; S.working = false; setMsg(n ? `拉到 ${n} 项改动，刷新页面后生效` : '已同步'); } catch (err) { S.working = false; setMsg('同步失败：' + err.message, true); }
    return;
  }
  if (e.target.closest('[data-cs-logout]')) { saveState(null); S.pending = 0; setMsg('已退出，本机设置保留'); return; }
  if (e.target.closest('[data-cs-delete]')) {
    const st = state();
    if (!st || !confirm(tr('删除服务器上这个账号和全部同步数据？本机设置不受影响。'))) return;
    try { await call('delete', { user: st.user, auth: st.auth }); saveState(null); setMsg('云端数据已删除'); } catch (err) { setMsg(err.message, true); }
  }
}
