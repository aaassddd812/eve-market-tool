// EVE 日志增量扫描（纯被动，开着程序就在后台跑，每 5 秒一轮，只读）：
//   游戏日志 Gamelogs：赏金挂账「… ISK added to next bounty payout」/「… 星币 … 添加到下一次赏金支付」、
//     采矿「You (successfully) mined 1,234 units of 凡晶石」/ 中文「开采 / 采集 / 采掘 / 采矿 / 挖掘」几种说法。
//     记账原则：只累计逐笔挂账的赏金与采矿产出；20 分钟一次的赏金结算（钱包流水）不再算一次收入，不会重复计。
//   聊天日志 Chatlogs 的本地频道：「Channel changed to Local : 吉他」/「频道更换为 本地：吉他」= 角色所在位置的证据，
//     深渊里本地频道会换成一个不是任何星系的名字，用来推断每一趟进出深渊（views/abyss.js 的 rebuildFromLogs）。
// 增量读取：每个文件记住读到的位置，每轮只读之后的内容，一次最多 2MB，只处理到最后一个完整的行（UTF-16 按两字节对齐），
//   读到半行或半个字符就留到下一轮；文件开头（最多 8KB）的 SHA-256 作指纹，同名文件被新会话重写时从头再读。
//   编码：有 BOM 按 BOM，没有时看零字节比例判断 UTF-16LE / UTF-8。
// 记录存在本机（lite-logscan），保留 30 天。
import { invoke, store, inApp } from './platform.js';

const KEY = 'lite-logscan';
const CHUNK = 2 << 20;
const FP_LEN = 8192;
const KEEP = 30 * 864e5;
const S = store.get(KEY, null) || { files: {}, bounty: [], mine: [], loc: [] };
let dir = null, running = false, timer = null, lastScan = 0, lastErr = '';
const subs = new Set();
export const onScan = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export const status = () => ({ dir, lastScan, lastErr, files: Object.keys(S.files).length, inApp });

const TS = /^﻿?\[\s*(\d{4})\.(\d\d)\.(\d\d) (\d\d):(\d\d):(\d\d)\s*\]\s*(.*)$/;
const strip = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const num = (s) => Number(String(s).replace(/[,\s ']/g, '')) || 0;
const BOUNTY = [/([\d,.\s]+?)\s*ISK added to next bounty payout/i, /([\d,.\s]+?)\s*星币.*?添加到下一次赏金支付/];
const MINE = [
  /You (?:successfully )?mined ([\d,]+) units? of (.+?)(?:,? (?:with a lost residue|and lost|but lost).*)?\.?$/i,
  /(?:你|您)?(?:成功)?(?:开采|采集|采掘|采矿|挖掘)(?:了|到|出)?\s*([\d,]+)\s*(?:个)?单位(?:的)?\s*(.+?)(?:[，,。].*)?$/
];
const LOCAL = /(?:Channel changed to Local|频道更换为\s*本地)\s*[:：]\s*(.+?)\s*\*?$/i;

function encOf(b) {
  if (b[0] === 0xff && b[1] === 0xfe) return { enc: 'utf-16le', bom: 2 };
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { enc: 'utf-8', bom: 3 };
  let zero = 0;
  const n = Math.min(b.length, 2000);
  for (let i = 1; i < n; i += 2) if (b[i] === 0) zero++;
  return { enc: n && zero > n / 4 ? 'utf-16le' : 'utf-8', bom: 0 };
}
async function sha(bytes) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...h.slice(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const read = async (sub, name, offset, len) => new Uint8Array(await invoke('logs_read', { sub, name, offset, len }));

// 最后一个完整行的结束位置（不含换行之后的部分）；UTF-16 只认偶数位置上的 0A 00
function lastLineEnd(b, utf16) {
  if (utf16) { for (let i = (b.length & ~1) - 2; i >= 0; i -= 2) if (b[i] === 0x0a && b[i + 1] === 0) return i + 2; return 0; }
  const i = b.lastIndexOf(0x0a);
  return i < 0 ? 0 : i + 1;
}

function parseLines(text, f, sub) {
  for (const raw of text.split(/\r?\n/)) {
    if (!f.who) {
      const w = /Listener:\s*(.+)/.exec(raw);
      if (w) { f.who = w[1].trim(); continue; }
    }
    const m = TS.exec(raw);
    if (!m) continue;
    const t = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    if (Date.now() - t > KEEP) continue;
    const body = strip(m[7]);
    const who = f.cid || f.who;
    if (sub === 'Chatlogs') {
      const l = LOCAL.exec(body);
      if (l) S.loc.push([t, who, l[1]]);
      continue;
    }
    let hit = null;
    for (const re of BOUNTY) if ((hit = re.exec(body))) break;
    if (hit) { const v = num(hit[1]); if (v > 0) S.bounty.push([t, who, v]); continue; }
    for (const re of MINE) if ((hit = re.exec(body))) break;
    if (hit) { const q = num(hit[1]); if (q > 0) S.mine.push([t, who, hit[2].replace(/\*+$/, '').trim(), q]); }
  }
}

async function scanFile(sub, name, size) {
  const key = sub + '/' + name;
  let f = S.files[key];
  if (f && f.off === size) return false;
  const head = await read(sub, name, 0, Math.min(FP_LEN, size));
  if (f && f.fpLen && head.length >= f.fpLen && (await sha(head.subarray(0, f.fpLen))) !== f.fp) f = null;   // 同名文件被新会话重写
  if (f && size < f.off) f = null;
  if (!f) {
    const cid = Number((/_(\d{5,})\.txt$/i.exec(name) || [])[1]) || 0;
    f = { ...encOf(head), off: 0, fp: await sha(head), fpLen: head.length, cid, who: '' };
    S.files[key] = f;
  } else if (f.fpLen < FP_LEN && head.length > f.fpLen) {
    f.fp = await sha(head); f.fpLen = head.length;   // 文件还小时的指纹：变大后换成完整 8KB 的
  }
  const utf16 = f.enc === 'utf-16le';
  let changed = false;
  while (f.off < size) {
    const start = f.off === 0 ? f.bom : f.off;
    const chunk = await read(sub, name, start, Math.min(CHUNK, size - start));
    let end = lastLineEnd(chunk, utf16);
    if (!end) {
      if (chunk.length < CHUNK) break;   // 半行：等下一轮
      end = chunk.length & (utf16 ? ~1 : ~0);   // 一整块都没有换行（异常）：跳过，免得卡住
    }
    parseLines(new TextDecoder(f.enc).decode(chunk.subarray(0, end)), f, sub);
    f.off = start + end;
    changed = true;
    if (chunk.length < CHUNK) break;
  }
  return changed;
}

export async function scanOnce() {
  if (running) return;
  running = true;
  try {
    dir ||= await invoke('logs_dir');
    if (!dir) { lastErr = '没有找到 EVE 日志文件夹（文档\\EVE\\logs）'; return; }
    let changed = false;
    const [game, chat] = await Promise.all([invoke('logs_list', { sub: 'Gamelogs' }), invoke('logs_list', { sub: 'Chatlogs' })]);
    for (const [name, size] of game) if (await scanFile('Gamelogs', name, size).catch(() => false)) changed = true;
    for (const [name, size] of chat) if (/^(Local|本地)_/i.test(name) && await scanFile('Chatlogs', name, size).catch(() => false)) changed = true;
    lastErr = '';
    lastScan = Date.now();
    if (changed) {
      const cut = Date.now() - KEEP;
      S.bounty = S.bounty.filter((e) => e[0] >= cut).slice(-40000);
      S.mine = S.mine.filter((e) => e[0] >= cut).slice(-40000);
      S.loc = dedupeLoc(S.loc.filter((e) => e[0] >= cut));
      // 8 天前的文件 logs_list 不再列出：记录也删掉
      const live = new Set([...game.map(([n]) => 'Gamelogs/' + n), ...chat.map(([n]) => 'Chatlogs/' + n)]);
      for (const k of Object.keys(S.files)) if (!live.has(k)) delete S.files[k];
      store.set(KEY, S);
    }
    subs.forEach((fn) => { try { fn(changed); } catch (e) { console.error(e); } });
  } catch (e) {
    lastErr = String(e?.message || e);
  } finally {
    running = false;
  }
}
// 位置证据去重（同一角色、同一秒、同一频道名只留一条），按时间排序：重复、乱序到达都不影响
function dedupeLoc(list) {
  const seen = new Set();
  return list.filter((e) => { const k = e.join('|'); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a[0] - b[0]);
}

export function start() {
  if (timer || !inApp && !window.__MOCK_INVOKE__) return;
  scanOnce();
  timer = setInterval(scanOnce, 5000);
}

// 查询：who 是角色 ID 或角色名（较早的客户端日志文件名里没有角色 ID，只能用 Listener 名字）
const match = (who, acc) => who === acc.character_id || who === acc.character_name;
export const bounties = (accs, from, to = Infinity) => S.bounty.filter((e) => e[0] >= from && e[0] <= to && accs.some((a) => match(e[1], a)));
export const minings = (accs, from, to = Infinity) => S.mine.filter((e) => e[0] >= from && e[0] <= to && accs.some((a) => match(e[1], a)));
export const locations = (acc) => S.loc.filter((e) => match(e[1], acc));
