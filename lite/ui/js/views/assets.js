// 资产：按所在位置（空间站 / 玩家建筑 / 太空中）汇总件数与估值，点位置行在下面原地展开物品；估值按交易中心价格（国服按全服均价）
import { esiPaged } from '../esi.js';
import { typeIcon } from '../servers.js';
import { esc, formatISK, formatNumber, typeName, resolveNames, nameOf, structureName, loadTypeNames, getPrices, priceOf } from '../data.js';
import { store } from '../platform.js';

const S = { open: null, side: store.get('lite-asset-side', 'sell'), q: '' };

export async function render(box, acc, ctx) {
  const id = acc.character_id;
  const [list] = await Promise.all([esiPaged(acc, `/characters/${id}/assets/`, 50), loadTypeNames().catch(() => null)]);
  if (!ctx.isCurrent()) return;
  box.innerHTML = '<div class="loading">正在读取价格与位置名称…</div>';
  const byItem = new Map(list.map((a) => [a.item_id, a]));
  const rootOf = (a) => { let cur = a, n = 0; while (byItem.has(cur.location_id) && n++ < 10) cur = byItem.get(cur.location_id); return cur.location_id; };
  const prices = await getPrices(list.map((a) => a.type_id));
  const locs = new Map();
  for (const a of list) {
    if (a.is_blueprint_copy) a.bpc = true;
    const root = rootOf(a);
    if (!locs.has(root)) locs.set(root, { id: root, items: [], value: 0 });
    const L = locs.get(root);
    const v = a.bpc ? 0 : priceOf(prices, a.type_id, S.side) * a.quantity;
    L.items.push({ ...a, value: v });
    L.value += v;
  }
  await resolveNames([...locs.keys()].filter((x) => x < 1e12));
  await Promise.all([...locs.keys()].filter((x) => x >= 1e12).slice(0, 40).map((x) => structureName(acc, x)));
  if (!ctx.isCurrent()) return;
  const locName = (x) => nameOf(x) || (x >= 1e12 ? '玩家建筑（无停靠权限）' : x === 2004 ? '资产安全' : '位置 ' + x);
  const rows = [...locs.values()].sort((a, b) => b.value - a.value);
  const total = rows.reduce((t, l) => t + l.value, 0);

  // 点位置行在这一行下面原地展开它的物品（再点收起），不在页面底部另起一块
  const itemsHtml = (open) => {
    const q = S.q.trim().toLowerCase();
    const items = open.items.slice().sort((a, b) => b.value - a.value).filter((a) => !q || typeName(a.type_id).toLowerCase().includes(q));
    return `<tr class="loc-open"><td colspan="3"><div class="loc-items">
      <div class="head-row"><span class="muted small">${open.items.length} 项 · ${formatISK(open.value)} ISK</span><span class="grow"></span>
        <input type="text" placeholder="筛选物品" data-q value="${esc(S.q)}"></div>
      <table><thead><tr><th>物品</th><th class="r">数量</th><th class="r">单价</th><th class="r">估值</th></tr></thead><tbody>
      ${items.slice(0, 500).map((a) => `<tr><td><img class="ico" src="${typeIcon(a.type_id)}" alt="" loading="lazy">${esc(typeName(a.type_id))}${a.bpc ? ' <span class="pill">拷贝</span>' : ''}</td>
        <td class="r">${formatNumber(a.quantity)}</td><td class="r">${a.bpc ? '—' : formatISK(priceOf(prices, a.type_id, S.side))}</td><td class="r">${a.bpc ? '—' : formatISK(a.value)}</td></tr>`).join('')}
      </tbody></table>${items.length > 500 ? '<p class="muted small">只显示估值最高的 500 项</p>' : ''}${q && !items.length ? '<p class="muted small">没有匹配的物品</p>' : ''}</div></td></tr>`;
  };
  const draw = () => {
    box.innerHTML = `<div class="card">
      <div class="head-row"><h4>资产估值<small>${formatNumber(list.length)} 项 · ${rows.length} 个位置</small></h4><span class="grow"></span>
        <div class="segmented">${[['sell', '按卖单价'], ['buy', '按收单价']].map(([k, l]) => `<button data-side="${k}" class="${S.side === k ? 'active' : ''}">${l}</button>`).join('')}</div></div>
      <div class="stats"><div class="stat"><div class="l">合计</div><div class="v">${formatISK(total)}<small>ISK</small></div><div class="d">蓝图拷贝不计价</div></div></div>
    </div>
    <div class="card"><div class="table-wrap"><table class="loc-table"><thead><tr><th>位置</th><th class="r">物品</th><th class="r">估值</th></tr></thead><tbody>
      ${rows.map((l) => `<tr class="clickable${l.id === S.open ? ' sel' : ''}" data-loc="${l.id}"><td><span class="caret">${l.id === S.open ? '▾' : '▸'}</span>${esc(locName(l.id))}</td><td class="r">${l.items.length}</td><td class="r">${formatISK(l.value)}</td></tr>${l.id === S.open ? itemsHtml(l) : ''}`).join('')}
    </tbody></table></div></div>`;
  };
  draw();
  box.onclick = (e) => {
    const loc = e.target.closest('[data-loc]');
    if (loc) { S.open = S.open === Number(loc.dataset.loc) ? null : Number(loc.dataset.loc); S.q = ''; draw(); return; }
    const side = e.target.closest('[data-side]');
    if (side) { S.side = side.dataset.side; store.set('lite-asset-side', S.side); ctx.rerender(); }
  };
  box.oninput = (e) => {
    if (!e.target.matches('[data-q]')) return;
    S.q = e.target.value;
    const pos = e.target.selectionStart;
    const tr = box.querySelector('tr.loc-open'), open = rows.find((l) => l.id === S.open);
    if (!tr || !open) return;
    tr.outerHTML = itemsHtml(open);
    const inp = box.querySelector('[data-q]');
    inp.focus(); inp.setSelectionRange(pos, pos);
  };
}
