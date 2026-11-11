// 主界面：侧栏页面切换、顶部角色切换 / 添加 / 移除、服务器切换；各页面是 views/*.js 的 render(box, acc)
// 后台常驻：深渊位置监控（views/abyss.js）、日志增量扫描（logscan.js）、剪贴板监控（clip.js）
import { inApp, store } from './platform.js';
import { SERVERS, SERVER, setServer, portrait } from './servers.js';
import { accounts, activeAccount, setActive, removeAccount, startLogin, finishLogin } from './esi.js';
import { esc, loadTypeNames } from './data.js';
import * as overview from './views/overview.js';
import * as skills from './views/skills.js';
import * as wallet from './views/wallet.js';
import * as abyss from './views/abyss.js';
import * as assets from './views/assets.js';
import * as orders from './views/orders.js';
import * as live from './views/live.js';
import * as LS from './logscan.js';
import * as CLIP from './clip.js';

const VIEWS = { overview, skills, wallet, live, abyss, assets, orders };
const $ = (id) => document.getElementById(id);
let current = store.get('lite-view', 'overview');
if (!VIEWS[current]) current = 'overview';
let seq = 0;

export function toast(msg, kind = '', ms = 3000) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}
window.__toast = toast;

function renderChars() {
  const acc = activeAccount();
  $('chars').innerHTML = accounts().map((a) => `<button class="char-chip${a.character_id === acc?.character_id ? ' active' : ''}" data-char="${a.character_id}">
    <img src="${portrait(a.character_id, 32)}" alt="">${esc(a.character_name)}<span class="x" data-remove="${a.character_id}" title="移除这个角色">×</span></button>`).join('');
}

export async function render() {
  const my = ++seq;
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === current));
  renderChars();
  const box = $('view');
  box.dataset.view = current;   // 各页面后台刷新前核对：容器已经换成别的页面就不画
  box.onclick = box.onchange = box.oninput = null;
  const acc = activeAccount();
  if (!acc) {
    box.innerHTML = `<div class="empty"><h3>还没有添加角色</h3><p>添加角色后可以查看角色、技能、钱包与刷怪收益、资产和订单，并自动记录每一趟深渊。<br>令牌只保存在这台电脑上。</p><button class="btn primary" data-act="add">＋ 添加角色</button></div>`;
    return;
  }
  box.innerHTML = '<div class="loading">加载中…</div>';
  try {
    await VIEWS[current].render(box, acc, { isCurrent: () => my === seq, rerender: render });
  } catch (e) {
    if (my === seq) box.innerHTML = `<div class="empty">加载失败：${esc(e.message)}<br><button class="btn" data-act="retry">重试</button></div>`;
  }
}

// ---------- 登录 ----------
function openLogin() {
  $('callbackInput').value = '';
  $('loginErr').textContent = '';
  $('loginHint').textContent = '';
  $('loginDlg').showModal();
}
async function doOpenLogin() {
  $('loginErr').textContent = '';
  try {
    await startLogin();
    $('loginHint').textContent = '已在浏览器打开登录页';
  } catch (e) { $('loginErr').textContent = e.message; }
}
async function doFinish() {
  const raw = $('callbackInput').value.trim();
  if (!raw) { $('loginErr').textContent = '请粘贴登录后浏览器地址栏的完整地址'; return; }
  $('loginDone').disabled = true;
  try {
    const acc = await finishLogin(raw);
    $('loginDlg').close();
    toast('已添加：' + acc.character_name);
    abyss.restartMonitor();
    render();
  } catch (e) {
    $('loginErr').textContent = e.message;
  } finally {
    $('loginDone').disabled = false;
  }
}

// ---------- 事件 ----------
document.addEventListener('click', (e) => {
  const nav = e.target.closest('#nav button');
  if (nav) { current = nav.dataset.view; store.set('lite-view', current); render(); return; }
  const rm = e.target.closest('[data-remove]');
  if (rm) {
    e.stopPropagation();
    const id = Number(rm.dataset.remove);
    const a = accounts().find((x) => x.character_id === id);
    if (a && confirm(`移除角色「${a.character_name}」？本机保存的令牌会删除（深渊记录保留）。`)) { removeAccount(id); abyss.restartMonitor(); render(); }
    return;
  }
  const chip = e.target.closest('[data-char]');
  if (chip) { setActive(Number(chip.dataset.char)); render(); return; }
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'add') openLogin();
  if (act === 'retry') render();
});
$('addChar').addEventListener('click', openLogin);
$('refreshBtn').addEventListener('click', () => render());
$('openLogin').addEventListener('click', doOpenLogin);
$('loginDone').addEventListener('click', doFinish);
$('loginCancel').addEventListener('click', () => $('loginDlg').close());
$('callbackInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doFinish(); } });

const sel = $('serverSel');
sel.innerHTML = Object.values(SERVERS).map((s) => `<option value="${s.id}"${s.id === SERVER.id ? ' selected' : ''}>${s.name}（${s.sub}）</option>`).join('');
sel.addEventListener('change', () => setServer(sel.value));
$('appVer').textContent = inApp ? '' : '浏览器预览';

loadTypeNames().catch((e) => toast('物品名称加载失败：' + e.message, 'error', 5000));
abyss.restartMonitor();
LS.start();      // 日志增量扫描（赏金、采矿、本地频道）
CLIP.start();    // 剪贴板（游戏里复制的货柜）
render();
