// 教程：按玩法分类收录的 EVE 教程
// - 中文资料（官方新伊甸学院、BWIKI、B 站）为外链，在新标签页打开
// - 英文资料（EVE University Wiki 文章、EVE Academy 官方视频字幕）已全文翻译，放在 guides/<id>.json，站内阅读，可切换中文 / English / 对照
// 收录时逐条打开核对过（2026-10）；B 站视频注明发布日期，旧视频的界面和数值可能和现在不同

let ctx = null;
const $ = (id) => document.getElementById(id);
const LANG_KEY = 'eve-guide-lang';

const CATS = [
  ['start', '新手入门', '建号、新手任务、生涯代理人、Alpha / Omega、技能与安全等级'],
  ['ship', '舰船与装配', '舰船分类、装配思路、飞行操作、总览与定向扫描'],
  ['mine', '采矿与采集', '矿石、冰矿、气云，以及新手常见的赚钱路线'],
  ['pve', '任务与刷怪', '代理人任务、刷怪、异常、深渊、入侵'],
  ['explore', '探索与扫描', '探针扫描、数据 / 遗迹站点破解'],
  ['wh', '虫洞', '虫洞等级、进出与生存、虫洞战斗'],
  ['industry', '工业与行星开发', '制造、发明、行星开发（种菜）'],
  ['trade', '贸易与运输', '市场买卖、倒卖、运输'],
  ['pvp', 'PVP 与军团', 'PVP 入门、势力战争、公开舰队、找军团'],
  ['wiki', '百科与课程', '可以长期查阅的综合百科和课程库']
];

// { cat, title, src, lang: 原文语言 zh / en, kind: video / text, date, url: 原文, desc, doc: 站内译文 id }
const ACADEMY = 'https://www.eveonline.com/zh/eve-academy';
const UNI = 'https://wiki.eveuniversity.org/';
const BWIKI = 'https://wiki.biligame.com/eve/';
const BV = 'https://www.bilibili.com/video/';
const YT = 'https://www.youtube.com/watch?v=';
const g = (cat, title, src, lang, kind, date, url, desc, doc = '') => ({ cat, title, src, lang, kind, date, url, desc, doc });
// EVE University 文章：译文 id 由页面名生成（Directional_Scanner → directional-scanner）
const uni = (cat, title, page, desc) => g(cat, title, 'EVE University', 'en', 'text', '', UNI + page, desc, page.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
// EVE Academy 官方教学视频（英文配音，站内附中文字幕）
const academy = (cat, title, id, doc, desc) => g(cat, title, 'EVE 官方 · EVE Academy', 'en', 'video', '', YT + id, desc, 'academy-' + doc);

const GUIDES = [
  g('start', '新伊甸学院：新手指南', 'EVE 官方', 'zh', 'text', '', ACADEMY, '官方中文新手站，从这里开始：职业路线、舰船、驾驶与战斗机制。'),
  g('start', '职业生涯：四条发展路线', 'EVE 官方', 'zh', 'text', '', ACADEMY + '/careers', '探险家、工业家、执法者（PvE）、自由战士（PvP），每条路线有技能计划和入门配装。'),
  academy('start', '开始史诗任务线', 'bZRcJ3p8dTE', 'epic-arc', '新手任务之后，怎么接史诗任务线、能拿到什么。'),
  academy('start', '了解安全等级', 'DS1EnO1iJp4', 'security-status', '星系安全等级与个人安全等级：高安、低安、00 各有什么规则和风险。'),
  g('start', '简单EVE 新手教程篇 1：建号与新手任务', 'B 站 · L3-猛汉猎人', 'zh', 'video', '2017-10', BV + 'BV1xx411M7va/', '系列视频第一期，讲建号、选阵营和新手任务。版本较旧，新手任务流程已改过，作思路参考。'),
  g('start', '【EVE欧服】快速上手 EVE 的实用配置和建议', 'B 站 · 祖祖Limor', 'zh', 'video', '2023-08', BV + 'BV1qN411B7pk/', '客户端设置、界面布局等上手配置，以及给新人的建议。'),
  g('start', '【EVE新人必看技巧】新手常用邮件列表', 'B 站 · EVE欧服玉麒麟联盟', 'zh', 'video', '2022-07', BV + 'BV1TS4y1n7jQ/', '怎么加入和使用新手常用的邮件列表。同系列还有不少新人技巧。'),
  g('start', 'EVE 星战前夜，新手如何迅速成长', 'B 站专栏', 'zh', 'text', '', 'https://www.bilibili.com/read/cv5603494/', '新手前期的路线建议：先用免费克隆体熟悉操作、在高安积累技能等。'),
  uni('start', 'EVE 新手入门', 'Getting_Started_in_EVE_Online', '从创建角色到第一条史诗任务线的完整入门。'),
  uni('start', '生涯代理人', 'Career_Agents', '新手任务之后的扩展教程，五类生涯任务各给奖励和舰船。'),
  uni('start', 'AIR 生涯计划：免费技能点', 'AIR_Career_Program', '做生涯目标领取免费技能点，新号前期很划算。'),
  uni('start', 'Alpha 与 Omega 克隆状态', 'Clone_states', '免费号（Alpha）能飞什么、能练什么，和 Omega 的区别。'),
  uni('start', '技能与训练', 'Skills_and_learning', '技能训练、属性与植入体、技能队列。'),
  uni('start', '安全等级', 'Security_status', '星系安全等级与个人安全等级，高安 / 低安 / 00 的规则差异。'),

  g('ship', '舰船', 'EVE 官方', 'zh', 'text', '', ACADEMY + '/ships', '官方中文舰船介绍：舰船分类与各自定位。'),
  g('ship', '驾驶你的舰船', 'EVE 官方', 'zh', 'text', '', ACADEMY + '/ships/flying-your-ship', '官方中文：移动、跃迁、跳跃等基础飞行操作。'),
  g('ship', '战斗机制', 'EVE 官方', 'zh', 'text', '', ACADEMY + '/ships/combat-mechanics', '官方中文：锁定、伤害类型、抗性、命中等战斗基础。'),
  academy('ship', '舰船装配', 'ArCI4bi9Eyg', 'fitting', '装配窗口、CPU 与能量栅格、高中低槽怎么搭配。'),
  g('ship', '托勒克斯级配置思路详解', 'B 站 · 合辰JEX', 'zh', 'video', '2020-10', BV + 'BV1bZ4y1L7Ge/', '以一艘船为例讲配船思路（团内单挑赛冠军配置），适合学怎么自己配船。'),
  uni('ship', '舰船总览', 'Ships', '各级别、各势力舰船的索引和定位。'),
  uni('ship', '舰船装配', 'Fitting_ships', 'CPU / 能量栅格、高中低槽、改装件，配装的基本规则。'),
  uni('ship', '总览（Overview）', 'Overview', '总览面板的设置和常用预设。'),
  uni('ship', '定向扫描（D-Scan）', 'Directional_Scanner', '用定向扫描发现附近的舰船和建筑，保命必备。'),

  academy('mine', '采矿与资源获取', 'I_dD4I-zHlw', 'mining', '采矿入门：找矿、采矿、出售或提炼。'),
  g('mine', 'EVE Online 挖矿攻略：新手必知的七大经验', 'B 站专栏', 'zh', 'text', '2022-09', 'https://www.bilibili.com/opus/701181663484313606', '先做探索 / 采矿章节拿采矿船、用测量扫描看矿量、按货舱总价值选矿等。'),
  g('mine', '资源采集：矿石成分与提炼表', 'BWIKI', 'zh', 'text', '', BWIKI + '%E8%B5%84%E6%BA%90%E9%87%87%E9%9B%86', '各种矿石的矿物成分和提炼产出。'),
  uni('mine', '采矿', 'Mining', '采矿船、技能、矿石分布与采矿流程。'),
  uni('mine', '冰矿采集', 'Ice_harvesting', '冰矿带、采冰装备与产出用途。'),
  uni('mine', '气云采集', 'Gas_cloud_harvesting', '气云种类、位置（含虫洞）与采集装备。'),
  uni('mine', '赚钱方式汇总', 'Making_Money', '各种赚 ISK 的方式与门槛对比。'),

  g('pve', '执法者（PvE）路线', 'EVE 官方', 'zh', 'text', '', ACADEMY + '/careers/enforcer', '官方中文：任务、刷怪等 PvE 玩法的入门路线。'),
  academy('pve', '任务入门', 'OU9lrxsE4uM', 'missions', '代理人任务怎么找、怎么接、怎么完成。'),
  g('pve', 'ESS 的那些事', 'B 站 · 小珅的EVE之旅', 'zh', 'video', '2021-10', BV + 'BV1KT4y1d7uG/', '00 刷怪绕不开的 ESS（赏金储存装置）机制讲解。'),
  g('pve', '非月卡账号如何月入百亿（仅供参考）', 'B 站 · 了空上人', 'zh', 'video', '2023-06', BV + 'BV17c41137Q7/', 'Alpha 号的刷怪赚钱思路。'),
  g('pve', '6 级异常集会点战斗参考', 'B 站 · 了空上人', 'zh', 'video', '2022-09', BV + 'BV148411t71R/', '异常刷怪实战录像（曙光服），可参考打法。'),
  g('pve', '宁静服深渊收益简报', 'B 站专栏', 'zh', 'text', '2024-08', 'https://www.bilibili.com/opus/964384191376523297', '按深渊等级统计的收益区间，打深渊前心里有数。'),
  g('pve', '战斗玩法', 'BWIKI', 'zh', 'text', '', BWIKI + '%E6%88%98%E6%96%97%E7%8E%A9%E6%B3%95', '任务、异常、死亡空间、深渊、萨沙入侵等战斗玩法概览。'),
  uni('pve', '任务', 'Missions', '代理人任务的类型、等级与声望。'),
  uni('pve', '刷怪', 'Ratting', '小行星带和异常刷怪。'),
  uni('pve', '深渊', 'Abyssals', '深渊的规则、天气、等级与推荐舰船。'),
  uni('pve', '入侵', 'Incursions', '萨沙入侵：组队刷高收益的舰队玩法。'),

  g('explore', '探险家路线', 'EVE 官方', 'zh', 'text', '', ACADEMY + '/careers/explorer', '官方中文：扫描、破解、探索的入门路线和配装。'),
  academy('explore', '扫描宇宙信号', 'Ieo3WAvH4yU', 'scanning', '探针扫描器的用法，一步步把信号扫出来。'),
  academy('explore', '破解赚钱', 'asKp78zRZGY', 'hacking', '数据 / 遗迹站点的破解小游戏和收益。'),
  g('explore', '新手扫描教程', 'B 站 · 零-zer0', 'zh', 'video', '2022-05', BV + 'BV1DR4y1c7mj/', '探针扫描从零开始的操作演示。'),
  g('explore', '探索', 'BWIKI', 'zh', 'text', '', BWIKI + '%E6%8E%A2%E7%B4%A2', '探索玩法概念、探针与分析仪等必备装备。'),
  uni('explore', '探索', 'Exploration', '探索站点种类、收益与风险。'),
  uni('explore', '简明探针扫描步骤', 'Probing_In_Simple_Steps', '一步步教你把信号扫到 100%。'),
  uni('explore', '扫描', 'Scanning', '扫描相关技能、装备与各类扫描器。'),
  uni('explore', '破解', 'Hacking', '破解小游戏的规则与技巧。'),

  academy('wh', '虫洞基础', 'aldoiHE6O04', 'wormhole-basics', '虫洞是什么、怎么找、怎么判断能不能过、进去后怎么活下来。'),
  academy('wh', '虫洞战斗', 'yiWy2ehcc1o', 'wormhole-combat', '虫洞里的战斗站点和刷怪要点。'),
  g('wh', '虫洞', 'BWIKI', 'zh', 'text', '', BWIKI + '%E8%99%AB%E6%B4%9E', 'C1–C6 分级、本地不显示人数、席拉与碎裂虫洞等特殊星系。'),
  uni('wh', '虫洞', 'Wormholes', '虫洞机制最全的参考：质量、寿命、洞口类型、居住。'),
  g('wh', '虫洞“猖獗无人机巢穴”重做速览', 'B 站 · BeliEVE76', 'zh', 'video', '2026-07', BV + 'BV1BQgt6qEzW/', '近期改版后的新波次、掉落和收益。'),

  g('industry', '工业家路线', 'EVE 官方', 'zh', 'text', '', ACADEMY + '/careers/industrialist', '官方中文：采矿、制造、行星开发的入门路线。'),
  academy('industry', '基础工业生产', 'TGGKpe6MYrQ', 'industry', '蓝图、材料、工业窗口，造出第一件东西。'),
  academy('industry', '发明与 T2 生产', 'p0exyST_TDY', 'invention', '用 T1 蓝图拷贝发明 T2 蓝图，再生产 T2 物品。'),
  g('industry', '【EVE新人教程2022】工业家 - 制造商任务全流程', 'B 站 · EVE欧服玉麒麟联盟', 'zh', 'video', '2022-06', BV + 'BV1jY411M7Dt/', '工业生涯代理人任务一步步做完，顺便学会制造。'),
  g('industry', '【eve新手教学】制造流程、心得', 'B 站 · Baka_sbk', 'zh', 'video', '2016-08', BV + 'BV14s411C7d6/', '制造流程讲解。版本很旧，界面已变，思路可参考。'),
  g('industry', 'EVE 新手种菜教学（6 分钟包学会）', 'B 站 · Ezekiel_WarGod', 'zh', 'video', '2023-07', BV + 'BV1Dm4y177Z7/', '行星开发（种菜）快速上手。'),
  g('industry', '新手教程（7）：如何进行行星开发（种菜）', 'B 站专栏', 'zh', 'text', '', 'https://www.bilibili.com/read/cv6093172/', '图文讲解行星开发的建设和生产流程。'),
  g('industry', '生产贸易', 'BWIKI', 'zh', 'text', '', BWIKI + '%E7%94%9F%E4%BA%A7%E8%B4%B8%E6%98%93', '制造、发明、保险等生产相关说明。'),
  uni('industry', '工业', 'Industry', '制造、研究、蓝图与工业建筑。'),
  uni('industry', '发明', 'Invention', 'T1 蓝图拷贝发明 T2、数据核心与解码器。'),
  uni('industry', '行星开发', 'Planetary_Industry', '行星类型、资源、设施布局与产品链。'),

  academy('trade', '贸易赚钱', 'xTNrEqmjqmw', 'trading', '市场窗口、买单卖单和低买高卖的基本思路。'),
  g('trade', 'EVE 商人基本课', 'B 站 · 祖祖Limor', 'zh', 'video', '2023-08', BV + 'BV1zu411N7d7/', '市场买卖、挂单与倒卖的基础课。'),
  g('trade', 'EVE Online 新手教程：赚钱与投资思路', 'B 站 · EVE小课堂', 'zh', 'video', '2023-08', BV + 'BV1dh4y1r7w4/', '老玩家讲的赚钱、投资思路。'),
  uni('trade', '贸易', 'Trading', '订单、税费、贸易中心、跨星域贸易。'),
  uni('trade', '贸易入门课', 'Trade_(CORE_class)', '面向新人的贸易课程大纲：市场窗口、买卖单、合同。'),
  uni('trade', '运输', 'Hauling', '运输舰、快递合同与安全运输。'),

  g('pvp', '自由战士（PvP）路线', 'EVE 官方', 'zh', 'text', '', ACADEMY + '/careers/soldier-of-fortune', '官方中文：PvP 入门路线与配装。'),
  academy('pvp', '如何找军团', 'optDBEeT0C0', 'find-corp', '军团能给你什么、去哪里找、怎么挑。'),
  g('pvp', '天山军校 新人 PVP 入门：狂怒者级', 'B 站 · 天山以北EVE', 'zh', 'video', '2019-04', BV + 'BV1jb411u7eo/', '新人 PVP 系列，狂怒者级配置与使用。版本较旧。'),
  g('pvp', '天山军校 新人 PVP 入门：狞獾与小托', 'B 站 · 天山以北EVE', 'zh', 'video', '2019-04', BV + 'BV17b411K7eQ/', '同系列，护卫舰 / 驱逐舰入门 PVP。'),
  uni('pvp', 'PvP 入门', 'PvP', '从便宜船练起：拦截、近战与风筝、看击毁报告复盘。'),
  uni('pvp', '势力战争', 'Faction_Warfare', '加入势力民兵、争夺低安星系的规则与收益。'),
  uni('pvp', '公开舰队', 'Public_fleets', '新人也能跟的公开 PvP 舰队。'),
  uni('pvp', '找军团', 'Find_a_Corporation', '怎么挑选适合自己的军团。'),

  g('wiki', 'EVE University Wiki', 'EVE University', 'en', 'text', '', UNI + 'Main_Page', '最全的 EVE 英文百科，几乎所有机制都能查到。本站翻译了其中的入门文章。'),
  uni('wiki', 'EVE University 课程库', 'Class_Library', '历次公开课录像目录，按主题分类。'),
  g('wiki', 'EVE Academy 视频合集（YouTube）', 'EVE 官方 · YouTube', 'en', 'video', '', 'https://www.youtube.com/playlist?list=PLQvKSs1k6DLOwda12n4xtM6R-6tKZHYvA', '官方教学视频播放列表。其中 13 个教学视频本站已配中文字幕，分在各分类里。'),
  g('wiki', 'EVE 星战前夜 BWIKI', 'BWIKI', 'zh', 'text', '', BWIKI + '%E9%A6%96%E9%A1%B5', 'B 站玩家维护的中文端游百科。'),
  g('wiki', 'EVE Online（萌娘百科）', '萌娘百科', 'zh', 'text', '', 'https://zh.moegirl.org.cn/EVE_Online', '游戏背景、世界观与国服代理历史。')
];

const S = { q: '', kind: '', origin: '', cat: '', lang: 'zh', index: null, doc: null, listScroll: 0 };
const docs = new Map();
const KIND = { video: '视频', text: '图文' };
const ICON = {
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="m17 10 5-3v10l-5-3z"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
  all: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/></svg>'
};
const LANGS = [['zh', '中文'], ['en', 'English'], ['both', '对照']];

export function initGuides(context) {
  ctx = context;
  try { const v = localStorage.getItem(LANG_KEY); if (LANGS.some(([k]) => k === v)) S.lang = v; } catch { /* 无痕模式等 */ }
}

async function loadIndex() {
  if (S.index) return S.index;
  try {
    const r = await fetch('guides/index.json?v=3');
    S.index = r.ok ? await r.json() : {};
  } catch { S.index = {}; }
  return S.index;
}

async function loadDoc(id) {
  if (!docs.has(id)) {
    docs.set(id, fetch(`guides/${id}.json?v=3`).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch((e) => { docs.delete(id); throw e; }));
  }
  return docs.get(id);
}

// ---------- 安全输出：只保留 <b> <i> <code> <a href="https://…"> ----------
const tpl = document.createElement('template');
function safe(html) {
  if (!html) return '';
  tpl.innerHTML = html;
  const walk = (node) => [...node.childNodes].map((c) => {
    if (c.nodeType === 3) return ctx.esc(c.nodeValue);
    if (c.nodeType !== 1) return '';
    const inner = walk(c), tag = c.tagName.toLowerCase();
    if (tag === 'b' || tag === 'i' || tag === 'code') return `<${tag}>${inner}</${tag}>`;
    if (tag === 'a') {
      const href = c.getAttribute('href') || '';
      return /^https:\/\//.test(href) ? `<a href="${ctx.esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
    }
    return inner;
  }).join('');
  return walk(tpl.content);
}
const plain = (html) => { tpl.innerHTML = html || ''; return tpl.content.textContent; };

// ---------- 列表 ----------
const titleEn = (x) => (x.doc && S.index?.[x.doc]?.en) || '';
function matches(x) {
  if (S.kind && x.kind !== S.kind) return false;
  if (S.origin === 'zh' && x.lang !== 'zh') return false;
  if (S.origin === 'tr' && !x.doc) return false;
  if (!S.q) return true;
  return (x.title + ' ' + titleEn(x) + ' ' + x.src + ' ' + x.desc).toLowerCase().includes(S.q);
}

function cardTitle(x) {
  const en = titleEn(x);
  if (!en) return ctx.esc(x.title);
  if (S.lang === 'en') return ctx.esc(en);
  if (S.lang === 'both') return `${ctx.esc(x.title)}<span class="guide-title-en">${ctx.esc(en)}</span>`;
  return ctx.esc(x.title);
}

function metaLine(x) {
  const info = x.doc && S.index?.[x.doc];
  const extra = info ? (info.dur ? `${Math.max(1, Math.round(info.dur / 60))} 分钟` : `约 ${Math.max(1, Math.round(info.w / 400))} 分钟读完`) : x.date;
  return ctx.esc(x.src) + (extra ? ' · ' + ctx.esc(extra) : '');
}

function card(x) {
  const inSite = Boolean(x.doc);
  const badge = inSite ? `<span class="guide-lang tr">${x.kind === 'video' ? '中文字幕' : '中文译文'}</span>` : `<span class="guide-lang ${x.lang}">${x.lang === 'zh' ? '中文' : '英文'}</span>`;
  const attrs = inSite ? `href="#guide/read/${x.doc}" data-guide-read="${x.doc}"` : `href="${ctx.esc(x.url)}" target="_blank" rel="noopener noreferrer"`;
  return `<a class="guide-card${inSite ? ' in-site' : ''}" ${attrs}>
    <div class="guide-card-head"><span class="guide-kind ${x.kind}">${ICON[x.kind]}${KIND[x.kind]}</span>${badge}${inSite ? '' : ICON.out}</div>
    <strong class="guide-title">${cardTitle(x)}</strong>
    <p class="guide-desc">${ctx.esc(x.desc)}</p>
    <small class="guide-src">${metaLine(x)}</small></a>`;
}

function renderSide() {
  const list = GUIDES.filter(matches);
  const count = (c) => list.filter((x) => x.cat === c).length;
  const seg = (key, cur, opts) => `<div class="segmented guide-seg" role="group">${opts.map(([v, l]) => `<button type="button" data-guide-${key}="${v}" class="${cur === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const item = (k, name, n) => `<button type="button" class="ind-side-item${!S.doc && S.cat === k ? ' active' : ''}" data-guide-cat="${k}"${n ? '' : ' disabled'}><span>${name}</span><small>${n}</small></button>`;
  $('guideSide').innerHTML =
    `<div class="ind-side-section"><h4>分类</h4>${item('', '全部教程', list.length)}${CATS.map(([k, name]) => item(k, name, count(k))).join('')}</div>
    <div class="ind-side-section guide-side-filters"><h4>筛选</h4>
      ${seg('kind', S.kind, [['', '全部'], ['video', '视频'], ['text', '图文']])}
      ${seg('origin', S.origin, [['', '全部'], ['zh', '中文原创'], ['tr', '英文译文']])}</div>
    <div class="ind-side-section guide-side-filters"><h4>译文阅读语言</h4>${seg('lang', S.lang, LANGS)}
      <p class="ind-side-empty">英文资料已全文翻译，可在中文、英文原文、中英对照之间切换。</p></div>`;
}

function renderList() {
  const list = GUIDES.filter(matches);
  const cats = CATS.filter(([k]) => !S.cat || S.cat === k);
  const cur = CATS.find(([k]) => k === S.cat);
  const head = `<div class="pi-head guide-head"><h2>${cur ? cur[1] : '教程'}</h2><span class="text-muted guide-sub">${cur ? cur[2] : '精选 EVE 教程，按玩法分类。英文资料已全文翻译成中文，站内阅读；中文资料点开在新标签页打开原文'}</span></div>`;
  const body = cats.map(([k, name, intro]) => {
    const items = list.filter((x) => x.cat === k);
    if (!items.length) return '';
    return `<section class="guide-section">${S.cat ? '' : `<div class="guide-section-head"><h3>${name}</h3><span class="text-muted">${intro}</span></div>`}
      <div class="guide-grid">${items.map(card).join('')}</div></section>`;
  }).join('');
  $('guideMain').innerHTML = `<section class="pi-page guide-page">${head}${body || '<p class="legend-empty">没有符合条件的教程</p>'}
    <p class="text-muted valuation-note">中文资料来自 EVE 官方新伊甸学院、B 站 BWIKI 和 B 站 UP 主，版权归原作者。英文文章译自 EVE University Wiki（CC BY-SA 4.0），视频字幕译自 EVE Academy 官方视频，译文由本站翻译，可能有疏漏，以原文为准。B 站视频标了发布日期，较早的视频里界面和数值可能已经变了。</p></section>`;
}

// ---------- 阅读器 ----------
const pickText = (b, lang) => (lang === 'en' ? b.en : (b.zh ?? b.en));
// 中文 / English / 对照：对照时中文在上、英文原文在下
function dual(b, render) {
  if (S.lang === 'both') return render(b.zh ?? b.en, '') + (b.zh && b.zh !== b.en ? render(b.en, 'guide-en') : '');
  return render(pickText(b, S.lang), '');
}
function cellHtml(zh, en) {
  if (S.lang === 'en') return safe(en);
  if (S.lang === 'both' && zh && zh !== en) return `${safe(zh)}<div class="guide-en">${safe(en)}</div>`;
  return safe(zh ?? en);
}

// 扁平的 [深度] 列表还原为嵌套 <ul> / <ol>
function listHtml(b) {
  const zh = b.zh || [], d = b.d || [];
  const stack = [];   // 已打开的列表标签；每层都有一个未闭合的 <li>
  let html = '';
  b.en.forEach((en, i) => {
    const lvl = Math.min(d[i] || 0, stack.length);
    if (lvl === stack.length) { const tag = lvl ? 'ul' : b.t; html += `<${tag}>`; stack.push(tag); }
    else { html += '</li>'; while (stack.length - 1 > lvl) html += `</${stack.pop()}></li>`; }
    html += `<li>${cellHtml(zh[i], en)}`;
  });
  while (stack.length) html += `</li></${stack.pop()}>`;
  return html;
}

function blockHtml(b, i) {
  switch (b.t) {
    case 'h2': case 'h3': case 'h4':
      return `<${b.t} id="gh-${i}">${S.lang === 'both' && b.zh && b.zh !== b.en ? `${safe(b.zh)}<span class="guide-en">${safe(b.en)}</span>` : safe(pickText(b, S.lang))}</${b.t}>`;
    case 'p': return dual(b, (t, cls) => `<p${cls ? ` class="${cls}"` : ''}>${safe(t)}</p>`);
    case 'quote': return `<div class="guide-note">${dual(b, (t, cls) => `<p${cls ? ` class="${cls}"` : ''}>${safe(t)}</p>`)}</div>`;
    case 'ul': case 'ol': return listHtml(b);
    case 'table': {
      const zh = b.zh || [];
      // 原站的提示框是「图标 + 文字」两列表，按提示框显示
      if (b.en.every((r) => r.length === 2 && !plain(r[0]).trim())) {
        return `<div class="guide-note">${b.en.map((r, ri) => dual({ en: r[1], zh: zh[ri]?.[1] }, (t, cls) => `<p${cls ? ` class="${cls}"` : ''}>${safe(t)}</p>`)).join('')}</div>`;
      }
      const rows = b.en.map((r, ri) => {
        const tag = b.hr?.[ri] ? 'th' : 'td';
        return `<tr>${r.map((c, ci) => `<${tag}>${cellHtml(zh[ri]?.[ci], c)}</${tag}>`).join('')}</tr>`;
      }).join('');
      return `<div class="table-scroll guide-table-wrap"><table class="guide-table">${rows}</table></div>`;
    }
    case 'img':
      return `<figure class="guide-fig"><img src="${ctx.esc(b.src)}" alt="" loading="lazy" referrerpolicy="no-referrer">${b.en ? `<figcaption>${cellHtml(b.zh, b.en)}</figcaption>` : ''}</figure>`;
    default: return '';
  }
}

function docTitle(doc) {
  const zh = doc.title.zh || doc.title.en;
  if (S.lang === 'en') return ctx.esc(doc.title.en);
  if (S.lang === 'both' && zh !== doc.title.en) return `${ctx.esc(zh)}<span class="guide-title-en">${ctx.esc(doc.title.en)}</span>`;
  return ctx.esc(zh);
}

function renderArticleBody(doc) {
  const heads = doc.blocks.map((b, i) => [b, i]).filter(([b]) => b.t === 'h2' || b.t === 'h3');
  const toc = heads.length >= 3 ? `<nav class="guide-toc" aria-label="目录"><h4>目录</h4>${heads.map(([b, i]) =>
    `<button type="button" class="${b.t}" data-guide-toc="${i}">${ctx.esc(plain(S.lang === 'en' ? b.en : (b.zh ?? b.en)))}</button>`).join('')}</nav>` : '';
  $('guideDocBody').innerHTML = `<div class="guide-article-layout${toc ? '' : ' no-toc'}"><article class="guide-article">${doc.blocks.map(blockHtml).join('')}</article>${toc}</div>`;
}

// ---------- 视频：YouTube 播放器 + 同步中文字幕 ----------
const V = { player: null, timer: 0, cue: -1, doc: null, follow: true };
let ytApi = null;
function loadYouTube() {
  if (window.YT?.Player) return Promise.resolve();
  if (!ytApi) {
    ytApi = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => reject(new Error('YouTube 无法访问'));
      document.head.appendChild(s);
      setTimeout(() => reject(new Error('YouTube 加载超时')), 15000);
    }).catch((e) => { ytApi = null; throw e; });
  }
  return ytApi;
}

function stopVideo() {
  clearInterval(V.timer);
  V.timer = 0;
  try { V.player?.destroy(); } catch { /* 播放器未就绪 */ }
  V.player = null; V.cue = -1; V.doc = null;
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function capHtml(b) {
  if (!b) return '';
  if (S.lang === 'en') return `<span>${ctx.esc(b.en)}</span>`;
  if (S.lang === 'both') return `<span>${ctx.esc(b.zh ?? b.en)}</span><span class="guide-cap-en">${ctx.esc(b.en)}</span>`;
  return `<span>${ctx.esc(b.zh ?? b.en)}</span>`;
}

function renderTranscript(doc) {
  $('guideDocBody').innerHTML = `<div class="guide-transcript-head"><h3>字幕稿</h3><label class="guide-follow"><input type="checkbox" data-guide-follow${V.follow ? ' checked' : ''}> 跟随播放滚动</label></div>
    <ol class="guide-transcript" id="guideTranscript">${doc.blocks.map((b, i) => `<li data-guide-cue="${i}" class="${i === V.cue ? 'active' : ''}"><time>${fmtTime(b.s)}</time><div>${S.lang === 'en' ? ctx.esc(b.en) : S.lang === 'both' ? `${ctx.esc(b.zh ?? b.en)}<span class="guide-en">${ctx.esc(b.en)}</span>` : ctx.esc(b.zh ?? b.en)}</div></li>`).join('')}</ol>`;
  $('guideCap').innerHTML = capHtml(doc.blocks[V.cue]);
}

function tick() {
  if (!V.player?.getCurrentTime || !V.doc) return;
  if ($('guideView').hidden) { try { V.player.pauseVideo(); } catch { /* 忽略 */ } return; }   // 切到别的页面时暂停
  const t = V.player.getCurrentTime();
  const cues = V.doc.blocks;
  let idx = -1;
  for (let i = 0; i < cues.length; i++) { if (cues[i].s <= t + 0.05) { if (t < cues[i].e + 0.3) idx = i; } else break; }
  if (idx === V.cue) return;
  V.cue = idx;
  $('guideCap').innerHTML = capHtml(cues[idx]);
  const list = $('guideTranscript');
  list?.querySelector('li.active')?.classList.remove('active');
  const li = idx >= 0 ? list?.querySelector(`li[data-guide-cue="${idx}"]`) : null;
  if (li) {
    li.classList.add('active');
    if (V.follow) list.scrollTo({ top: li.offsetTop - list.clientHeight / 3, behavior: 'smooth' });
  }
}

function hideYtCaptions() {
  try {
    V.player.setOption('captions', 'track', {});
    V.player.unloadModule('captions');
    V.player.unloadModule('cc');
  } catch { /* 播放器未就绪 */ }
}

async function startVideo(doc) {
  stopVideo();
  V.doc = doc;
  try {
    await loadYouTube();
    if (S.doc !== doc) return;
    V.player = new window.YT.Player('guideYt', {
      videoId: doc.yt,
      playerVars: { rel: 0, modestbranding: 1, cc_load_policy: 0, playsinline: 1 },
      events: {
        onReady: () => { V.timer = setInterval(tick, 200); },
        // 关掉 YouTube 自带字幕（有的账号 / 浏览器设置会自动打开），只显示本站字幕；字幕模块在开始播放后才加载
        onApiChange: hideYtCaptions,
        onStateChange: (e) => { if (e.data === 1) hideYtCaptions(); }
      }
    });
  } catch (e) {
    const box = $('guideYt');
    if (box) box.outerHTML = `<div class="guide-yt-fail"><p>视频无法加载（${ctx.esc(e.message)}）。YouTube 在部分网络环境下无法访问，可以直接阅读下方的中文字幕稿，或<a href="${ctx.esc(doc.url)}" target="_blank" rel="noopener noreferrer">在 YouTube 打开</a>。</p></div>`;
  }
}

async function renderReader(id) {
  const main = $('guideMain');
  const entry = GUIDES.find((x) => x.doc === id);
  main.innerHTML = `<section class="pi-page guide-page guide-reader"><div class="guide-reader-bar">
      <button type="button" class="btn btn-ghost guide-back" data-guide-back>${ICON.back}返回${entry ? ' · ' + ctx.esc(CATS.find(([k]) => k === entry.cat)[1]) : ''}</button>
      <span class="toolbar-spacer"></span>
      <div class="segmented" role="group" aria-label="阅读语言">${LANGS.map(([v, l]) => `<button type="button" data-guide-lang="${v}" class="${S.lang === v ? 'active' : ''}">${l}</button>`).join('')}</div></div>
    <div id="guideDocHead"></div><div id="guideDocBody"><p class="legend-empty">加载中…</p></div></section>`;
  let doc;
  try { doc = await loadDoc(id); } catch (e) {
    $('guideDocBody').innerHTML = `<p class="legend-empty">译文加载失败：${ctx.esc(e.message)}${entry ? `，可以<a href="${ctx.esc(entry.url)}" target="_blank" rel="noopener noreferrer">阅读原文</a>` : ''}</p>`;
    return;
  }
  if (!location.hash.startsWith('#guide/read/' + id)) return;
  S.doc = doc;
  const video = Boolean(doc.yt);
  $('guideDocHead').innerHTML = `<h1 class="guide-doc-title" id="guideDocTitle">${docTitle(doc)}</h1>
    <p class="guide-doc-meta">${ctx.esc(doc.source)} · ${video ? '英文配音，中文字幕由本站翻译' : '本站翻译'} · ${ctx.esc(doc.license)} · <a href="${ctx.esc(doc.url)}" target="_blank" rel="noopener noreferrer">${video ? '在 YouTube 观看' : '查看英文原文'}${ICON.out}</a></p>
    ${video ? '<div class="guide-video"><div id="guideYt"></div><div class="guide-cap" id="guideCap" aria-live="off"></div></div>' : ''}`;
  if (video) { renderTranscript(doc); startVideo(doc); } else renderArticleBody(doc);
}

function refreshReaderLang() {
  const doc = S.doc;
  if (!doc) return;
  document.querySelectorAll('#guideMain [data-guide-lang]').forEach((b) => b.classList.toggle('active', b.dataset.guideLang === S.lang));
  $('guideDocTitle').innerHTML = docTitle(doc);
  if (doc.yt) renderTranscript(doc); else renderArticleBody(doc);
}

// ---------- 路由与事件 ----------
function scroller() { return $('guideMain').closest('.kb-scroll'); }

function navigate(hash, push = true) {
  if (location.hash !== hash) history[push ? 'pushState' : 'replaceState'](null, '', location.pathname + hash);
  showGuides(hash);
}

function setLang(v) {
  S.lang = v;
  try { localStorage.setItem(LANG_KEY, v); } catch { /* 无痕模式等 */ }
  renderSide();
  if (S.doc) refreshReaderLang(); else renderList();
}

function bind() {
  const view = $('guideView');
  view.addEventListener('click', (e) => {
    const read = e.target.closest('[data-guide-read]');
    if (read && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      S.listScroll = scroller().scrollTop;
      S.fromList = true;
      navigate('#guide/read/' + read.dataset.guideRead);
      ctx.closeDrawer?.();
      return;
    }
    const c = e.target.closest('[data-guide-cat]');
    if (c) { S.fromList = false; navigate('#guide' + (c.dataset.guideCat ? '/' + c.dataset.guideCat : ''), Boolean(S.doc)); scroller().scrollTop = 0; ctx.closeDrawer?.(); return; }
    if (e.target.closest('[data-guide-back]')) {
      // 从列表点进来的直接后退（回到原来的列表和滚动位置），分享链接直接打开的回到所属分类
      if (S.fromList) history.back();
      else navigate('#guide' + (S.cat ? '/' + S.cat : ''));
      return;
    }
    const k = e.target.closest('[data-guide-kind]');
    if (k) { S.kind = k.dataset.guideKind; renderSide(); if (!S.doc) renderList(); return; }
    const o = e.target.closest('[data-guide-origin]');
    if (o) { S.origin = o.dataset.guideOrigin; renderSide(); if (!S.doc) renderList(); return; }
    const l = e.target.closest('[data-guide-lang]');
    if (l) { setLang(l.dataset.guideLang); return; }
    const toc = e.target.closest('[data-guide-toc]');
    if (toc) { $('gh-' + toc.dataset.guideToc)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const cue = e.target.closest('[data-guide-cue]');
    if (cue && V.player?.seekTo && V.doc) { V.player.seekTo(V.doc.blocks[Number(cue.dataset.guideCue)].s, true); V.player.playVideo(); }
  });
  view.addEventListener('change', (e) => { if (e.target.matches('[data-guide-follow]')) V.follow = e.target.checked; });
  const input = $('guideSearch');
  input.addEventListener('input', ctx.debounce(() => {
    S.q = input.value.trim().toLowerCase();
    renderSide();
    if (S.doc) navigate('#guide' + (S.cat ? '/' + S.cat : '')); else renderList();
  }, 150));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; S.q = ''; renderSide(); if (!S.doc) renderList(); } });
}

export async function showGuides(hash) {
  const main = $('guideMain');
  if (!main.dataset.ready) { main.dataset.ready = '1'; bind(); }
  await loadIndex();
  const read = /^#guide\/read\/([\w-]+)/.exec(hash || '');
  if (read) {
    if (S.doc?.id === read[1] && main.querySelector('.guide-reader')) return;
    stopVideo();
    S.doc = null;
    const entry = GUIDES.find((x) => x.doc === read[1]);
    if (entry) S.cat = entry.cat;
    renderSide();
    scroller().scrollTop = 0;
    await renderReader(read[1]);
    return;
  }
  const wasReading = Boolean(S.doc) && S.fromList;
  stopVideo();
  S.doc = null;
  S.fromList = false;
  const m = /^#guide\/(\w+)/.exec(hash || '');
  S.cat = m && CATS.some(([k]) => k === m[1]) ? m[1] : '';
  renderSide();
  renderList();
  if (wasReading) requestAnimationFrame(() => { scroller().scrollTop = S.listScroll; });
}
