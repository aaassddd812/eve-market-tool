// ===== 购物车（右上角购物车图标）=====
// 估价、装配、制造材料、LP 商店、市场详情等处「加入购物车」，在这里合计数量与价格，一键复制为游戏「批量购买」（Multibuy）格式：
//   每行「物品名<Tab>数量」，在游戏市场窗口左下角「批量购买」→「从剪贴板导入」即可。游戏按客户端语言识别物品名，
//   中文客户端用中文名，英文客户端用英文名（中文界面下也可复制英文名，名称由 ESI /universe/names/ 取官方英文名）。
// 购物记录：复制清单时自动存一份（最多 30 份），可以重新载入或合并。数据只存在本浏览器（每个服务器分开）。
// 添加物品的逻辑在 modern-app.js（addToCart），这里只负责弹窗。

let ctx;   // esc, formatISK, formatNumber, showToast, copyText, store, valuation, typeById, typeByName, eveTypeIcon, openItem, cartKey, readCart, writeCart, esiUrl, isEn
const HISTORY_MAX = 30;
let modal = null;
let busy = 0;
let enNames = new Map();   // typeId -> 官方英文名（ESI 缓存）

export function initCart(context) {
  ctx = context;
  window.addEventListener('eve-cart-change', (e) => { if (modal && !modal.hidden) render(!e.detail?.quiet); });
}

const esc = (s) => ctx.esc(s);
const items = () => ctx.readCart().items;

async function englishNames(ids) {
  const miss = ids.filter((id) => !enNames.has(id));
  for (let i = 0; i < miss.length; i += 900) {
    const res = await fetch(ctx.esiUrl('/universe/names/'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(miss.slice(i, i + 900)) });
    if (!res.ok) throw new Error('ESI ' + res.status);
    for (const x of await res.json()) enNames.set(x.id, x.name);
  }
  return enNames;
}

// 批量购买文本：同一物品合并，数量取整
async function multibuyText(english) {
  const list = items().filter((x) => x.qty > 0);
  const names = english ? await englishNames(list.map((x) => x.id)) : null;
  return list.map((x) => `${english ? names.get(x.id) || x.en || x.name : x.name}\t${Math.round(x.qty)}`).join('\n');
}

function saveHistory(note) {
  const cart = ctx.readCart();
  if (!cart.items.length) return;
  const sig = cart.items.map((x) => x.id + ':' + x.qty).join(',');
  if (cart.history[0]?.sig === sig) return;   // 同一份清单连复制几次只存一次
  cart.history.unshift({ at: Date.now(), sig, note: note || '', items: cart.items.map((x) => ({ ...x })), total: S.total || 0 });
  cart.history.length = Math.min(cart.history.length, HISTORY_MAX);
  ctx.writeCart(cart, true);
}

// 粘贴清单：「名字<Tab>数量」「名字 x 数量」「数量 名字」「名字」（游戏里复制的仓库 / 合同列表也能识别第一、二列）
function parsePaste(text) {
  const out = [], unknown = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let name = line, qty = 1, m;
    const cols = line.split(/\t| {2,}/);
    if (cols.length > 1) { name = cols[0]; qty = Number(String(cols[1]).replace(/[,\s]/g, '')) || 1; }
    else if ((m = line.match(/^(.+?)\s*[x×*]\s*([\d,]+)$/i))) { name = m[1]; qty = Number(m[2].replace(/,/g, '')); }
    else if ((m = line.match(/^([\d,]+)\s*[x×*]?\s+(.+)$/i))) { name = m[2]; qty = Number(m[1].replace(/,/g, '')); }
    else if ((m = line.match(/^(.+?)\s+([\d,]+)$/)) && !ctx.typeByName(line)) { name = m[1]; qty = Number(m[2].replace(/,/g, '')); }
    name = name.replace(/\*$/, '').trim();
    const t = ctx.typeByName(name);
    if (t) out.push({ id: t.id, name: t.name, qty: Math.max(1, qty) });
    else unknown.push({ name, qty: Math.max(1, qty) });
  }
  return { out, unknown };
}

// 本地目录里找不到的名字（比如中文界面下粘贴英文客户端的清单）交给 ESI /universe/ids/ 识别
async function resolveUnknown(unknown) {
  if (!unknown.length) return { out: [], rest: [] };
  const byLower = new Map();
  try {
    const names = [...new Set(unknown.map((u) => u.name))];
    for (let i = 0; i < names.length; i += 500) {
      const res = await fetch(ctx.esiUrl('/universe/ids/'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(names.slice(i, i + 500)) });
      if (!res.ok) continue;
      for (const t of (await res.json()).inventory_types || []) byLower.set(String(t.name).toLowerCase(), t.id);
    }
  } catch { /* 识别不了就算无法识别 */ }
  const out = [], rest = [];
  for (const u of unknown) {
    const id = byLower.get(u.name.toLowerCase());
    const type = id && ctx.typeById(id);
    if (type) out.push({ id: type.id, name: type.name, qty: u.qty });
    else rest.push(u.name);
  }
  return { out, rest };
}

const S = { total: 0, prices: null, showHistory: false, showPaste: false };

async function loadPrices() {
  const list = items();
  if (!list.length) { S.prices = null; S.total = 0; return; }
  const my = ++busy;
  const v = await ctx.valuation.items(list.map((x) => ({ type_id: x.id, quantity: x.qty })));
  if (my !== busy) return;
  S.prices = v;
  S.total = v.sell;
  render(false);
}

function render(fetchPrices = true) {
  const body = modal.querySelector('#cartBody');
  const list = items();
  const cart = ctx.readCart();
  const v = S.prices;
  const price = (id) => v?.price(id) || {};
  const rows = list.map((x) => {
    const p = price(x.id);
    return `<tr>
      <td class="cart-name"><img src="${ctx.eveTypeIcon(x.id)}" alt="" width="24" height="24" loading="lazy"><button class="link-btn" data-cart-open="${x.id}">${esc(x.name)}</button></td>
      <td class="num"><input type="number" class="cr-input cart-qty" min="1" step="1" value="${Math.round(x.qty)}" data-cart-qty="${x.id}" aria-label="数量"></td>
      <td class="num">${p.sell != null ? ctx.formatISK(p.sell) : '—'}</td>
      <td class="num">${p.sell != null ? ctx.formatISK(p.sell * x.qty) : '—'}</td>
      <td class="num">${p.buy != null ? ctx.formatISK(p.buy * x.qty) : '—'}</td>
      <td><button class="ka-close" data-cart-del="${x.id}" title="移除" aria-label="移除">×</button></td></tr>`;
  }).join('');
  const volume = list.reduce((t, x) => t + (ctx.typeVolume(x.id) || 0) * x.qty, 0);
  body.innerHTML = `
    <div class="cart-bar">
      ${ctx.valuation.select('data-cart-src')}
      <button class="btn btn-ghost" data-cart-paste-toggle>${S.showPaste ? '收起粘贴' : '粘贴清单'}</button>
      <button class="btn btn-ghost" data-cart-history-toggle>购物记录${cart.history.length ? `（${cart.history.length}）` : ''}</button>
    </div>
    ${S.showPaste ? `<div class="cart-paste"><textarea class="cr-input" rows="5" data-cart-paste placeholder="每行一个物品：物品名 + Tab 或空格 + 数量；也可以粘贴游戏里复制的仓库、合同、批量购买清单"></textarea>
      <button class="btn btn-primary" data-cart-paste-add>加入购物车</button></div>` : ''}
    ${S.showHistory ? historyHtml(cart) : ''}
    ${list.length ? `<div class="table-scroll"><table class="data-table cart-table"><thead><tr><th>物品</th><th class="num">数量</th><th class="num">单价（最低卖）</th><th class="num">小计</th><th class="num">按最高收</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <div class="cart-total">
        <span>${list.length} 种物品${volume ? ' · 体积 ' + (volume < 10 ? volume.toFixed(2).replace(/\.?0+$/, '') : ctx.formatNumber(Math.round(volume))) + ' m³' : ''}</span>
        <span>合计（最低卖价）<b>${v ? ctx.formatISK(v.sell) + ' ISK' : '计算中…'}</b></span>
        ${v && v.sellN < v.n ? `<span class="text-muted">${v.n - v.sellN} 种在 ${esc(v.region.hub.name)} 没有卖单</span>` : ''}
      </div>
      <div class="cart-actions">
        <button class="btn btn-primary" data-cart-copy="ui">复制批量购买清单</button>
        ${ctx.isEn() ? '' : '<button class="btn btn-ghost" data-cart-copy="en" title="游戏客户端是英文时用这个">复制英文名清单</button>'}
        <button class="btn btn-ghost danger" data-cart-clear>清空</button>
      </div>
      <p class="ka-note">游戏里打开市场窗口 → 左下角「批量购买」→「从剪贴板导入」，即可一次下单全部物品。复制清单时会自动存进购物记录。</p>`
    : '<div class="empty-state"><p>购物车是空的。在估价、装配、制造、LP 商店或物品详情里点「加入购物车」，或用上面的「粘贴清单」。</p></div>'}`;
  if (fetchPrices) loadPrices().catch((e) => ctx.showToast('读取价格失败：' + e.message, 'error'));
}

function historyHtml(cart) {
  if (!cart.history.length) return '<div class="cart-history"><p class="text-muted">还没有购物记录（复制批量购买清单时自动保存）</p></div>';
  return `<div class="cart-history"><ul>${cart.history.map((h, i) => `<li>
      <span><b>${new Date(h.at).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</b>
      ${h.items.length} 种物品${h.total ? ' · ' + ctx.formatISK(h.total) + ' ISK' : ''}<small>${esc(h.items.slice(0, 3).map((x) => x.name).join('、'))}${h.items.length > 3 ? ' 等' : ''}</small></span>
      <button class="btn btn-ghost" data-cart-load="${i}">载入</button><button class="btn btn-ghost" data-cart-merge="${i}">合并</button>
      <button class="ka-close" data-cart-hdel="${i}" title="删除记录" aria-label="删除记录">×</button></li>`).join('')}</ul></div>`;
}

function setItems(list, keepPrices) {
  const cart = ctx.readCart();
  cart.items = list;
  ctx.writeCart(cart, keepPrices);
}

export function openCart() {
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'cartModal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.innerHTML = `<div class="modal-backdrop" data-cart-dismiss></div><div class="modal-content cart-modal">
      <div class="modal-header"><h3>购物车</h3><button class="modal-close" data-cart-dismiss aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
      <div class="modal-body" id="cartBody"></div></div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', onClick);
    modal.addEventListener('change', (e) => {
      const q = e.target.closest('[data-cart-qty]');
      if (q) {
        const id = Number(q.dataset.cartQty), n = Math.max(1, Math.round(Number(q.value) || 1));
        setItems(items().map((x) => (x.id === id ? { ...x, qty: n } : x)));
        return;
      }
      if (e.target.matches('[data-cart-src]')) { ctx.valuation.set(e.target.value); S.prices = null; render(); }
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal && !modal.hidden) { e.stopImmediatePropagation(); modal.hidden = true; } }, true);
  }
  modal.hidden = false;
  render();
}

async function onClick(e) {
  const t = (sel) => e.target.closest(sel);
  if (t('[data-cart-dismiss]')) { modal.hidden = true; return; }
  const open = t('[data-cart-open]');
  if (open) { modal.hidden = true; ctx.openItem(Number(open.dataset.cartOpen)); return; }
  const del = t('[data-cart-del]');
  if (del) { setItems(items().filter((x) => x.id !== Number(del.dataset.cartDel))); return; }
  if (t('[data-cart-clear]')) { if (confirm('清空购物车？')) setItems([]); return; }
  if (t('[data-cart-paste-toggle]')) { S.showPaste = !S.showPaste; render(false); return; }
  if (t('[data-cart-history-toggle]')) { S.showHistory = !S.showHistory; render(false); return; }
  if (t('[data-cart-paste-add]')) {
    const parsed = parsePaste(modal.querySelector('[data-cart-paste]').value);
    const extra = await resolveUnknown(parsed.unknown);
    const out = parsed.out.concat(extra.out), unknown = extra.rest;
    if (out.length) ctx.addToCart(out, { silent: true });
    ctx.showToast(`已加入 ${out.length} 种物品` + (unknown.length ? `，${unknown.length} 行无法识别：${unknown.slice(0, 3).join('、')}` : ''), unknown.length ? 'info' : 'success', 4000);
    if (out.length) S.showPaste = false;
    render();
    return;
  }
  const copy = t('[data-cart-copy]');
  if (copy) {
    try {
      const text = await multibuyText(copy.dataset.cartCopy === 'en');
      await navigator.clipboard.writeText(text);
      ctx.showToast(`已复制 ${items().length} 种物品的批量购买清单，到游戏市场「批量购买」里导入`, 'success', 3500);
      saveHistory();
      render(false);
    } catch (err) {
      ctx.showToast('复制失败：' + err.message, 'error');
    }
    return;
  }
  const cart = ctx.readCart();
  const load = t('[data-cart-load]'), merge = t('[data-cart-merge]'), hdel = t('[data-cart-hdel]');
  if (load) { const h = cart.history[Number(load.dataset.cartLoad)]; if (h) { setItems(h.items.map((x) => ({ ...x }))); ctx.showToast('已载入这份清单', 'success'); } return; }
  if (merge) { const h = cart.history[Number(merge.dataset.cartMerge)]; if (h) { ctx.addToCart(h.items, { silent: true }); ctx.showToast('已合并到购物车', 'success'); } return; }
  if (hdel) { cart.history.splice(Number(hdel.dataset.cartHdel), 1); ctx.writeCart(cart, true); render(false); }
}
