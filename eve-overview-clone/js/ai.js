// ===== AI 助手 =====
// 玩家用自然语言提问（配船、会战、物价走势、自己的 ESI 数据……），大模型按需调用工具，工具都在浏览器里执行：
//   装配引擎（fitting.js aiFit）、本站击杀记录接口（/api/kb/*）、ESI 公开市场数据、玩家自己的 ESI 令牌（只在本机）。
// 服务器 /api/kb/ai/chat 只做一步：把对话转成上游协议、带上系统提示词与工具定义（server/kb_service.py「AI 助手」）；
// 流式返回（NDJSON：{t: 文字增量} … {done: 结果}），回答边生成边显示。
// 循环：请求一步 → 有工具调用就逐个执行、把结果追加为 tool 消息 → 再请求，直到模型不再调用工具（最多 MAX_STEPS 步）。
// 对话记在本机（CHAT_KEY），自己的接口设置记在 LLM_KEY（API Key 只保存在本机浏览器，随请求经本站转发，不保存）。
import * as BS from './bazaar-skills.js?v=7';
import * as JP from './jump-planner.js?v=v17';

let ctx;   // esc, showToast, store, formatISK, formatNumber, server, fetchESI, esiAuthFetchPaged, hasEsiToken, tokenInfo,
           // resolveTypeNames, catalogTypes, hubPrices, avgPrices, fitting, openFit, openEsiBind, accounts, accountFetch, accountPaged
const $ = (id) => document.getElementById(id);
const CHAT_KEY = 'eve-ai-chat-v1';
const LLM_KEY = 'eve-ai-llm';
const MAX_STEPS = 16;
const RESULT_MAX = 12000;       // 每个工具结果最多字数（发给模型）
const WIRE_MAX = 500000;        // 整个对话发给服务器的上限（超出时丢掉最早的几轮）
const KB = '/api/kb/';
const PROTOS = [['openai-chat', 'OpenAI Chat'], ['openai-responses', 'OpenAI Responses'], ['anthropic', 'Anthropic']];
const TOOL_LABEL = {
  search_items: '搜索物品', auto_fit: '智能装配', compute_fit: '计算装配', show_fit: '展示装配', market_price: '查询价格', market_history: '查询价格走势',
  route_plan: '规划路线', jump_plan: '规划跳跃', industry_cost: '计算制造', industry_profits: '制造利润排行', industry_systems: '查询成本指数',
  lp_offers: '计算 LP 收益', pi_info: '查询行星工业', pi_colonies: '读取行星', wormhole_info: '查询虫洞', sov_system: '查询主权星系', sov_upgrades: '查询主权升级件', sov_plan: '主权规划', sov_my_hubs: '读取主权设施', appraise: '估价', contracts_search: '搜索合同',
  courier_contracts: '查询快递合同', hub_arbitrage: '查询倒卖', faction_warfare: '查询势力战争', guides_search: '搜索教程', guide_read: '阅读教程', plaza_search: '搜索广场', pilot_intel: '查询人物', my_characters_fly: '查询角色能开什么', bazaar_search: '搜索角色交易',
  kb_battles: '查询会战', kb_kills: '查询击杀记录', kb_ship_fits: '查询实战装配', kb_entity: '查询击杀统计', gank_risk: '查询强爆统计', my_character: '读取角色', esi_get: '读取 ESI'
};

const S = {
  msgs: [],          // 对话（与协议无关的格式；tool 消息另带 brief / card / fit 只在本机用）
  busy: false, abort: null, status: '', error: '',
  live: '',          // 正在流式生成的回答文字
  info: null,        // { site, model, daily, left }
  llm: { on: false, proto: 'openai-chat', base: '', key: '', model: '' },
  models: [], settings: false, llmMsg: '', showKey: false
};

export function initAi(context) {
  ctx = context;
  try { S.msgs = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]'); } catch { S.msgs = []; }
  if (!Array.isArray(S.msgs)) S.msgs = [];
  try { Object.assign(S.llm, JSON.parse(localStorage.getItem(LLM_KEY) || '{}')); } catch { /* 默认用本站模型 */ }
}

const ICON = {
  // AI 助手标志：曲边四角星 + 小星，蓝紫渐变填充（不加底色块）
  spark: '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="aiGrad" x1="4" y1="3" x2="21" y2="20" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#60a5fa"/><stop offset="0.55" stop-color="#818cf8"/><stop offset="1" stop-color="#c084fc"/></linearGradient></defs><path fill="url(#aiGrad)" d="M12 3C12.8 7.6 14.4 9.2 19 10C14.4 10.8 12.8 12.4 12 17C11.2 12.4 9.6 10.8 5 10C9.6 9.2 11.2 7.6 12 3Z"/><path fill="url(#aiGrad)" d="M18.5 15C18.8 16.5 19.3 17 20.8 17.3C19.3 17.6 18.8 18.1 18.5 19.6C18.2 18.1 17.7 17.6 16.2 17.3C17.7 17 18.2 16.5 18.5 15Z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.8 9.8 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  fit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/></svg>',
  battle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/></svg>',
  chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/></svg>',
  route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16"/></svg>',
  factory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21V10l6 4V10l6 4V4h6v17z"/><path d="M7 17h2M12 17h2M17 17h2"/></svg>',
  coins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="9" cy="7" rx="6" ry="3"/><path d="M3 7v5c0 1.7 2.7 3 6 3s6-1.3 6-3V7"/><path d="M9 15v2c0 1.7 2.7 3 6 3s6-1.3 6-3v-5c0-1.7-2.7-3-6-3"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="6"/><ellipse cx="12" cy="12" rx="11" ry="3.5" transform="rotate(-20 12 12)"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M12 8v5M12 16h.01"/></svg>'
};

export function showAi() {
  const root = $('aiMain');
  if (!root.dataset.ready) {
    root.dataset.ready = '1';
    root.innerHTML = `<div class="ai-scroll" id="aiScroll"><div class="ai-col">
        <div class="ai-top">
          <span class="ai-avatar">${ICON.spark}</span><b>AI 助手</b>
          <button type="button" class="ai-model" id="aiModel" data-ai-settings title="选择模型" aria-haspopup="dialog"><span></span>${ICON.chevron}</button>
          <span class="toolbar-spacer"></span>
          <button type="button" class="icon-btn" data-ai-new title="新对话" aria-label="新对话">${ICON.plus}</button>
          <div class="ai-settings" id="aiSettings" role="dialog" aria-label="模型设置" hidden></div>
        </div>
        <div class="ai-log" id="aiLog" aria-live="polite"></div>
      </div></div>
      <div class="ai-dock"><div class="ai-col">
        <form class="ai-composer" id="aiForm">
          <textarea id="aiText" rows="1" placeholder="问点什么，例如：帮我配一艘镰刀，装 100MN 加力，速度 2000 以上" maxlength="4000"></textarea>
          <button type="submit" class="ai-send" id="aiSend" title="发送" aria-label="发送">${ICON.send}</button>
        </form>
        <div class="ai-foot"><span id="aiQuota"></span><span class="ai-foot-key">Enter 发送 · Shift+Enter 换行</span></div>
      </div></div>`;
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    // 点浮层外面或按 Esc 关闭模型设置
    document.addEventListener('pointerdown', (e) => {
      if (S.settings && !e.target.closest?.('#aiSettings, [data-ai-settings]')) { S.settings = false; renderSettings(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && S.settings) { S.settings = false; renderSettings(); $('aiModel')?.focus(); }
    });
    $('aiForm').addEventListener('submit', (e) => { e.preventDefault(); send(); });
    const box = $('aiText');
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    box.addEventListener('input', growInput);
  }
  if (!S.msgs.length) refreshSuggest(); else render();
  renderSettings();
  loadInfo();
  setTimeout(() => $('aiText')?.focus(), 30);
}

// 输入框随内容长高（最多约 8 行）
function growInput() {
  const box = $('aiText');
  if (!box) return;
  box.style.height = 'auto';
  box.style.height = Math.min(box.scrollHeight, 200) + 'px';
}

async function loadInfo() {
  try {
    const r = await fetch(KB + 'ai/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (r.ok) S.info = await r.json();
  } catch { /* 显示不了额度 */ }
  renderHead();
  if (S.settings && !$('aiSettings')?.contains(document.activeElement)) renderSettings();
}

// ---------- 界面 ----------
function renderHead() {
  const q = $('aiQuota');
  if (!q) return;
  const own = S.llm.on && S.llm.key;
  q.textContent = own ? '使用自己的接口' : S.info?.site ? `今日剩余 ${S.info.left} / ${S.info.daily} 次` : S.info ? '本站未配置模型' : '';
  q.title = own ? '' : '每次调用模型算一次（一个问题通常要 2–6 次），UTC 0 点重置';
  const m = $('aiModel');
  m.firstElementChild.textContent = (own ? S.llm.model : S.info?.model) || '选择模型';
  m.classList.toggle('is-open', S.settings);
  m.setAttribute('aria-expanded', String(S.settings));
}

// ---------- 推荐问题：覆盖全站功能，结合已绑定角色（所在星系、在开的船）和最近的会战 / 强爆，每次打开随机换 ----------
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];
const pickTwo = (a) => { const x = pickOne(a); let y = pickOne(a); for (let i = 0; y === x && i < 9; i++) y = pickOne(a); return [x, y]; };
const SG = {
  ships: ['伊什塔级', '金鹏级', '狞獾级', '毒蜥级', '乌鸦级', '多米尼克斯级', 'Machariel', 'Vexor Navy Issue', 'Rattlesnake', 'Hurricane'],
  goals: ['刷 4 级任务', '刷 00 异常', '高安刷深渊 T3', '小规模 PVP', '低安漫游'],
  items: ['PLEX', '大型技能注入器', '三钛合金', '同位聚合体', '超噬矿', '技能提取器'],
  hubs: ['吉他', '艾玛', '多迪谢', '伦斯', '赫克'],
  danger: ['乌达玛', 'Niarja', 'Sivala', 'Tama'],
  pi: ['机器人技术', '超级计算机', '纳米工厂', 'Broadcast Node'],
  holes: ['H296', 'U210', 'B274', 'N062'],
  sov: ['1DQ1-A', 'T5ZI-S', 'M-OEE8', '4-HWWF']
};
// [图标, 分类, 生成问题]；返回 null 表示当前条件下不适用
const SUGGEST = [
  ['fit', '配船', () => { const [s, g] = [pickOne(SG.ships), pickOne(SG.goals)]; return `帮我配一艘${s}，用来${g}，按我的技能能开的来`; }],
  ['fit', '实战装配', () => `最近击杀记录里${pickOne(SG.ships)}大家都怎么配？`],
  ['chart', '物价', () => `${pickOne(SG.items)}最近价格走势怎么样？接下来会涨还是跌？`],
  ['chart', '倒卖', () => { const [a, b] = pickTwo(SG.hubs); return `${a}和${b}之间倒什么最赚钱？`; }],
  ['route', '路线', () => { const [a, b] = pickTwo(SG.hubs); return `从${a}到${b}最安全怎么走，要多少跳？`; }],
  ['route', '快递', () => `从${pickOne(SG.hubs)}出发有哪些报酬高的快递单？`],
  ['factory', '制造', () => `造一艘${pickOne(SG.ships)}成本多少，能赚多少？`],
  ['factory', '制造', () => pickOne(['现在高安造什么最赚钱？', '哪个高安星系制造成本指数最低？'])],
  ['coins', 'LP 商店', () => pickOne(['现在哪个 LP 商店最划算？', '我有 50 万势力战争 LP，换什么最赚？'])],
  ['globe', '行星工业', () => `${pickOne(SG.pi)}怎么造，利润怎么样？`],
  ['globe', '虫洞', () => (ctx.server.id === 'tq' && Math.random() < 0.5 ? '现在席拉连着哪些星系？离吉他最近的是哪个？' : `${pickOne(SG.holes)} 虫洞通往哪里，能过什么船？`)],
  ['flag', '主权规划', () => `${pickOne(SG.sov)} 能装哪些主权升级件，电力和劳动力够不够？`],
  ['flag', '势力战争', () => '现在势力战争哪边占优？各战区情况怎么样？'],
  ['box', '估价', () => '帮我估个价：三钛合金 100000、类晶体胶矿 50000、PLEX 10'],
  ['box', '合同', () => `合同里现在最便宜的${pickOne(SG.ships)}多少钱？`],
  ['shield', '高安强爆', () => `${pickOne(SG.danger)}最近强爆多吗？什么时段最危险？`],
  ['user', '角色交易', () => pickOne(['帮我找个能开旗舰、价格 100 亿以内的号', '角色交易里能开泰坦的号一般多少钱？'])],
  ['spark', '新手', () => pickOne(['新手怎么快速赚到第一个 10 亿？', '刚进游戏该先练哪些技能？'])]
];
const HINT = { at: 0, p: null, battle: null, gank: null, me: null };
// 最近的会战 / 强爆热点 / 当前角色的位置和舰船：五分钟内只读一次，读到后重排推荐
function loadHints() {
  if (HINT.p || Date.now() - HINT.at < 300e3) return HINT.p;
  HINT.at = Date.now();
  const me = ctx.accounts?.()?.[0];
  const has = (sc) => [].concat(me?.scopes || []).join(' ').includes(sc);
  return (HINT.p = Promise.all([
    kbGet('battles/history?days=2').then((d) => { const b = (d.battles || []).sort((x, y) => y.kills - x.kills)[0]; return b && mapData().then((m) => ({ system: m.systems.get(b.system_id)?.name, kills: b.kills })); }).catch(() => null),
    kbGet('gank?days=7').then((d) => { const x = d.systems?.[0]; return x && mapData().then((m) => m.systems.get(x.id)?.name); }).catch(() => null),
    me ? Promise.all([
      has('esi-location.read_location.v1') ? ctx.accountFetch(me.id, `/characters/${me.id}/location/`).catch(() => null) : null,
      has('esi-location.read_ship_type.v1') ? ctx.accountFetch(me.id, `/characters/${me.id}/ship/`).catch(() => null) : null
    ]).then(async ([loc, ship]) => ({
      name: me.name,
      system: loc?.solar_system_id ? (await mapData()).systems.get(loc.solar_system_id)?.name : '',
      ship: ship?.ship_type_id ? (await ctx.resolveTypeNames([ship.ship_type_id]).catch(() => new Map())).get(ship.ship_type_id) || '' : ''
    })) : null
  ]).then(([battle, gank, me]) => { Object.assign(HINT, { battle, gank, me }); }).finally(() => { HINT.p = null; }));
}
function suggestions() {
  const out = [], used = new Set();
  const add = (icon, tag, text) => { if (text && !used.has(text) && out.length < 6) { used.add(text); out.push({ icon, tag, text }); } };
  const accts = ctx.accounts?.() || [];
  const me = HINT.me;
  // 跟玩家自己相关的（已绑定角色）
  if (accts.length) {
    const who = accts.length > 1 ? '我所有角色' : me?.name || '我';
    add('box', '我的角色', pickOne([`看看${who}的资产里最值钱的十样东西`, `${who}现在能开哪些船？哪些差一点技能？`, '我的行星采集器有没有停的？', '我的工业任务什么时候做完？']));
    if (me?.ship) add('fit', '我的舰船', `我在开的${me.ship}怎么配比较好？按我的技能来`);
    else if (me?.system) add('route', '我的位置', `我现在在${me.system}，去${pickOne(SG.hubs.filter((h) => h !== me.system))}怎么走最安全？`);
    if (me?.system && me?.ship && Math.random() < 0.6) add('shield', '我的位置', `我在${me.system}附近，最近这一带危险吗？`);
  } else {
    add('box', '我的角色 · 需绑定 ESI', pickOne(['看看我的资产里最值钱的十样东西', '我现在能开哪些船？']));
  }
  // 最近发生的事
  if (HINT.battle?.system) add('battle', '最近会战', `${HINT.battle.system}最近那场会战（${HINT.battle.kills} 艘）谁赢了？双方损失多少？`);
  else add('battle', '会战', '昨晚有没有大规模会战？');
  if (HINT.gank && Math.random() < 0.7) add('shield', '高安强爆', `${HINT.gank}最近强爆多吗？什么时段最危险？`);
  // 其余从全站功能里随机挑，同一分类只出一个
  const tags = new Set(out.map((x) => x.tag));
  for (const [icon, tag, make] of [...SUGGEST].sort(() => Math.random() - 0.5)) {
    if (tags.has(tag)) continue;
    const text = make();
    if (text) { tags.add(tag); add(icon, tag, text); }
  }
  return out.sort(() => Math.random() - 0.5);
}
function refreshSuggest() {
  S.sugg = suggestions();
  if (!S.msgs.length) render();
  // 实时数据第一次读到时再换一次（只在还没开始对话、玩家没手动换过时）
  const p = loadHints();
  if (p && !HINT.me && !HINT.battle) p.then(() => { if (!S.msgs.length && !S.busy) { S.sugg = suggestions(); render(); } });
}

function render() {
  const log = $('aiLog');
  if (!log) return;
  renderHead();
  const { esc } = ctx;
  log.classList.toggle('is-empty', !S.msgs.length);
  if (!S.msgs.length) {
    log.innerHTML = `<div class="ai-hero"><span class="ai-hero-icon">${ICON.spark}</span><h2>有什么可以帮你？</h2></div>
      <div class="ai-examples">${(S.sugg || []).map((x) => `<button type="button" class="ai-example" data-ai-example>
        <span class="ai-example-icon">${ICON[x.icon] || ICON.spark}</span><span><small>${esc(x.tag)}</small><b>${esc(x.text)}</b></span></button>`).join('')}</div>
      <div class="ai-more"><button type="button" class="btn btn-ghost btn-sm" data-ai-more>${ICON.refresh}换一批</button></div>`;
  } else {
    // 同一轮里模型的多步（调用工具 → 回答）合成一块，只显示一个头像
    const results = new Map(S.msgs.filter((m) => m.role === 'tool').map((m) => [m.id, m]));
    const blocks = [];
    for (const m of S.msgs) {
      if (m.role === 'user') blocks.push({ user: m });
      else if (m.role === 'assistant') {
        let b = blocks[blocks.length - 1];
        if (!b || b.user) blocks.push(b = { steps: [], parts: [] });
        for (const c of m.calls || []) b.steps.push(stepHtml(c, results.get(c.id)));
        if (m.text) b.parts.push(`<div class="ai-md">${md(m.text)}</div>`);
        for (const c of m.calls || []) { const card = results.get(c.id)?.card; if (card) b.parts.push(cardHtml(card)); }
      }
    }
    if ((S.busy || S.error) && (!blocks.length || blocks[blocks.length - 1].user)) blocks.push({ steps: [], parts: [] });
    if (S.live) blocks[blocks.length - 1].parts.push(`<div class="ai-md ai-live">${md(S.live)}</div>`);
    log.innerHTML = blocks.map((b, i) => {
      if (b.user) return `<div class="ai-msg is-user"><div class="ai-bubble">${esc(b.user.text).replace(/\n/g, '<br>')}</div></div>`;
      const last = i === blocks.length - 1;
      const tail = last && S.busy && !S.live ? `<div class="ai-status"><span class="ai-dots"><i></i><i></i><i></i></span><span>${esc(S.status || '思考中…')}</span></div>`
        : last && S.error ? `<div class="ai-error"><span>${esc(S.error)}</span><button type="button" class="btn btn-ghost" data-ai-retry>重试</button></div>` : '';
      const trace = b.steps.length ? `<div class="ai-trace">${b.steps.join('')}</div>` : '';
      return `<div class="ai-msg is-bot"><span class="ai-avatar">${ICON.spark}</span><div class="ai-body">${trace}${b.parts.join('')}${tail}</div></div>`;
    }).join('');
  }
  const btn = $('aiSend');
  btn.innerHTML = S.busy ? ICON.stop : ICON.send;
  btn.classList.toggle('is-busy', S.busy);
  btn.title = S.busy ? '停止' : '发送';
  btn.setAttribute('aria-label', btn.title);
  const scroller = $('aiScroll');
  if (scroller && S.msgs.length) scroller.scrollTop = scroller.scrollHeight;
}

// 流式文字到达：只重画生成中的那段（每帧最多一次）；玩家没往上翻时跟着滚到底
let liveFrame = 0;
function renderLive() {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    const el = document.querySelector('#aiLog .ai-live');
    if (!el) { render(); return; }
    const sc = $('aiScroll');
    const stick = sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
    el.innerHTML = md(S.live);
    if (stick) sc.scrollTop = sc.scrollHeight;
  });
}

function stepHtml(c, res) {
  const { esc } = ctx;
  const state = !res ? 'is-run' : res.failed ? 'is-fail' : 'is-done';
  const label = TOOL_LABEL[c.name] || c.name;
  const brief = res?.brief || (res ? '' : '进行中…');
  return `<details class="ai-step ${state}"><summary><i></i><b>${esc(label)}</b>${brief ? `<span>${esc(brief)}</span>` : ''}</summary>
    <pre>${esc(JSON.stringify(c.args, null, 1))}${res ? '\n—\n' + esc(res.text.slice(0, 4000)) : ''}</pre></details>`;
}

function cardHtml(card) {
  const { esc, formatNumber } = ctx;
  if (card.kind !== 'fit') return '';
  const s = card.summary;
  const item = (label, value) => `<div><small>${label}</small><b>${value}</b></div>`;
  return `<div class="ai-card">
    <div class="ai-fit-head"><img src="https://images.evetech.net/types/${card.ship}/render?size=128" alt="" width="56" height="56" loading="lazy">
      <div><b>${esc(card.title || s.ship)}</b><small>${esc(s.ship)}</small>${card.problems ? `<em>${esc(card.problems)}</em>` : ''}</div></div>
    <div class="ai-fit-stats">
      ${item('DPS', formatNumber(Math.round(s.dps)))}${item('EHP', formatNumber(Math.round(s.ehp)))}
      ${item('速度', formatNumber(Math.round(s.speed)) + ' m/s')}${item('电容', esc(s.cap))}
    </div>
    <div class="ai-fit-actions"><button type="button" class="btn btn-primary" data-ai-open-fit="${esc(card.id)}">在装配页打开</button>
      <button type="button" class="btn ai-btn-soft" data-ai-copy-eft="${esc(card.id)}">复制 EFT</button></div>
  </div>`;
}

// 模型设置浮层：本站模型 / 自己的接口二选一；自己的接口填协议、地址、Key、模型（可从上游取模型列表点选）
function renderSettings() {
  const box = $('aiSettings');
  if (!box) return;
  box.hidden = !S.settings;
  $('aiModel')?.classList.toggle('is-open', S.settings);
  $('aiModel')?.setAttribute('aria-expanded', String(S.settings));
  if (!S.settings) return;
  const { esc } = ctx;
  const L = S.llm, I = S.info;
  const opt = (on, src, title, sub) => `<button type="button" class="ai-opt${on ? ' is-active' : ''}" data-ai-src="${src}" aria-pressed="${on}">
      <span class="ai-opt-text"><b>${title}</b><small>${sub}</small></span><span class="ai-opt-check">${on ? ICON.check : ''}</span></button>`;
  const site = I?.site ? `${esc(I.model || '')} · 今日剩余 ${I.left} / ${I.daily} 次` : I ? '本站暂未配置模型' : '读取中…';
  const q = L.model.trim().toLowerCase();
  const models = S.models.filter((m) => !q || m.toLowerCase().includes(q) || m === L.model).slice(0, 80);
  box.innerHTML = `<div class="ai-set-title">模型</div>
    <div class="ai-opts">${opt(!L.on, 'site', '本站模型', site)}${opt(L.on, 'own', '自己的接口', '支持 OpenAI / Anthropic 协议，不占本站额度')}</div>
    ${L.on ? `<div class="ai-set-form">
      <div class="ai-field"><small>协议</small><div class="ai-chips">${PROTOS.map(([v, n]) => `<button type="button" class="${L.proto === v ? 'is-active' : ''}" data-ai-proto="${v}">${n}</button>`).join('')}</div></div>
      <label class="ai-field"><small>接口地址</small><input data-ai-llm="base" value="${esc(L.base)}" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false"></label>
      <label class="ai-field"><small>API Key</small><span class="ai-input"><input data-ai-llm="key" type="${S.showKey ? 'text' : 'password'}" value="${esc(L.key)}" placeholder="sk-…" autocomplete="off" spellcheck="false">
        <button type="button" class="ai-input-btn" data-ai-showkey title="${S.showKey ? '隐藏' : '显示'}" aria-label="${S.showKey ? '隐藏' : '显示'}">${S.showKey ? ICON.eyeOff : ICON.eye}</button></span></label>
      <label class="ai-field"><small>模型</small><span class="ai-input"><input data-ai-llm="model" value="${esc(L.model)}" placeholder="模型名，例如 gpt-4.1" autocomplete="off" spellcheck="false">
        <button type="button" class="ai-input-btn is-text" data-ai-models>获取列表</button></span></label>
      ${models.length ? `<div class="ai-model-list">${models.map((m) => `<button type="button" class="${m === L.model ? 'is-active' : ''}" data-ai-pick="${esc(m)}">${esc(m)}</button>`).join('')}</div>` : ''}
      ${S.llmMsg ? `<p class="ai-set-msg">${esc(S.llmMsg)}</p>` : ''}
      <p class="ai-set-note">${ICON.lock}<span>Key 只保存在本机浏览器，提问时经本站转发给上游，不保存、不写日志。模型需要支持工具调用。</span></p>
    </div>` : ''}`;
}

function saveLlm() {
  try { localStorage.setItem(LLM_KEY, JSON.stringify(S.llm)); } catch { /* 存不下就只在本次有效 */ }
}

function saveChat() {
  // 只留最近的对话；存不下时丢掉最早的
  let list = S.msgs;
  for (let i = 0; i < 5; i++) {
    try { localStorage.setItem(CHAT_KEY, JSON.stringify(list)); return; } catch { list = trimTurns(list, Math.ceil(list.length / 2)); }
  }
}

// 丢掉最早的若干条消息，从下一条用户消息开始
function trimTurns(list, drop) {
  let i = drop;
  while (i < list.length && list[i].role !== 'user') i++;
  return list.slice(i);
}

async function onClick(e) {
  const t = e.target;
  const ex = t.closest('[data-ai-example]');
  if (ex) { $('aiText').value = ex.querySelector('b').textContent; send(); return; }
  const src = t.closest('[data-ai-src]');
  if (src) { S.llm.on = src.dataset.aiSrc === 'own'; saveLlm(); renderSettings(); renderHead(); return; }
  const proto = t.closest('[data-ai-proto]');
  if (proto) { S.llm.proto = proto.dataset.aiProto; S.models = []; S.llmMsg = ''; saveLlm(); renderSettings(); return; }
  if (t.closest('[data-ai-showkey]')) { S.showKey = !S.showKey; renderSettings(); $('aiSettings').querySelector('[data-ai-llm="key"]')?.focus(); return; }
  const pick = t.closest('[data-ai-pick]');
  if (pick) { S.llm.model = pick.dataset.aiPick; saveLlm(); renderSettings(); renderHead(); return; }
  if (t.closest('[data-ai-new]')) {
    if (S.busy) stop();
    S.msgs = []; S.error = ''; saveChat(); refreshSuggest(); $('aiText').focus(); return;
  }
  if (t.closest('[data-ai-more]')) { S.sugg = suggestions(); render(); return; }
  if (t.closest('[data-ai-settings]')) { S.settings = !S.settings; renderSettings(); renderHead(); return; }
  if (t.closest('[data-ai-retry]')) { S.error = ''; run(); return; }
  if (t.closest('[data-ai-models]')) { fetchModels(); return; }
  const open = t.closest('[data-ai-open-fit]');
  if (open) { const f = findFit(open.dataset.aiOpenFit); if (f) ctx.openFit(f.compact); return; }
  const copy = t.closest('[data-ai-copy-eft]');
  if (copy) { const f = findFit(copy.dataset.aiCopyEft); if (f) ctx.copyText(f.eft); }
}

// 模型输入框：边输入边筛选取到的模型列表
function onInput(e) {
  const t = e.target;
  if (t.dataset?.aiLlm !== 'model' || !S.models.length) return;
  S.llm.model = t.value.trim();
  const list = $('aiSettings').querySelector('.ai-model-list');
  const q = S.llm.model.toLowerCase();
  if (list) for (const b of list.children) b.hidden = Boolean(q) && !b.dataset.aiPick.toLowerCase().includes(q);
}

function onChange(e) {
  const t = e.target;
  const k = t.dataset?.aiLlm;
  if (k) { S.llm[k] = t.value.trim(); saveLlm(); renderHead(); }
}

async function fetchModels() {
  for (const el of $('aiSettings').querySelectorAll('[data-ai-llm]')) S.llm[el.dataset.aiLlm] = el.value.trim();
  saveLlm();
  S.llmMsg = '正在获取…'; renderSettings();
  try {
    const r = await fetch(KB + 'translate/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ownLlm()), signal: AbortSignal.timeout(30000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    S.models = d.models || [];
    S.llmMsg = S.models.length ? `取到 ${S.models.length} 个模型，点一下选择（输入可筛选）` : '上游没有返回模型，请直接填写模型名';
  } catch (error) {
    S.llmMsg = '获取模型失败：' + error.message;
  }
  renderSettings();
}

const ownLlm = () => ({ proto: S.llm.proto, base: S.llm.base, key: S.llm.key, model: S.llm.model });
const findFit = (id) => {
  for (const m of S.msgs) if (m.role === 'tool') for (const f of m.fits || []) if (f.id === id) return f;
  return null;
};
// 工具执行中的进度（只改状态行的文字，不重画整个对话）
function setStatus(text) {
  S.status = text;
  const el = document.querySelector('#aiLog .ai-status');
  if (el?.lastChild) el.lastChild.textContent = text;
}

// ---------- 对话循环 ----------
function send() {
  if (S.busy) { stop(); return; }
  const box = $('aiText');
  const text = box.value.trim();
  if (!text) return;
  box.value = '';
  growInput();
  S.error = '';
  // 上次中断（刷新页面、出错）留下的未执行调用：标为已取消，不再执行
  const last = [...S.msgs].reverse().find((m) => m.role === 'assistant');
  const done = new Set(S.msgs.filter((m) => m.role === 'tool').map((m) => m.id));
  for (const c of last?.calls || []) if (!done.has(c.id)) S.msgs.push({ role: 'tool', id: c.id, name: c.name, text: '（已取消）', brief: '已取消', failed: true });
  S.msgs.push({ role: 'user', text });
  saveChat();
  run();
}

function stop() {
  S.abort?.abort();
}

// 发给服务器的对话：去掉本机字段；较早几轮的工具结果截短；太长时丢掉最早的几轮
function wire() {
  let list = S.msgs;
  const lastUser = list.map((m) => m.role).lastIndexOf('user');
  const out = () => list.map((m, i) => (m.role === 'tool' ? { role: 'tool', id: m.id, name: m.name, text: i < lastUser && m.text.length > 1500 ? m.text.slice(0, 1500) + '…（已截短）' : m.text }
    : m.role === 'assistant' ? { role: 'assistant', text: m.text || '', calls: m.calls || [], raw: m.raw || null } : { role: 'user', text: m.text }));
  let w = out();
  while (JSON.stringify(w).length > WIRE_MAX && list.length > 2) { list = trimTurns(list, 2); w = out(); }
  return w;
}

function chatCtx() {
  const tok = ctx.tokenInfo();
  const off = -new Date().getTimezoneOffset() / 60;
  return { server: ctx.server.id, lang: window.I18N?.lang === 'en' ? 'en' : 'zh', character: tok?.character_name || '', characters: ctx.accounts().map((a) => a.name), tz: (off >= 0 ? '+' : '') + off };
}

async function step(signal) {
  const body = JSON.stringify({ messages: wire(), ctx: chatCtx(), stream: true, ...(S.llm.on && S.llm.key ? { llm: ownLlm() } : {}) });
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(KB + 'ai/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
    if (r.ok && /ndjson/.test(r.headers.get('Content-Type') || '')) return readStream(r);
    const d = await r.json().catch(() => ({}));
    if (r.ok) return d;
    const msg = d.error || 'HTTP ' + r.status;
    // 本站或上游限流：等一会儿自动重试（最多 6 次）
    // 优先按本站 / 上游给的 Retry-After 等待
    const after = Number(r.headers.get('Retry-After')) || 0;
    const wait = r.status === 429 || after ? Math.min(90, after || 10) : /429|限流/.test(msg) ? 15 : 0;
    if (wait && attempt < 6) {
      for (let s = wait; s > 0; s--) {
        S.status = `请求太频繁，${s} 秒后自动重试…`; render();
        await new Promise((ok, no) => { const t = setTimeout(ok, 1000); signal.addEventListener('abort', () => { clearTimeout(t); no(new DOMException('', 'AbortError')); }, { once: true }); });
      }
      S.status = '思考中…'; render();
      continue;
    }
    throw new Error(msg);
  }
}

// 读流式回答：{t} 追加到生成中的文字，{done} 是这一步的完整结果，{error} 是中途出错
async function readStream(r) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  S.live = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += dec.decode(value || new Uint8Array(), { stream: !done });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.t) { S.live += ev.t; renderLive(); }
        if (ev.error) throw new Error(ev.error);
        if (ev.done) return ev.done;
      }
      if (done) throw new Error('连接中断，请重试');
    }
  } finally {
    S.live = '';
  }
}

async function run() {
  if (S.busy) return;
  S.busy = true; S.status = '思考中…'; S.error = '';
  S.abort = new AbortController();
  const { signal } = S.abort;
  render();
  try {
    // 上次中断留下的未执行调用：先补上结果
    await runPending(signal);
    for (let n = 0; n < MAX_STEPS; n++) {
      const res = await step(signal);
      if (typeof res.left === 'number' && S.info) S.info.left = res.left;
      S.msgs.push({ role: 'assistant', text: res.text || '', calls: res.calls || [], raw: res.raw || null });
      saveChat();
      if (!res.calls?.length) {
        if (!res.text) S.msgs[S.msgs.length - 1].text = res.stop === 'length' || res.stop === 'max_tokens' ? '（回答太长被截断了，请换个问法或分几次问）' : '（模型没有回答）';
        break;
      }
      await runPending(signal);
      if (n === MAX_STEPS - 1) S.error = '步骤太多，已停止。可以换个更具体的问法。';
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      S.msgs.push({ role: 'assistant', text: '（已停止）', calls: [] });
    } else {
      S.error = '出错了：' + error.message;
    }
  } finally {
    S.busy = false; S.abort = null; S.status = '';
    saveChat();
    render();
  }
}

async function runPending(signal) {
  const last = [...S.msgs].reverse().find((m) => m.role === 'assistant');
  if (!last?.calls?.length) return;
  const done = new Set(S.msgs.filter((m) => m.role === 'tool').map((m) => m.id));
  for (const c of last.calls) {
    if (done.has(c.id)) continue;
    if (signal.aborted) throw new DOMException('', 'AbortError');
    S.status = (TOOL_LABEL[c.name] || c.name) + '…';
    render();
    let out;
    try {
      out = await (TOOLS[c.name] || (() => { throw new Error('没有这个工具'); }))(c.args || {}, signal);
    } catch (error) {
      out = { text: '出错：' + error.message, brief: error.message, failed: true };
    }
    let text = typeof out.data === 'string' ? out.data : out.data !== undefined ? JSON.stringify(out.data) : out.text || '';
    if (text.length > RESULT_MAX) text = text.slice(0, RESULT_MAX) + '…（结果太长，已截断；可以缩小范围再查）';
    const fits = out.fits || (out.fit ? [out.fit] : null);
    S.msgs.push({ role: 'tool', id: c.id, name: c.name, text, brief: out.brief || '', failed: Boolean(out.failed), ...(out.card ? { card: out.card } : {}), ...(fits ? { fits } : {}) });
    S.status = '思考中…';
    saveChat();
    render();
  }
}

// ---------- 名称解析 ----------
let fitDataP = null, mapP = null, enP = null;
const fitData = () => (fitDataP ||= ctx.fitting().then((m) => m.fitData()).then((x) => x.data).catch((e) => { fitDataP = null; throw e; }));
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
// 比较用：去掉空格和常见标点（中文名里数字和汉字之间没有空格，模型常加上）
const squash = (s) => norm(s).replace(/[\s·・\-_'’"“”,，.。()（）]/g, '');
const grams = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
// 英文名 → 中文名（站内数据都是中文名；模型常给英文名）
function enNames() {
  if (!enP) enP = fetch('i18n/names-en.json').then((r) => (r.ok ? r.json() : {})).then((d) => {
    const m = new Map();
    for (const [zh, en] of Object.entries(d || {})) if (typeof en === 'string' && !m.has(en.toLowerCase())) m.set(en.toLowerCase(), zh);
    return m;
  }).catch(() => { enP = null; return new Map(); });
  return enP;
}
function mapData() {
  if (!mapP) mapP = fetch(ctx.server.mapData).then((r) => r.json()).then((d) => {
    // 跳跃规划（jump-planner.js）要的数组：下标即 i，带坐标与星门相邻表
    const list = d.systems.map((s, i) => ({ i, id: s[0], name: s[1], x: s[2], y: s[3], z: s[4], sec: s[5], region: s[6], nbr: [] }));
    for (const [a, b] of d.gates || []) { list[a]?.nbr.push(b); list[b]?.nbr.push(a); }
    const systems = new Map(list.map((s) => [s.id, s]));
    const regions = new Map(d.regions.map((r) => [r[0], { id: r[0], name: r[1] }]));
    return { list, systems, regions, sysByName: new Map([...systems.values()].map((s) => [norm(s.name), s])), regByName: new Map([...regions.values()].map((r) => [norm(r.name), r])) };
  }).catch((e) => { mapP = null; throw e; });
  return mapP;
}
const secText = (s) => (Math.round(Math.max(0, s) * 10) / 10).toFixed(1);
async function sysName(id) {
  const m = await mapData();
  const s = m.systems.get(id);
  return s ? `${s.name}（${secText(s.sec)}，${m.regions.get(s.region)?.name || ''}）` : String(id);
}
async function findPlace(name, kind) {
  if (!name) return null;
  const m = await mapData();
  const by = kind === 'region' ? m.regByName : m.sysByName;
  if (/^\d+$/.test(String(name))) return (kind === 'region' ? m.regions : m.systems).get(Number(name)) || null;
  let hit = by.get(norm(name));
  if (!hit) { const zh = (await enNames()).get(norm(name)); if (zh) hit = by.get(norm(zh)); }
  if (!hit) hit = [...by.entries()].find(([k]) => k.startsWith(norm(name)))?.[1];
  if (!hit) throw new Error(`找不到${kind === 'region' ? '星域' : '星系'}「${name}」`);
  return hit;
}

// 物品：装配数据（舰船 / 装备 / 弹药 / 无人机 / 植入体，含英文名）+ 市场目录（其他物品，只有中文名）
const KIND_CAT = { ship: 6, module: 7, charge: 8, drone: 18, implant: 20 };
let poolCache = null;
async function itemPool() {
  if (poolCache) return poolCache;
  const data = await fitData();
  const pool = new Map();
  for (const t of data.types.values()) if (t.market) pool.set(t.id, { id: t.id, name: t.name, en: t.en || '', cat: t.category, group: data.groups.get(t.group)?.name || '', slot: t.slot || '' });
  const cat = ctx.catalogTypes();
  for (const t of cat) if (!pool.has(t.id)) pool.set(t.id, { id: t.id, name: t.name, en: '', cat: 0, group: '' });
  if (cat.length) poolCache = pool;   // 市场目录还没加载完时下次再合并
  return pool;
}
// 打分：完全相同 > 开头相同 > 包含（各关键词都包含）；都没有时按两字片段重合度模糊匹配（「反应堆控制单元」→「反应堆控制元件」）
async function searchItems(query, kind = 'any', limit = 15) {
  const pool = await itemPool();
  const q = squash(query);
  if (!q) return [];
  const zh = (await enNames()).get(norm(query));
  const zq = zh ? squash(zh) : '';
  const words = norm(query).split(' ').map(squash).filter(Boolean);
  const cat = KIND_CAT[kind];
  const scored = [], fuzzy = [];
  const qg = grams(q);
  for (const t of pool.values()) {
    if (cat && t.cat !== cat) continue;
    const n = t.sq ||= squash(t.name), en = t.sqEn ??= squash(t.en);
    let s = 0;
    if (n === q || en === q || (zq && n === zq)) s = 100;
    else if (n.startsWith(q) || (en && en.startsWith(q))) s = 60;
    else if (n.includes(q) || (en && en.includes(q))) s = 40;
    else if (words.length > 1 && (words.every((w) => n.includes(w)) || (en && words.every((w) => en.includes(w))))) s = 30;
    if (s) { scored.push([s - n.length / 100, t]); continue; }
    if (qg.size >= 2) {
      let hit = 0;
      for (const g of grams(n)) if (qg.has(g)) hit++;
      const r = hit / qg.size;
      if (r >= 0.5) fuzzy.push([r * 20 - n.length / 100, t]);
    }
  }
  const list = scored.length ? scored : fuzzy;
  return list.sort((a, b) => b[0] - a[0]).slice(0, Math.min(50, limit || 15)).map(([, t]) => t);
}
// EFT 里的名字：先按原样认，认不出时按去掉空格后的名字、再按搜索结果的第一名（只取完全相同或开头相同的）纠正
async function fixEft(eft) {
  const data = await fitData();
  const known = (name) => data.byName.has(norm(name));
  const fixed = [];
  const fix = async (name) => {
    const raw = name.trim();
    if (!raw || known(raw) || /^\[empty/i.test(raw)) return raw;
    const ref = /\s*\[\d+\]$/.exec(raw)?.[0] || '';
    const base = raw.slice(0, raw.length - ref.length);
    if (known(base)) return raw;
    const hit = (await variants(base, 't2'))[0] || (await searchItems(base, 'any', 1))[0];
    if (hit && data.byName.has(norm(hit.name)) && (squash(hit.name) === squash(base) || squash(hit.en) === squash(base) || squash(hit.name).startsWith(squash(base)))) {
      fixed.push(`${base} → ${hit.name}`);
      return hit.name + ref;
    }
    return raw;
  };
  const out = [];
  for (const line of String(eft || '').replace(/\r/g, '').split('\n')) {
    const l = line.trim();
    if (!l || /^\[.+\]$/.test(l) || /^\[empty/i.test(l)) {
      const head = /^\[([^,\]]+)(,.*)?\]$/.exec(l);
      out.push(head && !/^\[empty/i.test(l) ? `[${await fix(head[1])}${head[2] || ''}]` : l);
      continue;
    }
    const off = /\s*\/offline$/i.exec(l)?.[0] || '';
    const body = l.slice(0, l.length - off.length);
    const qty = /^(.*?)(\s+x\d+)$/i.exec(body);
    if (qty) { out.push(await fix(qty[1]) + qty[2] + off); continue; }
    const [mod, charge] = body.split(',');
    out.push(await fix(mod) + (charge !== undefined ? ', ' + await fix(charge) : '') + off);
  }
  return { eft: out.join('\n'), fixed };
}
async function resolveItem(v) {
  if (/^\d+$/.test(String(v))) {
    const id = Number(v), t = (await itemPool()).get(id);
    return t || { id, name: 'Type ' + id };
  }
  const [hit] = await searchItems(v, 'any', 1);
  if (!hit) throw new Error(`找不到物品「${v}」`);
  return hit;
}

// 没写型号的装备名（如「100MN Afterburner」）：列出同系列里允许的型号，按加成从低到高排（装备等级 T1 → T2 → 故事线 → 势力 → 死亡空间 → 官员，同级按价格从低到高）
// 装备名按词匹配：查询里的每个词（英文 / 数字一段、中文一段）都出现在名字里即可，型号前缀不影响（「100MN Afterburner」匹配「100MN Y-S8 Compact Afterburner」）
const words = (q) => String(q || '').toLowerCase().match(/[a-z0-9-]+|[^\sa-z0-9-]+/g) || [];
const nameHas = (t, q) => t && [t.name, t.en].some((n) => n && words(q).every((w) => squash(n).includes(squash(w))));
const PROP_GROUP = 46;   // 推进装备（加力燃烧器 / 微型跃迁推进器）
const META_OK = { t1: [0, 1], t2: [0, 1, 2], faction: [0, 1, 2, 3, 4], deadspace: [0, 1, 2, 3, 4, 6], officer: [0, 1, 2, 3, 4, 5, 6] };
const META_RANK = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 3, 6: 4, 5: 5 };
async function variants(name, meta) {
  const data = await fitData();
  const hits = (await searchItems(name, 'module', 40)).map((h) => data.types.get(h.id)).filter((t) => t?.slot);
  const family = hits.filter((t) => nameHas(t, name));
  const allowed = family.filter((t) => (META_OK[meta] || META_OK.t2).includes(t.meta || 1));
  if (!allowed.length) return family.length ? [family[0]] : hits.slice(0, 1);
  const avg = await ctx.avgPrices().catch(() => new Map());
  const price = (t) => avg.get(t.id) ?? Infinity;
  return allowed.sort((x, y) => (META_RANK[x.meta || 1] ?? 9) - (META_RANK[y.meta || 1] ?? 9) || price(x) - price(y));
}

// 已绑定角色：按名字或 ID 找，空为当前角色
function pickAccount(v) {
  const all = ctx.accounts();
  if (!v) return all[0];
  const a = all.find((x) => String(x.id) === String(v)) || all.find((x) => norm(x.name) === norm(v)) || all.find((x) => norm(x.name).includes(norm(v)));
  if (!a) throw new Error(`没有绑定叫「${v}」的角色；已绑定：${all.map((x) => x.name).join('、')}`);
  return a;
}
// 「能开 / 能用 X」「某技能几级」→ 角色交易筛选同款条件（bazaar-skills.js meets）：船级 group、舰船 / 装备 type、技能 skill
async function needOf(what, skills = []) {
  const data = await fitData();
  const reqs = [], label = [];
  if (what) {
    const q = squash(what);
    const shipGroups = new Set([...data.types.values()].filter((t) => t.category === 6 && t.market).map((t) => t.group));
    const g = [...shipGroups].find((id) => squash(data.groups.get(id)?.name) === q) ?? [...shipGroups].find((id) => squash(data.groups.get(id)?.name).includes(q));
    if (g !== undefined && !(await searchItems(what, 'ship', 1)).some((t) => squash(t.name) === q || squash(t.en) === q)) {
      reqs.push({ k: 'group', id: g }); label.push(`能开任意一艘${data.groups.get(g).name}`);
    } else {
      const [t] = await searchItems(what, 'any', 1);
      const tt = t && data.types.get(t.id);
      if (!tt?.skills?.length) throw new Error(`认不出「${what}」（可以是舰船名、船级如「泰坦」、或装备名）`);
      reqs.push({ k: 'type', id: tt.id }); label.push(`能${tt.category === 6 ? '开' : '用'}${tt.name}`);
    }
  }
  for (const x of skills.slice(0, 10)) {
    const [t] = await searchItems(x.name, 'any', 1);
    const tt = t && data.types.get(t.id);
    if (!tt || tt.category !== 16) throw new Error(`认不出技能「${x.name}」`);
    const lv = Math.min(5, Math.max(1, Number(x.level) || 5));
    reqs.push({ k: 'skill', id: tt.id, lv }); label.push(`${tt.name} ${lv} 级`);
  }
  if (!reqs.length) throw new Error('请给出要开的船、船级、装备或技能');
  return { data, reqs, label: label.join('、') };
}
// 一个角色离满足条件还差多少：船级取最快能开的那艘
function gapOf(data, c, reqs, attrs) {
  const a = attrs && attrs.intelligence ? { cha: attrs.charisma, int: attrs.intelligence, mem: attrs.memory, per: attrs.perception, wil: attrs.willpower } : null;
  const mins = (e) => (a ? e.reduce((m, x) => m + x.sp / (a[x.pri] + a[x.sec] / 2), 0) : BS.defaultMinutes(e));
  let entries = [], best = null;
  for (const r of reqs) {
    if (r.k === 'group') {
      const opts = [...data.types.values()].filter((t) => t.group === r.id && t.category === 6 && t.market).map((t) => ({ t, e: BS.missing(c, t.skills) })).map((x) => ({ ...x, m: mins(x.e) })).sort((x, y) => x.m - y.m);
      if (opts[0]) { entries.push(...opts[0].e); best = opts[0].t.name; }
    } else if (r.k === 'skill') entries.push(...BS.missing(c, [[r.id, r.lv]]));
    else entries.push(...BS.missing(c, data.types.get(r.id).skills));
  }
  // 合并同一技能的多个等级
  const seen = new Set();
  entries = entries.filter((e) => { const k = e.skill + ':' + e.level; if (seen.has(k)) return false; seen.add(k); return true; });
  const top = new Map();
  for (const e of entries) top.set(e.skill, Math.max(top.get(e.skill) || 0, e.level));
  const m = mins(entries);
  return {
    ok: entries.length === 0, ...(best ? { closest_ship: best } : {}),
    missing_sp: Math.round(entries.reduce((n, e) => n + e.sp, 0)), train_time: entries.length ? BS.dur(m) : '0',
    missing_skills: [...top].slice(0, 25).map(([id, lv]) => `${data.types.get(id)?.name || id} → ${lv}（现在 ${c.have.get(id) || 0}）`)
  };
}

// ---------- 其他页面的数据 ----------
const v1 = async (path) => { const r = await fetch('/api/v1/' + path); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error?.message || d.error || 'HTTP ' + r.status); return d; };
let lpP = null, piP = null, whP = null;
const lpData = () => (lpP ||= fetch(ctx.server.lpData).then((r) => r.json()).catch((e) => { lpP = null; throw e; }));
const piData = () => (piP ||= fetch('pi-data.json?v=2').then((r) => r.json()).catch((e) => { piP = null; throw e; }));
const whData = () => (whP ||= fetch('wh-data.json?v=1').then((r) => r.json()).catch((e) => { whP = null; throw e; }));
// LP 兑换项与收益（与 lp-store.js 的 valueOf 同一公式；蓝图按自己制造后卖出）
function lpOffer(d, id) {
  const x = d.offers[id];
  if (!x) return null;
  const [type, qty, lp, iskCost, ak, req] = x;
  return { id, type, qty, lp, isk: iskCost, ak, req: req || [], bp: d.bp?.[type] || null };
}
function lpValue(o, px, taxPct) {
  const keep = 1 - taxPct / 100;
  let missing = false;
  const p = (id) => { const v = px(id); if (v == null) missing = true; return v || 0; };
  const unit = o.bp ? p(o.bp[0]) * o.bp[1] : p(o.type);
  const matCost = o.bp ? o.bp[2].reduce((n, [m, q]) => n + p(m) * q * o.qty, 0) : 0;
  const revenue = unit * o.qty * keep;
  const reqCost = o.req.reduce((n, [id, q]) => n + p(id) * q, 0);
  const cost = o.isk + reqCost + matCost;
  return { revenue, cost, profit: revenue - cost, iskLp: (revenue - cost) / o.lp, missing };
}
const WH_CLS = { 0: 'K162（出口）', 1: 'C1', 2: 'C2', 3: 'C3', 4: 'C4', 5: 'C5', 6: 'C6', 7: '高安', 8: '低安', 9: '00', 12: '席拉', 13: 'C13', 14: '流浪者', 15: '流浪者', 16: '流浪者', 17: '流浪者', 18: '流浪者', 25: '波赫文' };
const WH_EFFECT = { magnetar: '磁星', blackhole: '黑洞', redgiant: '红巨星', pulsar: '脉冲星', wolfrayet: '沃尔夫-拉叶星', cataclysmic: '激变变星' };
// 单次通过质量 → 可通过的最大船型（与 wormhole.js shipSize 相同）
const whShip = (jump) => (!jump ? '—' : jump <= 5e6 ? '护卫舰 / 驱逐舰' : jump <= 62e6 ? '巡洋舰 / 战巡' : jump <= 375e6 ? '战列舰' : jump <= 1e9 ? '旗舰（不含超旗）' : '旗舰 / 货舰');

async function kbGet(path) {
  const srv = ctx.server.id === 'tq' ? '' : 'server=' + ctx.server.id;
  const r = await fetch(KB + path + (srv ? (path.includes('?') ? '&' : '?') + srv : ''));
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error?.message || d.error || '击杀记录服务 ' + r.status);
  return d;
}
async function findEntity(name, kind = 'any') {
  if (!name) return null;
  const d = await kbGet('search?q=' + encodeURIComponent(name));
  const list = (d.results || []).filter((x) => kind === 'any' || x.category === kind);
  const hit = list.find((x) => norm(x.name) === norm(name)) || list[0];
  if (!hit) throw new Error(`本站没有收录「${name}」`);
  return hit;
}
const iso = (t) => (typeof t === 'number' ? new Date(t * 1000).toISOString() : String(t)).replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC');
const isk = (v) => ctx.formatISK(v);

// ---------- 工具 ----------
const TOOLS = {
  async search_items({ query, kind = 'any', limit = 15 }) {
    const list = await searchItems(query, kind, limit);
    return { brief: `「${query}」${list.length} 个结果`, data: list.length ? list.map((t) => ({ id: t.id, name: t.name, ...(t.en ? { en: t.en } : {}), ...(t.group ? { group: t.group } : {}), ...(t.slot ? { slot: t.slot } : {}) })) : '没有找到，换个关键词（中文或英文）试试' };
  },

  async compute_fit({ eft, skills = 'max' }) {
    const fm = await ctx.fitting();
    const { eft: text, fixed } = await fixEft(eft);
    eft = text;
    const r = await fm.aiFit(eft, skills);
    if (r.error) return { failed: true, brief: r.error, text: r.error + '。EFT 第一行应为 [舰船名, 装配名]。' };
    const sum = fitSummary(r);
    const id = 'f' + Math.random().toString(36).slice(2, 8);
    const suggest = {};
    for (const u of r.unknown || []) suggest[u] = (await searchItems(u.replace(/\s*\(.*\)$/, ''), 'any', 5)).map((t) => t.name + (t.en ? ' / ' + t.en : ''));
    const data = { fit_id: id, ...sum.data, ...(r.unknown?.length ? { unknown_items: suggest, note: '这些名称没有识别，没算进去；可以改用建议里的名字' } : {}), ...(fixed.length ? { renamed: fixed } : {}), ...(r.missing?.length ? { missing_skills: r.missing.slice(0, 20) } : {}) };
    return {
      brief: `${sum.data.ship} · 速度 ${Math.round(sum.speed)} m/s · DPS ${Math.round(sum.dps)} · EHP ${Math.round(sum.ehp)}${sum.data.problems.length ? ' · 有问题' : ''}`,
      data, fit: { id, compact: r.compact, eft: String(eft), summary: sum.card, ship: r.fit.ship, problems: sum.data.problems.join('；') }
    };
  },

  async auto_fit(a, signal) {
    const data = await fitData();
    const fm = await ctx.fitting();
    const [ship] = await searchItems(a.ship, 'ship', 1);
    if (!ship || !data.types.has(ship.id)) return { failed: true, brief: '无法识别舰船', text: `无法识别舰船「${a.ship}」，换个名字（中文或英文）试试` };
    // 每个必装装备的候选型号（写全名的只有一个；没写型号的按加成从低到高）
    const cands = [], bad = {};
    for (const name of (a.required_modules || []).slice(0, 12)) {
      const t = data.byName.get(norm(name));
      const vs = t?.slot ? [t] : await variants(name, a.meta || 't2');
      if (vs.length) cands.push(vs);
      else bad[name] = (await searchItems(name, 'module', 5)).map((x) => x.name + (x.en ? ' / ' + x.en : ''));
    }
    if (Object.keys(bad).length) return { failed: true, brief: '有装备认不出', data: { error: '这些必装装备认不出，请改用建议里的名字', suggestions: bad } };
    const t0 = Date.now();
    const onAbort = () => fm.aiAutoCancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    // 从加成最低的型号开始装，没达到要求再一级级往上换，直到满足为止
    const steps = Math.min(8, Math.max(1, ...cands.map((v) => v.length)));
    let list = [], tried = [];
    try {
      for (let k = 0; k < steps; k++) {
        const pick = cands.map((v) => v[Math.min(k, v.length - 1)]);
        const label = pick.filter((_, i) => cands[i].length > 1).map((t) => t.name).join('、');
        if (k && label === tried[tried.length - 1]) continue;
        tried.push(label);
        const got = await fm.aiAuto({
          ship: ship.id, fixed: pick.map((t) => t.id), focus: a.focus?.length ? a.focus : ['dps'], utils: a.utilities || null, weapon: a.weapon || 'auto', tank: a.tank || 'auto', meta: a.meta || 't2',
          budget: a.budget_million || 0, minDps: a.min_dps || 0, minEhp: a.min_ehp || 0, minSpeed: a.min_speed || 0, capStable: Boolean(a.cap_stable), skills: a.skills || 'max',
          onProgress: (n) => setStatus(`智能装配中${label ? `（${label}）` : ''}… 已试 ${ctx.formatNumber(n)} 种组合`)
        });
        if (got.length) list = got;
        if (got[0]?.met) break;
      }
    } catch (error) {
      if (signal?.aborted || error.message === 'cancelled') throw new DOMException('', 'AbortError');
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (!list.length) return { failed: true, brief: '没有找到可行的装配', text: '没有找到装得下的装配，放宽要求试试' };
    const fits = [], results = [];
    for (const x of list) {
      const r = await TOOLS.compute_fit({ eft: x.eft, skills: a.skills || 'max' });
      if (!r.fit) continue;
      fits.push(r.fit);
      results.push({ meets_all_requirements: x.met, eft: x.eft, ...r.data });
    }
    const best = results[0];
    // 最好的方案直接以卡片展示（省掉模型再调用一次 show_fit）
    const top = fits[0];
    const card = top && { kind: 'fit', id: top.id, ship: top.ship, title: `${ship.name} · ${Math.round(top.summary.speed)} m/s${top.summary.dps >= 1 ? ' · DPS ' + Math.round(top.summary.dps) : ''}`, summary: top.summary, problems: top.problems };
    return {
      card,
      brief: `${ship.name} · ${results.length} 种方案 · ${Math.round((Date.now() - t0) / 1000)} 秒` + (best ? ` · 最佳速度 ${best.max_velocity_m_s} m/s · DPS ${best.dps.total}` : ''),
      data: { note: '最好的方案（第一个）已自动以卡片展示给玩家；必装装备没写型号时已从加成最低的型号依次往上试，直到满足要求；meets_all_requirements 为 false 表示换到最高允许型号仍没全部达到', variants_tried: tried.filter(Boolean), results }, fits
    };
  },

  // 击杀记录里的实战装配：逐套算属性，按要求筛选、排序，最好的一套自动展示
  async kb_ship_fits({ ship: name, days = 30, with_modules = [], min_speed = 0, min_dps = 0, min_ehp = 0, sort = 'count', limit = 8 }) {
    const data = await fitData();
    const fm = await ctx.fitting();
    const [ship] = await searchItems(name, 'ship', 1);
    if (!ship || !data.types.has(ship.id)) return { failed: true, brief: '无法识别舰船', text: `无法识别舰船「${name}」` };
    setStatus('读取击杀记录装配…');
    const groups = await fm.aiKbFits(ship.id, Math.min(90, Math.max(1, days || 30)));
    if (!groups.length) return { brief: `${ship.name} · 没有阵亡记录`, data: `最近 ${days} 天本站没有收录${ship.name}的阵亡装配` };
    // 装配里每行的装备（EFT 行 → 物品）
    const lineType = (l) => data.byName.get(norm(l.replace(/\s*\/offline$/i, '').split(',')[0].replace(/\s+x\d+$/i, '')));
    const want = with_modules.filter(Boolean);
    // 先按必装装备筛，再逐套计算（最多算出现次数最多的 60 套）
    const todo = groups.map((g) => ({ g, lines: g.eft.split('\n') })).map((x) => ({ ...x, types: x.lines.map(lineType) }))
      .filter(({ types }) => want.every((q) => types.some((t) => t?.slot && nameHas(t, q)))).slice(0, 60);
    const rows = [];
    for (const [i, { g, lines, types }] of todo.entries()) {
      setStatus(`计算击杀记录装配… ${i + 1} / ${todo.length}`);
      // 推进装备同时只能开一个：装了多个时逐个只开一个，取指定装备（with_modules 里的）或速度最快的那种
      const props = lines.map((_, k) => k).filter((k) => types[k]?.group === PROP_GROUP);
      const tries = props.length > 1 ? props.map((on) => ({ on, eft: lines.map((l, k) => (props.includes(k) && k !== on && !/\/offline$/i.test(l) ? l + ' /offline' : l)).join('\n') })) : [{ on: props[0], eft: g.eft }];
      let pick = null;
      for (const t of tries) {
        const r = await TOOLS.compute_fit({ eft: t.eft });
        if (!r.fit) continue;
        const named = want.some((q) => nameHas(types[t.on], q));
        const score = (named ? 1e9 : 0) + r.fit.summary.speed;
        if (!pick || score > pick.score) pick = { r, score, eft: t.eft, prop: types[t.on]?.name };
      }
      if (pick) rows.push({ g, ...pick });
    }
    const ok = rows.filter(({ r }) => r.fit.summary.speed >= min_speed && r.fit.summary.dps >= min_dps && r.fit.summary.ehp >= min_ehp);
    const key = { speed: (x) => x.r.fit.summary.speed, dps: (x) => x.r.fit.summary.dps, ehp: (x) => x.r.fit.summary.ehp, count: (x) => x.g.n }[sort] || ((x) => x.g.n);
    ok.sort((a, b) => key(b) - key(a));
    const top = ok.slice(0, Math.min(20, Math.max(1, limit || 8)));
    // 没有达标的：展示含指定装备里最快的一套作参考
    const best = top[0] || [...rows].sort((a, b) => b.r.fit.summary.speed - a.r.fit.summary.speed)[0];
    const card = best && { kind: 'fit', id: best.r.fit.id, ship: best.r.fit.ship, title: `${ship.name} · 击杀记录 ×${best.g.n} · ${Math.round(best.r.fit.summary.speed)} m/s${top[0] ? '' : ' · 未达要求'}`, summary: best.r.fit.summary, problems: best.r.fit.problems };
    const fastest = rows.length ? Math.max(...rows.map(({ r }) => r.fit.summary.speed)) : 0;
    return {
      card, fits: (top.length ? top : best ? [best] : []).map((x) => x.r.fit),
      brief: `${ship.name} · ${groups.length} 种实战装配${want.length ? ` · 含${want.join('、')}的 ${rows.length} 种` : ''} · 符合 ${ok.length} 种` + (rows.length ? ` · 最快 ${Math.round(fastest)} m/s` : ''),
      data: {
        note: '来自击杀邮件里的完整装配（同装配合并，n 为出现次数），按全 5 级技能计算，不含植入体和超载；装了多个推进装备时只开 active_propulsion 那一个；第一套已自动以卡片展示（matched 为 0 时 fits 里是不达标但最快的一套，仅供参考）',
        fits_total: groups.length, with_modules_matched: want.length ? rows.length : undefined, matched: ok.length, fastest_m_s: Math.round(fastest),
        fits: (top.length ? top : best ? [best] : []).map(({ g, r, eft, prop }) => ({ n: g.n, last_seen: iso(g.last), kill_id: g.kill, active_propulsion: prop || null, eft, ...r.data }))
      }
    };
  },

  async show_fit({ fit_id, title = '' }) {
    const f = findFit(fit_id);
    if (!f) return { failed: true, brief: '没有这个 fit_id', text: '没有这个 fit_id，请先用 compute_fit 计算' };
    return { brief: title || f.summary.ship, text: '已展示给玩家', card: { kind: 'fit', id: f.id, ship: f.ship, title, summary: f.summary, problems: f.problems } };
  },

  async market_price({ items = [] }) {
    const list = [];
    for (const v of items.slice(0, 20)) { try { list.push(await resolveItem(v)); } catch (e) { list.push({ error: e.message }); } }
    const ids = list.filter((t) => t.id).map((t) => t.id);
    const [hub, avg] = await Promise.all([ctx.hubPrices(ids), ctx.avgPrices()]);
    const region = ctx.server.regions[0];
    return {
      brief: list.map((t) => t.name).filter(Boolean).join('、'),
      data: { hub: region.hub.name, items: list.map((t) => (t.error ? t : { id: t.id, name: t.name, sell_min: hub.get(t.id)?.sell ?? null, buy_max: hub.get(t.id)?.buy ?? null, global_average: avg.get(t.id) ?? null })) }
    };
  },

  async market_history({ item, region, days = 90 }) {
    const t = await resolveItem(item);
    const global = ctx.globalRegion(t.id);
    const reg = global ? { id: global, name: '全服统一市场' } : region ? await findPlace(region, 'region') : { id: ctx.server.regions[0].id, name: ctx.server.regions[0].name };
    const rows = await ctx.fetchESI(`/markets/${reg.id}/history/?type_id=${t.id}`);
    const all = (Array.isArray(rows) ? rows : []).sort((a, b) => (a.date < b.date ? -1 : 1));
    const list = all.slice(-Math.min(365, Math.max(7, days || 90)));
    if (!list.length) return { brief: `${t.name} 在${reg.name}没有成交记录`, data: `${t.name} 在${reg.name}没有成交记录` };
    const win = (n) => {
      const w = list.slice(-n);
      const vol = w.reduce((s, x) => s + x.volume, 0);
      return { days: w.length, avg_price: vol ? w.reduce((s, x) => s + x.average * x.volume, 0) / vol : w.reduce((s, x) => s + x.average, 0) / w.length, high: Math.max(...w.map((x) => x.highest)), low: Math.min(...w.map((x) => x.lowest)), avg_daily_volume: Math.round(vol / w.length) };
    };
    const weeks = [];
    for (let i = list.length; i > 0 && weeks.length < 26; i -= 7) {
      const w = list.slice(Math.max(0, i - 7), i);
      weeks.unshift({ to: w[w.length - 1].date, avg: +(w.reduce((s, x) => s + x.average, 0) / w.length).toPrecision(5), volume: w.reduce((s, x) => s + x.volume, 0) });
    }
    const first = list[0].average, last = list[list.length - 1];
    return {
      brief: `${t.name} · ${reg.name} · ${list.length} 天`,
      data: { item: t.name, type_id: t.id, region: reg.name, last_day: last, change_pct: +((last.average / first - 1) * 100).toFixed(1), d7: win(7), d30: win(30), d90: win(90), weekly: weeks, recent_days: list.slice(-10) }
    };
  },

  async kb_battles({ days = 2, region, min_kills, limit = 10 }) {
    const d = await kbGet('battles/history?days=' + Math.min(30, Math.max(1, days || 2)));
    const reg = region ? await findPlace(region, 'region') : null;
    let list = (d.battles || []).filter((b) => (!reg || b.region_id === reg.id) && (!min_kills || b.kills >= min_kills));
    const total = list.length;
    list = list.sort((a, b) => b.kills - a.kills).slice(0, Math.min(30, limit || 10));
    const name = (e) => d.names?.[e.id] || String(e.id);
    const out = [];
    for (const b of list) {
      out.push({
        system: await sysName(b.system_id), start: iso(b.start), end: iso(b.end), ships_destroyed: b.kills, isk_destroyed: isk(b.value), pilots: b.pilots,
        sides: (b.teams || []).slice(0, 3).map((t) => ({ main: t.entities.slice(0, 4).map(name).join('、') + (t.n_entities > 4 ? ` 等 ${t.n_entities} 个` : ''), pilots: t.pilots, losses: t.losses, isk_lost: isk(t.lost) }))
      });
    }
    return { brief: `最近 ${d.days} 天 ${total} 场`, data: { days: d.days, total_battles: total, rule: `同一星系短时间内击毁 ≥ ${d.min} 艘（不含太空舱和 1000 万 ISK 以下）`, battles: out } };
  },

  async kb_kills({ system, region, character, corporation, alliance, side = 'all', ship, min_value, space, solo, limit = 15 }) {
    const q = new URLSearchParams({ limit: String(Math.min(50, Math.max(1, limit || 15))) });
    if (system) q.set('system', (await findPlace(system, 'system')).id);
    if (region) q.set('region', (await findPlace(region, 'region')).id);
    for (const [k, v] of [['character', character], ['corporation', corporation], ['alliance', alliance]]) if (v) q.set(k, (await findEntity(v, k)).id);
    if ((character || corporation || alliance) && side !== 'all') q.set('side', side);
    if (ship) q.set('ship', (await resolveItem(ship)).id);
    if (min_value) q.set('min', String(min_value));
    if (space) q.set('space', space);
    if (solo) q.set('solo', '1');
    const d = await kbGet('feed?' + q);
    const names = d.names || {};
    const pool = await itemPool();
    const tn = (id) => pool.get(id)?.name || 'Type ' + id;
    const out = [];
    for (const k of d.kills || []) {
      out.push({ id: k.id, time: iso(k.time), system: await sysName(k.system_id), ship: tn(k.ship_type_id), value: isk(k.value),
        victim: [names[k.victim?.character_id], names[k.victim?.corporation_id], names[k.victim?.alliance_id]].filter(Boolean).join(' / '),
        attackers: k.attackers, final_blow: [names[k.final?.character_id], k.final?.ship_type_id ? tn(k.final.ship_type_id) : ''].filter(Boolean).join(' · '), solo: k.solo, npc: k.npc });
    }
    return { brief: `${out.length} 条`, data: out.length ? { kills: out } : '没有符合条件的击杀记录（本站只收录近期的击杀）' };
  },

  async kb_entity({ name, kind = 'any', days = 30 }) {
    const e = await findEntity(name, kind);
    const d = await kbGet(`entity/${e.category}/${e.id}?days=${Math.min(90, Math.max(1, days || 30))}`);
    const pool = await itemPool();
    const tn = (id) => pool.get(id)?.name || 'Type ' + id;
    const nm = d.names || {};
    const m = await mapData();
    const systems = [];
    for (const s of (d.systems || []).slice(0, 8)) systems.push({ system: await sysName(s.system_id), count: s.count });
    return {
      brief: `${d.name || e.name}（${{ character: '人物', corporation: '军团', alliance: '联盟' }[e.category]}）`,
      data: {
        name: d.name || e.name, kind: e.category, days: d.days, kills: d.kills, losses: d.losses, isk_destroyed: isk(d.destroyed), isk_lost: isk(d.lost), solo_kills: d.solo_kills, final_blows: d.final_blows,
        ships_used: (d.ships_used || []).slice(0, 10).map((x) => ({ ship: tn(x.ship_type_id), count: x.count })),
        ships_lost: (d.ships_lost || []).slice(0, 10).map((x) => ({ ship: tn(x.ship_type_id), count: x.count })),
        regions: (d.regions || []).slice(0, 6).map((x) => ({ region: m.regions.get(x.region_id)?.name || x.region_id, count: x.count })), systems,
        members: (d.members || []).slice(0, 10).map((x) => ({ name: x.name || nm[x.id], kills: x.kills, losses: x.losses })),
        top_kills: (d.top_kills || []).slice(0, 3).map((k) => ({ time: iso(k.time), ship: tn(k.ship_type_id), value: isk(k.value) })),
        top_losses: (d.top_losses || []).slice(0, 3).map((k) => ({ time: iso(k.time), ship: tn(k.ship_type_id), value: isk(k.value) }))
      }
    };
  },

  async gank_risk({ system, days = 30 }) {
    days = [7, 30, 90].includes(days) ? days : 30;
    const off = Math.round(-new Date().getTimezoneOffset() / 60);
    const local = (h) => (((h + off) % 24) + 24) % 24;
    if (!system) {
      const d = await kbGet('gank?days=' + days);
      const out = [];
      for (const s of (d.systems || []).slice(0, 15)) out.push({ system: await sysName(s.id), ganks: s.count, days_hit_pct: Math.round(s.days_hit / d.span * 100), isk: isk(s.value) });
      return { brief: `强爆最多的高安星系（${days} 天）`, data: { days: d.span, total: d.total, systems: out } };
    }
    const sys = await findPlace(system, 'system');
    const d = await kbGet(`gank?system=${sys.id}&days=${days}`);
    const span = d.span || d.days;
    const pool = await itemPool();
    const hours = Array.from({ length: 24 }, (_, x) => d.hours?.[(((x - off) % 24) + 24) % 24] || 0);
    return {
      brief: `${sys.name} · ${span} 天 ${d.count || 0} 次`,
      data: {
        system: await sysName(sys.id), days: span, ganks: d.count || 0, days_with_gank: d.days_hit || 0, chance_any_day_pct: Math.round((d.days_hit || 0) / span * 100), isk_lost: isk(d.value || 0),
        hourly_pct_local_time: { timezone: 'UTC' + (off >= 0 ? '+' : '') + off, by_hour: Object.fromEntries(hours.map((n, h) => [h, Math.round(n / span * 100)]).filter(([, p]) => p)) },
        groups: (d.groups || []).slice(0, 6).map((g) => ({ name: d.names?.[g.id] || g.id, kind: g.kind, ganks: g.count, pilots: g.pilots, peak_hours_local: g.hours ? g.hours.map((n, h) => [n, local(h)]).sort((a, b) => b[0] - a[0]).slice(0, 3).filter((x) => x[0]).map((x) => x[1]) : [] })),
        ships_killed: (d.ships || []).slice(0, 8).map(([t, n]) => ({ ship: pool.get(t)?.name || t, count: n })),
        rule: '受害者被玩家击毁，且有攻击者在同一星系前后 10 分钟内被统合部击毁；只统计本站收录的击杀'
      }
    };
  },

  // 星门路线（与星图「路线规划」同一数据：ESI /route/ + 本站强爆热点）；途经点可自动排最短顺序
  async route_plan({ from = '', to, via = [], prefer = 'shortest', avoid_gank = false, auto_order = true, character = '' }) {
    const m = await mapData();
    let a;
    if (from) a = await findPlace(from, 'system');
    else {
      if (!ctx.accounts().length) throw new Error('没有给起点，也没有绑定 ESI 角色读取当前位置');
      const acc = pickAccount(character);
      const loc = await ctx.accountFetch(acc.id, `/characters/${acc.id}/location/`).catch(() => null);
      if (!loc?.solar_system_id) throw new Error('读不到角色当前位置（授权缺少位置权限），请告诉我起点');
      a = m.systems.get(loc.solar_system_id);
    }
    const b = await findPlace(to, 'system');
    const vias = [];
    for (const v of via.slice(0, 8)) vias.push(await findPlace(v, 'system'));
    const flag = ['shortest', 'secure', 'insecure'].includes(prefer) ? prefer : 'shortest';
    // 强爆热点：最近 30 天里 40% 以上的日子出现强爆的高安星系
    let hot = new Map();
    try {
      const r = await fetch(KB + 'gank?days=30' + (ctx.server.id === 'tq' ? '' : '&server=' + ctx.server.id));
      const d = r.ok ? await r.json() : null;
      const span = d?.span || 30;
      hot = new Map((d?.systems || []).map((x) => [x.id, { share: x.days_hit / span, count: x.count }]));
    } catch { /* 没有强爆数据时不标 */ }
    const keep = new Set([a.id, b.id, ...vias.map((v) => v.id)]);
    const avoid = avoid_gank ? [...hot].filter(([id, x]) => x.share >= 0.4 && !keep.has(id)).map(([id]) => id).slice(0, 100) : [];
    const legCache = new Map();
    const leg = async (x, y) => {
      const k = x + '>' + y;
      if (!legCache.has(k)) legCache.set(k, (async () => {
        if (avoid.length) { try { return await ctx.fetchESI(`/route/${x}/${y}/?flag=${flag}&avoid=${avoid.join(',')}`); } catch { /* 绕不开：照常走 */ } }
        return ctx.fetchESI(`/route/${x}/${y}/?flag=${flag}`);
      })());
      return legCache.get(k);
    };
    // 途经点顺序：≤ 5 个时穷举最短，否则按给出的顺序
    let order = vias;
    if (auto_order && vias.length > 1 && vias.length <= 5) {
      setStatus('计算途经点顺序…');
      const perms = (arr) => (arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p])));
      let best = Infinity;
      for (const p of perms(vias)) {
        const pts = [a, ...p, b];
        let n = 0;
        for (let i = 1; i < pts.length; i++) n += (await leg(pts[i - 1].id, pts[i].id)).length - 1;
        if (n < best) { best = n; order = p; }
      }
    }
    const stops = [a, ...order, b];
    const ids = [a.id];
    for (let i = 1; i < stops.length; i++) ids.push(...(await leg(stops[i - 1].id, stops[i].id)).slice(1));
    const sec = (s) => Math.round(Math.max(0, s.sec) * 10) / 10;
    const cls = (s) => (sec(s) >= 0.5 ? '高安' : sec(s) > 0 ? '低安' : '00');
    const counts = { 高安: 0, 低安: 0, '00': 0 };
    const list = ids.map((id) => {
      const s = m.systems.get(id);
      if (!s) return { id };
      counts[cls(s)]++;
      const h = hot.get(id);
      return { name: s.name, sec: sec(s), region: m.regions.get(s.region)?.name, ...(h ? { gank_days_pct: Math.round(h.share * 100) } : {}) };
    });
    return {
      brief: `${a.name} → ${b.name} · ${ids.length - 1} 跳 · 高安 ${counts.高安} / 低安 ${counts.低安} / 00 ${counts['00']}`,
      data: {
        jumps: ids.length - 1, prefer: flag, stops: stops.map((s) => s.name), security: counts, avoided_gank_systems: avoid.length || undefined,
        note: 'gank_days_pct：最近 30 天里出现疑似强爆的日子占比；可以让玩家在星图里打开同样的路线写入游戏自动导航',
        route: list, map_link: '#map'
      }
    };
  },

  // 旗舰跳跃规划（与星图「跳跃规划」同一算法 jump-planner.js）：按舰船跳跃距离与玩家技能，逐跳光年、燃料、疲劳
  async jump_plan({ ship, from = '', to, skills = 'character', character = '', gates = false }) {
    const m = await mapData();
    const ships = await JP.loadJumpShips(ctx.fetchESI);
    const q = squash(ship);
    const [hit] = await searchItems(ship, 'ship', 1);
    const sh = ships.find((x) => x.id === hit?.id) || ships.find((x) => squash(x.name) === q) || ships.find((x) => squash(x.name).includes(q));
    if (!sh) throw new Error(`「${ship}」不能跳跃（不是旗舰 / 跳货 / 黑隐等有跳跃引擎的船）`);
    let a;
    if (from) a = await findPlace(from, 'system');
    else {
      const acc = ctx.accounts().length ? pickAccount(character) : null;
      const loc = acc && await ctx.accountFetch(acc.id, `/characters/${acc.id}/location/`).catch(() => null);
      if (!loc?.solar_system_id) throw new Error('请告诉我起点星系');
      a = m.systems.get(loc.solar_system_id);
    }
    const b = await findPlace(to, 'system');
    // 跳跃技能：跳跃引擎校准、跳跃燃料节约、跳货（角色读不到时按全 5 级）
    let sk = { jdc: 5, jfc: 5, jf: 5 }, src = '全 5 级', fatigue = 0;
    if (skills === 'character' && ctx.accounts().length) {
      const acc = pickAccount(character);
      try {
        const d = await ctx.accountFetch(acc.id, `/characters/${acc.id}/skills/`);
        const lv = (id) => (d.skills || []).find((x) => x.skill_id === id)?.active_skill_level || 0;
        sk = { jdc: lv(21611), jfc: lv(21610), jf: lv(29029) }; src = acc.name + ' 的技能';
        const f = await ctx.accountFetch(acc.id, `/characters/${acc.id}/fatigue/`).catch(() => null);
        if (f?.jump_fatigue_expire_date) fatigue = Math.max(0, (Date.parse(f.jump_fatigue_expire_date) - Date.now()) / 60e3);
      } catch { /* 按全 5 级 */ }
    }
    const range = JP.maxRange(sh, sk.jdc);
    const plan = JP.planJumpRoute(m.list, a.i, b.i, { range, gates, highsec: JP.canEnterHighSec(sh) });
    if (plan.error) return { failed: true, brief: plan.error, text: plan.error + `（${sh.name} 最大跳跃距离 ${range.toFixed(2)} 光年）` };
    const sim = JP.simulate(plan.legs, sh, { jfc: sk.jfc, jfSkill: sk.jf, fatigue });
    const price = (await ctx.avgPrices().catch(() => new Map())).get(sh.fuelType) || 0;
    const fuelName = (await itemPool()).get(sh.fuelType)?.name || '燃料';
    const sys = (i) => m.list[i];
    return {
      brief: `${sh.name} · ${a.name} → ${b.name} · ${sim.jumps} 次跳跃${sim.gateCount ? ` + ${sim.gateCount} 个星门` : ''} · ${Math.round(sim.totalLy * 10) / 10} 光年`,
      data: {
        ship: sh.name, max_range_ly: Math.round(range * 100) / 100, skills: `${src}（跳跃引擎校准 ${sk.jdc} / 跳跃燃料节约 ${sk.jfc}${sh.group === 902 ? ` / 跳货 ${sk.jf}` : ''}）`,
        jumps: sim.jumps, gates: sim.gateCount, total_ly: Math.round(sim.totalLy * 100) / 100, fuel: { type: fuelName, units: Math.round(sim.fuel), est_isk: price ? Math.round(price * sim.fuel) : null },
        total_time: JP.formatMinutes(sim.travel), final_fatigue: JP.formatMinutes(sim.finalFatigue), start_fatigue_min: Math.round(fatigue),
        legs: sim.rows.map((r) => ({ from: sys(r.from).name, to: sys(r.to).name, ...(r.gate ? { gate: true } : { ly: Math.round(r.ly * 100) / 100, fuel: Math.round(r.fuel), cooldown: JP.formatMinutes(r.cooldown), fatigue_after: JP.formatMinutes(r.fatigue) }) })),
        ...(plan.gates?.length ? { then_gates_to_destination: plan.gates.map((i) => sys(i).name) } : {}),
        note: '与星图「跳跃规划」同一算法；终点在高安等不能直接跳入时，会先跳到附近再走星门'
      }
    };
  },

  // ---------- 制造（与「制造」页同一公式：/api/v1/industry/*，全 5 级技能）----------
  async industry_cost({ product, runs = 1, me, te, system = '', facility = '', rig = 0, tax, materials = 'sell', sell = 'sell', invention = true, decryptor = '' }) {
    const q = new URLSearchParams({ product: String(product), runs: String(Math.max(1, Math.min(100000, runs || 1))), materials, sell, invention: invention ? '1' : '0' });
    if (me != null) q.set('me', String(me));
    if (te != null) q.set('te', String(te));
    if (system) q.set('system', String(system));
    if (facility) q.set('facility', facility);
    if (rig) q.set('rig', String(rig));
    if (tax != null) q.set('tax', String(tax));
    if (decryptor) { const d = await resolveItem(decryptor); q.set('decryptor', String(d.id)); }
    let d;
    try { d = await v1('industry/cost?' + q); } catch (e) {
      if (/404|找不到|unknown/i.test(e.message)) { const s = await v1('industry/search?q=' + encodeURIComponent(product)); return { failed: true, brief: '找不到这个产品', data: { error: e.message, suggestions: (s.results || []).slice(0, 8).map((r) => r.name + ' / ' + r.name_en) } }; }
      throw e;
    }
    return {
      brief: `${d.product?.name} ×${d.runs} · 成本 ${isk(d.total_cost)} · 利润 ${isk(d.profit)}（${Math.round((d.margin || 0) * 100)}%）`,
      data: { ...d, note: '与本站「制造」计算器同一公式，技能按全 5 级；价格为欧服（宁静）吉他价格' + (ctx.server.id === 'tq' ? '' : '（当前是国服，价格仅供参考）'), page_link: `#ind/calc/${d.product?.id}` }
    };
  },
  async industry_profits({ activity = 'manufacturing', category = 'all', tech = 'all', sort = 'profit_per_hour', limit = 15, system = '', facility = '', rig = 0 }) {
    const q = new URLSearchParams({ activity, category, tech, sort, limit: String(Math.min(50, Math.max(1, limit || 15))) });
    if (system) q.set('system', String(system));
    if (facility) q.set('facility', facility);
    if (rig) q.set('rig', String(rig));
    const d = await v1('industry/profits?' + q);
    return { brief: `${d.total} 种可造 · 前 ${d.rows?.length || 0}`, data: { ...d, rows: (d.rows || []).map((r) => ({ ...r, page_link: `#ind/calc/${r.id}` })), note: '每流程利润，技能全 5 级，价格为欧服吉他；liquid 只含有成交量的产品' } };
  },
  async industry_systems({ activity = 'manufacturing', security = '', region = '', limit = 15 }) {
    const q = new URLSearchParams({ activity, limit: String(Math.min(50, Math.max(1, limit || 15))) });
    if (security) q.set('security', security);
    if (region) q.set('region', String((await findPlace(region, 'region')).id));
    const d = await v1('industry/systems?' + q);
    return { brief: `${d.systems?.length || 0} 个星系`, data: { ...d, note: '按系统成本指数从低到高；指数越低工作费越便宜' } };
  },

  // ---------- LP 商店（与「LP 商店」页同一公式）----------
  async lp_offers({ corp = '', item = '', limit = 10, tax = 3.4, include_blueprints = false }) {
    const d = await lpData();
    const avg = await ctx.avgPrices().catch(() => new Map());
    let corps = d.corps;
    if (corp) {
      const q = squash(corp);
      corps = d.corps.filter((c) => squash(c.name) === q);
      if (!corps.length) corps = d.corps.filter((c) => squash(c.name).includes(q) || squash(d.factions[c.faction] || '').includes(q));
      if (!corps.length) throw new Error(`找不到 LP 商店「${corp}」`);
    }
    // 先按全服均价粗算，取前面的再用交易中心卖价精算
    const rows = [];
    const seen = new Set();
    for (const c of corps) for (const oid of d.stores[c.id] || []) {
      const o = lpOffer(d, oid);
      if (!o || !o.lp || seen.has(c.id + ':' + oid)) continue;
      seen.add(c.id + ':' + oid);
      if (item && !nameHas({ name: d.names[o.type] || '' }, item)) continue;
      if (o.bp && !include_blueprints && !item) continue;   // 蓝图要自己造、材料量大，默认不算（与 LP 页「最佳兑换」一致）
      rows.push({ c, o, v: lpValue(o, (id) => avg.get(id), tax) });
    }
    rows.sort((a, b) => b.v.iskLp - a.v.iskLp);
    const top = rows.filter((r) => !r.v.missing).slice(0, 60);
    const ids = new Set();
    for (const { o } of top) { ids.add(o.type); for (const [r] of o.req) ids.add(r); if (o.bp) { ids.add(o.bp[0]); for (const [m] of o.bp[2]) ids.add(m); } }
    const hub = await ctx.hubPrices([...ids]).catch(() => new Map());
    const px = (id) => hub.get(id)?.sell ?? avg.get(id);
    for (const r of top) r.v = lpValue(r.o, px, tax);
    top.sort((a, b) => b.v.iskLp - a.v.iskLp);
    const out = top.slice(0, Math.min(30, Math.max(1, limit || 10))).map(({ c, o, v }) => ({
      corp: c.name, item: d.names[o.type] || o.type, qty: o.qty, lp: o.lp, isk: o.isk, required_items: o.req.map(([id, n]) => `${d.names[id] || id} ×${n}`),
      ...(o.bp ? { blueprint_makes: `${d.names[o.bp[0]] || o.bp[0]} ×${o.bp[1]}` } : {}),
      revenue: Math.round(v.revenue), cost: Math.round(v.cost), profit: Math.round(v.profit), isk_per_lp: Math.round(v.iskLp), link: `#lp/store/${c.id}`
    }));
    return { brief: `${corp ? corps.map((c) => c.name).slice(0, 3).join('、') : '全部 LP 商店'} · 最高 ${out[0] ? out[0].isk_per_lp + ' ISK/LP' : '—'}`, data: { note: `按${ctx.server.regions[0].hub.name}最低卖价卖出、扣 ${tax}% 税费，需要的物品按卖价买入；${include_blueprints || item ? '蓝图按自己制造后卖出算（需要大量材料，注意市场能否吃下）' : '不含蓝图兑换项'}；冷门物品成交量小，大量兑换前先看市场深度`, offers: out } };
  },

  // ---------- 行星工业 ----------
  async pi_info({ product }) {
    const d = await piData();
    const q = squash(product);
    const ent = Object.entries(d.commodities).find(([, c]) => squash(c[0]) === q || squash(c[1]) === q) || Object.entries(d.commodities).find(([, c]) => squash(c[0]).includes(q) || squash(c[1]).includes(q));
    if (!ent) throw new Error(`「${product}」不是行星工业产品`);
    const id = Number(ent[0]), [name, , tier, vol] = ent[1];
    const sch = d.schematics.find((s) => s[2] === id);
    const ids = [id, ...(sch ? sch[4].map(([x]) => x) : [])];
    const hub = await ctx.hubPrices(ids).catch(() => new Map());
    const px = (x) => hub.get(x)?.sell ?? null;
    const cname = (x) => d.commodities[x]?.[0] || x;
    const out = { product: name, tier: 'P' + tier, volume_m3: vol, sell_price: px(id), page_link: `#pi/${id}`, note: '在「行星工业」页打开 page_link 会按当前设置自动算出整条生产链的日收益' };
    if (sch) {
      const [, cycle, , outQty, ins] = sch;
      const inCost = ins.reduce((n, [x, q2]) => n + (px(x) || 0) * q2, 0);
      Object.assign(out, { cycle_seconds: cycle, output_per_cycle: outQty, inputs: ins.map(([x, q2]) => ({ item: cname(x), tier: 'P' + d.commodities[x]?.[2], qty: q2, sell_price: px(x) })),
        margin_per_cycle_if_buying_inputs: px(id) ? Math.round(px(id) * outQty - inCost) : null });
    }
    // P0：哪些行星能采
    const p0s = new Set();
    const walk = (x, depth = 0) => { if (depth > 6) return; const c = d.commodities[x]; if (!c) return; if (c[2] === 0) { p0s.add(x); return; } const s = d.schematics.find((y) => y[2] === x); for (const [y] of s?.[4] || []) walk(y, depth + 1); };
    walk(id);
    out.raw_resources = [...p0s].map((x) => ({ p0: cname(x), planet_types: Object.values(d.planetTypes).filter((p) => p.res.includes(x)).map((p) => p.name) }));
    return { brief: `${name}（P${tier}）`, data: out };
  },
  async pi_colonies({ character = '' }) {
    if (!ctx.accounts().length) return { brief: '没有绑定 ESI', text: '玩家还没有绑定 ESI 角色' };
    const list = character ? [pickAccount(character)] : ctx.accounts().slice(0, 10);
    const d = await piData();
    const now = Date.now();
    const out = [];
    for (const a of list) {
      try {
        const planets = await ctx.accountFetch(a.id, `/characters/${a.id}/planets/`);
        const rows = await Promise.all(planets.map(async (p) => {
          const lay = await ctx.accountFetch(a.id, `/characters/${a.id}/planets/${p.planet_id}/`).catch(() => null);
          const pins = lay?.pins || [];
          const ex = pins.filter((x) => x.extractor_details);
          const exp = ex.map((x) => Date.parse(x.expiry_time || 0) || 0);
          const products = new Set(pins.map((x) => x.schematic_id && d.schematics.find((s) => s[0] === x.schematic_id)?.[2]).filter(Boolean));
          return { system: await sysName(p.solar_system_id), planet_type: p.planet_type, level: p.upgrade_level, extractors: ex.length,
            extractors_stopped: exp.filter((t) => t <= now).length, next_expiry: exp.length ? new Date(Math.min(...exp)).toISOString() : null,
            extracting: [...new Set(ex.map((x) => d.commodities[x.extractor_details.product_type_id]?.[0]).filter(Boolean))], producing: [...products].map((x) => d.commodities[x]?.[0] || x) };
        }));
        out.push({ character: a.name, colonies: rows });
      } catch (e) { out.push({ character: a.name, error: e.status === 403 ? '授权缺少行星权限' : e.message }); }
    }
    const stopped = out.reduce((n, c) => n + (c.colonies || []).reduce((m, p) => m + p.extractors_stopped, 0), 0);
    return { brief: `${out.length} 个角色 · ${stopped} 个采集器已停`, data: { characters: out, page_link: '#pi', note: '时间是 UTC' } };
  },

  // ---------- 虫洞 ----------
  async wormhole_info({ system = '', wh_type = '', thera = false }) {
    const d = await whData();
    const out = {};
    const holeInfo = (code) => {
      const h = d.wormholes.find((x) => x[0].toUpperCase() === String(code).toUpperCase());
      if (!h) return null;
      const [c, , dest, life, total, jump, regen] = h;
      return { type: c, leads_to: WH_CLS[dest] || dest, lifetime_h: life, total_mass_kt: total / 1e6, max_ship_mass_kt: jump / 1e6, biggest_ship: whShip(jump), ...(regen ? { regen_kt: regen / 1e6 } : {}) };
    };
    if (system) {
      const q = squash(system);
      const s = d.systems.find((x) => squash(x[1]) === q || String(x[0]) === String(system));
      if (!s) throw new Error(`找不到虫洞星系「${system}」`);
      const [id, name, cls, region, effect, planets, moons, statics] = s;
      Object.assign(out, { system: name, class: WH_CLS[cls] || cls, region: d.regions[region], effect: WH_EFFECT[effect] || effect || '无', planets: planets.length, moons,
        statics: statics.map(holeInfo).filter(Boolean), page_link: `#wh/system/${id}` });
      const act = await v1('wormholes/systems/' + id).catch(() => null);
      if (act) {
        const names = act.names || {};
        out.activity_30d = { kills: act.kills, isk_lost: act.value, npc_kills: act.npc_kills, last_kill: act.last, busiest_utc_hours: (act.hours_utc || []).map((n, h) => [h, n]).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([h]) => h),
          top_corporations: (act.corporations || []).slice(0, 5).map((c) => names[c.id] || c.id), top_alliances: (act.alliances || []).slice(0, 3).map((c) => names[c.id] || c.id) };
      }
    }
    if (wh_type) out.wormhole_type = holeInfo(wh_type) || `没有这种虫洞「${wh_type}」`;
    if (thera) {
      if (ctx.server.id !== 'tq') out.thera = '席拉 / 图尔努尔连接只有欧服有（EVE-Scout）';
      else {
        const r = await fetch('https://api.eve-scout.com/v2/public/signatures').then((x) => x.json()).catch(() => []);
        out.thera = (r || []).filter((x) => x.signature_type === 'wormhole').slice(0, 60).map((x) => ({ hub: x.out_system_name, hub_sig: x.out_signature, to: x.in_system_name, region: x.in_region_name, sig: x.in_signature, type: x.wh_type, max_ship: x.max_ship_size, hours_left: x.remaining_hours }));
      }
    }
    if (!system && !wh_type && !thera) throw new Error('请给出虫洞星系名、虫洞类型代码或要查席拉连接');
    return { brief: [out.system && `${out.system} ${out.class}`, out.wormhole_type?.type, thera && '席拉连接'].filter(Boolean).join(' · '), data: out };
  },

  // ---------- 主权规划（sov.js：与「主权规划」页同一套数据和规则）----------
  async sov_system({ system = '', systems = [], region = '', sort = 'power', limit = 15 }) {
    const m = await ctx.sov();
    if (region) {
      const r = await findPlace(region, 'region');
      const d = await m.aiSystems({ regionId: r.id, sort, limit: Math.min(50, limit || 15) });
      return { brief: `${d.region} · ${d.count} 个星系 · 按${{ power: '电力', workforce: '劳动力', ice: '超离子冰', gas: '岩浆气' }[sort] || '电力'}排序`, data: { ...d, page_link: '#sov' } };
    }
    const names = [system, ...(systems || [])].filter(Boolean);
    if (!names.length) throw new Error('请给出星系名或星域名');
    const ids = [];
    for (const n of names.slice(0, 20)) ids.push((await findPlace(n, 'system')).id);
    const d = await m.aiSystems({ ids });
    if (!d.systems.length) throw new Error('这些星系没有主权数据（只有 00 主权星系能装主权中心）');
    return { brief: d.systems.map((s) => `${s.system.split('（')[0]} 电力 ${s.max_power} · 劳动力 ${s.max_workforce}`).join('；'), data: { ...d, note: 'max_power / max_workforce 是所有对应行星都装天钩时的上限', page_link: '#sov' } };
  },
  async sov_upgrades() {
    const d = await (await ctx.sov()).aiUpgrades();
    return { brief: `${d.upgrades.length} 种升级件`, data: { ...d, page_link: '#sov' } };
  },
  async sov_plan({ systems = [], auto = true, save_to_page = false }) {
    if (!systems.length) throw new Error('请给出要规划的星系和各自的升级件');
    const plans = [];
    for (const s of systems.slice(0, 40)) plans.push({ id: (await findPlace(s.system, 'system')).id, upgrades: s.upgrades || [], off: s.skyhooks_off || [] });
    const d = await (await ctx.sov()).aiPlan(plans, { auto, save: save_to_page });
    const low = d.systems.reduce((n, s) => n + s.upgrades.filter((u) => u.state !== '可上线').length, 0);
    const ok = d.systems.reduce((n, s) => n + s.upgrades.filter((u) => u.state === '可上线').length, 0);
    return { brief: `${d.systems.length} 个星系 · ${ok} 个升级件可上线${low ? ` · ${low} 个资源不足` : ''}${d.saved ? ' · 已保存到主权规划页' : ''}`,
      data: { ...d, page_link: d.saved ? `#sov/sys/${plans[0].id}` : '#sov', note: d.saved ? '已写入本站「主权规划」页，玩家打开链接即可看到并继续调整' : '未保存；save_to_page=true 可写入「主权规划」页' } };
  },
  async sov_my_hubs({ refresh = false }) {
    const d = await (await ctx.sov()).aiMyHubs({ refresh });
    if (d.error) throw new Error(d.error);
    const low = d.hubs.filter((h) => h.fuel?.some((f) => f.hours_left != null && f.hours_left < 72)).length;
    return { brief: `${d.corporation} · ${d.hubs.length} 个主权中心 · ${d.skyhooks.length} 个天钩${low ? ` · ${low} 个燃料不足 3 天` : ''}`, data: d };
  },

  // ---------- 估价（与「估价」页一样：粘贴物品清单，按交易中心最低卖价 / 最高收价）----------
  async appraise({ text }) {
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 300);
    const agg = new Map(), unknown = [];
    for (const l of lines) {
      const cols = l.split(/\t| {2,}/);
      let name = cols[0], qty = Number(String(cols[1] || '').replace(/[,\s]/g, '')) || 0;
      // 「名称 x数量」「名称 数量」「数量 名称」
      const m = /^(.*?)(?:\s+x\s*|\s*[×*]\s*)([\d,]+)$/i.exec(l) || /^(.*?\D)\s+([\d,]+)$/.exec(l) || /^([\d,]+)\s*[x×]?\s+(.*)$/.exec(l);
      if (!qty && m) { if (/^[\d,]+$/.test(m[1])) { qty = Number(m[1].replace(/,/g, '')); name = m[2]; } else { name = m[1]; qty = Number(m[2].replace(/,/g, '')); } }
      try { const t = await resolveItem(name.trim()); agg.set(t.id, { name: t.name, qty: (agg.get(t.id)?.qty || 0) + (qty || 1) }); } catch { unknown.push(l); }
    }
    const hub = await ctx.hubPrices([...agg.keys()]).catch(() => new Map());
    let sell = 0, buy = 0;
    const items = [...agg].map(([id, x]) => { const h = hub.get(id) || {}; sell += (h.sell || 0) * x.qty; buy += (h.buy || 0) * x.qty; return { name: x.name, qty: x.qty, sell: h.sell ?? null, buy: h.buy ?? null, sell_total: h.sell ? Math.round(h.sell * x.qty) : null }; })
      .sort((a, b) => (b.sell_total || 0) - (a.sell_total || 0));
    return { brief: `${items.length} 种 · 卖价合计 ${isk(sell)} · 收价合计 ${isk(buy)}`, data: { hub: ctx.server.regions[0].hub.name, sell_total: Math.round(sell), buy_total: Math.round(buy), split: Math.round((sell + buy) / 2), items: items.slice(0, 80), unknown_lines: unknown.slice(0, 20), page_link: '#appr' } };
  },

  // ---------- 合同 / 快递 ----------
  async contracts_search({ item = '', q = '', type = '', region = '', status = 'open', min_price, max_price, sort = '', order = '', want = false, limit = 15 }) {
    const p = new URLSearchParams({ status, limit: String(Math.min(50, Math.max(1, limit || 15))) });
    if (item) p.set('item', String((await resolveItem(item)).id));
    if (q) p.set('q', q);
    if (type) p.set('type', type);
    if (region) p.set('region', String((await findPlace(region, 'region')).id));
    if (min_price != null) p.set('min', String(min_price));
    if (max_price != null) p.set('max', String(max_price));
    if (sort) p.set('sort', sort);
    if (order) p.set('order', order);
    if (want) p.set('side', 'want');
    const d = await kbGet('contracts?' + p);
    const pool = await itemPool();
    const list = [];
    for (const c of d.list || []) list.push({ id: c.contract_id, type: c.type, title: c.title || undefined, where: await sysName(c.system_id), price: c.type === 'courier' ? undefined : c.price, reward: c.type === 'courier' ? c.reward : undefined,
      collateral: c.collateral || undefined, volume_m3: c.volume, est_value: c.value || undefined, main_item: c.main_type ? pool.get(c.main_type)?.name || c.main_type : undefined, items: c.n_items || undefined, expires: c.expires, bids: c.bids || undefined });
    return { brief: `${d.total} 个合同 · 前 ${list.length}`, data: { total: d.total, ...(d.sold ? { recent_sold_unit_prices: d.sold } : {}), contracts: list, note: 'est_value 为物品按市场价估值；在游戏里按合同 ID 搜索，或打开本站「合同」页', page_link: '#contracts' } };
  },
  async courier_contracts({ from = '', max_volume = 0, min_reward = 0, max_collateral = 0, region = '', limit = 15 }) {
    const p = new URLSearchParams({ status: 'open', type: 'courier', limit: '200', sort: 'price' });
    if (region) p.set('region', String((await findPlace(region, 'region')).id));
    const d = await kbGet('contracts?' + p);
    const m = await mapData();
    const origin = from ? await findPlace(from, 'system') : null;
    const dist = (a, b) => { // 星门图上的跳数（BFS）
      const s = m.systems.get(a), t = m.systems.get(b);
      if (!s || !t) return null;
      const seen = new Map([[s.i, 0]]), qu = [s.i];
      while (qu.length) { const x = qu.shift(); if (x === t.i) return seen.get(x); for (const y of m.list[x].nbr) if (!seen.has(y)) { seen.set(y, seen.get(x) + 1); qu.push(y); } }
      return null;
    };
    const st = new Map();
    const endSys = async (loc) => {
      if (!(loc >= 60000000 && loc < 64000000)) return null;   // 玩家建筑需要授权，算不了
      if (!st.has(loc)) st.set(loc, ctx.fetchESI(`/universe/stations/${loc}/`).then((x) => x.system_id).catch(() => null));
      return st.get(loc);
    };
    let rows = (d.list || []).filter((c) => (!max_volume || c.volume <= max_volume) && (!min_reward || c.reward >= min_reward) && (!max_collateral || c.collateral <= max_collateral)).slice(0, 120);
    const out = [];
    for (const c of rows) {
      const to = await endSys(c.end_location_id);
      const jumps = to ? dist(c.system_id, to) : null;
      const pick = origin ? dist(origin.id, c.system_id) : null;
      const total = jumps != null ? jumps + (pick || 0) : null;
      out.push({ id: c.contract_id, from: await sysName(c.system_id), to: to ? await sysName(to) : '玩家建筑', jumps, pickup_jumps: pick ?? undefined, reward: c.reward, collateral: c.collateral, volume_m3: c.volume, days: c.days,
        isk_per_jump: total ? Math.round(c.reward / Math.max(1, total)) : null, isk_per_m3: c.volume ? Math.round(c.reward / c.volume) : null });
    }
    out.sort((a, b) => (b.isk_per_jump || 0) - (a.isk_per_jump || 0));
    return { brief: `${rows.length} 个快递合同`, data: { note: '按每跳报酬排序（含从起点过去的跳数）；跳数按星门最短路线', contracts: out.slice(0, Math.min(30, Math.max(1, limit || 15))), page_link: '#courier' } };
  },

  // ---------- 倒卖（与「倒卖排行」同一数据：五大交易中心最低卖价 / 最高收价、日成交量）----------
  async hub_arbitrage({ mode = 'instant', min_daily_volume = 10, max_unit_price = 0, limit = 15 }) {
    const d = await v1('hubs/arbitrage?server=' + ctx.server.id);
    if (d.loading) return { failed: true, brief: '倒卖数据还在准备', text: '服务器正在准备倒卖数据（1–2 分钟），稍后再问' };
    const m = await mapData();
    const hubName = (rid) => m.regions.get(rid)?.name || rid;
    const pool = await itemPool();
    const tax = 0.0337, broker = 0.015;
    const out = [];
    for (const [id, hs] of Object.entries(d.types || {})) {
      let best = null;
      hs.forEach((a, i) => {
        if (!a || !a[0]) return;
        if (max_unit_price && a[0] > max_unit_price) return;
        hs.forEach((b, j) => {
          if (!b || i === j) return;
          const sellAt = mode === 'instant' ? b[1] : b[0];
          const daily = b[6] || 0;
          if (!sellAt || daily < min_daily_volume) return;
          const unit = sellAt * (1 - tax - (mode === 'instant' ? 0 : broker)) - a[0];
          const qty = Math.min(a[4] || 0, mode === 'instant' ? (b[5] || 0) : Math.floor(daily * 0.1));
          const total = unit * qty;
          if (unit > 0 && qty > 0 && (!best || total > best.total)) best = { buy_at: hubName(d.hubs[i]), buy_price: a[0], sell_at: hubName(d.hubs[j]), sell_price: sellAt, unit_profit: Math.round(unit), margin_pct: Math.round(unit / a[0] * 1000) / 10, qty, total: Math.round(total), daily_volume_there: daily };
        });
      });
      if (best) out.push({ item: pool.get(Number(id))?.name || id, ...best });
    }
    out.sort((a, b) => b.total - a.total);
    return { brief: `${out.length} 个有利润的倒卖`, data: { mode: mode === 'instant' ? '在买入地吃最低卖单，到卖出地卖给最高收单（即买即卖）' : '到卖出地挂卖单（按日成交量的 10% 估可卖数量）', note: `税费按销售税 ${tax * 100}%${mode === 'instant' ? '' : ' + 中介费 1.5%'} 估算，不含运费；精确计算与运费用本站「倒卖排行」`, routes: out.slice(0, Math.min(40, Math.max(1, limit || 15))), page_link: '#arb' } };
  },

  // ---------- 势力战争 ----------
  async faction_warfare() {
    const [stats, systems] = await Promise.all([ctx.fetchESI('/fw/stats/'), ctx.fetchESI('/fw/systems/').catch(() => [])]);
    const names = await ctx.resolveNames([...new Set([...stats.map((s) => s.faction_id), ...systems.map((s) => s.occupier_faction_id)])]).catch(() => new Map());
    const m = await mapData();
    const fn = (id) => names.get?.(id) || id;
    const by = new Map();
    for (const s of systems) {
      const k = s.occupier_faction_id;
      const e = by.get(k) || { faction: fn(k), systems: 0, contested: 0, vulnerable: [] };
      e.systems++;
      if (s.contested !== 'uncontested') e.contested++;
      if (s.contested === 'vulnerable' && e.vulnerable.length < 15) e.vulnerable.push(m.systems.get(s.solar_system_id)?.name || s.solar_system_id);
      by.set(k, e);
    }
    return {
      brief: stats.map((s) => `${fn(s.faction_id)} ${s.systems_controlled} 星系`).join(' · '),
      data: { factions: stats.map((s) => ({ faction: fn(s.faction_id), pilots: s.pilots, systems: s.systems_controlled, kills_yesterday: s.kills?.yesterday, kills_last_week: s.kills?.last_week, vp_yesterday: s.victory_points?.yesterday, vp_last_week: s.victory_points?.last_week })),
        occupancy: [...by.values()], note: 'vulnerable 为可被夺取的星系', page_link: '#war/fw' }
    };
  },

  // ---------- 教程 / 广场 / 本地情报 ----------
  async guides_search({ q = '' }) {
    const idx = await fetch('guides/index.json?v=5').then((r) => r.json());
    const ws = words(q);
    const list = Object.entries(idx).map(([id, g]) => ({ id, title: g.zh, en: g.en, desc: g.d || '', video: Boolean(g.dur) }))
      .filter((g) => !ws.length || ws.some((w) => [g.title, g.en, g.desc].some((s) => squash(s).includes(squash(w)))));
    return { brief: `${list.length} 篇`, data: { guides: list.slice(0, 20).map((g) => ({ ...g, link: `#guide/${g.video ? 'v' : 'w'}/${g.id}` })), note: '用 guide_read 读取文字教程的正文' } };
  },
  async guide_read({ id }) {
    const g = await fetch(`guides/${encodeURIComponent(id)}.json?v=5`).then((r) => (r.ok ? r.json() : Promise.reject(new Error('没有这篇教程'))));
    const text = JSON.stringify(g).replace(/<[^>]+>/g, ' ').replace(/\\n/g, '\n').slice(0, 9000);
    return { brief: id, data: { id, link: `#guide/w/${id}`, content: text } };
  },
  async plaza_search({ kind = '', q = '', limit = 15 }) {
    const d = await kbGet('plaza?server=' + ctx.server.id + (kind ? '&kind=' + kind : ''));
    const ws = words(q);
    const list = (d.items || []).filter((p) => !ws.length || ws.every((w) => squash(JSON.stringify(p)).includes(squash(w))));
    return { brief: `${list.length} 条`, data: { posts: list.slice(0, Math.min(30, limit || 15)).map((p) => ({ ...p, link: `#plaza/p/${p.id}` })), kinds: '招新 recruit / 组队 fleet / 集市 market / 装配 fit / 其他 other', page_link: '#plaza' + (kind ? '/' + kind : '') } };
  },
  async pilot_intel({ names = [] }) {
    const list = names.map((n) => String(n).trim()).filter(Boolean).slice(0, 100);
    if (!list.length) throw new Error('请给出人物名');
    const ids = await ctx.fetchESI('/universe/ids/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(list) });
    const chars = ids.characters || [];
    if (!chars.length) return { failed: true, brief: '一个都没找到', text: '这些名字在 ESI 里找不到对应的人物' };
    const aff = await ctx.fetchESI('/characters/affiliation/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(chars.map((c) => c.id)) }).catch(() => []);
    const orgs = await ctx.resolveNames([...new Set(aff.flatMap((a) => [a.corporation_id, a.alliance_id]).filter(Boolean))]).catch(() => new Map());
    const st = await v1('pilots?ids=' + chars.map((c) => c.id).join(',') + (ctx.server.id === 'tq' ? '' : '&server=' + ctx.server.id)).catch(() => ({ pilots: {} }));
    const pool = await itemPool();
    return {
      brief: `${chars.length} 人`,
      data: { days: 30, pilots: chars.map((c) => { const a = aff.find((x) => x.character_id === c.id) || {}; const p = st.pilots?.[c.id] || {}; return { name: c.name, corporation: orgs.get?.(a.corporation_id), alliance: orgs.get?.(a.alliance_id) || undefined,
        kills: p.kills, losses: p.losses, solo: p.solo, avg_gang: p.gang, last_active: p.last, ships: (p.ships || []).slice(0, 5).map((s) => pool.get(Array.isArray(s) ? s[0] : s)?.name || s), systems: (p.systems || []).slice(0, 3) }; }),
        not_found: list.filter((n) => !chars.some((c) => norm(c.name) === norm(n))), note: '近 30 天本站收录的击杀；与「本地扫描」同一数据' }
    };
  },

  // 已绑定的角色：不指定时列出全部角色的概况（当前角色排第一）
  async my_character({ character = '' } = {}) {
    const all = ctx.accounts();
    if (!all.length) return { brief: '没有绑定 ESI', text: '玩家还没有绑定 ESI 角色，请提示他去「个人中心」绑定（可以绑定多个角色）。' };
    const list = character ? [pickAccount(character)] : all.slice(0, 20);
    const pool = await itemPool();
    const one = async (a) => {
      const get = (p) => ctx.accountFetch(a.id, `/characters/${a.id}/${p}`).catch((e) => ({ error: e.status === 403 ? '授权缺少权限' : e.message }));
      const [pub, wallet, loc, ship, skills] = await Promise.all([ctx.fetchESI(`/characters/${a.id}/`).catch(() => ({})), get('wallet/'), get('location/'), get('ship/'), get('skills/')]);
      const names = await ctx.resolveNames([pub.corporation_id, pub.alliance_id].filter(Boolean)).catch(() => new Map());
      return {
        name: a.name, character_id: a.id, current: a.id === all[0].id, corporation: names.get?.(pub.corporation_id) || pub.corporation_id, alliance: names.get?.(pub.alliance_id) || pub.alliance_id || null,
        security_status: pub.security_status, birthday: pub.birthday,
        wallet_isk: wallet, location: loc?.solar_system_id ? await sysName(loc.solar_system_id) : loc,
        ship: ship?.ship_type_id ? { type: pool.get(ship.ship_type_id)?.name || ship.ship_type_id, name: ship.ship_name } : ship,
        total_sp: skills?.total_sp ?? skills, unallocated_sp: skills?.unallocated_sp
      };
    };
    const out = await Promise.all(list.map(one));
    return { brief: out.map((c) => c.name).join('、'), data: { characters: out, note: `浏览器里共绑定 ${all.length} 个角色；current 为个人中心当前选中的角色` } };
  },

  // 我的角色里谁能开某船 / 某船级 / 用某装备、某技能几级；不能的还差哪些技能、要练多久
  async my_characters_fly({ ship = '', skills = [] }) {
    const all = ctx.accounts();
    if (!all.length) return { brief: '没有绑定 ESI', text: '玩家还没有绑定 ESI 角色，请提示他去「个人中心」绑定（可以绑定多个角色）。' };
    const { data, reqs, label } = await needOf(ship, skills);
    const rows = await Promise.all(all.slice(0, 30).map(async (a) => {
      try {
        const sk = await ctx.accountFetch(a.id, `/characters/${a.id}/skills/`);
        const attrs = await ctx.accountFetch(a.id, `/characters/${a.id}/attributes/`).catch(() => null);
        const c = BS.makeChar(data, { skills: (sk.skills || []).map((x) => [x.skill_id, x.active_skill_level ?? x.trained_skill_level ?? 0, x.skillpoints_in_skill || 0]), total_sp: sk.total_sp });
        return { name: a.name, ...gapOf(data, c, reqs, attrs), total_sp: sk.total_sp };
      } catch (e) {
        return { name: a.name, error: e.status === 403 ? '授权缺少技能权限（需重新绑定并勾选技能）' : e.message };
      }
    }));
    rows.sort((x, y) => (y.ok === true) - (x.ok === true) || (x.missing_sp ?? 1e12) - (y.missing_sp ?? 1e12));
    const ok = rows.filter((r) => r.ok);
    return {
      brief: `${label} · ${all.length} 个角色 · 能的 ${ok.length} 个` + (ok.length ? `：${ok.map((r) => r.name).join('、')}` : ''),
      data: { requirement: label, note: '按游戏规则检查完整的技能前置链；train_time 按角色当前属性（读不到时按默认属性）计算，不含植入体加成', characters: rows }
    };
  },

  // 角色交易（宁静：官方论坛 Character Bazaar；晨曦：网易藏宝阁；曙光：玩家自挂）按「能开什么 / 技能几级 / 技能点 / 价格」筛选
  async bazaar_search({ can_fly = '', skills = [], min_sp_million = 0, max_sp_million = 0, max_price = 0, sort = 'price', limit = 10 }) {
    const { data, reqs, label } = (can_fly || skills.length) ? await needOf(can_fly, skills) : { data: (await fitData()), reqs: [], label: '' };
    const sid = ctx.server.id;
    const get = async (path) => { const r = await fetch(KB + 'bazaar' + path); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status); return d; };
    let rows = [], cur = '十亿 ISK（B）', pending = 0, note = '';
    if (sid === 'tq') {
      setStatus('读取角色交易帖子…');
      const [list, set] = await Promise.all([get('?page=0'), get('/skillset')]);
      pending = set.pending || 0;
      for (const t of list.topics || []) {
        if (t.closed || !['wts', 'auction'].includes(t.kind)) continue;
        const chars = (set.topics?.[t.id] || []).map(([cid, name, sp, sk]) => ({ cid, name, sp, have: BS.parseSkills(sk) }));
        if (reqs.length && !chars.length) continue;
        const okc = reqs.length ? chars.filter((c) => BS.meets(data, c.have, reqs)) : chars;
        if (reqs.length && !okc.length) continue;
        rows.push({ title: t.title_zh || t.title, title_en: t.title_zh ? t.title : undefined, sp: okc[0]?.sp || (t.sp ? t.sp * 1e6 : null), price: t.price ?? t.isk ?? null,
          characters: okc.map((c) => c.name), last_post: t.last_posted_at, link: `#bazaar/t/${t.id}` });
      }
      note = '宁静服角色交易来自官方论坛 Character Bazaar，只有贴了 qsna.eu 技能展示的帖子才能按技能筛选；价格是卖家报价（ISK），买号要用游戏内角色转移服务';
    } else if (sid === 'serenity' || sid === 'infinity') {
      const base = sid === 'serenity' ? '/cbg' : '/sale', q = sid === 'infinity' ? '?server=infinity' : '';
      const [list, set] = await Promise.all([get(base + q), get(base + '/skillset' + q)]);
      pending = set.pending || 0;
      cur = '元';
      for (const t of list.items || []) {
        const sk = set.items?.[t.id];
        if (reqs.length && (!sk || !BS.meets(data, BS.parseSkills(sk[3]), reqs))) continue;
        rows.push({ name: t.name, sp: t.sp ?? null, price: t.price ?? null, status: t.status === 'fair' ? '公示期' : undefined, link: `#bazaar/${sid === 'serenity' ? 'c' : 's'}/${t.id}` });
      }
      note = sid === 'serenity' ? '晨曦服角色交易来自网易藏宝阁（人民币）' : '曙光服角色交易是玩家在本站自挂的角色';
    } else {
      return { failed: true, brief: '这个服务器没有角色交易', text: '当前服务器暂不支持角色交易' };
    }
    rows = rows.filter((r) => (!min_sp_million || (r.sp || 0) >= min_sp_million * 1e6) && (!max_sp_million || (r.sp || Infinity) <= max_sp_million * 1e6) && (!max_price || (r.price ?? Infinity) <= max_price));
    const key = { price: (r) => r.price ?? Infinity, sp: (r) => -(r.sp || 0), newest: (r) => -Date.parse(r.last_post || 0) || 0 }[sort] || ((r) => r.price ?? Infinity);
    rows.sort((a, b) => key(a) - key(b));
    return {
      brief: `${label ? label + ' · ' : ''}${rows.length} 个在售`,
      data: { requirement: label || null, currency: cur, matched: rows.length, still_loading: pending || undefined, note: note + '；link 是本站详情页，回答里写成 Markdown 链接', results: rows.slice(0, Math.min(30, Math.max(1, limit || 10))) }
    };
  },

  async esi_get({ path, character = '', search = '', summary = false, limit = 50 }) {
    if (!ctx.accounts().length) return { brief: '没有绑定 ESI', text: '玩家还没有绑定 ESI 角色，请提示他去「个人中心」绑定。' };
    const acc = pickAccount(character);
    let p = String(path || '').trim().replace(/^https?:\/\/[^/]+/, '').replace(/^\/(latest|v\d+)\//, '/').replace(/\?.*$/, '');
    p = p.replace('{character_id}', acc.id);
    if (!p.endsWith('/')) p += '/';
    const m = /^\/characters\/(\d+)\/[a-z_/]+\/$/.exec(p);
    if (!m || !ctx.accounts().some((a) => a.id === Number(m[1]))) throw new Error('只能读取已绑定角色的数据：/characters/{character_id}/…（用 character 参数指定角色）');
    let data;
    try {
      data = await ctx.accountPaged(Number(m[1]), p, 10);
    } catch (e) {
      if (e.status === 403) throw new Error('ESI 授权缺少这项权限，请在「个人中心」重新绑定并勾选对应权限');
      if (e.status === 404) throw new Error('ESI 没有这个接口：' + p);
      throw e;
    }
    if (Array.isArray(data) && data.length === 1 && !Array.isArray(data[0]) && typeof data[0] === 'object' && !p.match(/assets|journal|transactions|orders|blueprints|contracts|jobs|mining|killmails|fittings|planets|standings|points|notifications|clones/)) data = data[0];
    // 列表：附上物品名 / 星系名，按物品名过滤，汇总或截取
    const listKey = Array.isArray(data) ? null : Object.keys(data || {}).find((k) => Array.isArray(data[k]) && data[k].length > 10);
    let list = Array.isArray(data) ? data : listKey ? data[listKey] : null;
    if (list) {
      const ids = new Set();
      for (const x of list) for (const k of ['type_id', 'ship_type_id', 'skill_id', 'blueprint_type_id', 'product_type_id']) if (x?.[k]) ids.add(x[k]);
      const names = await ctx.resolveTypeNames([...ids]).catch(() => new Map());
      const mp = await mapData();
      for (const x of list) {
        if (!x || typeof x !== 'object') continue;
        for (const k of ['type_id', 'ship_type_id', 'skill_id', 'blueprint_type_id', 'product_type_id']) if (x[k] && names.get(x[k])) x[k.replace(/_id$/, '_name')] = names.get(x[k]);
        if (x.solar_system_id && mp.systems.get(x.solar_system_id)) x.solar_system_name = mp.systems.get(x.solar_system_id).name;
      }
      const total = list.length;
      if (search) {
        // 中文名或英文名包含关键词都算（技能、物品名在数据里是中文）
        const q = norm(search), en = await enNames();
        const zhToEn = new Map([...en].map(([e, z]) => [z, e]));
        const hit = (v) => norm(v).includes(q) || words(search).every((w) => squash(v).includes(squash(w))) || (zhToEn.get(v) && norm(zhToEn.get(v)).includes(q));
        list = list.filter((x) => Object.entries(x).some(([k, v]) => k.endsWith('_name') && typeof v === 'string' && hit(v)));
      }
      if (summary) {
        const avg = await ctx.avgPrices();
        const g = new Map();
        for (const x of list) {
          const id = x.type_id ?? x.skill_id;
          if (!id) continue;
          const e = g.get(id) || { type_id: id, name: x.type_name || x.skill_name || id, quantity: 0, rows: 0 };
          e.quantity += x.quantity ?? 1; e.rows++;
          g.set(id, e);
        }
        const rows = [...g.values()].map((e) => ({ ...e, est_value: avg.get(e.type_id) ? Math.round(avg.get(e.type_id) * e.quantity) : null })).sort((a, b) => (b.est_value || 0) - (a.est_value || 0))
          .slice(0, Math.min(200, limit || 50));
        // 附上主交易中心最低卖价，免得模型再逐个查价格
        const hub = await ctx.hubPrices(rows.map((e) => e.type_id)).catch(() => new Map());
        for (const e of rows) {
          const sell = hub.get(e.type_id)?.sell;
          if (sell) { e.hub_sell = sell; e.hub_value = Math.round(sell * e.quantity); }
        }
        return { brief: `${p} · ${total} 条，汇总 ${g.size} 种`, data: { total_rows: total, matched: list.length, note: `est_value 按全服均价估算（按它从高到低排），hub_value 按${ctx.server.regions[0].hub.name}最低卖价估算`, items: rows } };
      }
      const cut = list.slice(0, Math.min(200, limit || 50));
      const out = listKey ? { ...data, [listKey]: cut } : cut;
      return { brief: `${p} · ${total} 条${search ? `，匹配 ${list.length} 条` : ''}`, data: { total_rows: total, matched: list.length, shown: cut.length, rows: out } };
    }
    return { brief: p, data };
  }
};

// 发给模型的装配属性（精简）与卡片上显示的几项
function fitSummary(r) {
  const { stats: s, calc, data } = r;
  const pct = (v) => Math.round(v * 1000) / 10;
  const layer = (l) => ({ hp: Math.round(l.hp), resist_pct: { em: pct(l.resist[0]), thermal: pct(l.resist[1]), kinetic: pct(l.resist[2]), explosive: pct(l.resist[3]) } });
  const cap = s.capacitor;
  const capText = cap.stable ? `稳定 ${Math.round((cap.level ?? 1) * 100)}%` : `${Math.round(cap.lasts || 0)} 秒耗尽`;
  const name = (id) => data.types.get(id)?.name || id;
  const mods = {};
  for (const slot of ['high', 'mid', 'low', 'rig', 'sub']) {
    const list = r.fit.slots[slot].filter(Boolean).map((m) => name(m.type) + (m.charge ? `（${name(m.charge)}）` : '') + (m.state !== 'active' && data.types.get(m.type)?.activatable ? ` [${m.state}]` : ''));
    if (list.length) mods[slot] = list;
  }
  const res = s.resources;
  const used = (k) => `${+res[k].used.toFixed(1)} / ${+res[k].total.toFixed(1)}`;
  const dataOut = {
    ship: name(r.fit.ship),
    slots: Object.fromEntries(Object.entries(s.slots).filter(([, n]) => n).map(([k, n]) => [k, `${s.used[k]} / ${n}`])),
    modules: mods, drones: r.fit.drones.map((d) => `${name(d.type)} x${d.count}（出动 ${d.active}）`),
    cpu: used('cpu'), powergrid: used('power'), calibration: used('calibration'), turret_hardpoints: used('turrets'), launcher_hardpoints: used('launchers'),
    dps: { total: Math.round(s.weapon.total), turret: Math.round(s.weapon.turret), missile: Math.round(s.weapon.missile), drone: Math.round(s.weapon.drone), volley: Math.round(s.weapon.volley) },
    ehp: Math.round(s.defense.ehp), shield: layer(s.defense.shield), armor: layer(s.defense.armor), hull: layer(s.defense.hull),
    repair_ehp_per_s: { shield_boost: Math.round(s.defense.repsEhp.shield), armor_repair: Math.round(s.defense.repsEhp.armor), shield_passive: Math.round(s.defense.passiveRegenEhp) },
    capacitor: { capacity: Math.round(cap.capacity), recharge_s: Math.round(cap.recharge), usage_per_s: +cap.usage.toFixed(1), result: capText },
    max_velocity_m_s: Math.round(s.navigation.velocity), align_time_s: +s.navigation.align.toFixed(2), warp_au_s: +s.navigation.warp.toFixed(2),
    signature_m: Math.round(s.navigation.signature), mass_kg: Math.round(s.navigation.mass),
    lock_range_km: +(s.targeting.range / 1000).toFixed(1), scan_res: Math.round(s.targeting.scanRes), cargo_m3: Math.round(s.cargo),
    ...(s.mining?.total ? { mining_m3_per_s: +s.mining.total.toFixed(2) } : {}),
    problems: s.problems.map((p) => p.text)
  };
  void calc;
  return { data: dataOut, speed: s.navigation.velocity, dps: s.weapon.total, ehp: s.defense.ehp, card: { ship: dataOut.ship, dps: s.weapon.total, ehp: s.defense.ehp, speed: s.navigation.velocity, cap: capText } };
}

// ---------- Markdown（模型回答）：标题、列表、表格、粗体、行内代码、代码块、链接（站内 # 链接与 https）----------
function md(src) {
  const { esc } = ctx;
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((#[\w=&./-]+|https:\/\/[^\s)]+)\)/g, (_, t, h) => `<a href="${h}"${h.startsWith('#') ? '' : ' target="_blank" rel="noopener"'}>${t}</a>`);
  const lines = String(src).replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const row = (x) => x.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(l);
      const body = [];
      for (i += 2; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) body.push(row(lines[i]));
      out.push(`<div class="ai-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { out.push(`<h${Math.min(5, h[1].length + 2)}>${inline(h[2])}</h${Math.min(5, h[1].length + 2)}>`); i++; continue; }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l);
      const items = [];
      for (; i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i]); i++) items.push(`<li>${inline(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))}</li>`);
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const para = [];
    for (; i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*•]|\d+[.)])\s+|\s*\|)/.test(lines[i]); i++) para.push(inline(lines[i]));
    if (!para.length) { out.push(`<p>${inline(l)}</p>`); i++; continue; }
    out.push(`<p>${para.join('<br>')}</p>`);
  }
  return out.join('');
}
