// 技能：训练队列（每项完成时间）+ 已学技能按技能组分组（技能组来自本站 skill-data.json，读不到时按 ID 排列不分组）
import { esiAuth } from '../esi.js';
import { http } from '../platform.js';
import { SITE } from '../servers.js';
import { esc, formatNumber, typeName, loadTypeNames, fmtDur } from '../data.js';

const ROMAN = ['0', 'I', 'II', 'III', 'IV', 'V'];
let skillData = null;
async function loadSkillData() {
  if (!skillData) skillData = http(SITE + '/skill-data.json').then((r) => r.json()).catch(() => ({ skills: {}, groups: {} }));
  return skillData;
}
const lvHtml = (n) => '<span class="lv">' + '■'.repeat(n) + '<span class="off">' + '■'.repeat(5 - n) + '</span></span>';

export async function render(box, acc, { isCurrent }) {
  const id = acc.character_id;
  const [sk, queue, data] = await Promise.all([
    esiAuth(acc, `/characters/${id}/skills/`),
    esiAuth(acc, `/characters/${id}/skillqueue/`).catch(() => []),
    loadSkillData(), loadTypeNames().catch(() => null)
  ]);
  if (!isCurrent()) return;
  const now = Date.now();
  const q = queue.filter((x) => !x.finish_date || Date.parse(x.finish_date) > now).sort((a, b) => a.queue_position - b.queue_position);
  const name = (sid) => data.skills?.[sid]?.[0] || typeName(sid);
  const groups = new Map();
  for (const s of sk.skills || []) {
    const g = data.skills?.[s.skill_id]?.[2];
    const gname = data.groups?.[g] || '其他';
    if (!groups.has(gname)) groups.set(gname, []);
    groups.get(gname).push(s);
  }
  const gList = [...groups].sort((a, b) => b[1].reduce((t, s) => t + s.skillpoints_in_skill, 0) - a[1].reduce((t, s) => t + s.skillpoints_in_skill, 0));

  box.innerHTML = `<div class="card">
    <h4>训练队列<small>${q.length} 项</small></h4>
    ${q.length ? `<div class="table-wrap"><table><thead><tr><th>#</th><th>技能</th><th>等级</th><th>完成时间</th><th class="r">剩余</th></tr></thead><tbody>
      ${q.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(name(x.skill_id))}</td><td>${ROMAN[x.finished_level]}</td>
        <td>${x.finish_date ? new Date(x.finish_date).toLocaleString('zh-CN', { hour12: false }) : '暂停中'}</td><td class="r">${x.finish_date ? fmtDur(Date.parse(x.finish_date) - now) : '—'}</td></tr>`).join('')}
    </tbody></table></div>` : '<p class="muted">队列为空</p>'}
  </div>
  <div class="card">
    <h4>已学技能<small>${(sk.skills || []).length} 个 · ${formatNumber(sk.total_sp)} 技能点</small></h4>
    <div class="skill-groups">${gList.map(([g, list]) => `<details class="skill-group">
      <summary>${esc(g)}<span>${list.length} 个 · ${formatNumber(list.reduce((t, s) => t + s.skillpoints_in_skill, 0))}</span></summary>
      ${list.sort((a, b) => name(a.skill_id).localeCompare(name(b.skill_id), 'zh')).map((s) => `<div class="skill-line"><span>${esc(name(s.skill_id))}</span>${lvHtml(s.trained_skill_level)}</div>`).join('')}
    </details>`).join('')}</div>
  </div>`;
}
