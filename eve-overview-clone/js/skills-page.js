// ===== 个人中心 · 技能 =====
// 按游戏技能分组列出全部 512 个技能：已训练等级、生效等级（Alpha 克隆受限时较低）、技能点、训练队列中的目标等级，
// 未学的技能灰显。数据：ESI /skills/（个人中心已读取）、/skillqueue/（需要 esi-skills.read_skillqueue.v1），skill-data.json（build_industry.mjs 生成）。
let ctx;   // esc, formatNumber, esiAuthFetch, store
let data = null;
let loading = null;
const S = { filter: 'all', q: '', open: null, queue: null, queueFor: 0 };
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

function relTime(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '';
  if (ms <= 0) return '已完成';
  const d = Math.floor(ms / 86400e3), h = Math.floor((ms % 86400e3) / 3600e3), m = Math.floor((ms % 3600e3) / 60e3);
  return (d ? d + ' 天 ' : '') + (d || h ? h + ' 小时 ' : '') + m + ' 分钟';
}

export async function renderSkills(box, character, characterId) {
  box.innerHTML = '<p class="text-muted">载入技能数据…</p>';
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
  }
  box.dataset.skills = '1';
  box._skOwn = own;
  draw(box, own);
  bind(box, own);
}

function draw(box, own) {
  const esc = ctx.esc, fmt = ctx.formatNumber;
  const mine = new Map((own.skills || []).map((s) => [s.skill_id, s]));
  const queue = Array.isArray(S.queue) ? S.queue.slice().sort((a, b) => a.queue_position - b.queue_position) : [];
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

  const card = (label, value, detail) => `<div class="valuation-card"><span class="valuation-label">${label}</span><strong class="valuation-value">${value}</strong><span class="valuation-detail">${detail}</span></div>`;
  const cards = `<div class="valuation-grid sk-cards">
      ${card('总技能点', fmt(own.total_sp || 0), '')}
      ${card('未分配技能点', fmt(own.unallocated_sp || 0), '')}
      ${card('已学技能', `${trainedCount}<span class="unit">/ ${all.length}</span>`, `${fiveCount} 个已到 V 级`)}
      ${card('训练队列', queue.length ? queue.length + '<span class="unit">项</span>' : S.queue === null ? '读取中' : '空闲', queue.length ? esc(relTime(queue[queue.length - 1].finish_date)) + '后完成' : '')}
    </div>`;

  let queueHtml = '';
  if (S.queue?.error) queueHtml = `<p class="text-muted sk-note">训练队列读取失败：${esc(S.queue.error)}</p>`;
  else if (queue.length) {
    const now = Date.now();
    queueHtml = `<section class="sk-queue"><h3>训练队列</h3><ol>${queue.map((x, i) => {
      const s = data.skills[x.skill_id];
      const start = x.start_date ? new Date(x.start_date).getTime() : null, end = x.finish_date ? new Date(x.finish_date).getTime() : null;
      const pct = i === 0 && start && end && end > start ? Math.max(0, Math.min(100, ((now - start) / (end - start)) * 100)) : 0;
      return `<li class="${i === 0 ? 'active' : ''}"><span class="sk-q-name">${esc(s ? s[0] : '技能 ' + x.skill_id)} <b>${ROMAN[x.finished_level]}</b></span>
        <span class="sk-q-time">${x.finish_date ? esc(relTime(x.finish_date)) : '已暂停'}</span>
        ${i === 0 ? `<i class="sk-q-bar"><em style="width:${pct.toFixed(1)}%"></em></i>` : ''}</li>`;
    }).join('')}</ol></section>`;
  }

  const groupHtml = groups.filter((g) => g.shown.length).map((g) => {
    const open = q || S.filter !== 'all' || S.open.has(g.gid);
    const rows = g.shown.map((s) => {
      const m = mine.get(s.id);
      const lv = m?.trained_skill_level || 0, act = m?.active_skill_level ?? lv, sp = m?.skillpoints_in_skill || 0;
      const target = queued.get(s.id) || 0;
      const boxes = [1, 2, 3, 4, 5].map((n) => `<i class="${n <= act ? 'on' : n <= lv ? 'limited' : n <= target ? 'queued' : ''}"></i>`).join('');
      const title = `${s.desc}\n\n主属性：${ATTR_ZH[s.pri] || '—'} · 副属性：${ATTR_ZH[s.sec] || '—'} · 训练倍数 ×${s.rank}`;
      return `<div class="sk-row${lv ? '' : ' untrained'}" title="${esc(title)}">
        <span class="sk-name">${esc(s.name)}</span>
        <span class="sk-rank">×${s.rank}</span>
        <span class="sk-boxes" aria-label="${lv} 级">${boxes}</span>
        <span class="sk-sp">${lv ? fmt(sp) : '未学'}<small>${lv < 5 ? ' / ' + fmt(spForLevel(s.rank, Math.max(1, lv + 1))) : ''}</small></span>
      </div>`;
    }).join('');
    const pct = (g.levels / (g.list.length * 5)) * 100;
    return `<details class="sk-group" data-gid="${g.gid}"${open ? ' open' : ''}>
      <summary><span class="sk-g-name">${esc(g.name)}</span><span class="sk-g-count">${g.trained} / ${g.list.length}</span>
        <i class="sk-g-bar"><em style="width:${pct.toFixed(1)}%"></em></i><span class="sk-g-sp">${fmt(g.sp)} 技能点</span></summary>
      <div class="sk-rows">${rows}</div></details>`;
  }).join('') || '<p class="text-muted">没有符合条件的技能</p>';

  box.innerHTML = `${cards}${queueHtml}
    <div class="sk-toolbar">
      <div class="search-box sk-search">
        <svg class="search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="search" id="skSearch" placeholder="搜索技能（中英文）" value="${esc(S.q)}" autocomplete="off" spellcheck="false">
      </div>
      <div class="segmented" role="group">${[['all', '全部'], ['trained', '已学'], ['partial', '未满级'], ['untrained', '未学']].map(([k, l]) => `<button data-sk-filter="${k}" class="${S.filter === k ? 'active' : ''}">${l}</button>`).join('')}</div>
      <button class="link-btn" data-sk-all="1">全部展开</button><button class="link-btn" data-sk-all="0">全部收起</button>
      <span class="sk-legend"><i class="on"></i>已学<i class="limited"></i>受克隆限制<i class="queued"></i>队列中</span>
    </div>
    <div class="sk-groups">${groupHtml}</div>`;
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

export function leaveSkills(box) { if (box) box.dataset.skills = ''; }
