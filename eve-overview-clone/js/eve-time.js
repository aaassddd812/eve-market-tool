// ===== 时间显示：北京时间（UTC+8，默认）/ EVE 游戏内时间（UTC）=====
// 与浏览器所在时区无关，按固定偏移换算；选择存在 localStorage（eve-time-zone：cn | eve），战场统计的时间切换用它。
const KEY = 'eve-time-zone';
let tz = 'cn';
try { if (localStorage.getItem(KEY) === 'eve') tz = 'eve'; } catch { /* 忽略 */ }

export const getTz = () => tz;
export function setTz(v) {
  tz = v === 'eve' ? 'eve' : 'cn';
  try { localStorage.setItem(KEY, tz); } catch { /* 忽略 */ }
}
const OFF = { cn: 8 * 3600, eve: 0 };
export const tzOffset = (z = tz) => OFF[z];
export const tzLabel = (z = tz) => (z === 'cn' ? 'UTC+8' : 'EVE');
// sec：Unix 秒；返回 ISO 形式的「YYYY-MM-DDTHH:MM:SS」（已按时区偏移）
export const isoIn = (sec, z = tz) => new Date((sec + OFF[z]) * 1000).toISOString().slice(0, 19);
// datetime-local 输入框的值（按所选时区理解）→ Unix 秒
export const parseIn = (v, z = tz) => (v ? Math.floor(Date.parse(v.slice(0, 16) + ':00Z') / 1000) - OFF[z] : NaN);
// 完整时间「YYYY-MM-DD HH:MM:SS」
export const fullIn = (sec, z = tz) => isoIn(sec, z).replace('T', ' ');
