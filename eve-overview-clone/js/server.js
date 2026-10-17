// ===== 游戏服务器：宁静（Tranquility）/ 晨曦（Serenity）=====
// 当前服务器记在 localStorage「eve-server」，切换后整页刷新，各模块加载时读取一次即可。
// 晨曦服 ESI 支持浏览器跨域，可直接请求；晨曦 SSO 的换令牌接口不支持跨域，由 /api/esi/sso/token 原样转发（不保存任何内容）。
// 网易没有开放第三方应用申请，国服工具普遍复用官方 ESI 网页自带的应用（回调到网易 ESI 页面），
// 登录后浏览器停在 ali-esi.evepc.163.com/ui/oauth2-redirect.html，由用户复制地址栏粘贴回来。
// 网易登录还要求 realm=ESI 和一个设备 ID：设备 ID 与官方网页一样每次授权前向网易申请（经 /api/esi/sso/device）。
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
    lpData: 'lp-data.json?v=1'
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
    lpData: 'lp-data-serenity.json?v=1'
  }
};

const SERVER_KEY = 'eve-server';

function savedServer() {
  try { return localStorage.getItem(SERVER_KEY); } catch { return null; }
}

export const SERVER = SERVERS[savedServer()] || SERVERS.tq;
export const SERVER_LIST = Object.values(SERVERS);
export const IS_TQ = SERVER.id === 'tq';
export const NO_KB_MESSAGE = SERVER.full + '的击杀数据没有开放接口，本站无法直接显示' + (SERVER.kbSite ? '，可到「' + SERVER.kbSite.name + '」查看' : '');

// 外部击杀站链接（晨曦服：国服击坠榜）；kind 为 kill / pilot / corp / alliance
export function kbSiteLink(kind, id) {
  return SERVER.kbSite ? `${SERVER.kbSite.url}/${kind}${id ? '/' + id : ''}` : null;
}

export function setServer(id) {
  if (!SERVERS[id] || id === SERVER.id) return;
  try { localStorage.setItem(SERVER_KEY, id); } catch { /* 隐私模式下无法记住，仍按本次选择刷新 */ }
  location.reload();
}

// 与服务器绑定的本地存储键（令牌、建筑缓存、价格缓存等）：宁静服沿用原键名，晨曦服加前缀，两边互不覆盖
export function serverKey(key) {
  return IS_TQ ? key : SERVER.id + ':' + key;
}

// ESI 地址：自动补上 datasource
export function esiUrl(path) {
  return SERVER.esi + path + (path.includes('?') ? '&' : '?') + 'datasource=' + SERVER.datasource;
}

// 图片：物品图标两服通用；人物头像、玩家军团 / 联盟图标晨曦服要从网易图片服务器取
const LEGACY_SIZES = [32, 64, 128, 256, 512];
export function eveImage(path, size = 64) {
  if (!IS_TQ) {
    const m = /^(characters|corporations|alliances)\/(\d+)\/(portrait|logo)$/.exec(path);
    if (m) {
      const s = LEGACY_SIZES.find((x) => x >= size) || 512;
      const kind = { characters: 'Character', corporations: 'Corporation', alliances: 'Alliance' }[m[1]];
      return `https://image.evepc.163.com/${kind}/${m[2]}_${s}.${kind === 'Character' ? 'jpg' : 'png'}`;
    }
  }
  return `https://images.evetech.net/${path}?size=${size}`;
}
