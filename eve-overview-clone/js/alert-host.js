// ===== 服务器托管预警（「预警 → 微信 / 邮箱」标签页的「服务器托管」分区，由 alert-push.js 画）=====
// 网页或客户端开着时，预警都在本机检查；用户可以勾选几种预警交给击杀记录服务在后台检查（/api/kb/hosted/*，见 kb_service.py 的 Hosted），
// 网页关掉也会推送到这里设置的企业微信 / 邮箱。默认关闭，开启前必须勾选「已了解风险」。
//   能托管：击杀预警（人物关注、星域监控、按位置预警）、虫洞求救、订单被压价。本地日志、本地红名要读本机游戏日志 / 画面，不能托管。
//   授权：单独登录一次（只要勾选的预警用得到的权限），刷新令牌直接交给服务器，不存进本机账号，和浏览器里绑定的令牌互不影响。
//   设置：开启时把击杀预警 / 虫洞求救的设置和企业微信 / 邮箱账号一起交给服务器；之后网页上改了会自动同步（sync，3 秒防抖，内容没变不发）。
//   去重：托管期间，网页上同类提醒不再推送到企业微信 / 邮箱（alert-push.js 的 push 跳过 covers(src)），网页弹窗、提示音照旧。
// 本机只存 { 角色 ID, 名字, 凭证, 托管项, 权限 }（eve-alert-hosted-v1，按服务器），凭证用来查看状态、改设置、停止托管。

import { SERVER, IS_TQ, serverKey, kbSiteLink } from './server.js?v=s4';

const KEY = serverKey('eve-alert-hosted-v1');
const API = '/api/kb/hosted/';
const SRC = [['kill', '击杀预警'], ['sos', '虫洞求救'], ['order', '订单被压价']];
const SCOPE = {
  loc: 'esi-location.read_location.v1', online: 'esi-location.read_online.v1',
  orders: 'esi-markets.read_character_orders.v1', struct: 'esi-markets.structure_markets.v1'
};
const SCOPE_ZH = { [SCOPE.loc]: '角色位置', [SCOPE.online]: '在线状态', [SCOPE.orders]: '市场订单', [SCOPE.struct]: '建筑市场' };
const SRC_ZH = Object.fromEntries(SRC.map(([k, l]) => [k, l]));

let deps;   // esc, showToast, render, channels, lang；modern-app.js 给的 authLink, authFinish, killSettings, sosSettings, shipTypes
let H = null;   // 已托管：{ char, name, secret, src, scopes }
const S = { pick: new Set(['kill', 'sos', 'order']), agree: false, step: false, busy: '', status: null, error: '', synced: '' };
try { H = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { /* 忽略 */ }
if (H) S.pick = new Set(H.src);

export function initAlertHost(d) { deps = deps || d; }
const save = () => { try { if (H) localStorage.setItem(KEY, JSON.stringify(H)); else localStorage.removeItem(KEY); } catch { /* 忽略 */ } };
// 这种预警是否由服务器推送（网页上就不再推到企业微信 / 邮箱）
export const covers = (src) => Boolean(H?.src.includes(src));
export const isHosted = () => Boolean(H);

async function post(op, body) {
  const res = await fetch(API + op, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ server: SERVER.id, ...body }) });
  let d = null;
  try { d = await res.json(); } catch { /* 下面报错 */ }
  if (!res.ok || !d || d.error) {
    const e = new Error(d?.error || (res.status === 404 ? '服务器托管暂不可用' : 'HTTP ' + res.status));
    e.status = res.status;
    throw e;
  }
  return d;
}
const auth = () => ({ character_id: H.char, secret: H.secret });

// 勾选的预警要哪些权限：在线状态总是要（「角色离线时不提醒」用，也让授权至少有一项权限）
async function scopesFor(src) {
  const out = [SCOPE.online];
  if (src.includes('kill') && (await deps.killSettings()).on) out.push(SCOPE.loc);
  if (src.includes('order')) out.push(SCOPE.orders, SCOPE.struct);
  return out;
}

// 交给服务器的设置：渠道账号 + 击杀预警 / 虫洞求救的设置（舰船类别换成舰船 ID 列表，服务器没有市场分类）
async function settings(src) {
  const { P, ready } = deps.channels();
  const use = (ch) => src.filter((s) => P[ch].use[s]);
  const k = src.includes('kill') ? await deps.killSettings() : {};
  return {
    src, lang: deps.lang(),
    wecom: ready('wecom') ? { key: P.wecom.key, use: use('wecom') } : null,
    mail: ready('mail') ? { user: P.mail.user, password: P.mail.pass, to: P.mail.to || P.mail.user, host: P.mail.host, port: Number(P.mail.port), security: P.mail.security, use: use('mail') } : null,
    kill: src.includes('kill') ? {
      on: Boolean(k.on), jumps: k.jumps, pods: k.pods, minValue: k.minValue, maxAge: k.maxAge, offlineMute: k.offlineMute,
      ships: (k.classes || []).length ? deps.shipTypes(k.classes) : [],
      watchOn: Boolean(k.watchOn), watch: (k.watch || []).map((e) => ({ id: e.id, kind: e.kind, mode: e.mode, name: e.name })),
      regionOn: Boolean(k.regionOn), regions: (k.regions || []).map((r) => ({ id: r.id, name: r.name }))
    } : null,
    sos: src.includes('sos') ? { rewardOnly: Boolean((await deps.sosSettings()).rewardOnly) } : null,
    site: location.origin + location.pathname,
    killUrl: IS_TQ ? 'https://zkillboard.com/kill/{id}/' : kbSiteLink('kill', '{id}') || ''
  };
}

async function run(k, fn) {
  S.busy = k;
  S.error = '';
  deps.render();
  try { await fn(); } catch (error) {
    S.error = error.message;
    // 服务器上已经没有这个托管（在别的浏览器重新开启 / 停止了）：本机也清掉
    if (error.status === 403 && H) { H = null; save(); S.status = null; }
  }
  S.busy = '';
  deps.render();
}

async function startAuth() {
  const src = [...S.pick];
  const { ready } = deps.channels();
  if (!ready('wecom') && !ready('mail')) { deps.showToast('先在上面设置企业微信或邮箱', 'error'); return; }
  if (!src.length) { deps.showToast('至少选一种要托管的预警', 'error'); return; }
  await run('auth', async () => {
    const url = await deps.authLink(await scopesFor(src));
    window.open(url, '_blank', 'noopener');
    S.step = true;
  });
}

async function finishAuth(raw) {
  if (!raw) { deps.showToast('请粘贴登录后的完整地址', 'error'); return; }
  const src = [...S.pick];
  await run('finish', async () => {
    const tok = await deps.authFinish(raw);
    const d = await post('start', { client_id: tok.client_id, refresh_token: tok.refresh_token, settings: await settings(src) });
    H = { char: d.character_id, name: d.name, secret: d.secret, src, scopes: d.scopes };
    save();
    S.step = false;
    S.need = null;
    S.synced = JSON.stringify(await settings(src));
    deps.showToast(`已开启服务器托管：${d.name}`, 'success', 5000);
    loadStatus();
  });
}

async function loadStatus() {
  if (!H) return;
  try { S.status = await post('status', auth()); S.error = ''; } catch (error) {
    S.error = error.message;
    if (error.status === 403) { H = null; save(); S.status = null; }
  }
  deps.render();
}

// 设置变了就同步（防抖；内容没变不发）
let syncTimer = 0;
export function sync() {
  if (!H) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    if (!H) return;
    try {
      const s = await settings(H.src);
      const text = JSON.stringify(s);
      if (text === S.synced) return;
      await post('update', { ...auth(), settings: s });
      S.synced = text;
    } catch (error) {
      S.error = '同步设置失败：' + error.message;
      deps.render();
    }
  }, 3000);
}

// 改托管项：缺权限时要重新授权
async function changeSrc(src, on) {
  const next = SRC.map(([k]) => k).filter((k) => (k === src ? on : H.src.includes(k)));
  if (!next.length) { deps.showToast('至少留一种，不想托管了就关掉上面的开关', 'error'); return; }
  const need = (await scopesFor(next)).filter((x) => !H.scopes.includes(x));
  if (need.length) {
    S.pick = new Set(next);
    S.need = need;
    deps.render();
    return;
  }
  await run('src', async () => {
    const s = await settings(next);
    await post('update', { ...auth(), settings: s });
    H.src = next;
    save();
    S.synced = JSON.stringify(s);
    loadStatus();
  });
}

async function stop() {
  if (!confirm('停止托管并删除服务器上保存的授权、推送账号和设置？')) { deps.render(); return; }
  await run('stop', async () => {
    try { await post('stop', auth()); } catch (error) { if (error.status !== 403) throw error; }
    H = null;
    save();
    S.status = null;
    S.step = false;
    S.need = null;
    deps.showToast('已停止托管，服务器上的数据已删除', 'success');
  });
}

// ---------- 画面 ----------
const time = (t) => (t ? new Date(t * 1000).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—');
const busy = (k) => (S.busy === k ? ' disabled' : '');

function authStep(esc, cancel = false) {
  return `<div class="ka-opt ka-stack ap-form">
      <p class="ka-note">在新打开的页面登录要托管的角色，登录后把浏览器地址栏的完整地址复制到这里${IS_TQ ? '' : '（网易页面显示授权完成后复制它的地址）'}</p>
      <div class="ka-watch-add"><input type="text" class="cr-input" data-ah-cb data-ap-in="ahcb" placeholder="登录后的完整地址" autocomplete="off" spellcheck="false" aria-label="登录后的地址">
        <button class="btn btn-primary btn-sm" data-ah-finish${busy('finish')}>${S.busy === 'finish' ? '开启中…' : '完成'}</button>
${cancel ? '<button class="btn btn-ghost btn-sm" data-ah-cancel>取消</button>' : ''}</div></div>`;
}

const RISKS = [
  '服务器会保存：这个角色的 ESI 授权（只含勾选的预警用得到的权限）、上面设置的企业微信机器人地址、邮箱账号和授权码。',
  '这些信息加密保存，数据库单独泄露时读不出来；但服务器本身被攻破时仍可能泄露：别人可以读到你的位置和订单，用你的邮箱发信、往你的群里发消息。',
  '授权都是只读的，不能转账、交易或改游戏设置。',
  '随时可以关掉托管开关，服务器上的数据立即删除；也可以在 CCP 的第三方应用授权页撤销授权。',
  '托管期间，网页上同类提醒不再重复推送到企业微信 / 邮箱（网页弹窗、提示音照旧）；网页上改了预警设置会自动同步给服务器。'
];

export function html() {
  if (!deps?.authLink) return '';
  const esc = deps.esc;
  const err = S.error ? `<p class="ka-warn">${esc(S.error)}</p>` : '';
  const head = '<h4 class="ka-h">服务器托管<small>网页关掉也提醒</small></h4>';
  if (!H) {
    const rows = SRC.map(([k, l]) => `<label class="ka-opt"><span><b>${l}</b></span><input type="checkbox" class="ka-switch" data-ah-pick="${k}"${S.pick.has(k) ? ' checked' : ''}></label>`).join('');
    return `<section class="ka-sec">${head}
      <p class="ka-note">默认关闭：网页或客户端开着时，预警都在你自己的电脑上检查。勾选的预警交给本站服务器后台检查，网页关掉也会推送到上面设置的企业微信 / 邮箱。</p>
      <div class="ka-list">${rows}</div>
      <div class="ap-help"><b>开启前请了解风险</b><ul>${RISKS.map((x) => `<li>${x}</li>`).join('')}</ul></div>
      <label class="ka-opt"><span><b>我已了解上述风险，同意由服务器保存这些信息</b></span><input type="checkbox" class="ka-switch" data-ah-agree${S.agree ? ' checked' : ''}></label>
      <label class="ka-opt"><span><b>开启服务器托管</b><small>${S.step ? '等待登录授权' : S.agree ? '打开后单独登录授权一次' : '先勾选上面的「我已了解」'}</small></span>
        <input type="checkbox" class="ka-switch" data-ah-toggle${S.step ? ' checked' : ''}${(S.agree && S.pick.size) || S.step ? '' : ' disabled'}${S.busy ? ' disabled' : ''}></label>
      ${S.step ? authStep(esc) : ''}
      ${err}</section>`;
  }
  const st = S.status;
  const checked = (k) => st?.checked?.[k];
  const line = ([k, l]) => {
    const on = H.src.includes(k);
    const e = st?.errors?.[k === 'kill' ? 'loc' : k] || (k === 'kill' && st?.errors?.online) || '';
    const extra = k === 'kill' && st?.system ? ` · 角色在 ${esc(st.system)}${st.online === false ? '（离线）' : ''}` : '';
    return `<label class="ka-opt"><span><b>${l}</b><small>${on ? (e ? '出错：' + esc(e) : checked(k) ? `上次检查 ${time(checked(k))}${extra}` : '等待第一次检查') : '未托管'}</small></span>
      <input type="checkbox" class="ka-switch" data-ah-src="${k}"${on ? ' checked' : ''}${S.busy ? ' disabled' : ''}></label>`;
  };
  const pushErr = ['wecom', 'mail'].map((ch) => st?.errors?.['push_' + ch] ? `<p class="ka-warn">${ch === 'wecom' ? '企业微信' : '邮箱'}推送失败：${esc(st.errors['push_' + ch])}</p>` : '').join('');
  const sent = st?.sent?.length ? `<div class="ap-help"><b>最近推送</b><ul>${st.sent.slice(0, 5).map(([t, s, text]) => `<li>${time(t)} · ${SRC_ZH[s] || s} · ${esc(text)}</li>`).join('')}</ul></div>` : '';
  const need = S.need?.length ? `<p class="ka-warn">新加的预警需要${S.need.map((x) => SCOPE_ZH[x] || x).join('、')}权限，要重新授权一次</p>
    ${S.step ? authStep(esc, true) : `<div class="ka-actions"><button class="btn btn-primary btn-sm" data-ah-auth${busy('auth')}>重新授权</button><button class="btn btn-ghost btn-sm" data-ah-cancel>取消</button></div>`}` : '';
  const dead = st?.token_error ? `<p class="ka-warn">${esc(st.token_error)}</p>${S.step ? authStep(esc, true) : `<div class="ka-actions"><button class="btn btn-primary btn-sm" data-ah-auth${busy('auth')}>重新授权</button></div>`}` : '';
  return `<section class="ka-sec">${head}
    <div class="ka-list"><div class="ka-opt"><span><b>${esc(H.name)}</b><small>托管中 · ${H.src.map((s) => SRC_ZH[s]).join('、')}</small></span>
      <span class="ka-chips"><button class="btn btn-ghost btn-sm" data-ah-refresh${busy('refresh')}>刷新</button>
        <input type="checkbox" class="ka-switch" data-ah-toggle checked${S.busy ? ' disabled' : ''} title="关闭 = 停止托管并删除服务器上的数据" aria-label="服务器托管"></span></div>
      ${SRC.map(line).join('')}</div>
    ${dead}${need}${pushErr}${sent}${err}</section>`;
}

// 面板事件（alert-push.js 的面板容器转过来）；处理了返回 true
export function onClick(t) {
  const el = t.closest('[data-ah-auth], [data-ah-finish], [data-ah-cancel], [data-ah-refresh]');
  if (!el) return false;
  if (el.dataset.ahAuth != null) startAuth();
  else if (el.dataset.ahFinish != null) finishAuth(el.closest('.ap-form')?.querySelector('[data-ah-cb]')?.value.trim());
  else if (el.dataset.ahCancel != null) { S.step = false; S.need = null; if (H) S.pick = new Set(H.src); deps.render(); }
  else run('refresh', loadStatus);
  return true;
}
export function onChange(t) {
  if (t.matches('[data-ah-pick]')) { if (t.checked) S.pick.add(t.dataset.ahPick); else S.pick.delete(t.dataset.ahPick); deps.render(); return true; }
  if (t.matches('[data-ah-agree]')) { S.agree = t.checked; deps.render(); return true; }
  // 总开关：打开 = 去授权（粘贴登录地址后才真正开启），关上 = 取消授权 / 停止托管
  if (t.matches('[data-ah-toggle]')) {
    if (t.checked) startAuth();
    else if (H && !S.need && !S.step) stop();
    else { S.step = false; S.need = null; if (H) S.pick = new Set(H.src); deps.render(); }
    return true;
  }
  if (t.matches('[data-ah-src]')) { changeSrc(t.dataset.ahSrc, t.checked); return true; }
  return false;
}
export function onEnter(t) {
  if (!t.matches('[data-ah-cb]')) return false;
  finishAuth(t.value.trim());
  return true;
}
// 打开面板时读一次状态
export function shown() { if (H && !S.busy) loadStatus(); }
