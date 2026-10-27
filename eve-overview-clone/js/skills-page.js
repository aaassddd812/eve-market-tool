// ===== 个人中心 · 技能 =====
// 按游戏技能分组列出全部 512 个技能：已训练等级、生效等级（Alpha 克隆受限时较低）、技能点、训练队列中的目标等级，
// 未学的技能灰显。数据：ESI /skills/（个人中心已读取）、/skillqueue/（需要 esi-skills.read_skillqueue.v1），skill-data.json（build_industry.mjs 生成）。
// 角色属性：ESI /attributes/（esi-skills.read_skills.v1）。训练速度 = 主属性 + 副属性 / 2（技能点 / 分钟），据此估算每个技能升到下一级的时间。
import { skCards, skRows } from './skeleton.js?v=v17';

let ctx;   // esc, formatNumber, esiAuthFetch, store
let data = null;
let loading = null;
const S = { filter: 'all', q: '', open: null, queue: null, queueFor: 0, attrs: null };
const ATTR_KEY = { 164: 'charisma', 165: 'intelligence', 166: 'memory', 167: 'perception', 168: 'willpower' };
const OPEN_KEY = 'eve-skill-groups-open';
const ATTR_ZH = { 164: '魅力', 165: '智力', 166: '记忆', 167: '感知', 168: '毅力' };
const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V'];

export function initSkills(context) {
  ctx = context;
  try { S.open = new Set(ctx.store.getJSON(OPEN_KEY, [])); } catch { S.open = new Set(); }
}

function load() {
  if (!loading) loading = fetch('skill-data.json?v=1').then((r) => { if (!r.ok) throw new Error('skill-data.json ' + r.status); return r.json(); })
    .then((d) => { data = d; }).catch((e) => { loading = null; throw e; });
  return loading;
}

// 各等级累计所需技能点：250 × 倍数 × √32^(等级-1)
export const spForLevel = (rank, level) => (level <= 0 ? 0 : Math.ceil(250 * rank * Math.pow(Math.sqrt(32), level - 1)));

export async function renderSkills(box, character, characterId) {
  box.innerHTML = skCards(4, 'sk-cards') + skRows(8, { img: 28 });
  await load();
  const own = character?.skills && !character.skills.__error ? character.skills : null;
  if (!own) { box.innerHTML = `<p class="text-muted">技能读取失败：${ctx.esc(character?.skills?.__error || '权限不足')}</p>`; return; }
  if (S.queueFor !== characterId) {
    S.queueFor = characterId;
    S.queue = null;
    ctx.esiAuthFetch('/characters/' + characterId + '/skillqueue/')
      .then((q) => { S.queue = Array.isArray(q) ? q : []; })
      .catch((e) => { S.queue = { error: e.message }; })
      .finally(() => { if (box.isConnected && box.dataset.skills === '1') draw(box, own); });
    S.attrs = null;
    ctx.esiAuthFetch('/characters/' + characterId + '/attributes/')
      .then((a) => { if (S.queueFor === characterId) S.attrs = a; })
      .catch((e) => { if (S.queueFor === characterId) S.attrs = { error: e.message }; })
      .finally(() => { if (box.isConnected && box.dataset.skills === '1') draw(box, own); });
  }
  box.dataset.skills = '1';
  box._skOwn = own;
  draw(box, own);
  bind(box, own);
}

// 属性条：五项属性 + 重新分配（每年 1 次免费，另有奖励次数）
function attrHtml() {
  const esc = ctx.esc;
  if (S.attrs === null) return '';
  if (S.attrs.error) return `<p class="text-muted sk-note">角色属性读取失败：${esc(S.attrs.error)}</p>`;
  const a = S.attrs;
  const next = a.accrued_remap_cooldown_date ? new Date(a.accrued_remap_cooldown_date).getTime() : 0;
  const remap = next > Date.now() ? '下次可重新分配：' + new Date(next).toLocaleDateString('zh-CN') : '现在可以重新分配属性';
  return `<div class="sk-attrs">${Object.entries(ATTR_KEY).map(([id, k]) => `<span><em>${ATTR_ZH[id]}</em><b>${a[k] ?? '—'}</b></span>`).join('')}
    <span class="sk-remap">${esc(remap)}${a.bonus_remaps ? ` · 奖励重新分配 ${a.bonus_remaps} 次` : ''}</span></div>`;
}

function draw(box, own) {
  const esc = ctx.esc, fmt = ctx.formatNumber;
  const mine = new Map((own.skills || []).map((s) => [s.skill_id, s]));
  const now = Date.now();
  const queue = Array.isArray(S.queue) ? S.queue.filter((x) => !x.finish_date || Date.parse(x.finish_date) > now).sort((a, b) => a.queue_position - b.queue_position) : [];
  const queued = new Map();   // 技能 -> 队列中的最高目标等级
  for (const q of queue) queued.set(q.skill_id, Math.max(queued.get(q.skill_id) || 0, q.finished_level));
  const all = Object.entries(data.skills).map(([id, s]) => ({ id: Number(id), name: s[0], en: s[1], group: s[2], rank: s[3], pri: s[4], sec: s[5], desc: s[6] }));
  const trainedCount = all.filter((s) => mine.get(s.id)?.trained_skill_level > 0).length;
  const fiveCount = all.filter((s) => mine.get(s.id)?.trained_skill_level === 5).length;
  const q = S.q.trim().toLowerCase();
  const match = (s) => {
    const m = mine.get(s.id);
    const lv = m?.trained_skill_level || 0;
    if (S.filter === 'trained' && !lv) return false;
    if (S.filter === 'untrained' && lv) return false;
    if (S.filter === 'partial' && (!lv || lv === 5)) return false;
    return !q || s.name.toLowerCase().includes(q) || s.en.toLowerCase().includes(q);
  };

  const groups = Object.entries(data.groups).map(([gid, name]) => {
    const list = all.filter((s) => s.group === Number(gid)).sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const sp = list.reduce((t, s) => t + (mine.get(s.id)?.skillpoints_in_skill || 0), 0);
    const levels = list.reduce((t, s) => t + (mine.get(s.id)?.trained_skill_level || 0), 0);
    return { gid: Number(gid), name, list, shown: list.filter(match), sp, levels, trained: list.filter((s) => mine.get(s.id)?.trained_skill_level > 0).length };
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  const attrs = S.attrs && !S.attrs.error ? S.attrs : null;
  const rate = (s) => attrs ? (attrs[ATTR_KEY[s.pri]] || 0) + (attrs[ATTR_KEY[s.sec]] || 0) / 2 : 0;   // 技能点 / 分钟
  const dur = (min) => { const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = Math.round(min % 60); return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${Math.max(1, m)} 分钟`; };
  const card = (label, value, detail) => `<div class="valuation-card"><span class="valuation-label">${label}</span><strong class="valuation-value">${value}</strong><span class="valuation-detail">${detail}</span></div>`;
  const cards = `<div class="valuation-grid sk-cards">
      ${card('总技能点', fmt(own.total_sp || 0), '')}
      ${card('未分配技能点', fmt(own.unallocated_sp || 0), '')}
      ${card('已学技能', `${trainedCount}<span class="unit">/ ${all.length}</span>`, `${fiveCount} 个已到 V 级`)}
      ${card('训练队列', queue.length ? queue.length + '<span class="unit">项</span>' : S.queue === null ? '读取中' : '空闲', queue.length ? (queue[queue.length - 1].finish_date ? `<span data-sk-cd="${Date.parse(queue[queue.length - 1].finish_date)}" translate="no"></span> 后完成` : '已暂停') : '')}
    </div>${attrHtml()}`;

  let queueHtml = '';
  if (S.queue?.error) queueHtml = `<p class="text-muted sk-note">训练队列读取失败：${esc(S.queue.error)}</p>`;
  else if (queue.length) queueHtml = queueSection(queue, mine, rate);

  const groupHtml = groups.filter((g) => g.shown.length).map((g) => {
    const open = q || S.filter !== 'all' || S.open.has(g.gid);
    const rows = g.shown.map((s) => {
      const m = mine.get(s.id);
      const lv = m?.trained_skill_level || 0, act = m?.active_skill_level ?? lv, sp = m?.skillpoints_in_skill || 0;
      const target = queued.get(s.id) || 0;
      const boxes = [1, 2, 3, 4, 5].map((n) => `<i class="${n <= act ? 'on' : n <= lv ? 'limited' : n <= target ? 'queued' : ''}"></i>`).join('');
      const r = rate(s);
      const need = lv < 5 ? spForLevel(s.rank, lv + 1) - sp : 0;
      const eta = r && need > 0 ? dur(need / r) : '';
      const title = `${s.desc}\n\n主属性：${ATTR_ZH[s.pri] || '—'} · 副属性：${ATTR_ZH[s.sec] || '—'} · 训练倍数 ×${s.rank}` +
        (r ? `\n训练速度 ${r.toFixed(1)} 技能点 / 分钟（${Math.round(r * 60)} / 小时）${eta ? ` · 升到 ${ROMAN[lv + 1]} 级约 ${eta}` : ''}` : '');
      return `<div class="skl-row${lv ? '' : ' untrained'}" title="${esc(title)}">
        <span class="sk-name">${esc(s.name)}</span>
        <span class="skl-rank">×${s.rank}</span>
        <span class="sk-boxes" aria-label="${lv} 级">${boxes}</span>
        <span class="sk-sp">${lv ? fmt(sp) : '未学'}<small>${lv < 5 ? ' / ' + fmt(spForLevel(s.rank, Math.max(1, lv + 1))) : ''}</small>${eta && lv ? `<small class="sk-eta">下一级约 ${eta}</small>` : ''}</span>
      </div>`;
    }).join('');
    const pct = (g.levels / (g.list.length * 5)) * 100;
    return `<details class="sk-group" data-gid="${g.gid}"${open ? ' open' : ''}>
      <summary><span class="sk-g-name">${esc(g.name)}</span><span class="sk-g-count">${g.trained} / ${g.list.length}</span>
        <i class="sk-g-bar"><em style="width:${pct.toFixed(1)}%"></em></i><span class="sk-g-sp">${fmt(g.sp)} 技能点</span></summary>
      <div class="sk-rows">${rows}</div></details>`;
  }).join('') || '<p class="text-muted">没有符合条件的技能</p>';

  box.innerHTML = `${cards}${queueHtml}
    <div class="skl-toolbar">
      <div class="search-box sk-search">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="search" id="skSearch" placeholder="搜索技能（中英文）" value="${esc(S.q)}" autocomplete="off" spellcheck="false">
      </div>
      <div class="segmented" role="group">${[['all', '全部'], ['trained', '已学'], ['partial', '未满级'], ['untrained', '未学']].map(([k, l]) => `<button data-sk-filter="${k}" class="${S.filter === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      <button class="link-btn" data-sk-all="1">全部展开</button><button class="link-btn" data-sk-all="0">全部收起</button>
      <a class="link-btn sk-plan-link" href="#plan" title="按已学技能规划想开的船和发展方向">技能规划 ›</a>
      <span class="skl-legend"><i class="on"></i>已学<i class="limited"></i>受克隆限制<i class="queued"></i>队列中</span>
    </div>
    <div class="sk-groups">${groupHtml}</div>`;
  tick(box);
  startTick(box);
  if (document.activeElement?.id !== 'skSearch' && S.focusSearch) { const el = box.querySelector('#skSearch'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
}

function bind(box, own) {
  if (box.dataset.skBound) return;
  box.dataset.skBound = '1';
  box.addEventListener('click', (e) => {
    if (box.dataset.skills !== '1') return;
    const f = e.target.closest('[data-sk-filter]');
    if (f) { S.filter = f.dataset.skFilter; S.focusSearch = false; draw(box, currentOwn()); return; }
    const all = e.target.closest('[data-sk-all]');
    if (all) {
      const open = all.dataset.skAll === '1';
      S.open = open ? new Set(Object.keys(data.groups).map(Number)) : new Set();
      ctx.store.setJSON(OPEN_KEY, [...S.open]);
      box.querySelectorAll('.sk-group').forEach((d) => { d.open = open; });
    }
  });
  box.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!d.classList?.contains('sk-group') || S.q || S.filter !== 'all') return;
    const gid = Number(d.dataset.gid);
    if (d.open) S.open.add(gid); else S.open.delete(gid);
    ctx.store.setJSON(OPEN_KEY, [...S.open]);
  }, true);
  let t = 0;
  box.addEventListener('input', (e) => {
    if (e.target.id !== 'skSearch') return;
    S.q = e.target.value;
    clearTimeout(t);
    t = setTimeout(() => { S.focusSearch = true; draw(box, currentOwn()); }, 180);
  });
  function currentOwn() { return box._skOwn || own; }
}

export function leaveSkills(box) { if (box) box.dataset.skills = ''; clearInterval(timer); timer = 0; }

// ---------- 训练队列：像游戏里一样实时显示剩余时间、当前技能点与进度 ----------
const EN = () => window.I18N?.lang === 'en';
// 倒计时「1 天 02:13:45」
function countdown(ms) {
  if (ms <= 0) return EN() ? 'done' : '已完成';
  const t = Math.floor(ms / 1000), d = Math.floor(t / 86400), h = Math.floor((t % 86400) / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return (d ? d + (EN() ? 'd ' : ' 天 ') : '') + `${p2(h)}:${p2(m)}:${p2(sec)}`;
}
// 时长「1 天 5 小时」/「3 小时 20 分」
function span(ms) {
  const min = Math.max(1, Math.round(ms / 60e3)), d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  if (EN()) return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  return d ? `${d} 天 ${h} 小时` : h ? `${h} 小时 ${m} 分` : `${m} 分钟`;
}
function when(ms) {
  const d = new Date(ms), p2 = (n) => String(n).padStart(2, '0'), hm = p2(d.getHours()) + ':' + p2(d.getMinutes());
  if (EN()) return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' + hm;
  return `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]} ${hm}`;
}

// 每一项：技能点区间与训练速度。速度优先按队列给的起止时间算（已含植入体、加速器），暂停时按属性估算
function queueItems(queue, mine, rate) {
  return queue.map((x, i) => {
    const s = data.skills[x.skill_id];
    const rank = s ? s[3] : 1;
    const lv0 = x.level_start_sp ?? spForLevel(rank, x.finished_level - 1);
    const lv1 = x.level_end_sp ?? spForLevel(rank, x.finished_level);
    const own = mine.get(x.skill_id);
    const sp0 = x.training_start_sp ?? (own && own.trained_skill_level === x.finished_level - 1 ? Math.max(lv0, own.skillpoints_in_skill || 0) : lv0);
    const start = x.start_date ? Date.parse(x.start_date) : 0, end = x.finish_date ? Date.parse(x.finish_date) : 0;
    const theory = s ? rate({ pri: s[4], sec: s[5] }) * 60 : 0;   // 技能点 / 小时
    const perHour = start && end > start ? (lv1 - sp0) / ((end - start) / 3600e3) : theory;
    return { x, i, s, name: s ? s[0] : '技能 ' + x.skill_id, lv: x.finished_level, lv0, lv1, sp0, start, end, perHour };
  });
}

function queueSection(queue, mine, rate) {
  const { esc, formatNumber: fmt } = ctx;
  const items = queueItems(queue, mine, rate);
  const paused = !items[0].end;
  const last = items[items.length - 1];
  const boxes = (lv) => `<span class="sk-boxes">${[1, 2, 3, 4, 5].map((n) => `<i class="${n < lv ? 'on' : n === lv ? 'queued' : ''}"></i>`).join('')}</span>`;
  const head = `<div class="sk-q-head"><h3>训练队列</h3>
      <span class="sk-q-sum">${items.length} 项${paused ? ' · <b class="sk-q-paused">已暂停</b>' : ` · 全部完成还需 <b data-sk-cd="${last.end}" translate="no"></b> · <span translate="no">${esc(when(last.end))}</span>`}</span></div>`;
  const c = items[0];
  const now = `<div class="sk-q-now" data-sk-now data-start="${c.start}" data-end="${c.end}" data-sp0="${c.sp0}" data-lv0="${c.lv0}" data-lv1="${c.lv1}">
      <div class="sk-q-now-top"><span class="sk-q-tag">${paused ? '已暂停' : '正在训练'}</span><b class="sk-q-now-name">${esc(c.name)} <em>${ROMAN[c.lv]}</em></b>${boxes(c.lv)}</div>
      <i class="sk-q-bar"><em data-sk-bar style="width:0"></em></i>
      <div class="sk-q-stats">
        <div><span>剩余时间</span><b ${paused ? '' : `data-sk-cd="${c.end}"`} translate="no">${paused ? '—' : ''}</b></div>
        <div><span>技能点</span><b translate="no"><span data-sk-sp>${fmt(c.sp0)}</span><small> / ${fmt(c.lv1)}</small></b></div>
        <div><span>训练速度</span><b translate="no">${c.perHour ? fmt(Math.round(c.perHour)) : '—'}<small> ${EN() ? 'SP/h' : '技能点/小时'}</small></b></div>
        <div><span>完成时间</span><b translate="no">${paused ? '—' : esc(when(c.end))}</b></div>
      </div>
    </div>`;
  const rest = items.slice(1).map((it) => `<li>
      <span class="sk-q-no">${it.i + 1}</span>
      <span class="sk-q-name">${esc(it.name)} <b>${ROMAN[it.lv]}</b></span>
      <span class="sk-q-sp" translate="no">+${fmt(Math.max(0, it.lv1 - it.sp0))}</span>
      <span class="sk-q-rate" translate="no">${it.perHour ? fmt(Math.round(it.perHour)) + '/h' : '—'}</span>
      <span class="sk-q-dur" translate="no">${it.end ? span(it.end - it.start) : it.perHour ? span((it.lv1 - it.sp0) / it.perHour * 3600e3) : '—'}</span>
      <span class="sk-q-fin" translate="no">${it.end ? esc(when(it.end)) : ''}</span>
      <span class="sk-q-cd" ${it.end ? `data-sk-cd="${it.end}"` : ''} translate="no">${it.end ? '' : '已暂停'}</span>
    </li>`).join('');
  return `<section class="sk-queue">${head}${now}${rest ? `<div class="sk-q-list-head"><span>#</span><span>技能</span><span>技能点</span><span>速度</span><span>耗时</span><span>完成于</span><span>剩余</span></div><ol>${rest}</ol>` : ''}</section>`;
}

// 每秒更新：倒计时、当前技能点与进度条；当前技能练完时重画（队列前移）
let timer = 0;
function startTick(box) {
  clearInterval(timer);
  if (!box.querySelector('[data-sk-cd], [data-sk-now]')) { timer = 0; return; }
  timer = setInterval(() => {
    if (!box.isConnected || box.dataset.skills !== '1' || document.hidden) { if (!box.isConnected || box.dataset.skills !== '1') { clearInterval(timer); timer = 0; } return; }
    tick(box);
  }, 1000);
}
function tick(box) {
  const t = Date.now();
  let done = false;
  box.querySelectorAll('[data-sk-cd]').forEach((el) => {
    const ms = Number(el.dataset.skCd) - t;
    if (ms <= 0) done = true;
    el.textContent = countdown(ms);
  });
  const n = box.querySelector('[data-sk-now]');
  if (n) {
    const start = Number(n.dataset.start), end = Number(n.dataset.end), sp0 = Number(n.dataset.sp0), lv0 = Number(n.dataset.lv0), lv1 = Number(n.dataset.lv1);
    const f = end > start ? Math.min(1, Math.max(0, (t - start) / (end - start))) : 0;
    const sp = end > start ? sp0 + (lv1 - sp0) * f : sp0;
    n.querySelector('[data-sk-sp]').textContent = ctx.formatNumber(Math.floor(sp));
    n.querySelector('[data-sk-bar]').style.width = (lv1 > lv0 ? ((sp - lv0) / (lv1 - lv0)) * 100 : 0).toFixed(2) + '%';
  }
  if (done && box.dataset.skills === '1') { clearInterval(timer); timer = 0; setTimeout(() => draw(box, box._skOwn), 300); }
}
