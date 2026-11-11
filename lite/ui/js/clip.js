// 剪贴板监控：玩家在游戏里全选货柜按 Ctrl+C，清单自动交给深渊收益（views/abyss.js）记账。
//   每 750 毫秒问一次程序 Windows 剪贴板序号（clip_seq，每次复制加一），没变就跳过；变了再读文本（clip_text）。
//   剪贴板被占着（游戏刚复制大清单）时读不到，同一个序号最多重试 3 次；不清空、不改写剪贴板。
//   只收「含制表符、不超过 100KB」的文本：游戏复制的物品清单是制表符分隔的，聊天记录、网址不会被误记。
//   每批带一个 capture_id；和上一批内容完全相同的不重复交出去。
import { invoke, inApp } from './platform.js';

const MAX = 100 * 1024;
const SAFE = Number.MAX_SAFE_INTEGER;
let timer = null, lastSeq = null, tries = 0, lastText = '';
const subs = new Set();
export const onCapture = (fn) => { subs.add(fn); return () => subs.delete(fn); };

// 一行一项：剥掉 BOM、游戏在物品名前标的 *（非法 / 损坏标记），数量去千分位，钳在安全整数以内；没有数量的按 1
export function clipboardRows(text) {
  const rows = [];
  for (let line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    line = line.replace(/^﻿/, '');
    if (!line.trim()) continue;
    const cols = line.split('\t');
    const name = cols[0].replace(/^\*+\s*/, '').replace(/\*+$/, '').trim();
    if (!name) continue;
    const q = (cols[1] || '').replace(/[\s,. ']/g, '');
    rows.push({ name, qty: /^\d+$/.test(q) ? Math.min(Number(q), SAFE) : 1 });
  }
  return rows;
}

async function poll() {
  let seq;
  try { seq = await invoke('clip_seq'); } catch { return; }
  if (lastSeq === null) { lastSeq = seq; return; }   // 程序刚打开时剪贴板里原有的内容不算
  if (seq === lastSeq) return;
  let text;
  try { text = await invoke('clip_text'); } catch { text = null; }
  if (text == null) { if (++tries < 3) return; tries = 0; lastSeq = seq; return; }   // 被占用：下一轮再读
  tries = 0;
  lastSeq = seq;
  if (!text || text.length > MAX || !text.includes('\t') || text === lastText) return;
  lastText = text;
  const rows = clipboardRows(text);
  if (!rows.length) return;
  const capture = { id: crypto.randomUUID(), at: Date.now(), text, rows };
  subs.forEach((fn) => { try { fn(capture); } catch (e) { console.error(e); } });
}

export function start() {
  if (timer || !inApp && !window.__MOCK_INVOKE__) return;
  timer = setInterval(poll, 750);
}
export function stop() { clearInterval(timer); timer = null; }
