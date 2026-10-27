// ===== 行星工业 · 我的殖民地 =====
// /characters/{id}/planets/ 列出殖民地，/characters/{id}/planets/{planet_id}/ 读布局（设施、提取器、仓库存量），
// 需要 esi-planets.manage_planets.v1（「行星殖民地」权限）。ESI 数据在游戏里打开该行星时才更新（last_update）。
// 提取器到期时间、产物与每周期产量直接来自 ESI；仓库存量按 ESI 全服均价估值。

let ctx;   // esc, formatISK, formatNumber, esiAuthFetch, fetchESI, resolveTypeNames, officialName, gameImage, valuationCard, valuation, hasScopeGroup, scopeNeededHtml, tokenInfo, openMapSystem
const PLANET_TYPE = { temperate: '温和', barren: '贫瘠', oceanic: '海洋', ice: '冰体', gas: '气体', lava: '熔岩', storm: '风暴', plasma: '等离子' };
let cache = null;   // { id, at, promise }

export function initColonies(context) {
  ctx = context;
  window.addEventListener('eve-account-change', () => { cache = null; });
}

function left(ms) {
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600e3), d = Math.floor(h / 24), m = Math.floor((abs % 3600e3) / 60e3);
  return d ? `${d} 天 ${h % 24} 小时` : h ? `${h} 小时 ${m} 分` : `${Math.max(1, m)} 分钟`;
}

async function load(force) {
  const id = ctx.tokenInfo().character_id;
  if (!force && cache && cache.id === id && Date.now() - cache.at < 5 * 60e3) return cache.promise;
  const promise = (async () => {
    const list = await ctx.esiAuthFetch('/characters/' + id + '/planets/');
    const [layouts, names] = await Promise.all([
      Promise.all(list.map((p) => ctx.esiAuthFetch(`/characters/${id}/planets/${p.planet_id}/`).catch((e) => ({ error: e.message })))),
      Promise.all(list.map((p) => ctx.fetchESI(`/universe/planets/${p.planet_id}/?language=zh`).then((x) => x.name).catch(() => '行星 ' + p.planet_id)))
    ]);
    const typeIds = new Set();
    const schematics = new Set();
    for (const l of layouts) for (const pin of l.pins || []) {
      typeIds.add(pin.type_id);
      if (pin.extractor_details?.product_type_id) typeIds.add(pin.extractor_details.product_type_id);
      for (const c of pin.contents || []) typeIds.add(c.type_id);
      if (pin.schematic_id) schematics.add(pin.schematic_id);
    }
    // 工厂配方 → 产物（pi-data.json 与行星工业规划共用，浏览器已缓存）；ESI 的配方名只有英文
    const piData = await fetch('pi-data.json?v=2').then((r) => r.json()).catch(() => ({ schematics: [] }));
    const output = new Map((piData.schematics || []).map((x) => [x[0], x[2]]));
    for (const sid of schematics) if (output.has(sid)) typeIds.add(output.get(sid));
    const types = await ctx.resolveTypeNames([...typeIds]);
    const schem = [...schematics].map((sid) => [sid, output.has(sid) ? types.get(output.get(sid)) || '配方 ' + sid : '配方 ' + sid]);
    return { list, layouts, names, types, schematics: new Map(schem) };
  })();
  cache = { id, at: Date.now(), promise };
  promise.catch(() => { if (cache?.promise === promise) cache = null; });
  return promise;
}

function planetCard(p, layout, name, d) {
  const { esc, formatNumber, formatISK, gameImage } = ctx;
  const type = (id) => d.types.get(Number(id)) || 'Type ' + id;
  const icon = (id) => `<img src="${gameImage('types/' + id + '/icon', 32)}" alt="" width="18" height="18" loading="lazy">`;
  if (layout.error) return `<div class="col-card"><div class="col-head"><b>${esc(name)}</b></div><p class="text-muted">布局读取失败：${esc(layout.error)}</p></div>`;
  const pins = layout.pins || [];
  const extractors = pins.filter((x) => x.extractor_details);
  const factories = pins.filter((x) => x.schematic_id);
  const stores = new Map();
  for (const pin of pins) if (!pin.schematic_id) for (const c of pin.contents || []) stores.set(c.type_id, (stores.get(c.type_id) || 0) + c.amount);
  const storeValue = [...stores].reduce((t, [id, n]) => t + (d.val.price(id).sell || 0) * n, 0);
  const now = Date.now();
  const exRows = extractors.map((x) => {
    const e = x.extractor_details;
    const ms = x.expiry_time ? new Date(x.expiry_time) - now : null;
    const cls = ms == null ? '' : ms <= 0 ? 'down' : ms < 24 * 3600e3 ? 'warn-text' : 'up';
    return `<li>${icon(e.product_type_id)}<span>${esc(type(e.product_type_id))}</span>
      <small>${formatNumber(e.qty_per_cycle || 0)} / ${Math.round((e.cycle_time || 0) / 60)} 分钟 · ${(e.heads || []).length} 个钻头</small>
      <b class="${cls}">${ms == null ? '未运行' : ms <= 0 ? `已停止 ${left(ms)}` : `${left(ms)}后停止`}</b></li>`;
  }).join('');
  const factoryGroups = new Map();
  for (const f of factories) factoryGroups.set(f.schematic_id, (factoryGroups.get(f.schematic_id) || 0) + 1);
  const updated = p.last_update ? new Date(p.last_update) : null;
  return `<div class="col-card">
    <div class="col-head"><b>${esc(name)}</b><span class="pill">${esc(PLANET_TYPE[p.planet_type] || p.planet_type)}</span>
      <span class="text-muted">指挥中心 ${p.upgrade_level} 级 · ${p.num_pins} 个设施</span>
      <button class="link-btn" data-col-sys="${p.solar_system_id}">${esc(ctx.officialName(p.solar_system_id) || p.solar_system_id)}</button></div>
    ${extractors.length ? `<div class="col-sec"><h5>提取器</h5><ul class="col-list">${exRows}</ul></div>` : ''}
    ${factoryGroups.size ? `<div class="col-sec"><h5>工厂</h5><div class="col-chips">${[...factoryGroups].map(([sid, n]) => `<span class="pill">${esc(d.schematics.get(sid))} × ${n}</span>`).join(' ')}</div></div>` : ''}
    ${stores.size ? `<div class="col-sec"><h5>仓库 / 发射台存量 <small>最低卖价 ≈ ${formatISK(storeValue)} ISK</small></h5><ul class="col-list">${[...stores].sort((a, b) => b[1] - a[1]).map(([id, n]) => `<li>${icon(id)}<span>${esc(type(id))}</span><b>${formatNumber(n)}</b></li>`).join('')}</ul></div>` : ''}
    <p class="col-foot" title="游戏里打开行星后才刷新">${updated ? '更新于 ' + updated.toLocaleString('zh-CN', { hour12: false }) : ''}</p>
  </div>`;
}

export async function renderColonies(box, force = false) {
  const { esc, formatISK } = ctx;
  if (!ctx.tokenInfo()) { box.innerHTML = '<div class="pi-card"><p class="text-muted">需要先绑定 ESI</p></div>'; return; }
  if (!ctx.hasScopeGroup('planets')) { box.innerHTML = ctx.scopeNeededHtml('planets', '查看我的殖民地'); return; }
  box.innerHTML = '<div class="pi-loading">读取殖民地…</div>';
  let d;
  try { d = await load(force); } catch (error) { box.innerHTML = `<p class="text-muted">殖民地读取失败：${esc(error.message)}</p>`; return; }
  if (!d.list.length) { box.innerHTML = '<div class="pi-card"><p class="text-muted">当前角色没有行星殖民地</p></div>'; return; }
  const now = Date.now();
  const expiries = d.layouts.flatMap((l) => (l.pins || []).filter((x) => x.extractor_details && x.expiry_time).map((x) => new Date(x.expiry_time).getTime()));
  const stopped = expiries.filter((t) => t <= now).length;
  const next = expiries.filter((t) => t > now).sort((a, b) => a - b)[0];
  // 仓库与发射台里的存量，按所选交易中心估值
  const stock = [];
  for (const l of d.layouts) for (const pin of l.pins || []) if (!pin.schematic_id) for (const c of pin.contents || []) stock.push({ type_id: c.type_id, quantity: c.amount });
  const val = await ctx.valuation.items(stock);
  d = { ...d, val };
  box.innerHTML =
    '<div class="valuation-grid">' +
      ctx.valuationCard('殖民地', d.list.length + ' 个', '') +
      ctx.valuationCard('提取器', expiries.length + ' 台', stopped ? `${stopped} 台已停止` : '全部运行中', stopped ? 'is-sell' : 'is-buy') +
      ctx.valuationCard('最早到期', next ? left(next - now) + '后' : '—', next ? new Date(next).toLocaleString('zh-CN', { hour12: false }) : '') +
      ctx.valuation.cards(val, '存量估值') +
    '</div>' +
    `<div class="valuation-toolbar section-gap">${ctx.valuation.select('data-val-src', val.region)}<span class="toolbar-spacer"></span><button class="btn btn-ghost" data-col-reload>刷新</button></div>` +
    '<div class="col-grid">' + d.list.map((p, i) => planetCard(p, d.layouts[i], d.names[i], d)).join('') + '</div>';
  if (!box.dataset.colBound) {
    box.dataset.colBound = '1';
    box.addEventListener('click', (e) => {
      if (e.target.closest('[data-col-reload]')) { renderColonies(box, true); return; }
      const sys = e.target.closest('[data-col-sys]');
      if (sys) ctx.openMapSystem(Number(sys.dataset.colSys));
    });
    box.addEventListener('change', (e) => { if (e.target.matches('[data-val-src]')) { ctx.valuation.set(e.target.value); renderColonies(box); } });
  }
}
