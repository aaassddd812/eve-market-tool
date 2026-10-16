// ===== 会战监测 =====
// 每分钟向击杀记录服务查询疑似大规模会战（时间窗内同一星系被击毁的舰船数达到阈值，不含太空舱与 NPC 击杀），
// 新出现的会战弹出提醒；击杀记录页与星图通过 onBattles() 订阅。未部署击杀记录服务（404）时自动停用。
let app;
const POLL = 60e3;
const KEY = 'eve-battle-settings';
export const WINDOW_OPTIONS = [15, 30, 60];
export const MIN_OPTIONS = [20, 30, 50, 100, 200];
const DEFAULTS = { on: true, window: 30, min: 50 };

const B = { settings: { ...DEFAULTS }, list: [], names: {}, disabled: false, timer: null, alerted: new Map(), listeners: new Set(), loaded: false };

export function getBattles() { return B.list; }
export function getBattleNames() { return B.names; }
export function getBattleSettings() { return { ...B.settings }; }
export function isBattleWatchAvailable() { return !B.disabled; }

export function onBattles(fn) {
  B.listeners.add(fn);
  if (B.loaded) fn(B.list);
  return () => B.listeners.delete(fn);
}

export function setBattleSettings(patch) {
  B.settings = { ...B.settings, ...patch };
  app.store.setJSON(KEY, B.settings);
  B.alerted.clear();          // 阈值变化后重新判断哪些是“新”会战，但不重复弹出当前已显示的
  B.silent = true;
  poll();
}

export function initBattles(context) {
  app = context;
  B.settings = { ...DEFAULTS, ...app.store.getJSON(KEY, {}) };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  poll();
  B.timer = setInterval(poll, POLL);
}

async function poll() {
  if (B.disabled || document.hidden || B.busy) return;
  B.busy = true;
  try {
    const { window: win, min } = B.settings;
    const res = await fetch(`/api/kb/battles?window=${win}&min=${min}`);
    if (res.status === 404) { B.disabled = true; clearInterval(B.timer); B.list = []; emit(); return; }
    if (!res.ok) return;
    const data = await res.json();
    B.list = data.battles || [];
    B.names = data.names || {};
    B.loaded = true;
    if (B.settings.on && !B.silent) alertNew();
    else B.list.forEach((b) => B.alerted.set(b.system_id, true));
    B.silent = false;
    // 已结束（不再满足条件）的会战移出记录，之后再次出现时会重新提醒
    const active = new Set(B.list.map((b) => b.system_id));
    for (const id of B.alerted.keys()) if (!active.has(id)) B.alerted.delete(id);
    emit();
  } catch { /* 网络错误：下次再试 */ } finally {
    B.busy = false;
  }
}

function emit() {
  for (const fn of B.listeners) { try { fn(B.list); } catch (error) { console.error(error); } }
}

// ---------- 提醒 ----------
async function alertNew() {
  const fresh = B.list.filter((b) => !B.alerted.has(b.system_id));
  fresh.forEach((b) => B.alerted.set(b.system_id, true));
  if (!fresh.length) return;
  const kb = await app.loadKillboard();
  await kb.ensureSystems();
  let box = document.getElementById('battleAlerts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'battleAlerts';
    box.className = 'battle-alerts';
    box.setAttribute('role', 'status');
    document.body.appendChild(box);
    box.addEventListener('click', (e) => {
      const card = e.target.closest('.battle-alert');
      if (!card) return;
      const id = Number(card.dataset.system);
      if (e.target.closest('[data-battle-map]')) app.openMapSystem(id);
      else if (e.target.closest('[data-battle-kills]')) app.openKbSystem(id);
      if (e.target.closest('button')) card.remove();
    });
  }
  for (const b of fresh.slice(0, 3)) {
    const sys = kb.systemLabel(b.system_id);
    const sides = b.sides.slice(0, 2).map((s) => B.names[s.id] || app.officialName(s.id)).filter(Boolean);
    const card = document.createElement('div');
    card.className = 'battle-alert';
    card.dataset.system = b.system_id;
    card.innerHTML = `
      <div class="battle-alert-head"><svg class="battle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/><path d="M14.5 6.5 18 3h3v3l-3.5 3.5"/><path d="m5 14 4 4"/><path d="m7 17-3 3"/><path d="m3 19 2 2"/></svg><strong>疑似会战</strong>
        <span>${app.esc(sys.name)} <b style="color:${sys.color}">${sys.secText}</b>${sys.region ? ' · ' + app.esc(sys.region) : ''}</span>
        <button class="battle-close" data-battle-close aria-label="关闭">×</button></div>
      <p>${B.settings.window} 分钟内击毁 <b>${b.kills}</b> 艘舰船 · 约 ${b.pilots} 名飞行员 · 损失 ${app.formatISK(b.value)} ISK</p>
      ${sides.length ? `<p class="battle-sides">${sides.map(app.esc).join(' <i>vs</i> ')}</p>` : ''}
      <div class="battle-actions"><button class="btn btn-primary" data-battle-map>在星图查看</button><button class="btn btn-ghost" data-battle-kills>击杀记录</button></div>`;
    box.prepend(card);
    setTimeout(() => card.remove(), 45e3);
  }
  while (box.children.length > 4) box.lastElementChild.remove();
}
