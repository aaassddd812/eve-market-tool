// ===== 预警（右上角铃铛）=====
// 击杀预警（kill-alert.js）与本地日志（intel.js）合在一个弹窗里，两个标签页；检测与设置还是各自的模块，这里只管弹窗、标签切换和标签上的状态点。
// 两个模块都是点到对应标签页时才加载（已开启的会在页面打开时由 modern-app.js 先加载）。上次看的标签页记在 eve-alert-tab。
// 弹窗在电脑上固定 680×760（切换标签页不变大小），设置一栏排；手机上全屏。
// 第三个标签页「游戏邮件」（alert-mail.js）集中设置收件人与哪些预警发邮件；打开它时先加载两个预警模块（它们会登记自己的邮件开关）。
// 「本地红名」（local-watch.js）：共享游戏画面，本地频道出现红名就报警。
// 「虫洞求救」（sos-watch.js）：有人在虫洞里发求救时提醒（虫洞页「求救」也有入口）。
// 「消息推送」（alert-push.js）：企业微信、邮箱、Server酱、PushPlus、钉钉、飞书、Bark。

import * as AM from './alert-mail.js?v=v8';
import * as AP from './alert-push.js?v=v11';
import { skText } from './skeleton.js?v=v17';

let deps = null;   // { loadKill, loadIntel, loadLocal, loadSos, esc, showToast, host（服务器托管用，见 alert-host.js）}
let modal = null;
let tab = 'kill';
const TAB_KEY = 'eve-alert-tab';
const TABS = [['kill', '击杀预警'], ['intel', '本地日志'], ['local', '本地红名'], ['sos', '虫洞求救'], ['mail', '游戏邮件'], ['push', '消息推送']];
const state = { kill: false, intel: false, local: false, sos: false, mail: false, push: false };

export function initAlertCenter(d) {
  deps = d;
  AP.initAlertPush({ esc: d.esc, showToast: d.showToast, host: d.host });
  AP.onPushChange(() => setTabState('push', AP.isOn()));
  state.push = AP.isOn();
  try { const t = localStorage.getItem(TAB_KEY); if (TABS.some(([k]) => k === t)) tab = t; } catch { /* 忽略 */ }
}

const close = () => { if (modal) modal.hidden = true; };
const isOpen = (el) => Boolean(modal && !modal.hidden && !el.hidden);

function build() {
  if (modal) return;
  modal = document.createElement('div');
  modal.className = 'modal';
  modal.id = 'alertCenter';
  modal.hidden = true;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'alertCenterTitle');
  modal.innerHTML = `<div class="modal-backdrop" data-ac-dismiss></div><div class="modal-content ka-modal ac-modal">
    <div class="modal-header ac-head"><h3 id="alertCenterTitle">预警</h3>
      <div class="segmented ac-tabs" role="tablist">${TABS.map(([k, l]) => `<button type="button" role="tab" data-ac-tab="${k}"><i class="ac-dot" aria-hidden="true"></i>${l}</button>`).join('')}</div>
      <button class="modal-close" data-ac-dismiss aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>
    <div class="modal-body">${TABS.map(([k]) => `<div class="ac-pane" data-ac-pane="${k}" role="tabpanel" hidden>${skText(8)}</div>`).join('')}</div></div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-ac-dismiss]')) { close(); return; }
    const t = e.target.closest('[data-ac-tab], [data-ac-goto]');
    if (t) show(t.dataset.acTab || t.dataset.acGoto);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal && !modal.hidden) { e.stopImmediatePropagation(); close(); } }, true);
  paintTabs();
}

function paintTabs() {
  if (!modal) return;
  modal.querySelectorAll('[data-ac-tab]').forEach((b) => {
    const k = b.dataset.acTab;
    b.classList.toggle('active', k === tab);
    b.setAttribute('aria-selected', String(k === tab));
    b.classList.toggle('on', state[k]);
  });
}

// 标签上的状态点（开启时亮），由 modern-app.js 在两个模块状态变化时调用
export function setTabState(which, on) {
  state[which] = Boolean(on);
  paintTabs();
}

async function show(which) {
  tab = TABS.some(([k]) => k === which) ? which : 'kill';
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* 忽略 */ }
  paintTabs();
  modal.querySelectorAll('[data-ac-pane]').forEach((p) => { p.hidden = p.dataset.acPane !== tab; });
  const want = tab;
  const pane = modal.querySelector(`[data-ac-pane="${want}"]`);
  try {
    const m = want === 'kill' ? await deps.loadKill() : want === 'intel' ? await deps.loadIntel() : want === 'local' ? await deps.loadLocal() : want === 'sos' ? await deps.loadSos() : want === 'push' ? AP
      : await Promise.allSettled([deps.loadKill(), deps.loadIntel(), deps.loadSos()]).then(() => AM);
    m.mountPanel(pane, { close, isOpen });
    if (tab === want) m.showPanel();
  } catch (error) {
    pane.innerHTML = `<p class="ka-warn">加载失败：${deps.esc(error.message)}</p>`;
  }
}

// 打开弹窗（which 不填就回到上次看的标签页）
export function openAlertCenter(which) {
  build();
  modal.hidden = false;
  return show(which || tab);
}
