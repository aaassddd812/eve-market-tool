// ===== 角色提醒：技能队列、工业任务、行星开采器、订单成交 / 过期、合同 → 企业微信 / 邮箱 =====
// 只在 alert-push.js 里有渠道要推这几种（AP.wants，托管给服务器的不算）、而且绑定了 ESI 时才运行：读当前角色的数据，和上次读到的比
//   （按角色存在本机 eve-char-alerts-<角色>），刚开始只记下现状、不推。规则与服务器托管相同（kb_service.py 的 Hosted.skill_check 等）：
//   技能队列：某个技能练完、队列剩不到 24 小时、队列空了（或没在训练）；工业任务：到了完成时间（可以交付了）；
//   行星开采：开采器到期停了；订单成交：订单不见了，到历史订单里看是全部成交还是过期（取消的不提醒；历史接口缓存 1 小时，最多等 3 小时）；
//   合同：我发布的合同被接 / 完成 / 失败 / 被拒，拍卖有新出价，收到指定给我的合同。
// 各项按 ESI 缓存分开读（GAP）；授权里缺权限的项跳过。网页弹出一条提示，同时推送。
import * as AP from './alert-push.js?v=v10';
import { L } from './alert-mail.js?v=v8';

let ctx;   // esiAuthFetch, ensureEsiToken, hasEsiToken, hasScope, fetchESI, typeName, resolveTypeNames, placeNames, sysName, store, serverKey, showToast
const SRC = ['skill', 'job', 'pi', 'sold', 'contract'];
const GAP = { skill: 600e3, job: 300e3, pi: 1800e3, sold: 1200e3, contract: 300e3 };
const SCOPE = {
  skill: 'esi-skills.read_skillqueue.v1', job: 'esi-industry.read_character_jobs.v1', pi: 'esi-planets.manage_planets.v1',
  sold: 'esi-markets.read_character_orders.v1', contract: 'esi-contracts.read_character_contracts.v1'
};
const SKILL_LOW = 24 * 3600e3;
const PI_MAX = 12, BIDS_MAX = 5, GONE_KEEP = 3 * 3600e3;
const ACT = { 1: ['制造', 'Manufacturing'], 3: ['时间效率研究', 'TE research'], 4: ['材料效率研究', 'ME research'], 5: ['复制', 'Copying'],
  7: ['逆向工程', 'Reverse engineering'], 8: ['发明', 'Invention'], 9: ['反应', 'Reaction'], 11: ['反应', 'Reaction'] };
const CT = { item_exchange: ['物品交换', 'Item exchange'], auction: ['拍卖', 'Auction'], courier: ['快递', 'Courier'], loan: ['借贷', 'Loan'] };
const S = { timer: 0, at: {}, busy: false, char: 0 };

export function initCharAlerts(context) {
  if (ctx) return;
  ctx = context;
  AP.onPushChange(sync);
  sync();
}
const wanted = () => SRC.filter((s) => AP.wants(s));
// 有要推的就每分钟看一次哪些项到时间了
function sync() {
  const on = wanted().length > 0;
  if (on && !S.timer) { S.timer = setInterval(run, 60e3); setTimeout(run, 5e3); }
  if (!on && S.timer) { clearInterval(S.timer); S.timer = 0; }
}

const ts = (v) => Date.parse(v) || 0;
const fmt = (v) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isk = (v) => {
  for (const [n, u] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (Math.abs(v) >= n) return (v / n).toFixed(2) + u;
  return fmt(v);
};
const num = (v) => Number(v || 0).toLocaleString('en-US');
// 物品名（蓝图等不在市场目录里的去 ESI 查）
async function namer(ids) {
  const m = await ctx.resolveTypeNames(ids).catch(() => null);
  return (id) => m?.get(Number(id)) || ctx.typeName(id);
}

async function run() {
  if (S.busy || !ctx.hasEsiToken()) return;
  const due = wanted().filter((s) => ctx.hasScope(SCOPE[s]) && Date.now() - (S.at[s] || 0) >= GAP[s]);
  if (!due.length) return;
  S.busy = true;
  try {
    const token = await ctx.ensureEsiToken();
    const me = token.character_id;
    if (me !== S.char) { S.char = me; S.at = {}; }
    const key = ctx.serverKey('eve-char-alerts-' + me);
    const out = [];
    for (const src of due) {
      S.at[src] = Date.now();
      try {
        const st = ctx.store.getJSON(key, {}) || {};
        const lines = await CHECK[src](me, st);
        ctx.store.setJSON(key, st);
        for (const [sig, zh, en] of lines) out.push({ src, sig: `${src}:${me}:${sig}`, text: `${token.character_name || me} · ${L(zh, en)}` });
      } catch (error) { console.warn('角色提醒读取失败', src, error); }
    }
    if (out.length) {
      ctx.showToast(out.slice(0, 3).map((x) => x.text).join(L('；', '; ')) + (out.length > 3 ? L(` 等 ${out.length} 条`, ` (${out.length} in all)`) : ''), 'info', 8000);
      for (const x of out) AP.push(x.src, { sig: x.sig, text: x.text });
    }
  } catch { /* 令牌失效：下一轮再试 */ } finally { S.busy = false; }
}

// 每项返回 [[去重标记, 中文, 英文]]；st 是这个角色的状态（就地修改，调用方存回）
const CHECK = {
  async skill(me, st) {
    const q = await ctx.esiAuthFetch(`/characters/${me}/skillqueue/`);
    const now = Date.now();
    const cur = {};
    for (const e of Array.isArray(q) ? q : []) { const fin = ts(e.finish_date); if (fin) cur[`${e.skill_id}:${e.finished_level}`] = fin; }
    const end = Math.max(0, ...Object.values(cur));
    const low = end > now && end - now < SKILL_LOW;
    const prev = st.skillq;
    st.skillq = { q: Object.fromEntries(Object.entries(cur).filter(([, t]) => t > now)), low: prev ? Boolean(prev.low) && low : low, empty: end <= now };
    if (!prev) return [];
    const out = [];
    const done = Object.entries(prev.q).filter(([k, t]) => (cur[k] ?? t) <= now).map(([k]) => k);
    if (done.length) {
      const nm = await namer(done.map((k) => Number(k.split(':')[0])));
      const names = done.slice(0, 8).map((k) => [nm(k.split(':')[0]), k.split(':')[1]]);
      const more = done.length > 8;
      out.push([done.join(','), '技能练完：' + names.map(([n, l]) => `${n} ${l} 级`).join('、') + (more ? ` 等 ${done.length} 个` : ''),
        'Skill trained: ' + names.map(([n, l]) => `${n} level ${l}`).join(', ') + (more ? ` and ${done.length - 8} more` : '')]);
    }
    if (st.skillq.empty && !prev.empty) {
      const paused = Array.isArray(q) && q.length > 0;   // 有技能但没有完成时间：没在训练
      out.push(['empty:' + now, paused ? '技能队列没在训练' : '技能队列已空，记得续上', paused ? 'Skill queue is paused' : 'Skill queue is empty']);
    } else if (low && !prev.low) {
      const h = Math.max(1, Math.round((end - now) / 3600e3));
      out.push(['low:' + end, `技能队列 ${h} 小时后练完，记得续上`, `Skill queue ends in ${h} h`]);
      st.skillq.low = true;
    }
    return out;
  },

  async job(me, st) {
    const jobs = await ctx.esiAuthFetch(`/characters/${me}/industry/jobs/`);
    const now = Date.now();
    const ready = (Array.isArray(jobs) ? jobs : []).filter((j) => ['active', 'ready'].includes(j.status) && ts(j.end_date) && ts(j.end_date) <= now);
    const seen = st.jobs;
    st.jobs = ready.map((j) => j.job_id);
    if (!seen) return [];
    const fresh = ready.filter((j) => !seen.includes(j.job_id));
    if (!fresh.length) return [];
    const nm = await namer(fresh.map((j) => j.product_type_id || j.blueprint_type_id));
    const place = await ctx.placeNames(fresh.map((j) => j.facility_id || j.station_id));
    return fresh.map((j) => {
      const [zh, en] = ACT[j.activity_id] || ['工业任务', 'Industry job'];
      const name = nm(j.product_type_id || j.blueprint_type_id), where = place(j.facility_id || j.station_id);
      const tail = where ? ` · ${where}` : '';
      return [j.job_id, `${zh}完成：${name} ×${j.runs || 1}${tail}`, `${en} done: ${name} ×${j.runs || 1}${tail}`];
    });
  },

  async pi(me, st) {
    const planets = await ctx.esiAuthFetch(`/characters/${me}/planets/`);
    const now = Date.now();
    const stopped = new Map();
    for (const p of (Array.isArray(planets) ? planets : []).slice(0, PI_MAX)) {
      const d = await ctx.esiAuthFetch(`/characters/${me}/planets/${p.planet_id}/`);
      for (const pin of d?.pins || []) {
        const exp = ts(pin.expiry_time);
        if (pin.extractor_details && exp && exp <= now) {
          if (!stopped.has(p.planet_id)) stopped.set(p.planet_id, [p, []]);
          stopped.get(p.planet_id)[1].push(`${p.planet_id}:${pin.pin_id}:${exp}`);
        }
      }
    }
    const seen = st.pi;
    st.pi = [...stopped.values()].flatMap(([, keys]) => keys);
    if (!seen) return [];
    const out = [];
    for (const [pid, [p, keys]] of stopped) {
      const fresh = keys.filter((k) => !seen.includes(k));
      if (!fresh.length) continue;
      // ESI 的行星名是「英文星系名 + 罗马数字」：换成本站的星系名 + 罗马数字
      const info = await ctx.fetchESI(`/universe/planets/${pid}/`).catch(() => null);
      const roman = String(info?.name || '').split(' ').pop();
      const name = ctx.sysName(p.solar_system_id) + (/^[IVXLC]+$/.test(roman) ? ' ' + roman : '');
      out.push([fresh.join(','), `行星开采器已停：${name}（${fresh.length} 个）`, `Extractor stopped: ${name} (${fresh.length})`]);
    }
    return out;
  },

  async sold(me, st) {
    const orders = await ctx.esiAuthFetch(`/characters/${me}/orders/`);
    const now = Date.now();
    const cur = Object.fromEntries((Array.isArray(orders) ? orders : []).map((o) => [o.order_id, [o.volume_remain, o.price, o.type_id, o.is_buy_order ? 1 : 0, o.volume_total, o.location_id]]));
    const prev = st.orders;
    st.orders = cur;
    if (!prev) return [];
    const gone = st.orders_gone ||= {};
    for (const [id, p] of Object.entries(prev)) if (!cur[id] && !gone[id]) gone[id] = [...p, now];
    if (!Object.keys(gone).length) return [];
    const hist = await ctx.esiAuthFetch(`/characters/${me}/orders/history/`).catch(() => []);
    const by = new Map((Array.isArray(hist) ? hist : []).map((h) => [String(h.order_id), h]));
    const done = [];
    for (const [id, p] of Object.entries(gone)) {
      const h = by.get(id);
      if (!h) { if (now - p[6] > GONE_KEEP) delete gone[id]; continue; }
      delete gone[id];
      if (h.state !== 'cancelled') done.push([id, p, h]);
    }
    if (!done.length) return [];
    const nm = await namer(done.map(([, p]) => p[2]));
    const place = await ctx.placeNames(done.map(([, p]) => p[5]));
    return done.map(([id, p, h]) => {
      const name = nm(p[2]), total = h.volume_total || p[4], left = h.volume_remain || 0, price = h.price || p[1];
      const where = place(p[5]), tail = where ? ` · ${where}` : '';
      const [sz, se] = p[3] ? ['收单', 'buy'] : ['卖单', 'sell'];
      return left === 0
        ? [id, `订单全部成交：${name} ${sz} ×${num(total)} @ ${fmt(price)} · 共 ${isk(total * price)} ISK${tail}`, `Order filled: ${name} ${se} ×${num(total)} @ ${fmt(price)} · ${isk(total * price)} ISK${tail}`]
        : [id, `订单过期：${name} ${sz} 剩 ${num(left)}/${num(total)} @ ${fmt(price)}${tail}`, `Order expired: ${name} ${se} ${num(left)}/${num(total)} left @ ${fmt(price)}${tail}`];
    });
  },

  async contract(me, st) {
    const list = await ctx.esiAuthFetch(`/characters/${me}/contracts/`);
    const cs = (Array.isArray(list) ? list : []).filter((c) => !c.for_corporation && (c.issuer_id === me || c.assignee_id === me));
    const prev = st.contracts;
    st.contracts = Object.fromEntries(cs.map((c) => [c.contract_id, c.status]));
    const bids = st.bids ||= {};
    const live = new Set();
    const out = [];
    const couriers = cs.filter((c) => c.type === 'courier');
    const place = couriers.length ? await ctx.placeNames(couriers.flatMap((c) => [c.start_location_id, c.end_location_id])) : () => '';
    for (const c of cs) {
      const id = String(c.contract_id), mine = c.issuer_id === me;
      const [kz, ke] = CT[c.type] || ['合同', 'Contract'];
      const lz = kz + (c.title ? `「${c.title}」` : ''), le = ke + (c.title ? ` “${c.title}”` : '');
      if (mine && c.type === 'auction' && c.status === 'outstanding' && live.size < BIDS_MAX) {
        live.add(id);
        const b = await ctx.esiAuthFetch(`/characters/${me}/contracts/${c.contract_id}/bids/`).catch(() => []);
        const top = Math.max(0, ...(Array.isArray(b) ? b : []).map((x) => x.amount || 0));
        if (top > (bids[id] || 0) && prev && id in prev) out.push([`${id}:bid:${top}`, `${lz}有新出价：${isk(top)} ISK`, `New bid on ${le}: ${isk(top)} ISK`]);
        bids[id] = Math.max(top, bids[id] || 0);
      }
      if (!prev) continue;
      const old = prev[id];
      if (!mine) {
        const price = c.type === 'courier' ? c.reward : c.price;
        if (old == null && c.status === 'outstanding') out.push([`${id}:to`, `收到指定给你的合同：${lz}${price ? ` · ${isk(price)} ISK` : ''}`, `Contract assigned to you: ${le}${price ? ` · ${isk(price)} ISK` : ''}`]);
        continue;
      }
      if (old == null || old === c.status) continue;
      const sig = `${id}:${c.status}`;
      if (c.type === 'courier') {
        const route = [place(c.start_location_id), place(c.end_location_id)].filter(Boolean).join(' → ');
        const msg = { in_progress: ['快递合同被接了', 'Courier contract accepted'], finished: ['快递已送达', 'Courier contract delivered'],
          failed: ['快递合同失败', 'Courier contract failed'], rejected: ['快递合同被拒绝', 'Courier contract rejected'] }[c.status];
        const tail = route ? ` · ${route}` : '';
        if (msg) out.push([sig, msg[0] + (c.title ? `「${c.title}」` : '') + tail, msg[1] + (c.title ? ` “${c.title}”` : '') + tail]);
      } else if (['finished', 'finished_issuer', 'finished_contractor'].includes(c.status)) {
        const price = c.type === 'auction' ? bids[id] || c.price : c.price;
        out.push([sig, `${lz}已完成${price ? ` · ${isk(price)} ISK` : ''}`, `${le} completed${price ? ` · ${isk(price)} ISK` : ''}`]);
      } else if (c.status === 'rejected') out.push([sig, `${lz}被拒绝`, `${le} rejected`]);
    }
    for (const k of Object.keys(bids)) if (!live.has(k)) delete bids[k];
    return out;
  }
};
