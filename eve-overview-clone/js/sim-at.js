// ===== 战场模拟 · AT 赛（联盟锦标赛）=====
// 战场模拟页顶部「AT 赛」打开：列出这一届已打过的全部比赛（at-data.json，server/build_at.py 从 EVE_NT 赛事站生成），
// 按决赛周 / 预选筛选、按队名或选手名搜索；每场显示双方队标、胜负、阵容（阵亡的船变暗）与禁船。
// 点「模拟这场」把双方阵容带进战场模拟：蓝队进 A 方、红队进 B 方（和游戏里的颜色一致），每名选手一行（带选手名），
// 装配：决赛周阵亡的船用比赛实际装配（击杀记录 ID 在 ships 第 6 项），其余用同型船的 AT 实际装配或最近常见装配；结果旁边对照真实战损。
let ctx;   // esc, data, formatNumber
let box = null, onPick = null;
const A = { data: null, loading: null, type: '', q: '', shown: 30 };
const PAGE = 30;
const IMG = (id, kind = 'icon', size = 32) => `https://images.evetech.net/types/${id}/${kind}?size=${size}`;
const LOGO = (id) => `https://images.evetech.net/alliances/${id}/logo?size=64`;
const LOC = () => (window.I18N?.lang === 'en' ? 'en-US' : 'zh-CN');   // 日期按界面语言写（不走翻译）
const TYPES = [['', '全部'], ['final', '决赛周'], ['feeder', '预选']];
const shipName = (id) => ctx.data.types.get(id)?.name || '';

export function initAt(context) { ctx = context; }
// 战场模拟的「AT 得分」也用：分值表 points {船型: [分值, 重复加价]}、limit 每队分数上限
export const loadAtData = () => load();

function load() {
  if (A.data) return Promise.resolve(A.data);
  A.loading ||= fetch('./at-data.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then((d) => { A.data = d; return d; }).finally(() => { A.loading = null; });
  return A.loading;
}

// host：放弹窗的容器；pick(match) 选中一场
export function openAt(host, pick) {
  onPick = pick;
  if (!box) {
    box = document.createElement('div');
    box.className = 'sim-at-modal';
    box.addEventListener('click', onClick);
    box.addEventListener('input', (e) => { if (e.target.matches('[data-at-q]')) { A.q = e.target.value.trim().toLowerCase(); A.shown = PAGE; renderList(); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && box?.isConnected) close(); });
  }
  host.append(box);
  box.innerHTML = `<div class="sim-at-dlg" role="dialog" aria-modal="true" aria-labelledby="simAtTitle"><p class="sim-at-empty">读取比赛记录…</p></div>`;
  load().then(render).catch((e) => { box.querySelector('.sim-at-dlg').innerHTML = `<p class="sim-at-empty">比赛记录读取失败：${ctx.esc(e.message)}</p>`; });
}
function close() { box?.remove(); }

function render() {
  const d = A.data;
  const n = { final: 0, feeder: 0 };
  for (const m of d.matches) n[m.type] = (n[m.type] || 0) + 1;
  box.querySelector('.sim-at-dlg').innerHTML = `
    <header class="sim-at-head">
      <div><h3 id="simAtTitle">AT 赛 · ${ctx.esc(d.name || d.tournament)}</h3><small>已打 ${d.matches.length} 场 · 选一场带进战场模拟（蓝队 = A 方，红队 = B 方）· 决赛周阵亡的船用比赛实际装配</small></div>
      <button type="button" class="icon-btn" data-at-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </header>
    <div class="sim-at-tools">
      <div class="segmented" role="group">${TYPES.map(([k, l]) => `<button type="button" data-at-type="${k}" class="${A.type === k ? 'active' : ''}">${l}${k ? `<small>${n[k] || 0}</small>` : ''}</button>`).join('')}</div>
      <div class="search-box sim-at-search">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="search" data-at-q placeholder="搜队名或选手名" value="${ctx.esc(A.q)}" autocomplete="off" spellcheck="false" aria-label="搜队名或选手名">
      </div>
    </div>
    <div class="sim-at-list" id="simAtList"></div>
    <p class="sim-at-src">数据来自 <a href="https://open.eve-nt.uk/portal/tournaments/${ctx.esc(d.tournament)}" target="_blank" rel="noopener">EVE_NT 赛事站</a>${d.at ? ` · 更新于 ${new Date(d.at).toLocaleString(LOC(), { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}</p>`;
  renderList();
  box.querySelector('[data-at-q]')?.focus({ preventScroll: true });
}

const matchHit = (m, q) => !q || [m.red, m.blue].some((t) => t.name.toLowerCase().includes(q) || t.ships.some((s) => String(s[2]).toLowerCase().includes(q)));
const dayOf = (iso) => (iso ? new Date(iso).toLocaleDateString(LOC(), { month: 'long', day: 'numeric', weekday: 'short' }) : '时间未知');
function renderList() {
  const el = box.querySelector('#simAtList');
  if (!el) return;
  const list = A.data.matches.filter((m) => (!A.type || m.type === A.type) && matchHit(m, A.q));
  if (!list.length) { el.innerHTML = '<p class="sim-at-empty">没有匹配的比赛</p>'; return; }
  let day = '';
  el.innerHTML = list.slice(0, A.shown).map((m) => {
    const d = dayOf(m.start);
    const head = d !== day ? `<h4 class="sim-at-day">${d}</h4>` : '';
    day = d;
    return head + matchHtml(m);
  }).join('') + (list.length > A.shown ? `<button type="button" class="btn btn-ghost sim-at-more" data-at-more>再显示 ${Math.min(PAGE, list.length - A.shown)} 场（共 ${list.length} 场）</button>` : '');
}

function teamHtml(t, color, won) {
  const lost = t.ships.filter((s) => !s[3]).length;
  return `<div class="sim-at-team ${color}${won ? ' won' : ''}">
    <div class="sim-at-tname"><img src="${LOGO(t.id)}" alt="" width="28" height="28" loading="lazy"><b title="${ctx.esc(t.name)}">${ctx.esc(t.name)}</b>${won ? '<span class="sim-at-win">胜</span>' : ''}<small>${lost ? `损失 ${lost}` : '零损失'}</small></div>
    <div class="sim-at-ships">${t.ships.map((s) => `<img class="${s[3] ? '' : 'dead'}${s[4] ? ' flag' : ''}" src="${IMG(s[0])}" alt="" width="26" height="26" loading="lazy" title="${ctx.esc(shipName(s[0]))} · ${ctx.esc(s[2])}${s[4] ? '（AT 旗舰）' : ''}${s[3] ? '' : ' · 阵亡'}">`).join('')}</div>
  </div>`;
}
function matchHtml(m) {
  const time = m.start ? new Date(m.start).toLocaleTimeString(LOC(), { hour12: false, hour: '2-digit', minute: '2-digit' }) : '';
  const fits = [m.red, m.blue].reduce((t, x) => t + x.ships.filter((y) => y[5]).length, 0);
  const bans = m.bans.length ? `<div class="sim-at-bans"><span>禁船</span>${m.bans.map(([id, r, c]) => `<img class="${c}" src="${IMG(id)}" alt="" width="18" height="18" loading="lazy" title="${ctx.esc(shipName(id))} · 第 ${r} 轮 · ${c === 'blue' ? '蓝队' : c === 'red' ? '红队' : ''}禁">`).join('')}</div>` : '';
  return `<article class="sim-at-match">
    <div class="sim-at-meta"><span class="sim-at-type ${m.type}">${m.type === 'final' ? '决赛周' : '预选'}</span><span>第 ${m.no} 场${m.series ? ` · 系列 ${m.series}` : ''}</span><span>${time}</span>${fits ? `<span class="sim-at-fits" title="阵亡的船从击杀记录取到了比赛里的实际装配">${fits} 艘实际装配</span>` : ''}
      <a href="https://open.eve-nt.uk/portal/match/${m.id}" target="_blank" rel="noopener">赛事站 ↗</a></div>
    <div class="sim-at-teams">${teamHtml(m.blue, 'blue', m.winner === 'blue')}<i>VS</i>${teamHtml(m.red, 'red', m.winner === 'red')}</div>
    <div class="sim-at-foot">${bans}<button type="button" class="btn btn-primary btn-sm" data-at-pick="${m.id}">模拟这场</button></div>
  </article>`;
}

function onClick(e) {
  const el = (s) => e.target.closest(s);
  let x;
  if (e.target === box || el('[data-at-close]')) { close(); return; }
  if ((x = el('[data-at-type]'))) { A.type = x.dataset.atType; A.shown = PAGE; render(); return; }
  if (el('[data-at-more]')) { A.shown += PAGE; renderList(); return; }
  if ((x = el('[data-at-pick]'))) {
    const m = A.data.matches.find((y) => y.id === Number(x.dataset.atPick));
    if (!m) return;
    close();
    onPick?.(m, A.data);
  }
}
