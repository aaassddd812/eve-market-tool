// ===== 高安强爆风险（/api/kb/gank?system=）=====
// 击杀记录页（按高安星系筛选时）与星图星系面板共用。判定：受害者被玩家击毁，且有攻击者在同一星系、前后 10 分钟内被 NPC（统合部）击毁。
// h：{ esc, isk, num, typeName, typeIcon(t), avatar(kind, id), entity(kind, id) → 链接 HTML, ago(毫秒) }
const TZ = Math.round(-new Date().getTimezoneOffset() / 60);
export const TZ_LABEL = TZ === 8 ? '北京时间' : `本地时间 UTC${TZ >= 0 ? '+' : ''}${TZ}`;
const localHour = (utc) => (((utc + TZ) % 24) + 24) % 24;
export const GANK_NOTE = '判定方法：高安里受害者被玩家击毁，且有攻击者在同一星系、前后 10 分钟内被统合部（NPC）击毁。只统计本站收录的击杀，仅供参考。';

// 一天里最集中的 3 个小时（UTC 次数 → 本地时间段）
function peakHours(hours) {
  let best = -1, at = 0;
  for (let h = 0; h < 24; h++) { const v = hours[h] + hours[(h + 1) % 24] + hours[(h + 2) % 24]; if (v > best) { best = v; at = h; } }
  const a = localHour(at);
  return best > 0 ? `${a}–${(a + 3) % 24 || 24} 点` : '';
}

// sys：{ name, color, secText, region }；opts.head 追加在标题行右侧（天数切换等）；opts.compact 为星图面板的精简版
export function gankSystemHtml(sys, d, h, opts = {}) {
  const { compact = false, head: extra = '', foot = '' } = opts;
  const span = d.span || d.days;
  const head = `<div class="kb-gank-head"><h4>高安强爆风险${compact ? '' : ` · ${h.esc(sys.name)} <b style="color:${sys.color}">${sys.secText}</b>`}</h4>
    <small class="text-muted">${compact ? '' : h.esc(sys.region || '') + ' · '}最近 ${span} 天</small><span class="toolbar-spacer"></span>${extra}</div>`;
  if (!d.count) return `<div class="kb-gank${compact ? ' compact' : ''}">${head}<p class="kb-gank-safe">最近 ${span} 天没有发现疑似强爆记录。</p>${foot}</div>`;
  const pct = (n) => Math.round(n / span * 100);
  const stat = (label, value, sub = '') => `<div class="kb-gank-stat"><small>${label}</small><b>${value}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  const local = Array.from({ length: 24 }, (_, x) => d.hours[(((x - TZ) % 24) + 24) % 24] || 0);
  const maxP = Math.max(...local, 1);
  const cells = local.map((n, x) => `<div class="kb-gank-hour" title="${TZ_LABEL} ${x}:00–${x + 1}:00：最近 ${span} 天里有 ${n} 天在这个时段出现强爆（${pct(n)}%）">
      <span class="kb-gank-bar"><i style="height:${(n / maxP * 100).toFixed(0)}%;opacity:${n ? 0.35 + 0.65 * n / maxP : 0}"></i></span>${compact ? '' : `<em>${n ? pct(n) + '%' : ''}</em>`}<small>${!compact || x % 3 === 0 ? x : ''}</small></div>`).join('');
  const worst = local.map((n, x) => [n, x]).sort((a, b) => b[0] - a[0]).slice(0, 3).filter((x) => x[0]).map(([n, x]) => `<span>${x}–${x + 1} 点（${pct(n)}%）</span>`).join('、');
  const groups = d.groups.slice(0, compact ? 4 : 10).map((g) => `<div class="kb-mini-row kb-gank-group"><img src="${h.avatar(g.kind, g.id)}" alt="" width="24" height="24" loading="lazy">
      <span>${h.entity(g.kind, g.id)}<small>${compact ? '' : `${g.kind === 'alliance' ? '联盟' : '军团'} · ${g.pilots} 名角色 · `}${peakHours(g.hours) ? '常在 ' + peakHours(g.hours) + ' · ' : ''}最近 ${h.ago(g.last * 1000)}</small></span>
      <b title="参与的疑似强爆次数">${h.num(g.count)} 次</b></div>`).join('');
  const ships = compact ? '' : d.ships.map(([t, n]) => `<div class="kb-mini-row"><img src="${h.typeIcon(t)}" alt="" width="24" height="24" loading="lazy"><span>${h.esc(h.typeName(t))}</span><b>${h.num(n)} 艘</b></div>`).join('');
  return `<div class="kb-gank${compact ? ' compact' : ''}">${head}
    <div class="kb-gank-stats">
      ${stat('疑似强爆', h.num(d.count) + ' 次', '平均每天 ' + (d.count / span).toFixed(1) + ' 次')}
      ${stat('出现强爆的日子', `${d.days_hit} / ${span} 天`, `任意一天碰到的概率约 ${pct(d.days_hit)}%`)}
      ${compact ? '' : stat('被打掉的价值', h.isk(d.value) + ' ISK')}
      ${compact ? '' : stat('最近一次', d.recent[0] ? h.ago(d.recent[0].time * 1000) : '—')}
    </div>
    <h5 class="kb-gank-sub">各时段出现强爆的概率<small><span>${TZ_LABEL} · 该小时内出现过强爆的天数 ÷ ${span} 天</span>${worst ? ' · <span>最危险：</span>' + worst : ''}</small></h5>
    <div class="kb-gank-hours">${cells}</div>
    <div class="kb-gank-cols">
      <section class="kb-gank-panel"><h5>主要强爆团伙</h5>${groups || '<p class="text-muted">—</p>'}</section>
      ${ships ? `<section class="kb-gank-panel"><h5>常被打的舰船</h5>${ships}</section>` : ''}
    </div>
    ${foot}
  </div>`;
}
