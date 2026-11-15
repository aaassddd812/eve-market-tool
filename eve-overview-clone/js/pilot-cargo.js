// ===== 驾驶模拟 · 货柜舱和残骸货柜（客户端 inventory/invWindow：列表视图 + 底部「容量条 / N个 物品 / 预估价格」）=====
// 货柜舱：容量 = 装配算出来的舰船 capacity（扩展货柜舱算在内）；装配里没有货舱内容，开局是空的。
// 残骸：深渊的贮藏 / 节点被打掉后变成残骸（pilot-site.js），右键「打开货柜」（2,500 m 内）→ 残骸窗口，
//   「全部拾取」（UI/Inventory/LootAll）或把一行拖到货柜舱窗口。放不下时提示客户端的 NotEnoughCargoSpace，只装能装下的部分。
// 预估价格：客户端 GetAveragePrice = 全服均价（ESI /markets/prices/ 的 average_price），数量 × 均价；
//   合计照 UI/Inventory/EstIskPrice2「{iskString} 预估价格」，取整（FmtISKAndRound）。
let H = null;   // { S, ctx, esc, tr, UI, IMG, root(), toggleWin(id, show), msg(text), ST }
export function initCargo(hooks) { H = hooks; }

const EN = () => window.I18N?.lang === 'en';
// 物品：先查深渊战利品表（名字、体积、组），没有再查装配数据
function info(t) {
  const x = H.ST.lootItem(t);
  if (x) return { name: EN() ? x[1] : x[0], vol: x[2], group: EN() ? x[4] : x[3] };
  const d = H.ctx.data.types.get(t);
  return { name: d?.name || String(t), vol: d?.volume || 0, group: '' };
}
const fmtN = (x, d = 0) => Number(x || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtIsk = (x) => `${fmtN(x, 2)} ISK`;        // FmtISK
const fmtIskR = (x) => `${fmtN(Math.round(x))} ISK`;   // FmtISKAndRound(total, False)
const volOf = (list) => list.reduce((a, x) => a + info(x.t).vol * x.q, 0);
const priceOf = (t) => H.S.prices?.get(t) || 0;

// 开局：容量、清空；均价表只取一次（失败就不显示价格）
export function cargoInit(calc) {
  const { S, ctx } = H;
  S.cargo = { cap: (calc ? ctx.FE.fitStats(calc)?.cargo : 0) || 0, items: [] };
  S.lootCel = -1;
  if (!S.prices && !S.pricesP && ctx.prices) S.pricesP = ctx.prices().then((m) => { S.prices = m instanceof Map ? m : null; renderCargo(); renderLoot(); }).catch(() => {});
}
export const cargoBody = () => '<div class="pl-inv" id="plCargo"></div>';
export const lootBody = () => '<div class="pl-inv" id="plLoot"></div>';

// 列表（客户端列表视图：名字 / 数量 / 组 / 体积 / 预估价格）
function listHtml(list, drag) {
  const { esc, tr, IMG } = H;
  if (!list.length) return `<div class="pl-inv-none">${esc(tr('没有物品'))}</div>`;
  const rows = list.map((x, k) => {
    const it = info(x.t), p = priceOf(x.t);
    return `<tr${drag ? ` draggable="true" data-pl-lootrow="${k}"` : ''}><td><img src="${IMG(x.t, 'icon', 32)}" alt=""><span>${esc(it.name)}</span></td><td class="n">${fmtN(x.q)}</td><td>${esc(it.group)}</td><td class="n">${fmtN(it.vol * x.q, 2)} m³</td><td class="n">${p ? fmtIsk(p * x.q) : ''}</td></tr>`;
  }).join('');
  return `<div class="pl-inv-list"><table><colgroup><col class="nm"><col class="q"><col class="g"><col class="v"><col class="p"></colgroup><thead><tr><th>${esc(tr('名字'))}</th><th>${esc(tr('数量'))}</th><th>${esc(tr('组'))}</th><th>${esc(tr('体积'))}</th><th>${esc(tr('预估价格'))}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
// 底部：N个 物品（UI/Inventory/NumItems2）、预估价格合计（UI/Inventory/EstIskPrice2）
function footHtml(list) {
  const { esc, tr, S } = H;
  const total = list.reduce((a, x) => a + priceOf(x.t) * x.q, 0);
  const n = EN() ? `${fmtN(list.length)} ${list.length === 1 ? 'Item' : 'Items'}` : `${fmtN(list.length)}个 物品`;
  const price = S.prices ? (EN() ? `${fmtIskR(total)} Est. price` : `${fmtIskR(total)} 预估价格`) : esc(tr('全服均价读取中'));
  return `<span class="cnt">${esc(n)}</span><span class="isk">${price}</span>`;
}
export function renderCargo() {
  const box = H?.root()?.querySelector('#plCargo'), c = H?.S.cargo;
  if (!box || !c) return;
  const used = volOf(c.items), f = c.cap ? Math.min(1, used / c.cap) : 0;
  // 容量条（InvContCapacityGauge：UI/Inventory/ContainerQuantityAndCapacity「已用/容量 m³」）
  box.innerHTML = `<div class="pl-inv-gauge"><i style="width:${(f * 100).toFixed(1)}%"></i><span>${fmtN(used, 1)}/${fmtN(c.cap, 1)} m³</span></div>${listHtml(c.items, false)}<div class="pl-inv-foot">${footHtml(c.items)}</div>`;
}
// 残骸窗口：标题是残骸名（客户端单独开一个库存窗口，标题 = 容器名）
export function renderLoot() {
  const { S, esc, tr } = H || {};
  const box = H?.root()?.querySelector('#plLoot');
  if (!box) return;
  const c = S.b?.cel[S.lootCel], w = c?.site?.kind === 'wreck' ? c.site : null;
  const title = box.closest('[data-win]')?.querySelector('.pl-wh span');
  if (title && c) title.textContent = c.name;
  if (!w) { box.innerHTML = ''; return; }
  box.innerHTML = `${listHtml(w.loot, true)}<div class="pl-inv-foot">${footHtml(w.loot)}<button type="button" class="pl-btn" data-pl-lootall${w.loot.length ? '' : ' disabled'}>${esc(tr('全部拾取'))}</button></div>`;
}
export function openLoot(i) {
  const { S } = H;
  if (!H.ST.wreckOf(i)) return;
  S.lootCel = i;
  H.toggleWin('loot', true);
  renderLoot();
  if (!H.root()?.querySelector('[data-win="cargo"]')?.hidden) renderCargo();
}
// 拿东西：k = 第几堆（不给就全部）；放不下的只拿能装下的部分
function take(k) {
  const { S } = H;
  const w = H.ST.wreckOf(S.lootCel), c = S.cargo;
  if (!w || !c) return;
  if (!H.ST.lootRange(S.lootCel)) { closeLoot(); return; }
  const idx = k == null ? w.loot.map((_, n) => n) : [k];
  const need = idx.reduce((a, n) => a + info(w.loot[n].t).vol * w.loot[n].q, 0), free0 = Math.max(0, c.cap - volOf(c.items));
  let short = 0;
  for (const n of idx) {
    const x = w.loot[n], v = info(x.t).vol;
    const free = c.cap - volOf(c.items);
    const can = v > 0 ? Math.min(x.q, Math.floor((free + 1e-9) / v)) : x.q;
    if (can < x.q) short += (x.q - can) * v;
    if (can <= 0) continue;
    const have = c.items.find((y) => y.t === x.t);
    if (have) have.q += can; else c.items.push({ t: x.t, q: can });
    x.q -= can;
  }
  w.loot = w.loot.filter((x) => x.q > 0);
  // 客户端 UI/Messages/1336/NotEnoughCargoSpace
  if (short > 0) H.msg(`要完成此操作，需要${fmtN(need, 2)}个货柜单位的空间。目标货柜只有${fmtN(free0, 2)}个单位可用。`);
  if (!w.loot.length) H.wreckEmpty?.(S.lootCel);
  renderLoot();
  renderCargo();
}
function closeLoot() {
  H.S.lootCel = -1;
  H.toggleWin('loot', false);
}
// 每步：离开 2,500 m 关掉残骸窗口
export function cargoTick() {
  const { S } = H;
  if (S.lootCel >= 0 && !H.root()?.querySelector('[data-win="loot"]')?.hidden && !H.ST.lootRange(S.lootCel)) closeLoot();
}
export function cargoClick(e) {
  if (e.target.closest?.('[data-pl-lootall]')) { take(null); return true; }
  return false;
}
// 拖一行到货柜舱窗口
export function bindDrag(stage) {
  stage.addEventListener('dragstart', (e) => {
    const r = e.target.closest?.('[data-pl-lootrow]');
    if (!r) return;
    e.dataTransfer.setData('text/x-pl-loot', r.dataset.plLootrow);
    e.dataTransfer.effectAllowed = 'move';
  });
  stage.addEventListener('dragover', (e) => { if (e.target.closest?.('[data-win="cargo"]') && [...e.dataTransfer.types].includes('text/x-pl-loot')) e.preventDefault(); });
  stage.addEventListener('drop', (e) => {
    if (!e.target.closest?.('[data-win="cargo"]')) return;
    const k = e.dataTransfer.getData('text/x-pl-loot');
    if (k === '') return;
    e.preventDefault();
    take(Number(k));
  });
}
