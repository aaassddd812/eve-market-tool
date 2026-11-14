// ===== 骨架屏 =====
// 数据加载期间按最终布局显示灰色占位块（带微光动画），避免页面跳动；样式见 modern-style.css「骨架屏」。
const line = (w, cls = '') => `<span class="sk sk-line${cls ? ' ' + cls : ''}" style="width:${w}%"></span>`;
const widths = [62, 48, 70, 55, 66, 44, 58, 72, 50, 64];
const repeat = (n, fn) => Array.from({ length: n }, (_, i) => fn(i)).join('');

// 统计卡片（.valuation-card 尺寸）
export function skCards(n = 5, cls = '') {
  return `<div class="valuation-grid${cls ? ' ' + cls : ''}">` + repeat(n, (i) =>
    `<div class="valuation-card sk-card">${line(40 + (i % 3) * 8, 'sm')}${line(60 + (i % 2) * 12, 'lg')}${line(46 + (i % 4) * 6, 'sm')}</div>`) + '</div>';
}

// 列表行：图标 + 两行文字 + 右侧数值（击杀记录、合同等表格）
export function skRows(n = 8, { img = 32 } = {}) {
  return '<div class="sk-list">' + repeat(n, (i) => `<div class="sk-row">
      <span class="sk sk-img" style="width:${img}px;height:${img}px"></span>
      <span class="sk-col">${line(widths[i % 10] * 0.7, '')}${line(widths[(i + 3) % 10] * 0.45, 'sm')}</span>
      <span class="sk-col sk-col-narrow">${line(70 - (i % 3) * 10, '')}${line(45, 'sm')}</span>
      <span class="sk sk-line sk-value" style="width:${64 + (i % 3) * 14}px"></span>
    </div>`) + '</div>';
}

// 分段筛选按钮占位
export function skToolbar(n = 3) {
  return '<div class="sk-toolbar">' + repeat(n, (i) => `<span class="sk sk-pill" style="width:${64 + (i % 2) * 14}px"></span>`) + '</div>';
}

// 击杀记录页「最高损失」卡片
export function skTopCards(n = 10) {
  return repeat(n, (i) => `<div class="kb-top-card sk-static">
      <span class="sk sk-img" style="width:72px;height:72px"></span>
      <span class="kb-top-text">${line(widths[i % 10], '')}${line(48, 'sm')}${line(66, 'sm')}</span>
      <span class="sk sk-line" style="width:56px"></span>
    </div>`);
}

// 排行榜行：名次 + 头像 + 名称 + 数值
export function skBoard(n = 10) {
  return '<div class="sk-list sk-board">' + repeat(n, (i) => `<div class="sk-row">
      <span class="sk sk-rank"></span><span class="sk sk-img" style="width:30px;height:30px"></span>
      <span class="sk-col">${line(widths[i % 10], '')}</span>
      <span class="sk-col sk-col-narrow sk-right">${line(80, '')}${line(50, 'sm')}</span>
    </div>`) + '</div>';
}

// 击杀记录页首页统计：3 张卡片 + 每小时柱状图
export function skSummary() {
  return `<div class="kb-summary-cards" aria-busy="true">${repeat(3, (i) =>
    `<div class="valuation-card sk-card">${line(44, 'sm')}${line(58 + i * 6, 'lg')}${line(70, 'sm')}</div>`)}</div>
    <div class="kb-hours"><div class="kb-hours-head">${line(22, 'sm')}${line(16, 'sm')}</div>
      <div class="kb-bars sk-bars">${repeat(24, (i) => `<i class="sk" style="height:${22 + ((i * 37) % 60)}%"></i>`)}</div></div>`;
}

// 人物 / 军团 / 联盟页头部
export function skEntityHead() {
  return `<div class="kb-entity-head sk-static"><span class="sk sk-img" style="width:72px;height:72px;border-radius:12px"></span>
    <div class="sk-col">${line(12, 'sm')}${line(36, 'xl')}${line(54, 'sm')}</div></div>`;
}

// 小标题
export function skTitle(w = 18) {
  return `<div class="sk-title">${line(w, '')}</div>`;
}

// 段落文字：长短不一的几行（文章正文、设置面板）
export function skText(n = 6) {
  return '<div class="sk-text" aria-busy="true">' + repeat(n, (i) => line(i % 5 === 4 ? 38 : widths[i % 10] + 24, '')) + '</div>';
}

// 卡片网格（深渊装备列表等）：图标 + 名称 + 几行属性
export function skGrid(n = 6) {
  return '<div class="sk-grid" aria-busy="true">' + repeat(n, (i) => `<div class="sk-gcard">
      <div class="sk-row sk-flat"><span class="sk sk-img" style="width:36px;height:36px"></span><span class="sk-col">${line(widths[i % 10], '')}${line(40, 'sm')}</span></div>
      ${repeat(4, (j) => line(88 - ((i + j) % 4) * 9, 'sm'))}${line(34, '')}</div>`) + '</div>';
}

// 整页：标题 + 分段按钮 + 统计卡片 + 列表 / 卡片网格（各功能页首次载入时用）
export function skPage({ title = true, tabs = 0, cards = 0, rows = 8, grid = 0, img = 32 } = {}) {
  return `<div class="sk-page" aria-busy="true">${title ? skTitle(14) : ''}${tabs ? skToolbar(tabs) : ''}${cards ? skCards(cards, 'sk-cards') : ''}${grid ? skGrid(grid) : rows ? skRows(rows, { img }) : ''}</div>`;
}

// 驾驶模拟设置页：用真页面的外框（pl-page / pl-win / pl-setup-grid / pl-lobby），标题和三个页签直接画真字，
// 下面按上次停留的页签（单人 / 练习 / 匹配对战）画占位，模块下载完换成真页面时不跳动
const blk = (w, h, r = 6, extra = '') => `<span class="sk" style="display:inline-block;width:${w}${typeof w === 'number' ? 'px' : ''};height:${h}px;border-radius:${r}px;vertical-align:middle;${extra}"></span>`;
const field = (label, body) => `<div class="pl-field"><label>${label}</label>${body}</div>`;
const chips = (ws) => `<div style="display:flex;flex-wrap:wrap;gap:8px">${ws.map((w) => blk(w, 38, 999)).join('')}</div>`;
const seg = (n, w = 52) => blk(n * w + 8, 32, 6);
export function skPilot(tab = 'solo') {
  const tabs = [['solo', '单人'], ['tut', '练习'], ['match', '匹配对战']];
  const head = `<div class="pl-win-head"><h3>驾驶模拟</h3><div class="segmented pl-tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" class="${k === tab ? 'active' : ''}" disabled>${l}</button>`).join('')}</div></div>`;
  let body;
  if (tab === 'tut') {
    const row = (n) => `<div class="sim-opt-row"><span class="sim-opt-label">${blk(48, 12)}</span><div class="sim-scenes">${repeat(n, () => blk(110, 48, 6))}</div></div>`;
    body = `<div class="pl-tut-page">${seg(2, 96)}<div class="sim-opts">${row(7)}${row(6)}${row(3)}</div>
      <section class="sim-start">${line(14, 'lg')}${line(26, 'sm')}${line(42)}${line(36)}${line(30)}${line(12, 'sm')}</section></div>
      <div class="pl-setup-foot">${blk(160, 38, 6)}${blk(320, 12, 6, 'margin-left:14px')}</div>`;
  } else if (tab === 'match') {
    body = `<div class="pl-lobby"><section class="pl-lobby-main"><div class="pl-lobby-head">${blk(70, 18)}${seg(3, 40)}<span class="pl-lobby-sp"></span>${blk(110, 36)}${blk(60, 14)}</div>
      <div class="pl-rtable" aria-busy="true">${blk('100%', 34, 0)}${skRows(5)}</div></section>
      <aside class="pl-lobby-side">${field('我的船', `<div style="display:flex;flex-direction:column;gap:8px">${chips([140])}${blk('100%', 36)}${blk('100%', 34)}</div>`)}
      ${field('模式', seg(2, 38))}${field('装配价值上限', seg(3, 46))}${field('技能', seg(2, 60))}${blk('100%', 38)}</aside></div>`;
  } else {
    body = `<div class="pl-setup-grid">${field('预设场景', `<div style="display:flex;flex-direction:column;gap:12px">${seg(3, 76)}${chips([130, 186, 144, 130, 172, 152, 130])}</div>`).replace('pl-field', 'pl-field pl-span')}
      ${field('我方', `<div style="display:flex;flex-direction:column;gap:10px">${blk('100%', 92, 10)}${blk('100%', 36)}</div>`)}
      ${field('敌人', `<div style="display:flex;flex-direction:column;gap:10px"><div style="display:flex;gap:12px;align-items:center">${chips([110])}${blk(72, 36)}${blk(60, 14)}</div>${blk('100%', 36)}</div>`)}
      ${field('开局距离', seg(5, 54))}${field('星空', seg(5, 54))}</div>
      <div class="pl-setup-foot">${blk(160, 38, 6)}</div>`;
  }
  return `<div class="pl-page" aria-busy="true"><section class="pl-setup"><div class="pl-win pl-w pl-big">${head}${body}</div></section></div>`;
}
