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
