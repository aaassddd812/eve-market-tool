// 游戏服务器（与网站 eve-overview-clone/js/server.js 一致的部分）：宁静 / 晨曦 / 曙光
// 本站（SITE）提供：ESI 应用配置（Client ID、回调地址、权限）、网易登录的设备 ID 与换令牌转发、宁静服价格汇总、物品中文名
import { store } from './platform.js';

export const SITE = 'https://eve.navexor.top';

export const SERVERS = {
  tq: {
    id: 'tq', name: '宁静', sub: '国际服',
    esi: 'https://esi.evetech.net/latest', datasource: 'tranquility',
    sso: 'https://login.eveonline.com/v2/oauth',
    tokenProxy: false, needDevice: false, manualCallback: false, authParams: {},
    sitePrices: true, image: null,
    hub: { region: 10000002, name: '吉他' }
  },
  serenity: {
    id: 'serenity', name: '晨曦', sub: '国服',
    esi: 'https://ali-esi.evepc.163.com/latest', datasource: 'serenity',
    sso: 'https://login.evepc.163.com/v2/oauth',
    tokenProxy: true, needDevice: true, manualCallback: true, authParams: { realm: 'ESI' },
    sitePrices: false, image: 'https://image.evepc.163.com',
    hub: { region: 10000002, name: '吉他' }
  },
  infinity: {
    id: 'infinity', name: '曙光', sub: '国服',
    esi: 'https://ali-esi.evepc.163.com/latest', datasource: 'infinity',
    sso: 'https://login-infinity.evepc.163.com/v2/oauth',
    tokenProxy: true, needDevice: true, manualCallback: true, authParams: { realm: 'ESI' },
    sitePrices: false, image: 'https://image-infinity.evepc.163.com',
    hub: { region: 10000016, name: '索巴色基' }
  }
};

const KEY = 'lite-server';
export let SERVER = SERVERS[store.get(KEY, 'tq')] || SERVERS.tq;
export const serverQs = () => (SERVER.id === 'tq' ? '' : '?server=' + SERVER.id);
export function setServer(id) { store.set(KEY, id); location.reload(); }

// 本程序要用的 ESI 权限（与本站应用已申请的权限取交集）
export const SCOPES = [
  'esi-wallet.read_character_wallet.v1', 'esi-skills.read_skills.v1', 'esi-skills.read_skillqueue.v1',
  'esi-assets.read_assets.v1', 'esi-markets.read_character_orders.v1', 'esi-location.read_location.v1',
  'esi-location.read_ship_type.v1', 'esi-location.read_online.v1', 'esi-universe.read_structures.v1'
];

// 头像：国服用网易图片服务器的旧格式（Character/ID_128.jpg）；物品图标各服通用
export function portrait(id, size = 128) {
  if (SERVER.id === 'tq') return `https://images.evetech.net/characters/${id}/portrait?size=${size}`;
  const s = [32, 64, 128, 256, 512].find((x) => x >= size) || 512;
  return `${SERVER.image}/Character/${id}_${s}.jpg`;
}
export const typeIcon = (id, size = 32) => `https://images.evetech.net/types/${id}/icon?size=${size}`;
