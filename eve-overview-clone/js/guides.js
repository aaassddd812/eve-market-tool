// 教程：图文 Wiki + 视频
// - 图文 Wiki：资料全文收录在 guides/<id>.json，站内阅读，每篇标注出处和许可
//   · 中文原文：新伊甸学院（EVE 官方）、EVE 星战前夜 BWIKI、萌娘百科
//   · 英文原文：EVE University Wiki，本站全文翻译，可切换中文 / English / 对照
//   guides/index.json 是文章目录：{id: {zh, en, c: 分类, g: 小组, s: 来源, m: 阅读分钟, d: 摘要}}
// - 视频：站内嵌入 B 站 / YouTube 播放器，附原视频链接；EVE Academy 官方视频带本站翻译的中文字幕（guides/academy-*.json）
// 收录时逐条打开核对过（2026-10）；B 站视频注明发布日期，旧视频的界面和数值可能和现在不同

let ctx = null;
const $ = (id) => document.getElementById(id);
const LANG_KEY = 'eve-guide-lang';

// Wiki 分类：[key, 名称, 说明]
const CATS = [
  ['start', '新手入门', '建号、新手任务、生涯代理人、Alpha / Omega、技能与安全等级'],
  ['ship', '舰船与装配', '舰船分类、装配、飞行与战斗机制、总览与定向扫描'],
  ['mine', '采矿与采集', '矿石、冰矿、气云与提炼'],
  ['pve', '任务与刷怪', '代理人任务、刷怪、异常、死亡空间、深渊、入侵'],
  ['explore', '探索与扫描', '探针扫描、数据 / 遗迹站点破解'],
  ['wh', '虫洞', '虫洞等级、进出与生存、虫洞站点'],
  ['industry', '工业与行星开发', '制造、发明、行星开发（种菜）'],
  ['trade', '贸易与运输', '市场买卖、倒卖、运输与合同'],
  ['pvp', 'PVP 与军团', 'PVP 入门、势力战争、舰队、军团与主权'],
  ['lore', '背景与资料', '世界观、势力、星域、游戏历史与其他资料']
];

// 来源：index 里的 s 字段
const SRC = {
  nea: ['新伊甸学院', 'EVE 官方中文新手站'],
  bw: ['BWIKI', 'B 站玩家维护的中文 EVE 百科'],
  moe: ['萌娘百科', '中文综合百科'],
  uni: ['EVE University', '英文 EVE 百科，本站翻译'],
  site: ['本站整理', '玩家经验摘要']
};

// 视频分类
const VCATS = [
  ['start', '新手入门'],
  ['ship', '舰船与装配'],
  ['pve', '任务与刷怪'],
  ['explore', '探索与虫洞'],
  ['industry', '采矿与工业'],
  ['trade', '贸易与赚钱'],
  ['pvp', 'PVP 与军团']
];

// { cat, p: bili / yt, id: BV 号或 YouTube id, title, up, date, dur: 秒, pic: 封面, desc, doc: 中文字幕 }
const bili = (cat, id, title, up, date, dur, pic, desc) => ({ cat, p: 'bili', id, title, up, date, dur, pic: 'https://' + pic, desc });
// EVE Academy 官方教学视频：英文配音，本站翻译中文字幕
const academy = (cat, id, doc, title, desc) => ({ cat, p: 'yt', id, title, up: 'EVE Online 官方 · EVE Academy', date: '', dur: 0, pic: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, desc, doc: 'academy-' + doc });
const VIDEOS = [
  academy('start', 'bZRcJ3p8dTE', 'epic-arc', '开始史诗任务线', '新手任务之后，怎么接史诗任务线、能拿到什么。'),
  academy('start', 'DS1EnO1iJp4', 'security-status', '了解安全等级', '星系安全等级与个人安全等级：高安、低安、00 各有什么规则和风险。'),
  bili('start', 'BV1xx411M7va', '简单EVE 新手教程篇 1：建号与新手任务', 'L3-猛汉猎人', '2017-10', 2159, 'i0.hdslb.com/bfs/archive/c5c204d23ca20e26fd79f0f05cfc19a55c2d8a3b.png', '系列第一期，讲建号、选阵营和新手任务。版本较旧，新手任务流程已改过，作思路参考。'),
  bili('start', 'BV1qN411B7pk', '【EVE欧服】快速上手 EVE 的实用配置和建议', '祖祖Limor', '2023-08', 1045, 'i0.hdslb.com/bfs/archive/8b3dfcf59ba1d70ccdf229cb1eaad76159bea12b.jpg', '客户端设置、界面布局等上手配置，以及给新人的建议。'),
  bili('start', 'BV1TS4y1n7jQ', '【EVE新人必看技巧】新手常用邮件列表', 'EVE欧服玉麒麟联盟', '2022-07', 922, 'i1.hdslb.com/bfs/archive/a320e7dbe27d13bb40b4005e5f2e06ffb0248077.jpg', '怎么加入和使用新手常用的邮件列表。'),

  academy('ship', 'ArCI4bi9Eyg', 'fitting', '舰船装配', '装配窗口、CPU 与能量栅格、高中低槽怎么搭配。'),
  bili('ship', 'BV1bZ4y1L7Ge', '托勒克斯级配置思路详解', '合辰JEX', '2020-10', 1295, 'i1.hdslb.com/bfs/archive/fe52f209bdb55cff16cc6eea497a9c5b078d601b.jpg', '以一艘船为例讲配船思路（团内单挑赛冠军配置），适合学怎么自己配船。'),

  academy('pve', 'OU9lrxsE4uM', 'missions', '任务入门', '代理人任务怎么找、怎么接、怎么完成。'),
  bili('pve', 'BV1KT4y1d7uG', 'ESS 的那些事', '小珅的EVE之旅', '2021-10', 2759, 'i0.hdslb.com/bfs/archive/26377c7da9bf0df4439d5acf03a0f8828de7aac4.jpg', '00 刷怪绕不开的 ESS（赏金储存装置）机制讲解。'),
  bili('pve', 'BV17c41137Q7', '非月卡账号如何月入百亿（仅供参考）', '了空上人', '2023-06', 727, 'i1.hdslb.com/bfs/archive/54113a63c5ba8ffcda9465ad3fe90a6b6668221b.jpg', 'Alpha 号的刷怪赚钱思路。'),
  bili('pve', 'BV148411t71R', '6 级异常集会点战斗参考', '了空上人', '2022-09', 414, 'i2.hdslb.com/bfs/archive/2bd7be9ab2d761af14ab6dc64ae74253c0309f50.jpg', '异常刷怪实战录像（曙光服），可参考打法。'),

  academy('explore', 'Ieo3WAvH4yU', 'scanning', '扫描宇宙信号', '探针扫描器的用法，一步步把信号扫出来。'),
  academy('explore', 'asKp78zRZGY', 'hacking', '破解赚钱', '数据 / 遗迹站点的破解小游戏和收益。'),
  bili('explore', 'BV1DR4y1c7mj', '新手扫描教程', '零-zer0', '2022-05', 1368, 'i1.hdslb.com/bfs/archive/bf2b653ce8451aa599303d920bfa000645269424.jpg', '探针扫描从零开始的操作演示。'),
  academy('explore', 'aldoiHE6O04', 'wormhole-basics', '虫洞基础', '虫洞是什么、怎么找、怎么判断能不能过、进去后怎么活下来。'),
  academy('explore', 'yiWy2ehcc1o', 'wormhole-combat', '虫洞战斗', '虫洞里的战斗站点和刷怪要点。'),
  bili('explore', 'BV1BQgt6qEzW', '虫洞“猖獗无人机巢穴”重做速览', 'BeliEVE76', '2026-07', 246, 'i1.hdslb.com/bfs/archive/0e8ab0e0a748e67666c9834e3c87ad21b96280f3.jpg', '近期改版后的新波次、掉落和收益。'),

  academy('industry', 'I_dD4I-zHlw', 'mining', '采矿与资源获取', '采矿入门：找矿、采矿、出售或提炼。'),
  academy('industry', 'TGGKpe6MYrQ', 'industry', '基础工业生产', '蓝图、材料、工业窗口，造出第一件东西。'),
  academy('industry', 'p0exyST_TDY', 'invention', '发明与 T2 生产', '用 T1 蓝图拷贝发明 T2 蓝图，再生产 T2 物品。'),
  bili('industry', 'BV1jY411M7Dt', '【EVE新人教程2022】工业家 - 制造商任务全流程', 'EVE欧服玉麒麟联盟', '2022-06', 3638, 'i0.hdslb.com/bfs/archive/ec2e1c8bce979a2cc64a5b985477800fcee0b4c0.jpg', '工业生涯代理人任务一步步做完，顺便学会制造。'),
  bili('industry', 'BV14s411C7d6', '【eve新手教学】制造流程、心得', 'Baka_sbk', '2016-08', 1374, 'i0.hdslb.com/bfs/archive/9245e43626928ebdab1e3018afd324657a476cec.jpg', '制造流程讲解。版本很旧，界面已变，思路可参考。'),
  bili('industry', 'BV1Dm4y177Z7', 'EVE 新手种菜教学（6 分钟包学会）', 'Ezekiel_WarGod', '2023-07', 371, 'i0.hdslb.com/bfs/archive/5047f659ad9ec6572f49ffd3eff4dae59262f83a.jpg', '行星开发（种菜）快速上手。'),

  academy('trade', 'xTNrEqmjqmw', 'trading', '贸易赚钱', '市场窗口、买单卖单和低买高卖的基本思路。'),
  bili('trade', 'BV1zu411N7d7', 'EVE 商人基本课', '祖祖Limor', '2023-08', 720, 'i0.hdslb.com/bfs/archive/2611f22340c110d81d1a2123d20164a164c1df50.jpg', '市场买卖、挂单与倒卖的基础课。'),
  bili('trade', 'BV1dh4y1r7w4', 'EVE Online 新手教程：赚钱与投资思路', 'EVE小课堂', '2023-08', 580, 'i2.hdslb.com/bfs/archive/d579e8c72580e00d9575671bad485f4765bc67fb.jpg', '老玩家讲的赚钱、投资思路。'),

  academy('pvp', 'optDBEeT0C0', 'find-corp', '如何找军团', '军团能给你什么、去哪里找、怎么挑。'),
  bili('pvp', 'BV1jb411u7eo', '天山军校 新人 PVP 入门：狂怒者级', '天山以北EVE', '2019-04', 1169, 'i1.hdslb.com/bfs/archive/07e2abcd89e761fef48d4981f502f73d9888e250.jpg', '新人 PVP 系列，狂怒者级配置与使用。版本较旧。'),
  bili('pvp', 'BV17b411K7eQ', '天山军校 新人 PVP 入门：狞獾与小托', '天山以北EVE', '2019-04', 1114, 'i0.hdslb.com/bfs/archive/8730915706ce105b60a590e1c155e48a966d5d6c.jpg', '同系列，护卫舰 / 驱逐舰入门 PVP。')
];

// Wiki 首页「新手从这里开始」
const START = ['nea-index', 'getting-started-in-eve-online', 'nea-careers', 'clone-states', 'nea-ships-flying-your-ship', 'directional-scanner', 'making-money', 'find-a-corporation'];

const S = { mode: 'wiki', page: 'home', q: '', cat: '', lang: 'zh', index: null, doc: null, video: null, listScroll: 0, fromList: false };
const docs = new Map();
const ICON = {
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="15" height="14" rx="2"/><path d="m17 10 5-3v10l-5-3z"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'
};
const LANGS = [['zh', '中文'], ['en', 'English'], ['both', '对照']];

export function initGuides(context) {
  ctx = context;
  try { const v = localStorage.getItem(LANG_KEY); if (LANGS.some(([k]) => k === v)) S.lang = v; } catch { /* 无痕模式等 */ }
}

async function loadIndex() {
  if (S.index) return S.index;
  try {
    const r = await fetch('guides/index.json?v=4');
    S.index = r.ok ? await r.json() : {};
  } catch { S.index = {}; }
  return S.index;
}

async function loadDoc(id) {
  if (!docs.has(id)) {
    docs.set(id, fetch(`guides/${id}.json?v=4`).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((doc) => {
        // 中文原文只有 zh 字段，补上 en 让阅读器按同一套逻辑渲染
        if (doc.lang === 'zh') { doc.title.en = doc.title.zh; doc.blocks.forEach((b) => { b.en = b.zh; }); }
        return doc;
      })
      .catch((e) => { docs.delete(id); throw e; }));
  }
  return docs.get(id);
}

// ---------- 安全输出：只保留 <b> <i> <code> <a href="https://…"> 和站内链接 <a href="#guide/w/…"> ----------
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
      if (/^#guide\/w\/[\w-]+$/.test(href)) return `<a href="${href}" data-guide-link>${inner}</a>`;
      return /^https:\/\//.test(href) ? `<a href="${ctx.esc(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : inner;
    }
    return inner;
  }).join('');
  return walk(tpl.content);
}
const plain = (html) => { tpl.innerHTML = html || ''; return tpl.content.textContent; };

// ---------- 通用 ----------
const catName = (k, list = CATS) => list.find(([c]) => c === k)?.[1] || '';
// 同分类里官方新手站在前，其次本站译文、本站摘要、BWIKI、萌娘百科，同来源按标题排
const SRC_ORDER = Object.keys(SRC);
let pageList = null;
const pages = () => (pageList ||= Object.entries(S.index || {}).filter(([id]) => !id.startsWith('academy-')).map(([id, x]) => ({ id, ...x }))
  .sort((a, b) => ((a.s === 'uni' ? 0.5 : SRC_ORDER.indexOf(a.s)) - (b.s === 'uni' ? 0.5 : SRC_ORDER.indexOf(b.s))) || a.zh.localeCompare(b.zh, 'zh')));
const videoDur = (v) => v.dur || S.index?.[v.doc]?.dur || 0;
const isTr = (x) => x.s === 'uni';
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const seg = (key, cur, opts, cls = '') => `<div class="segmented guide-seg ${cls}" role="group">${opts.map(([v, l]) => `<button type="button" data-guide-${key}="${v}" class="${cur === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
const shortTitle = (x) => ctx.esc(isTr(x) && S.lang === 'en' ? x.en : x.zh);

function pageTitle(x) {
  if (!isTr(x) || S.lang === 'zh') return ctx.esc(x.zh);
  if (S.lang === 'en') return ctx.esc(x.en);
  return `${ctx.esc(x.zh)}<span class="guide-title-en">${ctx.esc(x.en)}</span>`;
}

function matchPage(x) {
  if (!S.q) return true;
  return (x.zh + ' ' + (x.en || '') + ' ' + (x.d || '') + ' ' + (x.g || '')).toLowerCase().includes(S.q);
}
function matchVideo(v) {
  if (!S.q) return true;
  return (v.title + ' ' + v.up + ' ' + v.desc).toLowerCase().includes(S.q);
}

// 同分类文章按小组排列：没有小组的在前，小组按出现顺序
function groupPages(list) {
  const groups = new Map();
  for (const x of list) { const g = x.g || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); }
  return [...groups.entries()].sort((a, b) => (a[0] ? 1 : 0) - (b[0] ? 1 : 0));
}

// ---------- 侧边栏 ----------
function renderSide() {
  const mode = seg('mode', S.mode, [['wiki', `${ICON.text}图文 Wiki`], ['video', `${ICON.video}视频`]], 'guide-mode');
  let body;
  if (S.mode === 'wiki') {
    const list = pages().filter(matchPage);
    const item = (k, name, n, href) => `<a class="ind-side-item${S.page !== 'doc' && S.cat === k && !S.q ? ' active' : ''}" href="${href}" data-guide-nav><span>${name}</span><small>${n}</small></a>`;
    // 当前分类下展开文章列表
    const cur = S.cat && !S.q ? list.filter((x) => x.c === S.cat) : [];
    const sub = cur.length ? `<div class="guide-side-pages">${groupPages(cur).map(([g, xs]) => `${g ? `<div class="guide-side-group">${ctx.esc(g)}</div>` : ''}${xs.map((x) =>
      `<a class="guide-side-page${S.doc?.id === x.id ? ' active' : ''}" href="#guide/w/${x.id}" data-guide-read>${shortTitle(x)}</a>`).join('')}`).join('')}</div>` : '';
    body = `<div class="ind-side-section"><h4>分类</h4>${item('', 'Wiki 首页', list.length, '#guide')}${CATS.map(([k, name]) =>
      item(k, name, list.filter((x) => x.c === k).length, '#guide/' + k) + (k === S.cat ? sub : '')).join('')}</div>
      <div class="ind-side-section guide-side-filters"><h4>译文阅读语言</h4>${seg('lang', S.lang, LANGS)}
        <p class="ind-side-empty">EVE University 的英文文章已全文翻译，可切换中文、英文原文或中英对照。</p></div>`;
  } else {
    const list = VIDEOS.filter(matchVideo);
    const item = (k, name, n) => `<a class="ind-side-item${S.page !== 'video' && S.cat === k ? ' active' : ''}" href="#guide/video${k ? '/' + k : ''}" data-guide-nav><span>${name}</span><small>${n}</small></a>`;
    body = `<div class="ind-side-section"><h4>分类</h4>${item('', '全部视频', list.length)}${VCATS.map(([k, name]) => item(k, name, list.filter((v) => v.cat === k).length)).join('')}</div>`;
  }
  $('guideSide').innerHTML = `<div class="ind-side-section guide-side-mode">${mode}</div>${body}`;
  $('guideSearch').placeholder = S.mode === 'wiki' ? '搜索 Wiki，如 虫洞、扫描、种菜' : '搜索视频，如 种菜、PVP';
  $('guideSide').querySelector('.guide-side-page.active')?.scrollIntoView({ block: 'nearest' });
}

// ---------- Wiki 列表 ----------
const srcBadge = (x) => `<span class="guide-src-badge ${x.s}">${SRC[x.s]?.[0] || ''}</span>`;

function pageRow(x) {
  return `<a class="guide-row" href="#guide/w/${x.id}" data-guide-read>
    <div class="guide-row-main"><strong class="guide-title">${pageTitle(x)}</strong>${x.d ? `<p class="guide-desc">${ctx.esc(x.d)}</p>` : ''}</div>
    <div class="guide-row-meta">${srcBadge(x)}${isTr(x) ? '<span class="guide-lang tr">译文</span>' : ''}<small>${x.m || 1} 分钟</small></div></a>`;
}

const WIKI_NOTE = `<p class="text-muted valuation-note">图文资料全文收录自新伊甸学院（EVE 官方，版权归 CCP Games）、EVE 星战前夜 BWIKI（CC BY-NC-SA 4.0）、萌娘百科（CC BY-NC-SA 3.0 CN）和 EVE University Wiki（CC BY-SA 4.0，英文原文，本站翻译）。每篇文章开头标注了出处和原文链接，内容以原文为准。</p>`;

function renderWikiHome() {
  const all = pages();
  const start = START.map((id) => all.find((x) => x.id === id)).filter(Boolean);
  const srcCount = Object.keys(SRC).map((k) => [k, all.filter((x) => x.s === k).length]).filter(([, n]) => n);
  $('guideMain').innerHTML = `<section class="pi-page guide-page">
    <div class="guide-hero"><h2>EVE 中文 Wiki</h2>
      <p class="text-muted">${all.length} 篇图文资料，按玩法分类整理。来源：${srcCount.map(([k, n]) => `${SRC[k][0]} ${n} 篇`).join('、')}。另有 <a href="#guide/video" data-guide-nav>${VIDEOS.length} 个教学视频</a>。</p></div>
    ${start.length ? `<section class="guide-section"><div class="guide-section-head"><h3>新手从这里开始</h3></div>
      <div class="guide-start">${start.map((x, i) => `<a class="guide-start-item" href="#guide/w/${x.id}" data-guide-read><b>${i + 1}</b><span>${shortTitle(x)}</span>${srcBadge(x)}</a>`).join('')}</div></section>` : ''}
    <section class="guide-section"><div class="guide-section-head"><h3>分类</h3></div>
      <div class="guide-cat-grid">${CATS.map(([k, name, intro]) => {
        const xs = all.filter((x) => x.c === k);
        if (!xs.length) return '';
        return `<div class="guide-cat-card"><a class="guide-cat-head" href="#guide/${k}" data-guide-nav><strong>${name}</strong><small>${xs.length} 篇</small></a>
          <p class="guide-desc">${intro}</p>
          <ul>${xs.slice(0, 6).map((x) => `<li><a href="#guide/w/${x.id}" data-guide-read>${shortTitle(x)}</a></li>`).join('')}</ul>
          ${xs.length > 6 ? `<a class="guide-more" href="#guide/${k}" data-guide-nav>全部 ${xs.length} 篇 →</a>` : ''}</div>`;
      }).join('')}</div></section>
    ${WIKI_NOTE}</section>`;
}

function renderWikiCat() {
  const [k, name, intro] = CATS.find(([c]) => c === S.cat);
  const xs = pages().filter((x) => x.c === k);
  $('guideMain').innerHTML = `<section class="pi-page guide-page">
    <nav class="guide-crumb"><a href="#guide" data-guide-nav>Wiki</a><span>/</span>${name}</nav>
    <div class="pi-head guide-head"><h2>${name}</h2><span class="text-muted guide-sub">${intro} · ${xs.length} 篇</span></div>
    ${groupPages(xs).map(([g, list]) => `<section class="guide-section">${g ? `<div class="guide-section-head"><h3>${ctx.esc(g)}</h3><span class="text-muted">${list.length} 篇</span></div>` : ''}
      <div class="guide-rows">${list.map(pageRow).join('')}</div></section>`).join('') || '<p class="legend-empty">这个分类还没有文章</p>'}
    ${WIKI_NOTE}</section>`;
}

function renderWikiSearch() {
  const xs = pages().filter(matchPage);
  const vs = VIDEOS.filter(matchVideo);
  $('guideMain').innerHTML = `<section class="pi-page guide-page">
    <div class="pi-head guide-head"><h2>搜索「${ctx.esc(S.q)}」</h2><span class="text-muted guide-sub">${xs.length} 篇文章${vs.length ? `，视频里还有 ${vs.length} 个结果，切到「视频」查看` : ''}</span></div>
    ${CATS.map(([k, name]) => {
      const list = xs.filter((x) => x.c === k);
      return list.length ? `<section class="guide-section"><div class="guide-section-head"><h3>${name}</h3><span class="text-muted">${list.length} 篇</span></div><div class="guide-rows">${list.map(pageRow).join('')}</div></section>` : '';
    }).join('') || '<p class="legend-empty">没有找到相关文章</p>'}</section>`;
}

// ---------- 视频列表 ----------
function videoCard(v) {
  return `<a class="guide-vcard" href="#guide/v/${v.id}" data-guide-read>
    <div class="guide-thumb"><img src="${ctx.esc(v.pic)}${v.p === 'bili' ? '@480w_270h_1c.webp' : ''}" alt="" loading="lazy" referrerpolicy="no-referrer">
      <span class="guide-thumb-play">${ICON.play}</span>${videoDur(v) ? `<span class="guide-thumb-dur">${fmtDur(videoDur(v))}</span>` : ''}
      ${v.doc ? '<span class="guide-thumb-tag">中文字幕</span>' : ''}</div>
    <strong class="guide-title">${ctx.esc(v.title)}</strong>
    <small class="guide-src">${v.p === 'bili' ? 'B 站' : 'YouTube'} · ${ctx.esc(v.up)}${v.date ? ' · ' + v.date : ''}</small></a>`;
}

function renderVideoList() {
  const list = VIDEOS.filter(matchVideo);
  const cats = VCATS.filter(([k]) => !S.cat || S.cat === k);
  const name = catName(S.cat, VCATS);
  $('guideMain').innerHTML = `<section class="pi-page guide-page">
    ${name ? `<nav class="guide-crumb"><a href="#guide/video" data-guide-nav>视频</a><span>/</span>${name}</nav>` : ''}
    <div class="pi-head guide-head"><h2>${S.q ? `搜索「${ctx.esc(S.q)}」` : name || '教学视频'}</h2><span class="text-muted guide-sub">${S.q ? `${list.length} 个视频` : '站内直接播放，附原视频链接。EVE Academy 官方视频是英文配音，本站翻译了中文字幕'}</span></div>
    ${cats.map(([k, n]) => {
      const vs = list.filter((v) => v.cat === k);
      return vs.length ? `<section class="guide-section">${S.cat ? '' : `<div class="guide-section-head"><h3>${n}</h3><span class="text-muted">${vs.length} 个</span></div>`}
        <div class="guide-vgrid">${vs.map(videoCard).join('')}</div></section>` : '';
    }).join('') || '<p class="legend-empty">没有符合条件的视频</p>'}
    <p class="text-muted valuation-note">视频版权归原作者，本站只嵌入原平台的播放器。B 站视频标了发布日期，较早的视频里界面和数值可能已经变了。</p></section>`;
}

// ---------- 文章阅读 ----------
const pickText = (b, lang) => (lang === 'en' ? b.en : (b.zh ?? b.en));
const docLang = () => (S.doc?.lang === 'zh' ? 'zh' : S.lang);
// 中文 / English / 对照：对照时中文在上、英文原文在下
function dual(b, render) {
  const lang = docLang();
  if (lang === 'both') return render(b.zh ?? b.en, '') + (b.zh && b.zh !== b.en ? render(b.en, 'guide-en') : '');
  return render(pickText(b, lang), '');
}
function cellHtml(zh, en) {
  const lang = docLang();
  if (lang === 'en') return safe(en);
  if (lang === 'both' && zh && zh !== en) return `${safe(zh)}<div class="guide-en">${safe(en)}</div>`;
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
      return `<${b.t} id="gh-${i}">${docLang() === 'both' && b.zh && b.zh !== b.en ? `${safe(b.zh)}<span class="guide-en">${safe(b.en)}</span>` : safe(pickText(b, docLang()))}</${b.t}>`;
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
  const lang = docLang();
  if (lang === 'en') return ctx.esc(doc.title.en);
  if (lang === 'both' && zh !== doc.title.en) return `${ctx.esc(zh)}<span class="guide-title-en">${ctx.esc(doc.title.en)}</span>`;
  return ctx.esc(zh);
}

function relatedHtml(id) {
  const me = S.index[id];
  if (!me) return '';
  const same = pages().filter((x) => x.c === me.c && x.id !== id);
  same.sort((a, b) => (b.g === me.g) - (a.g === me.g));
  const list = same.slice(0, 8);
  return list.length ? `<section class="guide-related"><h3>${catName(me.c)} · 相关文章</h3><div class="guide-rows">${list.map(pageRow).join('')}</div></section>` : '';
}

function renderArticleBody(doc) {
  const heads = doc.blocks.map((b, i) => [b, i]).filter(([b]) => b.t === 'h2' || b.t === 'h3');
  const toc = heads.length >= 3 ? `<nav class="guide-toc" aria-label="目录"><h4>目录</h4>${heads.map(([b, i]) =>
    `<button type="button" class="${b.t}" data-guide-toc="${i}">${ctx.esc(plain(pickText(b, docLang())))}</button>`).join('')}</nav>` : '';
  $('guideDocBody').innerHTML = `<div class="guide-article-layout${toc ? '' : ' no-toc'}"><div><article class="guide-article">${doc.blocks.map(blockHtml).join('')}</article>${relatedHtml(doc.id)}</div>${toc}</div>`;
}

function sourceBox(doc) {
  let shown = doc.url;
  try { shown = decodeURI(doc.url); } catch { /* 保持原样 */ }
  return `<div class="guide-source">
    <div><span>来源</span><b>${ctx.esc(doc.source)}</b></div>
    <div><span>许可</span>${ctx.esc(doc.license)}</div>
    <div><span>原文</span><a href="${ctx.esc(doc.url)}" target="_blank" rel="noopener noreferrer">${ctx.esc(shown.replace(/^https:\/\//, ''))}${ICON.out}</a></div>
    ${doc.lang !== 'zh' ? '<div><span>说明</span>英文原文由本站翻译成中文，可能有疏漏，以原文为准</div>' : doc.note ? `<div><span>说明</span>${ctx.esc(doc.note)}</div>` : ''}</div>`;
}

async function renderDoc(id) {
  const info = S.index[id];
  $('guideMain').innerHTML = `<section class="pi-page guide-page guide-reader"><div class="guide-reader-bar">
      <nav class="guide-crumb"><a href="#guide" data-guide-nav>Wiki</a>${info ? `<span>/</span><a href="#guide/${info.c}" data-guide-nav>${catName(info.c)}</a>` : ''}</nav>
      <span class="toolbar-spacer"></span><div id="guideLangBar"></div></div>
    <div id="guideDocHead"></div><div id="guideDocBody"><p class="legend-empty">加载中…</p></div></section>`;
  let doc;
  try { doc = await loadDoc(id); } catch (e) {
    $('guideDocBody').innerHTML = `<p class="legend-empty">文章加载失败：${ctx.esc(e.message)}</p>`;
    return;
  }
  if (parse(location.hash).id !== id) return;
  S.doc = doc;
  renderSide();
  if (doc.lang !== 'zh') $('guideLangBar').innerHTML = `<div class="segmented" role="group" aria-label="阅读语言">${LANGS.map(([v, l]) => `<button type="button" data-guide-lang="${v}" class="${S.lang === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  $('guideDocHead').innerHTML = `<h1 class="guide-doc-title" id="guideDocTitle">${docTitle(doc)}</h1>${sourceBox(doc)}`;
  renderArticleBody(doc);
}

// ---------- 视频播放 ----------
// YouTube：IFrame API + 同步中文字幕；B 站：嵌入官方播放器
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

function capHtml(b) {
  if (!b) return '';
  if (S.lang === 'en') return `<span>${ctx.esc(b.en)}</span>`;
  if (S.lang === 'both') return `<span>${ctx.esc(b.zh ?? b.en)}</span><span class="guide-cap-en">${ctx.esc(b.en)}</span>`;
  return `<span>${ctx.esc(b.zh ?? b.en)}</span>`;
}

function renderTranscript(doc) {
  $('guideTranscriptBox').innerHTML = `<div class="guide-transcript-head"><h3>字幕稿</h3>
      <div class="segmented" role="group" aria-label="字幕语言">${LANGS.map(([v, l]) => `<button type="button" data-guide-lang="${v}" class="${S.lang === v ? 'active' : ''}">${l}</button>`).join('')}</div>
      <label class="guide-follow"><input type="checkbox" data-guide-follow${V.follow ? ' checked' : ''}> 跟随播放滚动</label></div>
    <ol class="guide-transcript" id="guideTranscript">${doc.blocks.map((b, i) => `<li data-guide-cue="${i}" class="${i === V.cue ? 'active' : ''}"><time>${fmtDur(b.s)}</time><div>${S.lang === 'en' ? ctx.esc(b.en) : S.lang === 'both' ? `${ctx.esc(b.zh ?? b.en)}<span class="guide-en">${ctx.esc(b.en)}</span>` : ctx.esc(b.zh ?? b.en)}</div></li>`).join('')}</ol>`;
  const cap = $('guideCap');
  if (cap) cap.innerHTML = capHtml(doc.blocks[V.cue]);
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

async function startYouTube(v, doc) {
  stopVideo();
  V.doc = doc;
  try {
    await loadYouTube();
    if (S.video !== v) return;
    V.player = new window.YT.Player('guideYt', {
      videoId: v.id,
      playerVars: { rel: 0, modestbranding: 1, cc_load_policy: 0, playsinline: 1 },
      events: {
        onReady: () => { if (doc) V.timer = setInterval(tick, 200); },
        // 关掉 YouTube 自带字幕（有的账号 / 浏览器设置会自动打开），只显示本站字幕；字幕模块在开始播放后才加载
        onApiChange: hideYtCaptions,
        onStateChange: (e) => { if (e.data === 1) hideYtCaptions(); }
      }
    });
  } catch (e) {
    const box = $('guideYt');
    if (box) box.outerHTML = `<div class="guide-yt-fail"><p>视频无法加载（${ctx.esc(e.message)}）。YouTube 在部分网络环境下无法访问，可以直接阅读下方的中文字幕稿，或<a href="https://www.youtube.com/watch?v=${ctx.esc(v.id)}" target="_blank" rel="noopener noreferrer">在 YouTube 打开</a>。</p></div>`;
  }
}

async function renderVideo(id) {
  const v = VIDEOS.find((x) => x.id === id);
  if (!v) { navigate('#guide/video', false); return; }
  S.video = v;
  S.cat = v.cat;
  renderSide();
  const url = v.p === 'bili' ? `https://www.bilibili.com/video/${v.id}/` : `https://www.youtube.com/watch?v=${v.id}`;
  const player = v.p === 'bili'
    ? `<iframe src="https://player.bilibili.com/player.html?bvid=${v.id}&autoplay=0&danmaku=0&high_quality=1" title="${ctx.esc(v.title)}" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>`
    : '<div id="guideYt"></div><div class="guide-cap" id="guideCap" aria-live="off"></div>';
  const related = VIDEOS.filter((x) => x.cat === v.cat && x !== v);
  $('guideMain').innerHTML = `<section class="pi-page guide-page guide-reader">
    <div class="guide-reader-bar"><nav class="guide-crumb"><a href="#guide/video" data-guide-nav>视频</a><span>/</span><a href="#guide/video/${v.cat}" data-guide-nav>${catName(v.cat, VCATS)}</a></nav></div>
    <h1 class="guide-doc-title">${ctx.esc(v.title)}</h1>
    <p class="guide-doc-meta">${v.p === 'bili' ? 'B 站' : 'YouTube'} · ${ctx.esc(v.up)}${v.date ? ' · ' + v.date + ' 发布' : ''}${videoDur(v) ? ' · ' + fmtDur(videoDur(v)) : ''} · <a href="${url}" target="_blank" rel="noopener noreferrer">${v.p === 'bili' ? '在 B 站观看' : '在 YouTube 观看'}${ICON.out}</a></p>
    <div class="guide-video">${player}</div>
    <p class="guide-vdesc">${ctx.esc(v.desc)}${v.doc ? ' 英文配音，中文字幕由本站翻译，播放时显示在画面上，下方是完整字幕稿，点击可跳转。' : ''}</p>
    <div id="guideTranscriptBox"></div>
    ${related.length ? `<section class="guide-related"><h3>${catName(v.cat, VCATS)} · 更多视频</h3><div class="guide-vgrid">${related.map(videoCard).join('')}</div></section>` : ''}</section>`;
  if (v.p !== 'yt') return;
  let doc = null;
  if (v.doc) {
    try { doc = await loadDoc(v.doc); } catch { /* 没有字幕也能播放 */ }
    if (S.video !== v) return;
    if (doc) { S.doc = doc; renderTranscript(doc); }
  }
  startYouTube(v, doc);
}

// ---------- 路由与事件 ----------
function scroller() { return $('guideMain').closest('.kb-scroll'); }

function parse(hash) {
  const h = (hash || '').replace(/^#guide\/?/, '');
  let m;
  if ((m = /^w\/([\w-]+)/.exec(h))) return { mode: 'wiki', page: 'doc', id: m[1] };
  if ((m = /^v\/([\w-]+)/.exec(h))) return { mode: 'video', page: 'video', id: m[1] };
  // 旧链接 #guide/read/<id>
  if ((m = /^read\/([\w-]+)/.exec(h))) {
    const v = VIDEOS.find((x) => x.doc === m[1]);
    return v ? { mode: 'video', page: 'video', id: v.id } : { mode: 'wiki', page: 'doc', id: m[1] };
  }
  if ((m = /^video(?:\/(\w+))?/.exec(h))) return { mode: 'video', page: 'list', cat: VCATS.some(([k]) => k === m[1]) ? m[1] : '' };
  if ((m = /^(\w+)/.exec(h)) && CATS.some(([k]) => k === m[1])) return { mode: 'wiki', page: 'cat', cat: m[1] };
  return { mode: 'wiki', page: 'home', cat: '' };
}

function navigate(hash, push = true) {
  if (location.hash !== hash) history[push ? 'pushState' : 'replaceState'](null, '', location.pathname + hash);
  showGuides(hash);
}

function setLang(v) {
  S.lang = v;
  try { localStorage.setItem(LANG_KEY, v); } catch { /* 无痕模式等 */ }
  renderSide();
  if (S.page === 'doc' && S.doc) {
    document.querySelectorAll('#guideMain [data-guide-lang]').forEach((b) => b.classList.toggle('active', b.dataset.guideLang === S.lang));
    $('guideDocTitle').innerHTML = docTitle(S.doc);
    renderArticleBody(S.doc);
  } else if (S.page === 'video') { if (S.doc) renderTranscript(S.doc); }
  else render();
}

function bind() {
  const view = $('guideView');
  view.addEventListener('click', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
    const read = e.target.closest('[data-guide-read], [data-guide-link]');
    if (read) {
      // 进入文章 / 视频：记住列表位置，浏览器后退时恢复
      e.preventDefault();
      if (S.page !== 'doc' && S.page !== 'video') S.listScroll = scroller().scrollTop;
      S.fromList = S.page !== 'doc' && S.page !== 'video' ? true : S.fromList;
      navigate(read.getAttribute('href'));
      ctx.closeDrawer?.();
      return;
    }
    const nav = e.target.closest('[data-guide-nav]');
    if (nav) {
      e.preventDefault();
      S.fromList = false;
      if (S.q) { S.q = ''; $('guideSearch').value = ''; }
      navigate(nav.getAttribute('href'));
      ctx.closeDrawer?.();
      return;
    }
    const mode = e.target.closest('[data-guide-mode]');
    if (mode) {
      if (mode.dataset.guideMode !== S.mode) { S.fromList = false; navigate(mode.dataset.guideMode === 'video' ? '#guide/video' : '#guide'); }
      return;
    }
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
    // 阅读时搜索：回到列表显示结果
    if (S.page === 'doc' || S.page === 'video') { S.fromList = false; navigate(S.mode === 'video' ? '#guide/video' : '#guide'); return; }
    renderSide();
    render();
  }, 150));
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { input.value = ''; S.q = ''; renderSide(); if (S.page !== 'doc' && S.page !== 'video') render(); } });
}

function render() {
  if (S.mode === 'video') renderVideoList();
  else if (S.q) renderWikiSearch();
  else if (S.page === 'cat') renderWikiCat();
  else renderWikiHome();
}

export async function showGuides(hash) {
  const main = $('guideMain');
  if (!main.dataset.ready) { main.dataset.ready = '1'; bind(); }
  await loadIndex();
  const r = parse(hash);
  // 旧链接 #guide/read/<id> 换成新地址
  if (/^#guide\/read\//.test(hash || '')) { const h = r.page === 'video' ? '#guide/v/' + r.id : '#guide/w/' + r.id; history.replaceState(null, '', location.pathname + h); }
  if (r.page === 'doc' || r.page === 'video') {
    const cur = r.page === 'doc' ? S.page === 'doc' && S.doc?.id === r.id : S.page === 'video' && S.video?.id === r.id;
    if (cur && main.querySelector('.guide-reader')) return;
    stopVideo();
    Object.assign(S, { mode: r.mode, page: r.page, doc: null, video: null });
    scroller().scrollTop = 0;
    if (r.page === 'doc') { S.cat = S.index[r.id]?.c || ''; renderSide(); await renderDoc(r.id); }
    else await renderVideo(r.id);
    return;
  }
  const back = S.fromList && (S.page === 'doc' || S.page === 'video');
  stopVideo();
  Object.assign(S, { mode: r.mode, page: r.page, cat: r.cat, doc: null, video: null, fromList: false });
  renderSide();
  render();
  scroller().scrollTop = back ? S.listScroll : 0;
}
