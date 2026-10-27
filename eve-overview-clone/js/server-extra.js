// ===== 国服（晨曦 / 曙光）独有的舰船、装备、技能等 =====
// CCP 的 SDE 里没有这些物品，由 server/build_cn_extra.py 从网易 ESI 生成 cn-extra-<服>.json，
// 切到对应服务器时并入物品目录（catalog）、装配数据（fit）和技能页（skills）。宁静服不加载。
import { SERVER, IS_TQ } from './server.js?v=s4';

let extraP = null;
export function serverExtra() {
  if (IS_TQ) return Promise.resolve(null);
  if (!extraP) {
    extraP = fetch(`./cn-extra-${SERVER.id}.json?v=2`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return extraP;
}

// 国服独有物品在 images.evetech.net 上没有图标，改从网易图片服务器取（只有 32 / 64 两种尺寸）
const TYPE_IMG = /^https:\/\/images\.evetech\.net\/types\/(\d+)\/(icon|render|bp|bpc)(?:\?size=(\d+))?$/;
export function cnTypeImage(src) {
  if (IS_TQ || !SERVER.image) return null;
  const m = TYPE_IMG.exec(src);
  if (!m) return null;
  return `${SERVER.image}/Type/${m[1]}_${Number(m[3] || 64) <= 32 ? 32 : 64}.png`;
}
