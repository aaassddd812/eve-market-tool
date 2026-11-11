// 角色概览：头像、军团 / 联盟、钱包余额、技能点、当前位置与舰船、在线状态、正在训练的技能
import { esiPublic, esiAuth, hasScope } from '../esi.js';
import { portrait } from '../servers.js';
import { esc, formatISK, formatNumber, typeName, resolveNames, nameOf, structureName, loadTypeNames, fmtDur, isAbyssSystem } from '../data.js';

const safe = (p) => p.catch((e) => ({ __error: e.message }));

export async function render(box, acc, { isCurrent }) {
  const id = acc.character_id;
  const [pub, wallet, loc, ship, online, sk, queue] = await Promise.all([
    safe(esiPublic(`/characters/${id}/`)),
    safe(esiAuth(acc, `/characters/${id}/wallet/`)),
    safe(esiAuth(acc, `/characters/${id}/location/`)),
    safe(esiAuth(acc, `/characters/${id}/ship/`)),
    hasScope(acc, 'esi-location.read_online.v1') ? safe(esiAuth(acc, `/characters/${id}/online/`)) : null,
    safe(esiAuth(acc, `/characters/${id}/skills/`)),
    safe(esiAuth(acc, `/characters/${id}/skillqueue/`)),
    loadTypeNames().catch(() => null)
  ]);
  await resolveNames([pub.corporation_id, pub.alliance_id, loc.solar_system_id, loc.station_id, ship.ship_type_id].filter(Boolean));
  const where = loc.__error ? '—' : esc(nameOf(loc.solar_system_id) || loc.solar_system_id) + (isAbyssSystem(loc.solar_system_id) ? ' <span class="pill warn">深渊</span>' : '') +
    (loc.station_id ? ' · ' + esc(nameOf(loc.station_id) || '') : loc.structure_id ? ' · ' + esc((await structureName(acc, loc.structure_id)) || '玩家建筑') : ' · 太空中');
  if (!isCurrent()) return;
  const now = Date.now();
  const q = Array.isArray(queue) ? queue.filter((x) => x.finish_date && Date.parse(x.finish_date) > now).sort((a, b) => a.queue_position - b.queue_position) : [];
  const training = q[0];
  const qEnd = q.length ? Date.parse(q[q.length - 1].finish_date) : 0;
  const pct = training && training.start_date ? Math.min(100, Math.max(0, (now - Date.parse(training.start_date)) / (Date.parse(training.finish_date) - Date.parse(training.start_date)) * 100)) : 0;
  const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V'];

  box.innerHTML = `<div class="card">
    <div class="hero">
      <img src="${portrait(id, 128)}" alt="">
      <div>
        <h2>${esc(acc.character_name)}</h2>
        <div class="muted">${esc(nameOf(pub.corporation_id) || '')}${pub.alliance_id ? ' · ' + esc(nameOf(pub.alliance_id) || '') : ''}</div>
        <div class="small">${online && !online.__error ? (online.online ? '<span class="pill on">在线</span>' : '<span class="pill">离线</span>' + (online.last_logout ? ' <span class="muted">上次下线 ' + new Date(online.last_logout).toLocaleString('zh-CN', { hour12: false }) + '</span>' : '')) : ''}
          ${typeof pub.security_status === 'number' ? ' <span class="muted">安全等级 ' + pub.security_status.toFixed(2) + '</span>' : ''}</div>
      </div>
    </div>
    <div class="kv">
      <div><span>钱包余额</span><b>${typeof wallet === 'number' ? formatISK(wallet) + ' ISK' : '—'}</b></div>
      <div><span>技能点</span><b>${sk.total_sp ? formatNumber(sk.total_sp) : '—'}</b>${sk.unallocated_sp ? ' <span class="muted small">未分配 ' + formatNumber(sk.unallocated_sp) + '</span>' : ''}</div>
      <div><span>当前位置</span>${where}</div>
      <div><span>当前舰船</span>${ship.__error ? '—' : esc(typeName(ship.ship_type_id)) + (ship.ship_name ? ' <span class="muted">「' + esc(ship.ship_name) + '」</span>' : '')}</div>
    </div>
  </div>
  <div class="card">
    <h4>技能训练<small>${q.length ? '队列 ' + q.length + ' 项，全部完成还要 ' + fmtDur(qEnd - now) : '队列为空'}</small></h4>
    ${training ? `<div class="row"><b>${esc(typeName(training.skill_id))} ${ROMAN[training.finished_level] || training.finished_level}</b><span class="muted">还要 ${fmtDur(Date.parse(training.finish_date) - now)}</span></div>
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : '<p class="muted">没有正在训练的技能</p>'}
  </div>`;
}
