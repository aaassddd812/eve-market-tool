// 程序本身：启动上报（统计使用人数）和自动更新。
//   上报：每次启动向本站 POST /api/kb/lite/ping {iid, ver, server}。iid 是第一次运行时随机生成的安装 ID，
//         不带角色、账号、令牌等任何信息，只用来数有多少台电脑在用；失败不提示、不重试。
//   更新：启动 5 秒后检查一次，之后每 6 小时检查一次（tauri-plugin-updater，读 eve-tool-desktop 的 lite-latest/lite.json，
//         直连失败走 ghfast 镜像；安装包有签名校验）。有新版本时左下角出现提示，点「更新」才下载安装，安装完程序自动重启。
import { http, store } from './platform.js';
import { SERVER, SITE } from './servers.js';

const T = window.__TAURI__;
const updater = () => T?.updater || window.__MOCK_UPDATER__ || null;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let version = '';
let pending = null;        // 检查到的新版本（Update 对象）
let busy = false;

function installId() {
  let id = store.get('lite-iid', '');
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    id = crypto.randomUUID();
    store.set('lite-iid', id);
  }
  return id;
}

async function ping() {
  if (!T) return;   // 浏览器预览不上报
  try {
    await http(SITE + '/api/kb/lite/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iid: installId(), ver: version, server: SERVER.id })
    });
  } catch { /* 连不上就算了 */ }
}

function paint(text = '') {
  const box = $('updBox');
  if (!box) return;
  $('appVer').textContent = version ? 'v' + version : (T ? '' : '浏览器预览');
  const btn = $('updCheck');
  btn.hidden = !updater();
  btn.disabled = busy;
  if (pending) {
    box.hidden = false;
    box.innerHTML = `<div class="upd-title">发现新版本 v${esc(pending.version)}</div>
      ${text ? `<div class="upd-msg">${esc(text)}</div>` : ''}
      <button class="btn sm primary" id="updGo"${busy ? ' disabled' : ''}>${busy ? '正在更新…' : '下载并安装'}</button>`;
  } else {
    box.hidden = !text;
    box.innerHTML = text ? `<div class="upd-msg">${esc(text)}</div>` : '';
  }
}

export async function check(manual = false) {
  const u = updater();
  if (!u || busy) return;
  busy = true;
  paint(manual ? '正在检查更新…' : '');
  try {
    pending = await u.check();
    busy = false;
    paint(pending ? '' : manual ? '已经是最新版本' : '');
    if (manual && !pending) setTimeout(() => { if (!pending && !busy) paint(''); }, 4000);
  } catch (e) {
    busy = false;
    paint(manual ? '检查更新失败：' + (e?.message || e) : '');
  }
}

async function install() {
  if (!pending || busy) return;
  busy = true;
  let total = 0, got = 0;
  paint('正在下载…');
  try {
    await pending.downloadAndInstall((ev) => {
      if (ev.event === 'Started') total = ev.data?.contentLength || 0;
      if (ev.event === 'Progress') { got += ev.data?.chunkLength || 0; paint(total ? `正在下载 ${Math.min(100, Math.round(got / total * 100))}%` : '正在下载…'); }
      if (ev.event === 'Finished') paint('下载完成，正在安装，程序会自动重启');
    });
    // Windows 上安装程序会关掉并重新打开本程序；走到这里说明没有自动重启
    paint('安装完成，请重新打开程序');
  } catch (e) {
    busy = false;
    paint('更新失败：' + (e?.message || e) + '。可以到网站重新下载安装包');
  }
}

export async function start() {
  try { version = T ? await T.app.getVersion() : (window.__MOCK_VERSION__ || ''); } catch { version = ''; }
  paint();
  $('updCheck')?.addEventListener('click', () => check(true));
  $('updBox')?.addEventListener('click', (e) => { if (e.target.closest('#updGo')) install(); });
  ping();
  setTimeout(() => check(false), 5000);
  setInterval(() => check(false), 6 * 3600e3);
}
