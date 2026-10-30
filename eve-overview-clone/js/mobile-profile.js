// ===== 手机个人中心（≤768px）=====
// 首页：角色卡 + 功能宫格（每个入口一句说明）；点进去是子页：顶部「‹ 个人中心」返回条 + 当前页名，
// 子页里不再显示角色大卡片和 14 个标签的横条。进入子页时 pushState 记一条，手机返回键 / 浏览器后退回到宫格。
// 宽屏不受影响（.pm-* 只在 768px 断点里显示）。

const ICON = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
// [图标, 说明]
const META = {
  info: [ICON('<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>'), '种族、军团、位置、当前舰船'],
  skills: [ICON('<path d="M12 3 3 8l9 5 9-5z"/><path d="m3 13 9 5 9-5"/>'), '技能、训练队列、技能规划'],
  assets: [ICON('<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5M12 13v8"/>'), '资产估值、各空间站物品'],
  orders: [ICON('<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>'), '挂单与被压价提醒'],
  trades: [ICON('<path d="M7 4v16M7 4 3.5 7.5M7 4l3.5 3.5"/><path d="M17 20V4M17 20l-3.5-3.5M17 20l3.5-3.5"/>'), '买卖成交与盈亏'],
  contracts: [ICON('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>'), '个人与军团合同'],
  combat: [ICON('<circle cx="12" cy="12" r="8"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>'), '击杀与损失'],
  wallet: [ICON('<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20M16 15h2"/>'), '收支流水与分类'],
  clones: [ICON('<rect x="7" y="3" width="10" height="18" rx="3"/><path d="M11 7h2M10 17h4"/>'), '跳跃克隆、植入体'],
  mining: [ICON('<path d="m14 4 6 6-9 9-6-6z"/><path d="m3 21 4-4"/>'), '挖矿产量与价值'],
  research: [ICON('<path d="M9 3h6M10 3v6L4 19a1 1 0 0 0 .9 1.5h14.2A1 1 0 0 0 20 19l-6-10V3"/>'), '研究点数累积'],
  fleet: [ICON('<path d="M12 3 4 9l8 4 8-4z"/><path d="m4 15 8 4 8-4"/>'), '舰队成员与编队'],
  mail: [ICON('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>'), '游戏邮件'],
  corp: [ICON('<path d="M3 21h18M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/>'), '成员、建筑与军团事务']
};
const BACK = ICON('<path d="m15 18-6-6 6-6"/>');

let query = null, open = null, box = null, grid = null, bar = null, sub = false;

const tabs = () => [...document.querySelectorAll('.profile-tabs .tab-link')];

function renderGrid() {
  grid.innerHTML = tabs().filter((t) => !t.hidden).map((t) => {
    const [icon, desc] = META[t.dataset.profile] || [ICON('<circle cx="12" cy="12" r="8"/>'), ''];
    return `<button type="button" class="pm-tile" data-pm-open="${t.dataset.profile}">${icon}<b>${t.textContent.trim()}</b>${desc ? `<small>${desc}</small>` : ''}</button>`;
  }).join('');
}

function setHome() {
  sub = false;
  box.classList.remove('pm-sub');
  renderGrid();
}

// 进入子页（个人中心任何地方切换标签都会走到这里）
export function profileEntered(tab) {
  if (!box || !query.matches) return;
  const t = tabs().find((x) => x.dataset.profile === tab);
  bar.querySelector('.pm-title').textContent = t ? t.textContent.trim() : '';
  if (!sub) {
    sub = true;
    history.pushState({ ...(history.state || {}), pm: tab }, '', location.href);
  }
  box.classList.add('pm-sub');
}

export function initMobileProfile(mq, openTab) {
  query = mq;
  open = openTab;
  box = document.querySelector('.profile-container');
  const header = document.querySelector('#profileContent .profile-header');
  const strip = document.querySelector('#profileContent .profile-tabs');
  if (!box || !header || !strip) return;
  grid = document.createElement('div');
  grid.className = 'pm-grid';
  header.after(grid);
  bar = document.createElement('div');
  bar.className = 'pm-bar';
  bar.innerHTML = `<button type="button" class="pm-back" data-pm-back>${BACK}<span>个人中心</span></button><b class="pm-title"></b>`;
  strip.before(bar);
  renderGrid();
  grid.addEventListener('click', (e) => { const t = e.target.closest('[data-pm-open]'); if (t) open(t.dataset.pmOpen); });
  bar.addEventListener('click', (e) => {
    if (!e.target.closest('[data-pm-back]')) return;
    if (history.state?.pm) history.back(); else setHome();
  });
  window.addEventListener('popstate', () => { if (sub && !history.state?.pm) setHome(); });
  // 战斗记录等入口按服务器显示 / 隐藏，宫格跟着变
  new MutationObserver(() => { if (!sub) renderGrid(); }).observe(strip, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
}
