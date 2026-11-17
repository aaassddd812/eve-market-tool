// 桌面版原生引擎（可选组件，CCP 开源引擎 trinity）：战场模拟可以另开一个原生渲染的窗口，和网页 3D 画面同步。
// 网页还是模拟的“大脑”：sim-3d 每帧把相机、船位、朝向交给这里（view.setNative），这里经桌面版的 native_send 转给原生进程
// （desktop/src-tauri/src/native.rs → host/bridge.py）。组件第一次用时下载（约 120 MB），以后直接启动。
// 桌面版 1.0.18 起才有这些命令；旧版本、浏览器里 supported() 为假，界面不显示入口。
const FROM = [1, 0, 18];
// 桥协议版本（host/bridge.py 开头的消息格式；它在 ready 消息里带 proto），对不上时提示一句，照样接着画
const PROTO = 3;
const ipc = () => {
  const v = String(window.__EVE_DESKTOP__ || '').split('.').map(Number);
  if (!window.__TAURI_INTERNALS__ || v.length < 3) return null;
  for (let i = 0; i < 3; i++) if (v[i] !== FROM[i]) return v[i] > FROM[i] ? window.__TAURI_INTERNALS__ : null;
  return window.__TAURI_INTERNALS__;
};
export const supported = () => Boolean(ipc());
export const status = () => ipc().invoke('native_status');

// 下载安装；onProgress({ stage, done, total })：stage = manifest / download / verify / extract
export async function install(onProgress) {
  const job = ipc().invoke('native_install');
  let finished = false;
  job.then(() => { finished = true; }, () => { finished = true; });
  while (!finished) {
    await new Promise((r) => setTimeout(r, 400));
    try { const s = await status(); if (s.download && !finished) onProgress?.(s.download); } catch { /* 查不到进度不要紧 */ }
  }
  return job;
}

// 当前连接：view（sim-3d 的视图）、轮询定时器
let cur = null;
export const running = () => Boolean(cur);

// 原生进程退出（native_poll 的 exit 消息：code 退出码、codeText、killed 被桌面版结束、log 日志最后几行）时给用户的提示：
// 自己关了窗口只提一句；出错时报错提示的「提交工单」附上日志。返回 [文字, 类型, 附在工单里的详情]
export function exitNotice(m) {
  if (m?.killed) return ['原生引擎没有响应，已结束，画面照常用网页渲染', 'error', logDetail(m.log)];
  if (m?.code === 0) return ['原生引擎窗口已关闭，画面照常用网页渲染', 'info', ''];
  return [`原生引擎意外退出（退出码 ${m?.codeText ?? '?'}），画面照常用网页渲染`, 'error', logDetail(m?.log)];
}
// 启动 / 下载出错：桌面版把日志最后几行接在「\n---\n」后面
export function errorNotice(e) {
  const [msg, log] = String(e?.message || e).split('\n---\n');
  return [`原生引擎：${msg}`, 'error', logDetail(log)];
}
const logDetail = (log) => (log ? `原生引擎日志（最后几行）：\n${log}` : '');

// 启动原生窗口并接到 view 上；hooks.onStatus({ ships, built, busy, fps })、hooks.onExit(退出消息，见 exitNotice；网页这边主动关的没有)、
// hooks.onWarn(文字)：组件和网页的协议版本对不上；hooks.gfx：画质 auto / high / medium / low（不给 = auto）
export async function connect(view, hooks = {}) {
  if (cur) disconnect();
  const scene = view.nativeScene?.() || null;
  await ipc().invoke('native_start', { scene, rect: null, gfx: hooks.gfx || null });
  let pending = false, latest = null;
  const flush = () => {
    if (pending || !latest) return;
    const text = latest;
    latest = null;
    pending = true;
    ipc().invoke('native_send', { text }).then((ok) => { pending = false; if (!ok) lost(); else flush(); }, () => { pending = false; lost(); });
  };
  const send = (msg) => { latest = latest ? `${latest}\n${JSON.stringify(msg)}` : JSON.stringify(msg); flush(); };
  // 每帧只留最新的一帧（上一帧还没发出去就替换掉）；船清单、场景、事件这类消息不能丢，跟在后面一起发
  const sink = {
    frame(f) {
      const msg = JSON.stringify({ t: 'frame', ...f });
      if (latest && latest.includes('"t":"frame"')) latest = latest.split('\n').filter((l) => !l.includes('"t":"frame"')).concat(msg).join('\n');
      else latest = latest ? `${latest}\n${msg}` : msg;
      flush();
    },
    ships(list) { send({ t: 'ships', list }); },
    scene(path) { send({ t: 'scene', path }); },
    fx(ev) { send({ t: 'fx', ev }); },   // 开火、导弹、阵亡等事件（不能丢）
  };
  const me = { view, hooks, timer: 0 };
  // exit：原生进程自己退出的退出消息；网页这边主动关（disconnect）时为空
  const stop = (exit = null) => {
    if (cur !== me) return;
    clearInterval(me.timer);
    cur = null;
    view.setNative(null);
    hooks.onExit?.(exit);
  };
  const handle = (lines) => {
    for (const l of lines) {
      let m;
      try { m = JSON.parse(l); } catch { continue; }
      if (m.t === 'status') hooks.onStatus?.(m);
      else if (m.t === 'ready' && m.proto !== PROTO) hooks.onWarn?.('原生引擎组件和网页版本不一致，部分特效可能不显示');
      else if (m.t === 'exit') { stop(m); return true; }
    }
    return false;
  };
  // 发不出去：桌面版已结束原生进程，再取一次消息拿退出信息
  const lost = () => {
    if (cur !== me) return;
    ipc().invoke('native_poll').then((lines) => { if (!handle(lines)) stop({ killed: true }); }, () => stop({ killed: true }));
  };
  me.stop = () => stop();
  me.timer = setInterval(() => { ipc().invoke('native_poll').then(handle, () => {}); }, 400);
  cur = me;
  view.setNative(sink);
}

export function disconnect() {
  if (!cur) return;
  const me = cur;
  me.stop();
  ipc()?.invoke('native_stop').catch(() => {});
}
