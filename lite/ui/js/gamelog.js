// EVE 游戏日志（文档\EVE\logs\Gamelogs\*.txt，只读，经程序的 logs_* 命令）：
//   编码多为 UTF-16LE（也兼容 UTF-8）；文件开头有「Listener: 角色名」「Session Started: 2026.11.11 03:20:00」；每行「[ 2026.11.11 03:21:05 ] (combat) …」，时间是 EVE 时间（UTC）。
//   战斗行去掉标签后形如「350 to 目标 - 武器 - 命中」「120 from 敌人 - 武器 - 擦过」（中文客户端为「对 / 来自」）。
// 日志里没有捡到的战利品，所以收益靠粘贴货柜；这里只给某段时间内的战斗统计（造成 / 受到伤害、命中次数、第一 / 最后一次交火、
// 打得最多的目标）和这段时间里的系统提示（notify），用来核对每一趟的实际战斗时间。
import { invoke } from './platform.js';

const LINE = /^\[ (\d{4})\.(\d\d)\.(\d\d) (\d\d):(\d\d):(\d\d) \] \(([a-z]+)\) (.*)$/;
const COMBAT = /^([\d,.]+)\s+(to|from|对|来自)\s+(.+?)(?:\s+-\s+(.+?))?(?:\s+-\s+(.+))?$/i;
const strip = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const OUT = new Set(['to', '对']);

function decode(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  // 没有 BOM：零字节多就是 UTF-16LE（游戏日志常见），否则 UTF-8
  let zero = 0;
  const n = Math.min(b.length, 2000);
  for (let i = 1; i < n; i += 2) if (b[i] === 0) zero++;
  return new TextDecoder(n && zero > n / 4 ? 'utf-16le' : 'utf-8').decode(b);
}
async function readAll(name, size) {
  const parts = [];
  for (let off = 0; off < size; off += 4 << 20) parts.push(new Uint8Array(await invoke('logs_read', { sub: 'Gamelogs', name, offset: off, len: Math.min(4 << 20, size - off) })));
  const all = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.length; }
  return decode(all.buffer);
}

// 文件名「20261111_032000_<角色ID>.txt」（较早的客户端没有角色 ID）：开始时间按 UTC 解析
function fileStart(name) {
  const m = /^(\d{4})(\d\d)(\d\d)_(\d\d)(\d\d)(\d\d)/.exec(name);
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
}

export const logsDir = () => invoke('logs_dir');

const headCache = new Map();   // 文件名 -> 角色名
async function listener(name) {
  if (!headCache.has(name)) {
    let who = '';
    try { who = (/Listener:\s*(.+)/.exec(decode(await invoke('logs_read', { sub: 'Gamelogs', name, offset: 0, len: 800 })))?.[1] || '').trim(); } catch { /* 读不到 */ }
    headCache.set(name, who);
  }
  return headCache.get(name);
}

// 某角色在 [from, to] 内的战斗统计；没有日志文件夹 / 没有对应日志时返回 { error }
export async function combatStats(charId, charName, from, to) {
  let files;
  try { files = await invoke('logs_list', { sub: 'Gamelogs' }); } catch (e) { return { error: String(e.message || e) }; }
  // 开始时间在这一趟结束之前、且不早于开始前 1 天的文件（一次登录一个文件，可能连续跑很多趟）
  const cands = files.map(([name, size]) => ({ name, size, t: fileStart(name) }))
    .filter((f) => f.t && f.t <= to && f.t >= from - 864e5 && (!/_\d+\.txt$/i.test(f.name) || f.name.endsWith('_' + charId + '.txt')))
    .sort((a, b) => b.t - a.t);
  const st = { dmgOut: 0, dmgIn: 0, hitsOut: 0, hitsIn: 0, first: 0, last: 0, targets: new Map(), notes: [], files: 0 };
  for (const f of cands) {
    if ((await listener(f.name)) !== charName) continue;
    st.files++;
    const text = await readAll(f.name, f.size);
    for (const line of text.split(/\r?\n/)) {
      const m = LINE.exec(line);
      if (!m) continue;
      const t = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
      if (t < from || t > to) continue;
      const body = strip(m[8]);
      if (m[7] === 'notify' || m[7] === 'info') { if (st.notes.length < 40) st.notes.push({ t, text: body }); continue; }
      if (m[7] !== 'combat') continue;
      const c = COMBAT.exec(body);
      if (!c) continue;
      const dmg = Number(c[1].replace(/[,.]/g, '')) || 0;
      if (OUT.has(c[2].toLowerCase())) {
        st.dmgOut += dmg; st.hitsOut++;
        st.targets.set(c[3], (st.targets.get(c[3]) || 0) + dmg);
      } else { st.dmgIn += dmg; st.hitsIn++; }
      st.first = st.first ? Math.min(st.first, t) : t;
      st.last = Math.max(st.last, t);
    }
  }
  if (!st.files) return { error: '没有找到这个角色在这段时间的游戏日志' };
  return { ...st, targets: [...st.targets].sort((a, b) => b[1] - a[1]).slice(0, 6) };
}
