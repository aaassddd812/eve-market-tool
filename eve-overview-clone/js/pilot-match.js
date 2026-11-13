// ===== 驾驶模拟 · 匹配对战的连接（WebSocket /api/match/ws，服务 server/match_service.mjs）=====
// 只管连接和排队状态；对局画面、每一步怎么走在 pilot.js（用 match-sim.js，和服务器同一套代码）。
// MT.state：off 未连接 · connecting 连接中 · idle 已登录 · queued 排队中 · room 在邀请码房间里 · match 对局中
// 本地测试：localStorage「eve-match-url」改服务地址；「eve-match-dev」= 名字 时用开发令牌（服务器设了 EVE_MATCH_DEV_SKILLS 才认）
import { SERVER } from './server.js?v=s4';

export const MT = { ws: null, state: 'off', me: null, err: '', queued: null, room: null, rooms: null, H: null, getToken: null, mid: null, retry: 0, timer: 0 };
const ls = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const url = () => ls('eve-match-url') || `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/match/ws`;
// 公开预设（HTTP，不用登录）：本地测试时跟着「eve-match-url」走
const api = (p) => (ls('eve-match-url') || '').replace(/^ws/, 'http').replace(/\/api\/match\/ws.*$/, '') + '/api/match/' + p;
async function getJson(p) {
  const r = await fetch(api(p), { cache: 'no-store' });
  if (!r.ok) throw new Error(r.status === 404 ? '预设不存在或已被删除' : '读取失败（' + r.status + '）');
  return r.json();
}
export const fetchPresets = () => getJson(`presets?server=${SERVER.id}`);
export const fetchPreset = (id) => getJson(`preset?server=${SERVER.id}&id=${encodeURIComponent(id)}`);
const set = (k, v = {}) => { Object.assign(MT, { state: k }, v); MT.H?.onState?.(); };

export function matchSend(m) {
  if (MT.ws?.readyState === 1) MT.ws.send(JSON.stringify(m));
}
// H = { onState, onMatch(m), onGo, onTick(m), onEnd(m), onLost, onErr(m), onRooms, onPreset(m) }；getToken() → { character_id, access_token }
export function matchConnect(H, getToken) {
  MT.H = H;
  MT.getToken = getToken;
  if (MT.ws && MT.ws.readyState <= 1) return Promise.resolve(MT.state !== 'connecting');
  return open();
}
async function open() {
  set('connecting', { err: '' });
  let hello;
  try {
    const dev = ls('eve-match-dev');
    if (dev) hello = { op: 'hello', server: SERVER.id, id: Number(ls('eve-match-dev-id')) || 1, token: 'dev', name: dev };
    else {
      const t = await MT.getToken();
      if (!t?.access_token) throw new Error('要先绑定 EVE 角色（ESI）');
      hello = { op: 'hello', server: SERVER.id, id: t.character_id, token: t.access_token };
    }
  } catch (e) { set('off', { err: e.message }); return false; }
  return new Promise((done) => {
    let ws;
    try { ws = new WebSocket(url()); } catch (e) { set('off', { err: '连不上匹配服务：' + e.message }); done(false); return; }
    MT.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify(hello));
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.op === 'tick') { MT.H?.onTick?.(m); return; }
      if (m.op === 'hi') { MT.retry = 0; MT.me = { id: m.id, name: m.name }; if (MT.state === 'connecting') set('idle'); done(true); return; }
      if (m.op === 'err') { if (MT.H?.onErr?.(m)) return; MT.err = m.msg; if (m.fatal) { MT.fatal = true; ws.close(); } MT.H?.onState?.(); return; }
      if (m.op === 'rooms') { MT.rooms = m.list; MT.H?.onRooms?.(); return; }
      if (m.op === 'preset_ok') { MT.H?.onPreset?.(m); return; }
      if (m.op === 'queued') { set('queued', { queued: m, room: null, err: '' }); return; }
      if (m.op === 'room') { set('room', { room: m, err: '' }); return; }
      if (m.op === 'idle') { if (MT.state !== 'match') set('idle', { queued: null, room: null }); return; }
      if (m.op === 'match') { set('match', { mid: m.mid, queued: null, room: null, err: '' }); MT.H?.onMatch?.(m); return; }
      if (m.op === 'go') { MT.H?.onGo?.(); return; }
      if (m.op === 'end') { set('idle', { mid: null }); MT.H?.onEnd?.(m); }
    };
    ws.onclose = () => {
      const was = MT.state;
      MT.ws = null;
      done(false);
      // 对局中断线：自动重连（服务器会接回原来的对局）
      if ((was === 'match' || (was === 'connecting' && MT.mid)) && !MT.fatal && MT.retry < 10) {
        MT.retry++;
        MT.H?.onLost?.(MT.retry);
        clearTimeout(MT.timer);
        const mid = MT.mid;
        // 重连后服务器会先回 hi 再发 match（接回对局）；3 秒没发说明对局已经结束了
        MT.timer = setTimeout(() => open().then((ok) => { if (ok) setTimeout(() => { if (MT.state !== 'match' && MT.mid === mid) { MT.mid = null; MT.H?.onEnd?.({ op: 'end', winner: null, reason: 'lost', stats: [] }); } }, 3000); }), 1500 * MT.retry);
        MT.state = 'match';
        return;
      }
      MT.fatal = false;
      set('off', { queued: null, room: null, mid: null, err: MT.err || (was === 'connecting' ? '连不上匹配服务' : '') });
    };
  });
}
export function matchClose() {
  clearTimeout(MT.timer);
  MT.retry = 99;
  MT.ws?.close();
}
