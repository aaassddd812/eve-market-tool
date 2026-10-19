// ===== 游戏服务器：宁静（Tranquility）/ 晨曦（Serenity）/ 曙光（Infinity）=====
// 当前服务器记在 localStorage「eve-server」，切换后整页刷新，各模块加载时读取一次即可。
// 晨曦服 ESI 支持浏览器跨域，可直接请求；晨曦 SSO 的换令牌接口不支持跨域，由 /api/esi/sso/token 原样转发（不保存任何内容）。
// 网易没有开放第三方应用申请，国服工具普遍复用官方 ESI 网页自带的应用（回调到网易 ESI 页面），
// 登录后浏览器停在 ali-esi.evepc.163.com/ui/oauth2-redirect.html，由用户复制地址栏粘贴回来。
// 网易登录还要求 realm=ESI 和一个设备 ID：设备 ID 与官方网页一样每次授权前向网易申请（经 /api/esi/sso/device）。
// 曙光服与晨曦同一套 ESI（datasource=infinity）和同一个官方应用，只是登录域名不同；
// 曙光服星图重新排布过（坐标、星门、星域都不同），用单独的 map-data-infinity.json（build_map_esi.mjs 生成），
// 主要交易中心也不在吉他，而在长征星域的索巴色基。角色 ID 与晨曦会重复，头像要从曙光自己的图片服务器取。
//
// regions：主要交易中心（第一个是全站默认的价格基准，市场、估价、制造、行星工业、LP 商店都用它）
// hub 为该星域交易中心空间站，星域名称取自 ESI /universe/regions/{id}/?language=zh
const JITA_REGIONS = [
  { id: 10000002, name: '伏尔戈', en: 'The Forge', hub: { id: 60003760, name: '吉他海4', system: 30000142 } },
  { id: 10000043, name: '多美', en: 'Domain', hub: { id: 60008494, name: '艾玛 VIII', system: 30002187 } },
  { id: 10000032, name: '金纳泽', en: 'Sinq Laison', hub: { id: 60011866, name: '多迪谢 IX', system: 30002659 } },
  { id: 10000030, name: '西玛特尔', en: 'Heimatar', hub: { id: 60004588, name: '伦斯 VI', system: 30002510 } },
  { id: 10000042, name: '美特伯里斯', en: 'Metropolis', hub: { id: 60005686, name: '赫克 VIII', system: 30002053 } }
];
const SERVERS = {
  tq: {
    id: 'tq', name: '宁静', full: '宁静服',
    esi: 'https://esi.evetech.net/latest', datasource: 'tranquility',
    sso: 'https://login.eveonline.com/v2/oauth',
    tokenProxy: false,
    authParams: {},
    manualCallback: false,
    kb: true,          // 自建击杀记录服务与 zKillboard 只收录宁静服
    kbSite: null,
    lpData: 'lp-data.json?v=1',
    mapData: './map-data.json?v=v7r1',
    image: null,
    sub: '国际服 · Tranquility',
    regions: JITA_REGIONS
  },
  serenity: {
    id: 'serenity', name: '晨曦', full: '晨曦服',
    esi: 'https://ali-esi.evepc.163.com/latest', datasource: 'serenity',
    sso: 'https://login.evepc.163.com/v2/oauth',
    tokenProxy: true,
    authParams: { realm: 'ESI' },
    needDevice: true,
    manualCallback: true,   // 回调落在网易页面，不会自动跳回本站
    kb: false,
    // 国服击坠榜：数据接口有人机验证、不开放跨域，只能外链过去查看
    kbSite: { name: '国服击坠榜', url: 'https://beta.ceve-market.org' },
    lpData: 'lp-data-serenity.json?v=1',
    mapData: './map-data.json?v=v7r1',   // 晨曦星图与宁静相同
    image: 'https://image.evepc.163.com',
    sub: '国服 · Serenity',
    regions: JITA_REGIONS
  },
  infinity: {
    id: 'infinity', name: '曙光', full: '曙光服',
    esi: 'https://ali-esi.evepc.163.com/latest', datasource: 'infinity',
    sso: 'https://login-infinity.evepc.163.com/v2/oauth',
    tokenProxy: true,
    authParams: { realm: 'ESI' },
    needDevice: true,
    manualCallback: true,
    kb: false,
    // 国服击坠榜的曙光分站（与晨曦同一站点、同样的链接格式）；另附开明网的曙光 PVP 战情大厅
    kbSite: { name: '曙光击坠榜', url: 'https://inf.ceve-market.org' },
    kbExtra: [{ name: '开明网 PVP 战情大厅', url: 'https://eveai.vip/pvp' }],
    lpData: 'lp-data-infinity.json?v=1',
    mapData: './map-data-infinity.json?v=i1',
    image: 'https://image-infinity.evepc.163.com',
    sub: '国服 · Infinity',
    regions: [
      { id: 10000016, name: '长征', en: 'Lonetrek', hub: { id: 60000843, name: '索巴色基 V', system: 30001363 } },
      { id: 10000002, name: '伏尔戈', en: 'The Forge', hub: { id: 60003760, name: '吉他海4', system: 30000142 } },
      { id: 10000043, name: '多美', en: 'Domain', hub: { id: 60006399, name: '佩尼尔格曼 III', system: 30003488 } },
      { id: 10000032, name: '金纳泽', en: 'Sinq Laison', hub: { id: 60001866, name: '多迪谢 V', system: 30002659 } },
      { id: 10000030, name: '西玛特尔', en: 'Heimatar', hub: { id: 60004611, name: '劳斯特威克 IX', system: 30002545 } }
    ]
  }
};

const SERVER_KEY = 'eve-server';

function savedServer() {
  try { return localStorage.getItem(SERVER_KEY); } catch { return null; }
}

export const SERVER = SERVERS[savedServer()] || SERVERS.tq;
export const SERVER_LIST = Object.values(SERVERS);
export const IS_TQ = SERVER.id === 'tq';
// 全站默认的价格基准交易中心（宁静 / 晨曦为吉他，曙光为索巴色基）；HUB_NAME 用于「吉他卖单」这类文字
export const HUB = SERVER.regions[0];
export const HUB_NAME = HUB.hub.name.split(' ')[0].replace(/海\d+$/, '');
export const NO_KB_MESSAGE = SERVER.full + '的击杀数据没有开放接口，本站无法直接显示' + (SERVER.kbSite ? '，可到「' + SERVER.kbSite.name + '」查看' : '');

// 外部击杀站链接（晨曦服：国服击坠榜；曙光服：其曙光分站）；kind 为 kill / pilot / corp / alliance
export function kbSiteLink(kind, id) {
  return SERVER.kbSite ? `${SERVER.kbSite.url}/${kind}${id ? '/' + id : ''}` : null;
}

export function setServer(id) {
  if (!SERVERS[id] || id === SERVER.id) return;
  try { localStorage.setItem(SERVER_KEY, id); } catch { /* 隐私模式下无法记住，仍按本次选择刷新 */ }
  location.reload();
}

// 与服务器绑定的本地存储键（令牌、建筑缓存、价格缓存等）：宁静服沿用原键名，其它服加前缀，互不覆盖
export function serverKey(key) {
  return IS_TQ ? key : SERVER.id + ':' + key;
}

// ESI 地址：自动补上 datasource
export function esiUrl(path) {
  return SERVER.esi + path + (path.includes('?') ? '&' : '?') + 'datasource=' + SERVER.datasource;
}

// 图片：物品图标各服通用；人物头像、玩家军团 / 联盟图标国服要从网易图片服务器取（晨曦、曙光各自一台）
const LEGACY_SIZES = [32, 64, 128, 256, 512];
export function eveImage(path, size = 64) {
  if (SERVER.image) {
    const m = /^(characters|corporations|alliances)\/(\d+)\/(portrait|logo)$/.exec(path);
    if (m) {
      const s = LEGACY_SIZES.find((x) => x >= size) || 512;
      const kind = { characters: 'Character', corporations: 'Corporation', alliances: 'Alliance' }[m[1]];
      return `${SERVER.image}/${kind}/${m[2]}_${s}.${kind === 'Character' ? 'jpg' : 'png'}`;
    }
  }
  return `https://images.evetech.net/${path}?size=${size}`;
}
