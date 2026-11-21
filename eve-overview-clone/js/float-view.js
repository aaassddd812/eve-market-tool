// ===== 悬浮窗页面（float.html）=====
// 只负责显示：内容由主页面（float-feed.js）经 BroadcastChannel 推过来，这里不请求任何数据。
// ?kind=kill 击杀预警 / price 到价提醒 / local 本地红名 / intel 日志预警 / chat 频道翻译；?pip=1 在网页画中画的 iframe 里（标题栏可以切换内容）。
// 桌面版原生窗口（有 __TAURI_INTERNALS__ 且不是画中画）：无边框，标题栏拖动窗口，另有透明度、鼠标穿透、关闭按钮；和画中画一样顶部可以切换内容。
// 标签栏：拖动标签调整顺序；桌面版 1.0.16+（壳在地址里带 win=）还能把标签拖到窗口外面单独成一个悬浮窗、拖到别的悬浮窗上合并，
//   哪个内容在哪个窗口记在 localStorage（eve-float-layout-v1，主页面 float-feed.js 按它决定开哪个窗口），各窗口经 BroadcastChannel 同步。
// 大小：桌面版拖边框 / 角改大小（无边框窗口，调 plugin:window|start_resize_dragging）；Ctrl + 滚轮、Ctrl + = / - / 0 或放大镜按钮缩放内容，每个窗口各记各的。
// 点击击杀 / 物品 / 本地里的人：在悬浮窗这边看详情（float-detail.html）——桌面版点了才开一个置顶小窗、关掉就关了（float_detail 命令，旧版没有就叠在本窗口里），网页画中画叠在本窗口里。

const q = new URLSearchParams(location.search);
const KINDS = { kill: '击杀预警', price: '到价提醒', local: '本地红名', intel: '日志预警', chat: '频道翻译' };
let kind = KINDS[q.get('kind')] ? q.get('kind') : 'kill';
const PIP = q.get('pip') === '1';
const ipc = !PIP && window.__TAURI_INTERNALS__ ? window.__TAURI_INTERNALS__ : null;
// 这个窗口的标签（float 主悬浮窗，float-w1… 拆出来的）；壳没带 win 就是旧版桌面版，不能拆分
const SPLIT = Boolean(ipc) && q.has('win');
const WIN = SPLIT && /^float-w\d{1,3}$/.test(q.get('win')) ? q.get('win') : 'float';
const EN = window.I18N?.lang === 'en';
const ALPHA_KEY = 'eve-float-alpha';
const ALPHAS = [1, 0.85, 0.7, 0.55];
const ZOOM_KEY = 'eve-float-zoom-' + WIN;
const ZOOMS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.6];
const LAYOUT_KEY = 'eve-float-layout-v1';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const invoke = (cmd, args) => ipc?.invoke(cmd, args).catch(() => {});

const data = {};
const expanded = new Set();   // 手动展开了历史的预警（最新一条默认展开）
const collapsed = new Set();  // 手动收起的
let lastTop = {};      // kind -> 上次显示的第一条（新来的闪一下）
let gotAny = false;
// 别的悬浮窗（桌面版每种内容可以各开一个窗口）正在显示什么：窗口 id -> { kind, at }
const others = new Map();
const ME = Math.random();

const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel('eve-float') : null;
const post = (m) => { try { bc?.postMessage(m); } catch { /* 忽略 */ } };
const hello = () => post({ t: 'hello', kind, id: ME });
if (bc) {
  bc.onmessage = (e) => {
    const m = e.data || {};
    if (m.t === 'ready') hello();
    else if (m.t === 'snap' && KINDS[m.kind]) { data[m.kind] = m.data; gotAny = true; if (m.kind === kind) render(); }
    else if ((m.t === 'hello' || m.t === 'alive') && KINDS[m.kind] && m.id) others.set(m.id, { kind: m.kind, at: Date.now() });
    else if (m.t === 'alert' && KINDS[m.kind]) onAlert(m.kind);
    else if (m.t === 'layout' && m.layout) { layout = cleanLayout(m.layout); applyLayout(); if (m.show?.win === WIN && KINDS[m.show.kind]) setKind(m.show.kind); }
    else if (m.t === 'tab-drop' && SPLIT && m.from !== WIN && hits(m.sx, m.sy)) post({ t: 'tab-hit', rid: m.rid, win: WIN });
    else if (m.t === 'tab-hit' && pending && m.rid === pending.rid && !pending.hit) pending.hit = m.win;
  };
}
// 每 20 秒报一次还开着（主页面据此决定到价提醒要不要接着查价）
setInterval(() => post({ t: 'alive', kind, id: ME }), 20e3);

// 画中画里由主页面切换内容
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || e.data?.t !== 'kind' || !KINDS[e.data.kind]) return;
  setKind(e.data.kind);
});
// 有新提醒：切到那个菜单（有切换栏时）。别的悬浮窗已经在显示它就不切；几个悬浮窗同时收到时错开一点，先切的报到后别的就不切了
function onAlert(k) {
  if (!(PIP || ipc) || k === kind || !mine().includes(k)) return;
  const shown = () => [...others.values()].some((o) => o.kind === k && Date.now() - o.at < 25e3);
  setTimeout(() => { if (k !== kind && !shown()) setKind(k); }, Math.round(ME * 150));
}
function setKind(k) {
  // 主页面要看的内容在别的窗口里（或旧版壳）：挪到这个窗口
  if (SPLIT && winOf(k) !== WIN) moveKind(k, WIN);
  kind = k;
  hello();
  render();
}

// ---------- 显示 ----------
const ago = (t) => { const m = Math.floor((Date.now() - t) / 60e3); return m < 1 ? '刚刚' : m < 60 ? m + ' 分钟前' : m < 2880 ? Math.floor(m / 60) + ' 小时前' : Math.floor(m / 1440) + ' 天前'; };
const clock = (t) => new Date(t).toLocaleTimeString(EN ? 'en-GB' : 'zh-CN', { hour12: false });

function render() {
  document.title = KINDS[kind] + ' · EVE';
  $('flTitle').textContent = KINDS[kind];
  renderTabs();
  for (const b of document.querySelectorAll('[data-fl-kind]')) {
    b.classList.toggle('active', b.dataset.flKind === kind);
    if (b.dataset.flKind === kind && b.offsetParent) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });   // 窄窗口里标签栏放不下时滚到当前标签
  }
  const d = data[kind];
  const body = $('flBody'), foot = $('flFoot');
  if (!d) {
    body.innerHTML = `<p class="fl-empty">${gotAny || !bc ? '读取中…' : '等主窗口发来内容…'}</p>`;
    foot.textContent = '';
    return;
  }
  if (kind === 'kill') renderKill(d, body, foot);
  else if (kind === 'local') renderLocal(d, body, foot);
  else if (kind === 'intel') renderIntel(d, body, foot);
  else if (kind === 'chat') renderChat(d, body, foot);
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
        <small>${a.value ? `<b translate="no">${esc(a.value)}</b> · ` : ''}${a.muted ? '<span>离线未提醒</span> · ' : ''}<span>${ago(a.at)}</span></small>
        ${histHtml(a, i === 0)}</li>`).join('')}</ul>`
      : '<p class="fl-empty">还没有预警</p>');
  foot.textContent = d.on ? d.status || '' : '';
}

// 受害者近 30 天历史：统计一行 + 最近 5 条击杀 / 损失（点击在主窗口打开）
function histHtml(a, first) {
  const h = a.hist;
  if (!h) return '';
  const open = expanded.has(a.key) || (first && !collapsed.has(a.key));
  const sum = `<span class="fl-hist-who" translate="no">${esc(a.who)}</span> <span>近 30 天</span>
    <span class="fl-k"><span>击杀</span> ${h.kills}</span><small translate="no">${esc(h.destroyed)}</small>
    <span class="fl-l"><span>损失</span> ${h.losses}</span><small translate="no">${esc(h.lost)}</small>`;
  const ships = h.ships.length ? `<div class="fl-hist-ships"><span>常开</span> ${h.ships.map(([n, c]) => `<span class="fl-chip"><span translate="no">${esc(n)}</span> ×${c}</span>`).join('')}</div>` : '';
  const rows = h.recent.length ? `<ul class="fl-hist-list">${h.recent.map((r) => `<li${r.id ? ` class="click" data-fl-kill="${r.id}"` : ''}>
      <span class="fl-tag ${r.loss ? 'l' : 'k'}">${r.loss ? '损失' : '击杀'}</span>
      <span class="fl-hist-main"><span translate="no">${esc(r.ship)}</span>${r.other ? `<small> · <span>${r.loss ? '击杀者' : '受害者'}</span> <span translate="no">${esc(r.other)}</span></small>` : ''}</span>
      <small class="fl-hist-meta"><span translate="no">${esc(r.system)}</span>${r.value ? ` · <b translate="no">${esc(r.value)}</b>` : ''} · <span>${ago(r.at)}</span></small></li>`).join('')}</ul>` : '<p class="fl-hist-none">近期没有其他记录</p>';
  return `<div class="fl-hist${open ? ' open' : ''}">
    <button type="button" class="fl-hist-sum" data-fl-exp="${esc(a.key)}" aria-expanded="${open}">${sum}<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
    ${open ? ships + rows : ''}</div>`;
}

// 本地名单：红 / 橙在前；每人一行所属与近 30 天击杀记录，新进本地的闪一下（点击在主窗口打开人物页）
const CLS = { red: '红', orange: '橙', none: '白', friend: '友', pending: '…' };
function renderLocal(d, body, foot) {
  const items = d.items || [];
  const flashed = lastTop.local || (lastTop.local = new Set());
  body.innerHTML = (d.locked ? '<p class="fl-warn">国服桌面版不能用本地红名</p>' : d.on ? '' : '<p class="fl-warn">本地红名没有开启：在主窗口右上角铃铛「本地红名」里点「开始」</p>')
    + (d.on && d.clipped ? '<p class="fl-warn">有名字显示不全：把游戏里本地频道的成员列表拉宽一点</p>' : '')
    + (items.length ? `<ul class="fl-list">${items.map((p) => {
      const isNew = p.fresh && (p.cls === 'red' || p.cls === 'orange') && !flashed.has(p.key);
      if (isNew) flashed.add(p.key);
      return `<li class="fl-local ${p.cls}${isNew ? ' new' : ''}${p.id ? ' click' : ''}"${p.id ? ` data-fl-char="${p.id}"` : ''}>
        <span class="fl-dot ${p.cls}" title="${CLS[p.cls] || ''}"></span>
        <span class="fl-main"><b>${p.name ? `<span translate="no">${esc(p.name)}</span>` : `<span>${p.look === 'ocr' ? '识别中…' : '没认出来'}</span>`}</b>${p.name && !p.sure ? '<small class="fl-q" title="名字显示不全，没认出来">…?</small>' : ''}${p.org ? ` <small translate="no">${esc(p.org)}</small>` : ''}</span>
        ${p.st ? `<small class="fl-local-st"><span class="fl-k"><span>击杀</span> ${p.st.kills}</span> · <span class="fl-l"><span>损失</span> ${p.st.losses}</span>${p.st.ships.length ? ` · <span translate="no">${esc(p.st.ships.join(' / '))}</span>` : ''}</small>` : ''}</li>`;
    }).join('')}</ul>`
      : d.colorOnly || d.moreRed || d.moreWhite ? '' : `<p class="fl-empty">${!d.on ? '还没有名单' : d.hidden ? '本地没有红名 / 白名' : '还没有识别到名单'}</p>`)
    + (d.on ? countHtml(d, items.length) : '');
  foot.textContent = d.on ? (d.status || '') + (d.hidden ? ` · 另有 ${d.hidden} 人不是敌对或还在确认` : '') : '';
}

// 人数：只看色块时写红名、白名各几个；识别名字时写列表之外还有几个（颜色确认了、名字没认全）
function countHtml(d, listed) {
  const part = (n, cls, word) => (n ? `<span class="fl-n ${cls}"><b>${n}</b> <span>${word}</span></span>` : '');
  if (d.colorOnly) return `<p class="fl-count">${d.reds || d.whites ? `<span>本地</span> ${part(d.reds, 'r', '个红名')}${part(d.whites, 'w', '个白名')}` : '<span>本地没有红名 / 白名</span>'}</p>`;
  if (!d.moreRed && !d.moreWhite) return '';
  return `<p class="fl-count"><span>${listed ? '还有' : '本地有'}</span> ${part(d.moreRed, 'r', '个红名')}${part(d.moreWhite, 'w', '个白名')}<small>名字没认全</small></p>`;
}

// 日志预警：敌情（星系、跳数）、关键词、游戏日志；点敌情在主窗口星图里看
function renderIntel(d, body, foot) {
  const items = d.items || [];
  const top = items[0]?.key;
  const fresh = top && lastTop.intel !== undefined && top !== lastTop.intel;
  lastTop.intel = top;
  const badge = (r) => (r.type !== 'intel' ? `<span>${r.type === 'kw' ? '关键词' : '日志'}</span>` : r.clear ? '<span>平安</span>' : r.jumps == null ? '<span>敌情</span>' : r.jumps === 0 ? '<span>本星系</span>' : `${r.jumps} <span>跳</span>`);
  const tone = (r) => (r.type === 'intel' ? (r.clear ? ' kill' : r.jumps != null && r.jumps <= 1 ? ' near' : r.alert ? ' warn' : '') : ' warn');
  body.innerHTML = (d.locked ? '<p class="fl-warn">国服桌面版不读取本地日志</p>' : d.idle ? '<p class="fl-warn">本地日志还没开始读取：在主窗口右上角铃铛「本地日志」里点「开始读取」</p>' : d.on ? '' : '<p class="fl-warn">本地日志监听没有开启：在主窗口右上角铃铛「本地日志」里开启</p>')
    + (items.length ? `<ul class="fl-list">${items.map((r, i) => `<li class="fl-kill${tone(r)}${i === 0 && fresh ? ' new' : ''}${r.system ? ' click' : ''}"${r.system ? ` data-fl-sys="${r.system}"` : ''}>
        <span class="fl-badge">${badge(r)}</span>
        <span class="fl-main">${r.system ? `<b translate="no">${esc(r.name)}</b> ` : r.kw ? `<b translate="no">${esc(r.kw)}</b> ` : ''}${r.who ? `<span translate="no">${esc(r.who)}</span>${EN ? ': ' : '：'}` : ''}<span translate="no">${esc(r.msg)}</span></span>
        <small><span translate="no">${esc(r.channel)}</span> · <span>${ago(r.at)}</span></small></li>`).join('')}</ul>`
      : '<p class="fl-empty">还没有消息</p>');
  foot.textContent = d.status || '';
}

// 频道翻译：译文在上、原文在下
function renderChat(d, body, foot) {
  const items = d.items || [];
  const top = items[0]?.key;
  const fresh = top && lastTop.chat !== undefined && top !== lastTop.chat;
  lastTop.chat = top;
  const warn = d.need === 'locked' ? '国服桌面版不读取本地日志' : d.need === 'off' ? '频道翻译没有开启：在主窗口右上角铃铛「本地日志」里开启'
    : d.need === 'log' ? '本地日志监听没有开启：在主窗口右上角铃铛「本地日志」里开启' : d.need === 'start' ? '本地日志还没开始读取：在主窗口右上角铃铛「本地日志」里点「开始读取」' : '';
  body.innerHTML = (warn ? `<p class="fl-warn">${warn}</p>` : '')
    + (items.length ? `<ul class="fl-list">${items.map((m, i) => `<li class="fl-chat${i === 0 && fresh ? ' new' : ''}">
        <div class="fl-chat-head"><b translate="no">${esc(m.who)}</b><small><span translate="no">${esc(m.channel)}</span>${m.lang ? ` · <span translate="no">${esc(m.lang)}</span>` : ''} · ${clock(m.at)}</small></div>
        <div class="fl-chat-text" translate="no">${esc(m.text)}</div>
        <div class="fl-chat-src" translate="no">${esc(m.msg)}</div></li>`).join('')}</ul>`
      : `<p class="fl-empty">${d.on ? '还没有需要翻译的消息' : '还没有翻译'}</p>`);
  foot.textContent = d.status || '';
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

// ---------- 标签：顺序、分到哪个窗口 ----------
function cleanLayout(l) {
  const order = Array.isArray(l?.order) ? l.order.filter((k, i, a) => KINDS[k] && a.indexOf(k) === i) : [];
  for (const k of Object.keys(KINDS)) if (!order.includes(k)) order.push(k);
  const wins = {};
  for (const k of order) if (/^float-w\d{1,3}$/.test(l?.wins?.[k] || '')) wins[k] = l.wins[k];
  return { order, wins };
}
function readLayout() { try { return cleanLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null')); } catch { return cleanLayout(null); } }
let layout = readLayout();
const winOf = (k) => (SPLIT && layout.wins[k]) || 'float';
const mine = () => layout.order.filter((k) => winOf(k) === WIN);
function saveLayout(show) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* 忽略 */ }
  post({ t: 'layout', layout, show });
  applyLayout();
}
function moveKind(k, win) {
  if (win === 'float') delete layout.wins[k];
  else layout.wins[k] = win;
  saveLayout();
}
// 布局变了：当前内容不在这个窗口了就换一个，窗口空了就关掉
function applyLayout() {
  const m = mine();
  if (!m.length) { invoke('float_close'); return; }
  if (!m.includes(kind)) setKind(m[0]);
  else renderTabs();
}
function renderTabs() {
  const box = $('flTabs');
  const m = mine();
  const html = m.map((k) => `<button type="button" data-fl-kind="${k}"${k === kind ? ' class="active"' : ''} title="${SPLIT ? '拖动调整顺序；拖到窗口外面单独成一个悬浮窗，拖到别的悬浮窗上合并' : '拖动调整顺序'}">${KINDS[k]}</button>`).join('');
  if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
}
// 屏幕上这一点在不在本窗口里
const hits = (x, y) => x >= window.screenX && x < window.screenX + window.outerWidth && y >= window.screenY && y < window.screenY + window.outerHeight;

let drag = null;      // 正在拖的标签
let pending = null;   // 拖出窗口后等别的悬浮窗回应
let noClick = false;  // 拖完松手时不算点击
$('flTabs').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('[data-fl-kind]');
  if (!b || e.button !== 0 || pending) return;
  drag = { kind: b.dataset.flKind, x: e.clientX, y: e.clientY, on: false };
  b.setPointerCapture(e.pointerId);
});
$('flTabs').addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.on && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
  drag.on = true;
  const out = !inView(e);
  const at = out ? null : dropAt(e);
  document.documentElement.classList.add('fl-dragging');
  for (const b of $('flTabs').children) {
    b.classList.toggle('dragging', b.dataset.flKind === drag.kind);
    b.classList.toggle('drop-at', b === at?.btn);
  }
  dragTip(out ? (SPLIT ? '松开：单独成一个悬浮窗（拖到别的悬浮窗上就合并过去）' : '桌面版可以把标签拖出来单独成窗') : '');
});
const endDrag = (e) => {
  const d = drag;
  drag = null;
  document.documentElement.classList.remove('fl-dragging');
  for (const b of $('flTabs').children) b.classList.remove('dragging', 'drop-at');
  dragTip('');
  if (!d?.on || e.type === 'pointercancel') return;
  noClick = true;
  setTimeout(() => { noClick = false; }, 0);
  if (inView(e)) {
    const at = dropAt(e);
    if (!at || at.kind === d.kind) return;
    const o = layout.order.filter((k) => k !== d.kind);
    o.splice(o.indexOf(at.kind) + (at.after ? 1 : 0), 0, d.kind);
    layout.order = o;
    saveLayout();
  } else if (SPLIT) dropOut(d.kind, e.screenX, e.screenY);
};
$('flTabs').addEventListener('pointerup', endDrag);
$('flTabs').addEventListener('pointercancel', endDrag);
const inView = (e) => e.clientX >= 0 && e.clientY >= 0 && e.clientX < window.innerWidth && e.clientY < window.innerHeight;
// 松手处对着哪个标签（左半边插到它前面，右半边插到后面）
function dropAt(e) {
  const r0 = $('flTabs').getBoundingClientRect();
  if (e.clientY < r0.top - 8 || e.clientY > r0.bottom + 8) return null;
  let best = null;
  for (const btn of $('flTabs').children) {
    const r = btn.getBoundingClientRect();
    const dist = Math.abs(e.clientX - (r.left + r.width / 2)) + Math.abs(e.clientY - (r.top + r.height / 2)) * 3;
    if (!best || dist < best.dist) best = { btn, kind: btn.dataset.flKind, after: e.clientX > r.left + r.width / 2, dist };
  }
  return best;
}
function dragTip(text) {
  let t = document.querySelector('.fl-drag-tip');
  if (!text) { t?.remove(); return; }
  if (!t) { t = document.createElement('div'); t.className = 'fl-drag-tip'; document.body.append(t); }
  if (t.textContent !== text) t.textContent = text;
}
// 拖到窗口外面松手：落在别的悬浮窗上就合并过去，否则在松手的地方开一个新悬浮窗
function dropOut(k, sx, sy) {
  const rid = Math.random();
  pending = { rid, hit: null };
  post({ t: 'tab-drop', rid, kind: k, sx, sy, from: WIN });
  setTimeout(() => {
    const p = pending;
    pending = null;
    if (p.hit) {
      layout.wins[k] = p.hit;
      if (p.hit === 'float') delete layout.wins[k];
      saveLayout({ kind: k, win: p.hit });
      return;
    }
    if (mine().length === 1) return;   // 只剩这一个：拖出去等于挪窗口，不用拆
    const used = new Set(Object.values(layout.wins));
    let n = 1;
    while (used.has('float-w' + n)) n++;
    const win = 'float-w' + n;
    layout.wins[k] = win;
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* 忽略 */ }
    ipc.invoke('float_open', { kind: k, title: KINDS[k], win, x: Math.max(0, sx - 60), y: Math.max(0, sy - 14) })
      .then(() => saveLayout())
      .catch(() => { delete layout.wins[k]; saveLayout(); });
  }, 200);
}

// ---------- 缩放 ----------
function zoom() { let z = 1; try { z = Number(localStorage.getItem(ZOOM_KEY)) || 1; } catch { /* 忽略 */ } return ZOOMS.includes(z) ? z : 1; }
let zoomTimer = 0;
function setZoom(z, tip) {
  try { localStorage.setItem(ZOOM_KEY, String(z)); } catch { /* 忽略 */ }
  $('fl').style.zoom = z === 1 ? '' : String(z);
  if (!tip) return;
  dragTip(`缩放 ${Math.round(z * 100)}%`);
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(() => dragTip(''), 900);
}
const zoomBy = (d) => { const i = ZOOMS.indexOf(zoom()); setZoom(d === 0 ? 1 : ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, i + d))], true); };
document.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); zoomBy(e.deltaY < 0 ? 1 : -1); }, { passive: false });
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const d = e.key === '=' || e.key === '+' ? 1 : e.key === '-' ? -1 : e.key === '0' ? 0 : null;
  if (d === null) return;
  e.preventDefault();
  zoomBy(d);
});
setZoom(zoom());

// ---------- 交互 ----------
document.addEventListener('click', (e) => {
  const k = e.target.closest('[data-fl-kind]');
  if (k) { if (!noClick) setKind(k.dataset.flKind); return; }
  if (e.target.closest('[data-fl-zoom]')) { setZoom(ZOOMS[(ZOOMS.indexOf(zoom()) + 1) % ZOOMS.length], true); return; }
  const exp = e.target.closest('[data-fl-exp]');
  if (exp) {
    const k = exp.dataset.flExp;
    const open = exp.getAttribute('aria-expanded') === 'true';
    if (open) { expanded.delete(k); collapsed.add(k); } else { collapsed.delete(k); expanded.add(k); }
    render();
    return;
  }
  const kill = e.target.closest('[data-fl-kill]');
  if (kill) { openDetail('kill', Number(kill.dataset.flKill)); return; }
  const ch = e.target.closest('[data-fl-char]');
  if (ch) { openDetail('char', Number(ch.dataset.flChar)); return; }
  const sys = e.target.closest('[data-fl-sys]');
  if (sys) { post({ t: 'open-sys', id: Number(sys.dataset.flSys) }); invoke('float_focus_main'); return; }
  const item = e.target.closest('[data-fl-item]');
  if (item) { openDetail('item', Number(item.dataset.flItem)); return; }
  if (e.target.closest('[data-fl-close]')) { invoke('float_close'); return; }
  if (e.target.closest('[data-fl-alpha]')) { const i = ALPHAS.indexOf(alpha()); setAlpha(ALPHAS[(i + 1) % ALPHAS.length]); return; }
  if (e.target.closest('[data-fl-pass]')) setPass(true);
});

// ---------- 详情 ----------
const DETAIL_V = 'v3';   // 跟 float-detail.html 里 float-detail.js 的版本一致
function openDetail(kind, id) {
  if (!(id > 0)) return;
  if (ipc) { ipc.invoke('float_detail', { kind, id }).catch(() => overlay(kind, id)); return; }
  overlay(kind, id);
}
// 叠在悬浮窗里的详情
function overlay(kind, id) {
  let box = document.querySelector('.fl-detail');
  if (box) { box.querySelector('iframe').contentWindow.postMessage({ t: 'show', kind, id }, location.origin); return; }
  box = document.createElement('div');
  box.className = 'fl-detail';
  box.innerHTML = `<iframe src="float-detail.html?kind=${kind}&id=${id}&v=${DETAIL_V}" title="详情"></iframe>`;
  document.body.append(box);
}
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin) return;
  if (e.data?.t === 'detail-close') document.querySelector('.fl-detail')?.remove();
  else if (e.data?.t === 'focus-main') invoke('float_focus_main');
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
// 主窗口点「悬浮窗」按钮时由壳切换内容
window.__floatKind = (k) => { if (KINDS[k]) setKind(k); };

if (ipc) {
  document.documentElement.classList.add('fl-native');
  $('flCtl').hidden = false;
  setAlpha(alpha());
  // 无边框窗口：按住标题栏空白处拖动
  $('flHead').addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    invoke('float_drag');
  });
  // 无边框窗口：边框和四个角拖动改大小（新版壳才放行）
  if (SPLIT) {
    const DIRS = { n: 'North', s: 'South', e: 'East', w: 'West', ne: 'NorthEast', nw: 'NorthWest', se: 'SouthEast', sw: 'SouthWest' };
    for (const d of Object.keys(DIRS)) {
      const g = document.createElement('div');
      g.className = 'fl-rz ' + d;
      g.addEventListener('mousedown', (e) => { if (e.button === 0) { e.preventDefault(); invoke('plugin:window|start_resize_dragging', { value: DIRS[d] }); } });
      document.body.append(g);
    }
  }
}
// 画中画与桌面版原生窗口都显示切换栏（击杀预警 / 到价提醒 / 本地红名 / 日志预警 / 频道翻译），一个悬浮窗里就能切换
if (PIP || ipc) { $('flTabs').hidden = false; $('flTitle').hidden = true; }

if (SPLIT && winOf(kind) !== WIN) moveKind(kind, WIN);
render();
hello();
// 几秒内没有主页面回应：提示打开主窗口
setTimeout(() => { if (!gotAny) { $('flBody').innerHTML = '<p class="fl-empty">主窗口没有打开：先打开网站，再点「悬浮窗」</p>'; } }, 4000);
// 「几分钟前」随时间更新
setInterval(() => { if (data[kind]) render(); }, 30e3);
