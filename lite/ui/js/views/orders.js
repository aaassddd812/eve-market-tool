// 订单：进行中的卖单 / 收单（与交易中心当前最低卖 / 最高收比较，看是否被压价）+ 最近 90 天已结束的订单
import { esiAuth, esiPaged } from '../esi.js';
import { SERVER, typeIcon } from '../servers.js';
import { esc, formatISK, formatPrice, formatNumber, typeName, resolveNames, nameOf, structureName, loadTypeNames, getPrices } from '../data.js';

export async function render(box, acc, { isCurrent }) {
  const id = acc.character_id;
  const [orders, history] = await Promise.all([
    esiAuth(acc, `/characters/${id}/orders/`),
    esiPaged(acc, `/characters/${id}/orders/history/`, 3).catch(() => []),
    loadTypeNames().catch(() => null)
  ]);
  const prices = await getPrices(orders.map((o) => o.type_id), { exact: true });
  await resolveNames([...orders, ...history].map((o) => o.location_id).filter((x) => x < 1e12));
  await Promise.all([...new Set(orders.map((o) => o.location_id).filter((x) => x >= 1e12))].slice(0, 20).map((x) => structureName(acc, x)));
  if (!isCurrent()) return;
  const loc = (x) => nameOf(x) || (x >= 1e12 ? '玩家建筑' : String(x));
  const sells = orders.filter((o) => !o.is_buy_order), buys = orders.filter((o) => o.is_buy_order);
  const sum = (l, f) => l.reduce((t, o) => t + f(o), 0);
  // 和交易中心比：卖单比最低卖价高 = 被压价；收单比最高收价低 = 被抬价（只在同一星域比才有意义，这里给参考）
  const status = (o) => {
    const p = prices.get(o.type_id) || {};
    if (o.is_buy_order) return p.buy == null ? '' : o.price >= p.buy ? '<span class="pill on">最高</span>' : `<span class="pill bad">低于 ${formatISK(p.buy)}</span>`;
    return p.sell == null ? '' : o.price <= p.sell ? '<span class="pill on">最低</span>' : `<span class="pill bad">高于 ${formatISK(p.sell)}</span>`;
  };
  const table = (list) => `<div class="table-wrap"><table><thead><tr><th>物品</th><th class="r">单价</th><th class="r">剩余 / 总量</th><th>${SERVER.hub.name}比价</th><th>位置</th><th>挂单时间</th></tr></thead><tbody>
    ${list.sort((a, b) => b.price * b.volume_remain - a.price * a.volume_remain).map((o) => `<tr><td><img class="ico" src="${typeIcon(o.type_id)}" alt="" loading="lazy">${esc(typeName(o.type_id))}</td>
      <td class="r">${formatPrice(o.price)}</td><td class="r">${formatNumber(o.volume_remain)} / ${formatNumber(o.volume_total)}</td><td>${status(o)}</td>
      <td>${esc(loc(o.location_id))}</td><td>${new Date(o.issued).toLocaleString('zh-CN', { hour12: false })}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">没有</td></tr>'}
    </tbody></table></div>`;
  const STATE = { expired: '到期', cancelled: '取消', completed: '完成' };
  box.innerHTML = `<div class="card"><div class="stats">
      <div class="stat"><div class="l">卖单</div><div class="v">${sells.length}<small>个</small></div><div class="d">挂单总值 ${formatISK(sum(sells, (o) => o.price * o.volume_remain))}</div></div>
      <div class="stat"><div class="l">收单</div><div class="v">${buys.length}<small>个</small></div><div class="d">托管 ${formatISK(sum(buys, (o) => o.escrow || 0))}</div></div>
    </div></div>
    <div class="card"><h4>卖单</h4>${table(sells)}</div>
    <div class="card"><h4>收单</h4>${table(buys)}</div>
    <div class="card"><h4>已结束的订单<small>最近 90 天，显示最近 100 个</small></h4>
      <div class="table-wrap"><table><thead><tr><th>物品</th><th>类型</th><th class="r">单价</th><th class="r">成交 / 总量</th><th>结果</th><th>位置</th><th>挂单时间</th></tr></thead><tbody>
      ${history.sort((a, b) => Date.parse(b.issued) - Date.parse(a.issued)).slice(0, 100).map((o) => `<tr><td>${esc(typeName(o.type_id))}</td><td>${o.is_buy_order ? '收' : '卖'}</td><td class="r">${formatPrice(o.price)}</td>
        <td class="r">${formatNumber(o.volume_total - o.volume_remain)} / ${formatNumber(o.volume_total)}</td><td>${STATE[o.state] || o.state}</td><td>${esc(loc(o.location_id))}</td>
        <td>${new Date(o.issued).toLocaleString('zh-CN', { hour12: false })}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">没有</td></tr>'}
      </tbody></table></div></div>`;
}
