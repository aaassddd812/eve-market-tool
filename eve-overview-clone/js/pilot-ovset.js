// 总览配置（照客户端 overviewPresetSvc / overviewMenuUtil / OverviewSettingsWnd）：
//   · 页签 = 名字 + 用哪个预设（过滤条件）+ 颜色；几个页签可以共用一个预设，改预设会一起变
//   · 右键物体「添加{组名}到总览 / 从总览中移除{组名}」改的是当前页签的预设；改动先记在「未保存」副本里
//     （标题显示「{预设} - 未保存」），和原预设一样了就自动丢掉副本（ChangeSettings → RestoreSavedPreset）
//   · 总览设置窗口：「标签」改页签名字 / 预设 / 颜色、删页签、加页签；「过滤条件」按分类勾物品组，撤销 / 保存 / 另存为 / 删除
//   · 都记在本机（localStorage），下次打开还在
// 分类和物品组列表：assets/eveui/overview-groups.json（tools/ui-assets/overview-groups.py 照客户端 GetListOfCategories 生成）
// 客户端还有的：标签页的「图标过滤条件」、过滤条件的「例外情况」（按状态）、外观 / 舰船 / 杂项 / 历史 —— 模拟里没有对应的东西，没做
let H = null;   // { S, store, esc, tr, UI, root(), defaults(): {预设: Set}, presetLabel(预设): 本地化名, groupName(组): 名, changed(), openWin(id) }
const KEY = 'eve-pilot-ovset';
export const DEFAULT_TABS = [['通用', 'default', '#00cc99'], ['采矿', 'defaultmining', '#ff6600'], ['跃迁到', 'defaultwarpto', '#3399ff'], ['刷怪', 'defaultall', '#ff0000'], ['PVP', 'defaultpvp', '#ffff00'], ['可拾取', 'defaultloot', '#66ff00'], ['打捞', 'defaultdrones', '#668b8b'], ['天体/行星海关', 'defaultwarpto', '#cd950c']];
const EN = () => window.I18N?.lang === 'en';
let C = null;   // { tabs: [[名, 预设, 颜色]], custom: { 名: [组] }, unsaved: { 预设: [组] } }
let GL = null, glLoad = null;   // 分类列表
const V = { pane: 'tabs', preset: '', open: new Set(), q: '', saveAs: null };   // 设置窗口的界面状态

export function initOvSet(hooks) {
  H = hooks;
  let s = null;
  try { s = H.store.getJSON(KEY, null); } catch { /* 默认 */ }
  const ok = (t) => Array.isArray(t) && typeof t[0] === 'string' && typeof t[1] === 'string';
  C = {
    tabs: Array.isArray(s?.tabs) && s.tabs.length && s.tabs.every(ok) ? s.tabs.map((t) => [t[0], t[1], /^#[0-9a-f]{6}$/i.test(t[2]) ? t[2] : '#ffffff']) : DEFAULT_TABS.map((t) => t.slice()),
    custom: s?.custom && typeof s.custom === 'object' ? s.custom : {},
    unsaved: s?.unsaved && typeof s.unsaved === 'object' ? s.unsaved : {},
  };
}
const persist = () => H.store.setJSON(KEY, C);
// 教程按默认页签写的（「点 PVP 页签」），教程里不用自己的页签
export const tabs = () => (H.S.tut ? DEFAULT_TABS : C.tabs);
const isDefault = (p) => Boolean(H.defaults()?.[p]) || p in (H.presetNames?.() || {});
const known = (p) => isDefault(p) || p in C.custom;
// 预设的组：未保存副本 > 自己保存的 > 默认；默认配置还没加载完返回 null（总览全显示）
function base(p) {
  if (p in C.custom) return new Set(C.custom[p]);
  const d = H.defaults();
  return d ? new Set(d[p] || d.default || []) : null;
}
export function groupsOf(p) {
  if (C.unsaved[p]) return new Set(C.unsaved[p]);
  return base(p);
}
export const isUnsaved = (p) => Boolean(C.unsaved[p]);
// 显示名（GetPresetDisplayName）：默认预设用本地化名；有未保存改动加「 - 未保存」（UI/Overview/PresetNotSaved）
export function presetName(p) {
  const n = isDefault(p) ? H.presetLabel(p) : p;
  return isUnsaved(p) ? (EN() ? `${n} - Not Saved` : `${n} - 未保存`) : n;
}
// ChangeSettings：groups 可以是一个组或一组（NPC 合并项）
function change(p, groups, add) {
  const cur = groupsOf(p);
  if (!cur) return;
  for (const g of [].concat(groups)) { if (add) cur.add(g); else cur.delete(g); }
  const b = base(p);
  if (b && b.size === cur.size && [...cur].every((g) => b.has(g))) delete C.unsaved[p];
  else C.unsaved[p] = [...cur].sort((a, b2) => a - b2);
  persist();
  H.changed();
}
// 右键菜单条目（GetToggleEntry）：当前页签的预设显示这个组就给「从总览中移除」，否则「添加…到总览」
// 组号：添加在 NAVIGATIONGROUP2（menuHierarchy 第 6 位），移除在 CHANGESGROUP（第 11 位）
export function toggleEntry(group) {
  if (group == null) return null;
  const p = tabs()[H.S.ovTab ?? 0]?.[1];
  const set = p && groupsOf(p);
  if (!set) return null;
  const name = H.groupName(group);
  return set.has(group)
    ? [EN() ? `Remove ${name} from Overview` : `从总览中移除${name}`, () => change(p, group, false), { g: 11 }]
    : [EN() ? `Add ${name} to Overview` : `添加${name}到总览`, () => change(p, group, true), { g: 6 }];
}
// 总览窗口「更多」菜单（OverviewWindow.GetMenuMoreOptions）：添加标签、打开总览设置
export function moreMenu() {
  return [
    [EN() ? 'Add Tab' : '添加标签', () => addTabPopup(), { ic: `${H.UI}eveicon/system_icons/add_16px.png?v=1` }],
    [EN() ? 'Open Overview Settings' : '打开总览设置', () => open(), { ic: `${H.UI}eveicon/system_icons/settings_16px.png?v=1` }],
  ];
}
function open(pane) {
  if (pane) V.pane = pane;
  H.openWin('ovset');
  render();
}
function addTab(name, preset) {
  const n = C.tabs.length + 1;
  C.tabs.push([name || (EN() ? `Tab ${n}` : `标签 ${n}`), preset || 'default', '#ffffff']);
  persist();
  H.changed(true);
}
const MAX_NAME = 30;   // 客户端 ChangeTabName 的 maxLength
const CHECK = () => `${H.UI}eveicon/system_icons/checkmark_16px.png?v=1`;
// 默认筛选条件按显示名排（GetDefaultFiltersSorted），自定义的按名字排（GetCustomFiltersSorted）
const defaultsSorted = () => Object.keys(H.presetNames?.() || {}).sort((a, b) => cmp(H.presetLabel(a), H.presetLabel(b)));
const customSorted = () => Object.keys(C.custom).sort(cmp);
// 定向扫描「显示结果」的选项（GetPresetOptions）：自定义的在前，再默认的
export const presetOptions = () => [...customSorted(), ...defaultsSorted()].map((p) => [presetName(p), p]);
// 页签右键（OverviewTab.GetMenu）：筛选条件 ▸、更改名称、删除标签（多于一个页签才有，DESTRUCTIVEGROUP）
// 客户端还有图标过滤条件 ▸、列 ▸、移动标签到 ▸（多个总览窗口）——模拟里没有
export function tabMenu(i) {
  const t = tabs()[i];
  if (!t || H.S.tut) return [];
  const pick = (p) => [presetName(p), () => setTabPreset(i, p), p === t[1] ? { ic: CHECK() } : {}];
  const sub = [];
  const mine = customSorted();
  if (mine.length) sub.push([EN() ? 'Custom Filters' : '自定义过滤条件', null, { lbl: true }], ...mine.map(pick));
  sub.push([EN() ? 'Default Filters' : '默认筛选条件', null, { lbl: true }], ...defaultsSorted().map(pick));
  sub.push(null, [EN() ? 'Edit Current' : '编辑当前信息', () => { V.preset = t[1]; open('filters'); }, { ic: `${H.UI}eveicon/system_icons/settings_16px.png?v=1` }]);
  const out = [[EN() ? 'Filter' : '筛选条件', sub, { ic: `${H.UI}eveicon/system_icons/filter_16px.png?v=1` }], null,
    [EN() ? 'Change Name' : '更改名称', () => namePopup({ title: EN() ? 'Change Name' : '更改名称', label: EN() ? 'Type in new name' : '输入新名称', value: t[0], ok: (n) => { C.tabs[i][0] = n; persist(); H.changed(true); } })]];
  if (C.tabs.length > 1) out.push([EN() ? 'Delete Tab' : '删除标签', () => delTab(i), { warn: true }]);
  return out;
}
function setTabPreset(i, p) {
  if (!C.tabs[i]) return;
  C.tabs[i][1] = p;
  persist();
  H.changed(true);
}
function delTab(i) {
  if (C.tabs.length < 2) return;
  C.tabs.splice(i, 1);
  if ((H.S.ovTab ?? 0) >= C.tabs.length) H.S.ovTab = C.tabs.length - 1;
  persist();
  H.changed(true);
}
// 「添加标签」窗口（AddTabPopup）：说明、标签名、筛选条件（默认选排在第一的默认筛选条件）
export function addTabPopup() {
  if (H.S.tut) return;
  namePopup({ title: EN() ? 'Add Tab' : '添加标签', body: EN() ? 'Set the name and the presets for the new tab. These settings can be changed later from the tab right click menu or in the Overview Settings.' : '为新标签设置名称和预设。这些设置可以稍后在总览设置的标签右键菜单中更改。',
    label: EN() ? 'Tab Name' : '标签名', value: '', preset: defaultsSorted()[0] || 'default', ok: (n, p) => addTab(n, p) });
}
// 起名小窗（NamePopup）：画面中间，回车 = 确定，Esc = 取消
let POP = null;
function namePopup(o) {
  POP = o;
  const stage = H.root()?.querySelector('#plStage');
  if (!stage) return;
  stage.querySelector('.pl-os-pop')?.remove();
  const el = document.createElement('div');
  el.className = 'pl-os-pop';
  el.innerHTML = `<div class="pl-os-popw"><div class="hd"><span>${H.esc(o.title)}</span><button type="button" data-os-popx><img src="${H.UI}classes/window/btnclose.png?v=1" alt=""></button></div>
    ${o.body ? `<p>${H.esc(o.body)}</p>` : ''}
    <label>${H.esc(o.label)}<input type="text" maxlength="${MAX_NAME}" value="${H.esc(o.value || '')}" data-os-popname></label>
    ${o.preset ? `<label>${L('筛选条件', 'Filter')}<select data-os-poppreset>${presetOpts(o.preset)}</select></label>` : ''}
    <div class="btns"><button type="button" class="pl-btn" data-os-popok>${L('确定', 'OK')}</button><button type="button" class="pl-btn" data-os-popx>${L('取消', 'Cancel')}</button></div></div>`;
  stage.appendChild(el);
  const inp = el.querySelector('[data-os-popname]');
  inp.focus();
  inp.select();
}
function popClose() { H.root()?.querySelector('.pl-os-pop')?.remove(); POP = null; }
function popOk() {
  const el = H.root()?.querySelector('.pl-os-pop');
  const n = el?.querySelector('[data-os-popname]')?.value.trim();
  if (!POP || !n) return;
  const p = el.querySelector('[data-os-poppreset]')?.value;
  const f = POP.ok;
  popClose();
  f(n, p);
}

// ---------- 设置窗口 ----------
const L = (zh, en) => H.esc(EN() ? en : zh);
const loadGroups = () => (glLoad ||= fetch(`${H.UI}overview-groups.json?v=1`).then((r) => (r.ok ? r.json() : { cats: [] })).catch(() => ({ cats: [] })).then((d) => { GL = d.cats || []; render(); }));
// 预设下拉的选项（GetFilterComboOptions）：默认预设在前，自己保存的按名字排
function presetOpts(sel) {
  const def = Object.keys(H.presetNames?.() || {});
  const mine = Object.keys(C.custom).sort((a, b) => a.localeCompare(b));
  return [...def, ...mine].map((p) => `<option value="${H.esc(p)}"${p === sel ? ' selected' : ''}>${H.esc(presetName(p))}</option>`).join('');
}
export const body = () => '<div class="pl-os" id="plOvSet"></div>';
export function render() {
  const el = H.root()?.querySelector('#plOvSet');
  if (!el || el.closest('[data-win]')?.hidden) return;
  const panes = [['tabs', '标签', 'Tabs'], ['filters', '过滤条件', 'Filters']];
  el.innerHTML = `<div class="pl-os-tabs">${panes.map(([k, zh, en]) => `<button type="button" data-os-pane="${k}"${V.pane === k ? ' class="on"' : ''}>${L(zh, en)}</button>`).join('')}</div>
    <div class="pl-os-body">${V.pane === 'tabs' ? tabsPane() : filtersPane()}</div>`;
}
function tabsPane() {
  const rows = C.tabs.map(([n, p, c], i) => `<div class="pl-os-trow">
      <input type="color" value="${H.esc(c)}" data-os-tcolor="${i}" title="${L('颜色', 'Color')}">
      <input type="text" maxlength="${MAX_NAME}" value="${H.esc(n)}" data-os-tname="${i}">
      <select data-os-tpreset="${i}" title="${L('这个选项决定了你在总览窗口中可以看到那些物体。', 'This option defines which entities are visible in the Overview window when this tab is active.')}">${presetOpts(p)}</select>
      <button type="button" class="x" data-os-tdel="${i}" title="${L('删除标签', 'Delete Tab')}"${C.tabs.length < 2 ? ' disabled' : ''}><img src="${H.UI}classes/window/btnclose.png?v=1" alt=""></button></div>`).join('');
  return `<div class="pl-os-thead"><span></span><span>${L('标签名', 'Tab Name')}</span><span>${L('筛选条件', 'Filter')}</span><span></span></div>${rows}
    <div class="pl-os-btns"><button type="button" class="pl-btn" data-os-tadd>${L('添加标签', 'Add Tab')}</button></div>`;
}
function filtersPane() {
  if (!GL) { loadGroups(); return `<p class="pl-os-wait">${L('加载中…', 'Loading…')}</p>`; }
  const p = known(V.preset) ? V.preset : tabs()[H.S.ovTab ?? 0]?.[1] || 'default';
  V.preset = p;
  const set = groupsOf(p) || new Set();
  const q = V.q.trim().toLowerCase();
  const nm = (g) => (EN() ? g[2] : g[1]);
  const on = (g) => (Array.isArray(g[0]) ? g[0].some((x) => set.has(x)) : set.has(g[0]));
  const cats = GL.map((c, ci) => ({ c, ci, g: c.g.filter((g) => !q || nm(g).toLowerCase().includes(q) || g[2].toLowerCase().includes(q)) })).filter((x) => x.g.length)
    .sort((a, b) => cmp(EN() ? a.c.n[1] : a.c.n[0], EN() ? b.c.n[1] : b.c.n[0]));
  for (const x of cats) x.g = x.g.slice().sort((a, b) => cmp(nm(a), nm(b)));
  const list = cats.map(({ c, ci, g }) => {
    const k = g.filter(on).length;
    const open = V.open.has(ci) || Boolean(q);
    // 分类名颜色（_GetListGroupLabelColor）：全选 = 主题色，部分 = 高亮，没有 = 次要
    const cls = k >= g.length ? 'all' : k ? 'some' : '';
    const items = open ? g.map((x) => `<button type="button" class="pl-os-g" data-os-g="${ci}:${c.g.indexOf(x)}"><img src="${H.UI}classes/utilmenu/checkbox${on(x) ? 'active' : 'inactive'}.png?v=1" alt=""><span>${H.esc(nm(x))}</span></button>`).join('') : '';
    return `<div class="pl-os-cat"><button type="button" class="pl-os-ch ${cls}" data-os-cat="${ci}"><img class="ar${open ? ' on' : ''}" src="${H.UI}icons/1_16_14.png?v=1" alt=""><span>${H.esc(EN() ? c.n[1] : c.n[0])}</span><em>${k} / ${g.length}</em></button>${items}</div>`;
  }).join('');
  const uns = isUnsaved(p), dflt = isDefault(p);
  const saveAs = V.saveAs != null ? `<div class="pl-os-saveas"><span>${L('过滤条件名称', 'Filter Name')}</span><input type="text" maxlength="80" value="${H.esc(V.saveAs)}" data-os-saname><button type="button" class="pl-btn" data-os-saok>${L('确定', 'OK')}</button><button type="button" class="pl-btn" data-os-sacancel>${L('取消', 'Cancel')}</button><em id="plOsErr"></em></div>` : '';
  return `<div class="pl-os-lbl">${L('选择过滤条件进行修改', 'Select filter to edit')}</div>
    <div class="pl-os-top"><select data-os-preset>${presetOpts(p)}</select>${dflt ? '' : `<button type="button" class="pl-btn" data-os-pdel>${L('删除', 'Delete')}</button>`}</div>
    <div class="pl-os-sub"><span class="on">${L('显示类型', 'Types Shown')}</span></div>
    <div class="pl-os-top"><button type="button" class="pl-btn" data-os-all="1">${L('全选', 'Select All')}</button><button type="button" class="pl-btn" data-os-all="0">${L('取消全选', 'Deselect All')}</button><input type="search" class="q" placeholder="${L('搜索', 'Search')}" value="${H.esc(V.q)}" data-os-q></div>
    <div class="pl-os-list">${list}</div>
    ${saveAs}
    <div class="pl-os-btns"><button type="button" class="pl-btn" data-os-revert${uns ? '' : ' disabled'}>${L('撤销', 'Revert')}</button><button type="button" class="pl-btn" data-os-save${uns && !dflt ? '' : ' disabled'}>${L('保存', 'Save')}</button><button type="button" class="pl-btn" data-os-saveas>${L('另存为', 'Save As')}</button></div>`;
}
// 客户端排序是 Python 的 list.sort()：按字符编码比，不按拼音
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// 全选 / 取消全选：只动列表里看得到的（搜索过滤后的）组
function visibleGroups() {
  const q = V.q.trim().toLowerCase(), out = [];
  for (const c of GL || []) for (const g of c.g) if (!q || g[1].toLowerCase().includes(q) || g[2].toLowerCase().includes(q)) out.push(...[].concat(g[0]));
  return out;
}
function doSaveAs() {
  const inp = H.root().querySelector('[data-os-saname]'), n = inp?.value.trim() || '';
  const err = (t) => { const e = H.root().querySelector('#plOsErr'); if (e) e.textContent = t; };
  if (!n) return;
  // 不能用默认预设的名字（IsDefaultPresetName，内部名和显示名都比）
  const lower = n.toLowerCase();
  if (Object.keys(H.presetNames?.() || {}).some((p) => p.toLowerCase() === lower || H.presetLabel(p).toLowerCase() === lower)) { err(EN() ? 'That name is used by a default filter' : '不能使用默认过滤条件的名字'); return; }
  if (n in C.custom && n !== V.preset && inp.dataset.ow !== n) { inp.dataset.ow = n; err(EN() ? 'Already exists — click OK again to overwrite' : '已有同名过滤条件，再点一次「确定」覆盖'); return; }
  C.custom[n] = [...(groupsOf(V.preset) || [])].sort((a, b) => a - b);
  delete C.unsaved[V.preset];
  delete C.unsaved[n];
  // 另存为后当前页签换成新预设（SavePreset → LoadPreset）
  const t = C.tabs[H.S.ovTab ?? 0];
  if (t && t[1] === V.preset) t[1] = n;
  V.preset = n;
  V.saveAs = null;
  persist();
  H.changed(true);
}
export function click(e) {
  const t = e.target;
  let x;
  if (t.closest('[data-os-popok]')) { popOk(); return true; }
  if (t.closest('[data-os-popx]')) { popClose(); return true; }
  if (t.closest('.pl-os-pop')) return true;
  if ((x = t.closest('[data-os-pane]'))) { V.pane = x.dataset.osPane; V.saveAs = null; render(); return true; }
  if (t.closest('[data-os-tadd]')) { addTabPopup(); return true; }
  if ((x = t.closest('[data-os-tdel]'))) { delTab(Number(x.dataset.osTdel)); return true; }
  if ((x = t.closest('[data-os-cat]'))) { const ci = Number(x.dataset.osCat); if (V.open.has(ci)) V.open.delete(ci); else V.open.add(ci); render(); return true; }
  if ((x = t.closest('[data-os-g]'))) {
    const [ci, gi] = x.dataset.osG.split(':').map(Number), g = GL[ci]?.g[gi];
    if (!g) return true;
    const set = groupsOf(V.preset) || new Set();
    const on = [].concat(g[0]).some((y) => set.has(y));
    change(V.preset, g[0], !on); render(); return true;
  }
  if ((x = t.closest('[data-os-all]'))) { change(V.preset, visibleGroups(), x.dataset.osAll === '1'); render(); return true; }
  if (t.closest('[data-os-revert]')) { delete C.unsaved[V.preset]; persist(); H.changed(); render(); return true; }
  if (t.closest('[data-os-save]')) {
    if (!isUnsaved(V.preset) || isDefault(V.preset)) return true;
    C.custom[V.preset] = C.unsaved[V.preset]; delete C.unsaved[V.preset]; persist(); H.changed(); render(); return true;
  }
  if (t.closest('[data-os-saveas]')) { V.saveAs = presetName(V.preset).replace(/ - (未保存|Not Saved)$/, ''); render(); H.root().querySelector('[data-os-saname]')?.select(); return true; }
  if (t.closest('[data-os-sacancel]')) { V.saveAs = null; render(); return true; }
  if (t.closest('[data-os-saok]')) { doSaveAs(); return true; }
  if (t.closest('[data-os-pdel]')) {
    const p = V.preset;
    if (isDefault(p)) return true;
    delete C.custom[p]; delete C.unsaved[p];
    // 用这个预设的页签换回默认预设（DeletePreset → LoadPreset(defaultPreset)）
    for (const tb of C.tabs) if (tb[1] === p) tb[1] = 'default';
    V.preset = '';
    persist(); H.changed(true); render(); return true;
  }
  return false;
}
// 输入框 / 下拉 / 颜色的 change 和 input
export function input(e) {
  const t = e.target;
  if (t.matches('[data-os-q]')) { V.q = t.value; const pos = t.selectionStart; render(); const q = H.root().querySelector('[data-os-q]'); q?.focus(); q?.setSelectionRange(pos, pos); return true; }
  if (t.matches('[data-os-saname]')) { delete t.dataset.ow; return true; }
  return false;
}
export function change2(e) {
  const t = e.target;
  if (t.matches('[data-os-preset]')) { V.preset = t.value; V.saveAs = null; render(); return true; }
  const set = (i, k, v) => { if (!C.tabs[i]) return; C.tabs[i][k] = v; persist(); H.changed(true); };
  if (t.matches('[data-os-tname]')) { const v = t.value.trim(); if (v) set(Number(t.dataset.osTname), 0, v); else t.value = C.tabs[Number(t.dataset.osTname)]?.[0] || ''; return true; }
  if (t.matches('[data-os-tpreset]')) { set(Number(t.dataset.osTpreset), 1, t.value); return true; }
  if (t.matches('[data-os-tcolor]')) { set(Number(t.dataset.osTcolor), 2, t.value); return true; }
  return false;
}
export function keydown(e) {
  if (POP && e.target.closest?.('.pl-os-pop')) { if (e.key === 'Enter') { popOk(); return true; } if (e.key === 'Escape') { popClose(); return true; } }
  if (e.key === 'Enter' && e.target.matches?.('[data-os-saname]')) { doSaveAs(); return true; }
  if (e.key === 'Enter' && e.target.matches?.('[data-os-tname]')) { e.target.blur(); return true; }
  return false;
}
