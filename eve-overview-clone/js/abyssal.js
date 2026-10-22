// ===== 深渊装备估价（MutaMarket）=====
// MutaMarket 为每个深渊装备类型训练一个随机森林模型（输入突变属性，标签为真实单件合同成交价），按单件 item_id 估价。
// 对方不允许浏览器跨域，经本站击杀记录服务代理（server/kb_service.py 的 Abyssal）：
//   GET  /api/v1/abyssal/modules/{item_id}：本站缓存或对方已收录的结果（6 小时），没有时 404，不会自动导入
//   POST /api/v1/abyssal/appraise {type_id, item_id}：让对方从 ESI 导入 / 刷新并估价——这件装备会出现在对方公开页面，只在用户点击时调用
// 只有宁静服：价格模型来自宁静服合同，国服的物品 ID 与价格不能混用。
// 估价是模型预测的参考值，不是能立即成交的收购价，不计入普通的最低卖 / 最高收合计；没有模型时显示「暂无估价」，不当作 0。
import { SERVER, IS_TQ } from './server.js?v=s3';

let ctx;   // esc, formatISK, formatNumber, resolveTypeNames(ids) -> Map, openDynamicItem(typeId, itemId)
const results = new Map();   // item_id -> { state: 'loading' | 'ok' | 'missing' | 'error' | 'posting', data, error }
const names = new Map();
const listeners = new Set();

export function initAbyssal(context) { ctx = context; }
export const supported = IS_TQ && SERVER.kb;

// 游戏物品链接：<url=showinfo:typeID//itemID>名称</url>，或直接 showinfo:typeID//itemID
export function parseLinks(text) {
  const out = [], seen = new Set();
  for (const m of String(text || '').matchAll(/showinfo:(\d+)\/\/(\d+)/g)) {
    const type = Number(m[1]), item = Number(m[2]);
    if (!(type > 0 && type < 2 ** 31 && item > 0 && item < 2 ** 53) || seen.has(item)) continue;
    seen.add(item);
    out.push({ type, item });
  }
  return out;
}
// 去掉含物品链接的行（其余行照常按普通物品估价）
export const stripLinks = (text) => String(text || '').split('\n').filter((l) => !/showinfo:\d+\/\/\d+/.test(l)).join('\n');

function notify() { for (const fn of listeners) fn(); }

async function request(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (res.status === 404) return { missing: true, message: body.error?.message };
  if (!res.ok) throw new Error(body.error?.message || 'HTTP ' + res.status);
  return { data: body };
}

// 读取已收录的估价（只读）
export function lookup(type, item) {
  const hit = results.get(item);
  if (hit && hit.state !== 'error') return;
  results.set(item, { state: 'loading' });
  request(`/api/v1/abyssal/modules/${item}?type_id=${type}`)
    .then((r) => results.set(item, r.missing ? { state: 'missing' } : { state: 'ok', data: r.data }))
    .catch((e) => results.set(item, { state: 'error', error: e.message }))
    .finally(notify);
}

// 用户点击：让 MutaMarket 导入 / 刷新这件装备
export function appraise(type, item) {
  const prev = results.get(item);
  results.set(item, { ...prev, state: 'posting' });
  notify();
  return request('/api/v1/abyssal/appraise', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type_id: type, item_id: item, server: SERVER.id }) })
    .then((r) => results.set(item, r.missing ? { state: 'missing', error: r.message } : { state: 'ok', data: r.data }))
    .catch((e) => results.set(item, prev?.data ? { state: 'ok', data: prev.data, error: e.message } : { state: 'error', error: e.message }))
    .finally(notify);
}

const pendingNames = new Set();
async function loadNames(ids) {
  const todo = [...new Set(ids)].filter((id) => id && !names.has(id) && !pendingNames.has(id));
  if (!todo.length) return false;
  todo.forEach((id) => pendingNames.add(id));
  const map = await ctx.resolveTypeNames(todo).catch(() => new Map());
  for (const id of todo) { names.set(id, map.get(id) || ''); pendingNames.delete(id); }
  return true;
}
const nameOf = (id, fallback) => names.get(id) || fallback || 'Type ' + id;

export function fmtTime(s) {
  const t = Date.parse(String(s || '').replace(' ', 'T').replace(/\+00$/, 'Z'));
  if (!Number.isFinite(t)) return '';
  const d = new Date(t), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// 模型可信度：按该类型模型的 R²（整体拟合度）分档，与 MutaMarket 页面一致的五档
export function confidence(r2) {
  if (r2 == null) return null;
  return r2 >= 0.85 ? '很高' : r2 >= 0.7 ? '高' : r2 >= 0.5 ? '中' : r2 >= 0.3 ? '低' : '很低';
}
const pct = (v) => (v == null ? '' : `${Math.round(v)}%`);
function modelText(m) {
  if (!m || m.r2 == null) return '该类型暂无模型';
  return `模型样本 ${ctx.formatNumber(m.data_count)} 笔 · 平均误差约 ${pct(m.nmae)}`;
}
function modelTitle(m) {
  if (!m || m.r2 == null) return 'MutaMarket 至少积累 50 笔成交才训练模型';
  return `R² ${m.r2.toFixed(3)}（类型整体拟合度，不是这件卖出该价的概率）\n平均绝对误差 ${ctx.formatISK(m.mae)}（类型整体）\n模型训练于 ${fmtTime(m.last_trained_at)}`;
}
// 合同价：只有单件合同才代表这件装备的挂牌价
function contractText(c) {
  if (!c?.price) return '';
  const single = c.abyssal_modules_count === 1 && !c.non_abyssal_modules_count;
  return `${single ? '挂牌' : '所在合同'} ${ctx.formatISK(c.price)}${single ? '' : `（含 ${(c.abyssal_modules_count || 0) + (c.non_abyssal_modules_count || 0)} 件物品）`}`;
}

const NOTE = '估价来自 <a href="https://mutamarket.com" target="_blank" rel="noopener">MutaMarket</a>：按真实单件合同成交价训练的模型预测，仅供参考，不是能立即成交的价格。点「查询估价」会让 MutaMarket 从 ESI 导入这件装备，并在其网站公开显示。';

// ---------- 突变属性弹窗里的一块 ----------
export function mountItem(el, type, item) {
  if (!supported) { el.innerHTML = `<div class="aby-box"><span class="text-muted">深渊装备估价只支持宁静服（${ctx.esc(SERVER.full)}没有对应的成交数据）</span></div>`; return; }
  const draw = () => {
    if (!el.isConnected) { listeners.delete(draw); return; }
    const r = results.get(item) || { state: 'loading' };
    const d = r.data;
    let body;
    if (r.state === 'loading') body = '<span class="text-muted">查询深渊估价…</span>';
    else if (r.state === 'missing' || (r.state === 'posting' && !d)) {
      body = `<span>MutaMarket 还没有收录这件装备。</span><button class="btn btn-primary btn-sm" data-aby-post ${r.state === 'posting' ? 'disabled' : ''}>${r.state === 'posting' ? '查询中…' : '查询估价'}</button>`;
    } else if (r.state === 'error' && !d) body = `<span class="down">估价查询失败：${ctx.esc(r.error)}</span><button class="btn btn-sm" data-aby-retry>重试</button>`;
    else {
      body = `<div class="aby-value"><span>深渊参考估价</span><b>${d.estimated_value ? ctx.formatISK(d.estimated_value) + ' ISK' : '暂无估价'}</b>
          <small>${d.estimated_value_updated_at ? '估于 ' + fmtTime(d.estimated_value_updated_at) : ''}</small></div>
        <div class="aby-meta"><span title="${ctx.esc(modelTitle(d.model))}">${modelText(d.model)}</span>${contractText(d.contract) ? `<span>${contractText(d.contract)}</span>` : ''}</div>
        <div class="aby-actions"><button class="btn btn-sm" data-aby-post ${r.state === 'posting' ? 'disabled' : ''}>${r.state === 'posting' ? '刷新中…' : '刷新估价'}</button>
          <a class="btn btn-ghost btn-sm" href="#abyss/m/${item}" data-dyn-close>深渊市场详情</a>
          ${d.source_url ? `<a class="btn btn-ghost btn-sm" href="${ctx.esc(d.source_url)}" target="_blank" rel="noopener">在 MutaMarket 查看</a>` : ''}</div>
        ${r.error ? `<div class="down aby-err">刷新失败：${ctx.esc(r.error)}</div>` : ''}`;
    }
    el.innerHTML = `<div class="aby-box">${body}<p class="text-muted aby-note">${NOTE}</p></div>`;
  };
  listeners.add(draw);
  el.onclick = (e) => {
    if (e.target.closest('[data-aby-post]')) appraise(type, item);
    if (e.target.closest('[data-aby-retry]')) { results.delete(item); lookup(type, item); draw(); }
  };
  lookup(type, item);
  draw();
}

// ---------- 估价页的深渊装备列表 ----------
export function mountList(el, links) {
  if (!links.length) { el.innerHTML = ''; return; }
  if (!supported) { el.innerHTML = `<div class="ap-card aby-card"><div class="aby-card-head"><h3>深渊装备 ${links.length} 件</h3></div><p class="text-muted">深渊装备估价只支持宁静服。</p></div>`; return; }
  const ICON = (id) => `https://images.evetech.net/types/${id}/icon?size=32`;
  const draw = () => {
    if (!el.isConnected) { listeners.delete(draw); return; }
    // 名称：装备类型与结果回来后的原型
    loadNames([...links.map((l) => l.type), ...links.map((l) => results.get(l.item)?.data?.source_type?.id)]).then((more) => { if (more) draw(); });
    let total = 0, priced = 0;
    const missing = [];
    const rows = links.map(({ type, item }) => {
      const r = results.get(item) || { state: 'loading' };
      const d = r.data;
      if (d?.estimated_value) { total += d.estimated_value; priced++; }
      if (r.state === 'missing') missing.push(item);
      const busy = r.state === 'posting';
      let value, meta = '', action;
      if (r.state === 'loading') { value = '<span class="text-muted">查询中…</span>'; action = ''; }
      else if (!d && (r.state === 'missing' || busy)) { value = '<span class="text-muted">未收录</span>'; action = `<button class="btn btn-primary btn-sm" data-aby-post="${type}:${item}" ${busy ? 'disabled' : ''}>${busy ? '查询中…' : '查询估价'}</button>`; }
      else if (!d) { value = `<span class="down" title="${ctx.esc(r.error || '')}">查询失败</span>`; action = `<button class="btn btn-sm" data-aby-retry="${type}:${item}">重试</button>`; }
      else {
        value = d.estimated_value ? `<b>${ctx.formatISK(d.estimated_value)}</b>` : '<span class="text-muted">暂无估价</span>';
        meta = `<span title="${ctx.esc(modelTitle(d.model))}">${modelText(d.model)}</span>${d.estimated_value_updated_at ? ` · 估于 ${fmtTime(d.estimated_value_updated_at)}` : ''}${contractText(d.contract) ? ` · ${contractText(d.contract)}` : ''}${r.error ? ` · <span class="down">刷新失败</span>` : ''}`;
        action = `<button class="btn btn-sm" data-aby-post="${type}:${item}" ${busy ? 'disabled' : ''}>${busy ? '刷新中…' : '刷新'}</button><a class="btn btn-ghost btn-sm" href="#abyss/m/${item}">详情</a>`;
      }
      return `<tr><td><div class="aby-name"><img src="${ICON(type)}" alt="" width="28" height="28" loading="lazy"><div><a href="#" data-aby-attrs="${type}:${item}">${ctx.esc(nameOf(type, d?.type_name))}</a>
          <small>${d ? ctx.esc(nameOf(d.source_type.id, d.source_type.name)) : ''}</small></div></div></td>
        <td class="num">${value}</td><td class="aby-meta-cell">${meta}</td><td><div class="aby-actions">${action}</div></td></tr>`;
    }).join('');
    el.innerHTML = `<div class="ap-card aby-card"><div class="aby-card-head"><h3>深渊装备 ${links.length} 件</h3>
        <span class="aby-total">参考估价合计 <b>${ctx.formatISK(total)}</b>${priced < links.length ? `<small>（${links.length - priced} 件暂无估价，未计入）</small>` : ''}</span>
        <span class="toolbar-spacer"></span>${missing.length > 1 ? `<button class="btn btn-primary btn-sm" data-aby-post-all>查询全部未收录（${missing.length}）</button>` : ''}</div>
      <div class="table-scroll"><table class="ap-table aby-table"><thead><tr><th>装备 / 原型</th><th class="num">参考估价</th><th>依据</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="text-muted aby-note">${NOTE}</p></div>`;
  };
  listeners.add(draw);
  el.onclick = async (e) => {
    const t = e.target;
    const post = t.closest('[data-aby-post]');
    if (post) { const [type, item] = post.dataset.abyPost.split(':').map(Number); appraise(type, item); return; }
    const retry = t.closest('[data-aby-retry]');
    if (retry) { const [type, item] = retry.dataset.abyRetry.split(':').map(Number); results.delete(item); lookup(type, item); draw(); return; }
    const attrs = t.closest('[data-aby-attrs]');
    if (attrs) { e.preventDefault(); const [type, item] = attrs.dataset.abyAttrs.split(':').map(Number); ctx.openDynamicItem(type, item); return; }
    if (t.closest('[data-aby-post-all]')) {
      // 逐个导入，避免同时打爆对方接口
      for (const { type, item } of links) if (results.get(item)?.state === 'missing') await appraise(type, item);
    }
  };
  for (const { type, item } of links) lookup(type, item);
  draw();
}
