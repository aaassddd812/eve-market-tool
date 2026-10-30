// ===== 悬浮窗页面（float.html）=====
// 只负责显示：内容由主页面（float-feed.js）经 BroadcastChannel 推过来，这里不请求任何数据。
// ?kind=kill 击杀预警 / price 到价提醒；?pip=1 在网页画中画的 iframe 里（标题栏可以切换两种内容）。
// 桌面版原生窗口（有 __TAURI_INTERNALS__ 且不是画中画）：无边框，标题栏拖动窗口，另有透明度、鼠标穿透、关闭按钮。

const q = new URLSearchParams(location.search);
const KINDS = { kill: '击杀预警', price: '到价提醒' };
let kind = KINDS[q.get('kind')] ? q.get('kind') : 'kill';
const PIP = q.get('pip') === '1';
const ipc = !PIP && window.__TAURI_INTERNALS__ ? window.__TAURI_INTERNALS__ : null;
const EN = window.I18N?.lang === 'en';
const ALPHA_KEY = 'eve-float-alpha';
const ALPHAS = [1, 0.85, 0.7, 0.55];
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const invoke = (cmd, args) => ipc?.invoke(cmd, args).catch(() => {});

const data = {};
let lastTop = {};      // kind -> 上次显示的第一条（新来的闪一下）
let gotAny = false;

const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel('eve-float') : null;
const post = (m) => { try { bc?.postMessage(m); } catch { /* 忽略 */ } };
const hello = () => post({ t: 'hello', kind });
if (bc) {
  bc.onmessage = (e) => {
    const m = e.data || {};
    if (m.t === 'ready') hello();
    else if (m.t === 'snap' && KINDS[m.kind]) { data[m.kind] = m.data; gotAny = true; if (m.kind === kind) render(); }
  };
}
// 每 20 秒报一次还开着（主页面据此决定到价提醒要不要接着查价）
setInterval(() => post({ t: 'alive', kind }), 20e3);

// 画中画里由主页面切换内容
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.t !== 'kind' || !KINDS[e.data.kind]) return;
  setKind(e.data.kind);
});
function setKind(k) {
  kind = k;
  hello();
  render();
}

// ---------- 显示 ----------
const ago = (t) => { const m = Math.floor((Date.now() - t) / 60e3); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : Math.floor(m / 60) + ' 小时前'; };
const clock = (t) => new Date(t).toLocaleTimeString(EN ? 'en-GB' : 'zh-CN', { hour12: false });

function render() {
  document.title = KINDS[kind] + ' · EVE';
  $('flTitle').textContent = KINDS[kind];
  for (const b of document.querySelectorAll('[data-fl-kind]')) b.classList.toggle('active', b.dataset.flKind === kind);
  const d = data[kind];
  const body = $('flBody'), foot = $('flFoot');
  if (!d) {
    body.innerHTML = `<p class="fl-empty">${gotAny || !bc ? '读取中…' : '等主窗口发来内容…'}</p>`;
    foot.textContent = '';
    return;
  }
  if (kind === 'kill') renderKill(d, body, foot);
  else renderPrice(d, body, foot);
}

function renderKill(d, body, foot) {
  const items = d.items || [];
  const top = items[0]?.key;
  const fresh = top && lastTop.kill !== undefined && top !== lastTop.kill;
  lastTop.kill = top;
  body.innerHTML = (d.on ? '' : '<p class="fl-warn">击杀预警没有开启：在主窗口右上角铃铛里开启</p>')
    + (items.length ? `<ul class="fl-list">${items.map((a, i) => `<li class="fl-kill${a.tone ? ' ' + a.tone : ''}${i === 0 && fresh ? ' new' : ''}${a.open ? ' click' : ''}"${a.open ? ` data-fl-kill="${a.id}"` : ''}>
        <span class="fl-badge">${esc(a.badge)}</span>
        <span class="fl-main"${EN ? ' translate="no"' : ''}>${esc(EN ? a.en : a.zh)}</span>
        <small>${a.value ? `<b translate="no">${esc(a.value)}</b> · ` : ''}${a.muted ? '<span>离线未提醒</span> · ' : ''}<span>${ago(a.at)}</span></small></li>`).join('')}</ul>`
      : '<p class="fl-empty">还没有预警</p>');
  foot.textContent = d.on ? d.status || '' : '';
}

function renderPrice(d, body, foot) {
  const items = d.items || [];
  const top = items.find((x) => !x.on)?.key || '';
  const fresh = top && lastTop.price !== undefined && top !== lastTop.price;
  lastTop.price = top;
  const gap = (g) => (g == null ? '' : Math.abs(g) < 0.0005 ? '就差一点' : `还差 ${(Math.abs(g) * 100).toFixed(1)}%`);
  body.innerHTML = items.length ? `<ul class="fl-list">${items.map((x) => `<li class="fl-price click${x.on ? '' : ' hit'}${!x.on && x.key === top && fresh ? ' new' : ''}" data-fl-item="${x.id}">
      <img src="${esc(x.icon)}" alt="" width="28" height="28" loading="lazy">
      <span class="fl-main"><span class="fl-name" translate="no">${esc(x.name)}</span>
        <small><span>${esc(x.hub)}</span> <span>${x.side === 'buy' ? '收价' : '卖价'}</span> ${x.op === 'le' ? '≤' : '≥'} <b translate="no">${esc(x.target)}</b></small></span>
      <span class="fl-val"><b translate="no">${esc(x.cur)}</b><small>${x.on ? `<span>${gap(x.gap)}</span>` : `<span>已触发</span> · <span>${ago(x.hit)}</span>`}</small></span></li>`).join('')}</ul>`
    : '<p class="fl-empty">还没有到价提醒：在主窗口「自选看板」给物品点 🔔 设置</p>';
  foot.textContent = d.at ? `价格于 ${clock(d.at)} · 每 5 分钟更新` : '读取价格中…';
}

// ---------- 交互 ----------
document.addEventListener('click', (e) => {
  const k = e.target.closest('[data-fl-kind]');
  if (k) { setKind(k.dataset.flKind); return; }
  const kill = e.target.closest('[data-fl-kill]');
  if (kill) { post({ t: 'open-kill', id: Number(kill.dataset.flKill) }); invoke('float_focus_main'); return; }
  const item = e.target.closest('[data-fl-item]');
  if (item) { post({ t: 'open-item', id: Number(item.dataset.flItem) }); invoke('float_focus_main'); return; }
  if (e.target.closest('[data-fl-close]')) { invoke('float_close'); return; }
  if (e.target.closest('[data-fl-alpha]')) { const i = ALPHAS.indexOf(alpha()); setAlpha(ALPHAS[(i + 1) % ALPHAS.length]); return; }
  if (e.target.closest('[data-fl-pass]')) setPass(true);
});

function alpha() { let a = 1; try { a = Number(localStorage.getItem(ALPHA_KEY)) || 1; } catch { /* 忽略 */ } return ALPHAS.includes(a) ? a : 1; }
function setAlpha(a) {
  try { localStorage.setItem(ALPHA_KEY, String(a)); } catch { /* 忽略 */ }
  document.documentElement.style.setProperty('--fl-alpha', a);
}
// 鼠标穿透：窗口不再接收点击；主窗口再点一次「悬浮窗」时桌面版调 __floatPass(false) 恢复
function setPass(on) {
  document.documentElement.classList.toggle('fl-passing', on);
  invoke('float_pass', { on });
}
window.__floatPass = (on) => document.documentElement.classList.toggle('fl-passing', Boolean(on));

if (ipc) {
  document.documentElement.classList.add('fl-native');
  $('flCtl').hidden = false;
  setAlpha(alpha());
  // 无边框窗口：按住标题栏空白处拖动
  $('flHead').addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    invoke('float_drag');
  });
}
if (PIP) { $('flTabs').hidden = false; $('flTitle').hidden = true; }

render();
hello();
// 几秒内没有主页面回应：提示打开主窗口
setTimeout(() => { if (!gotAny) { $('flBody').innerHTML = '<p class="fl-empty">主窗口没有打开：先打开网站，再点「悬浮窗」</p>'; } }, 4000);
// 「几分钟前」随时间更新
setInterval(() => { if (data[kind]) render(); }, 30e3);
