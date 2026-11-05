// ===== 分享图片：共用的配色、Canvas 小工具与预览弹窗 =====
// 战场统计、击杀详情、人物 / 军团 / 联盟页的分享图片都用这里的配色与弹窗；图片宽 1200，按 2 倍像素输出。
// 头像、图标来自 images.evetech.net（允许跨域），加载失败时画占位色块。
export const W = 1200, SCALE = 2;
export const THEMES = {
  light: {
    bg: '#eef1f6', panel: '#ffffff', panel2: '#f2f4f8', line: '#e2e7ef', text: '#141a26', sub: '#4a5568', muted: '#8a94a6',
    a: '#2f6fe0', b: '#e0413e', aDeep: '#1f4fb0', bDeep: '#b42a28', loss: '#d23c39', good: '#16a06a', gold: '#c98a12', tint: 0.07, glow: 0.10
  },
  dark: {
    bg: '#0b0f17', panel: '#131b28', panel2: '#1a2435', line: '#253047', text: '#e6edf7', sub: '#a3b0c3', muted: '#6f7d93',
    a: '#4f8ff7', b: '#f0524f', aDeep: '#2f5fb3', bDeep: '#a7302e', loss: '#f3a0a0', good: '#3ccf8e', gold: '#f0b43c', tint: 0.10, glow: 0.20
  }
};
const THEME_KEY = 'eve-share-image-theme';   // 图片配色，默认浅色

// 同一张图切换配色时不重复下载；失败的不缓存（下次生成再试）
// 一张图可能要上百个头像 / 图标，两条路：直连图片服务器，或走本站中转（/api/kb/img，服务器端取图并缓存）。
// 第一次生成时同一张图两条路同时取一次，谁先到以后就先走谁（各地网络不同：有的直连快，有的直连很慢），失败再换另一条；
// 同时最多下载 12 个，每次超时 10 秒，尽量都画进图里
const imageCache = new Map();
const LIMIT = 12;
let active = 0;
const waiting = [];
const slot = () => (active < LIMIT ? (active++, Promise.resolve()) : new Promise((r) => waiting.push(r)));
const release = () => { const next = waiting.shift(); if (next) next(); else active--; };
function tryLoad(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const timer = setTimeout(() => { img.src = ''; resolve(null); }, 10000);
    img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth ? img : null); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = src;
  });
}
const viaProxy = (url) => '/api/kb/img?u=' + encodeURIComponent(url);
// 直连时加参数区分缓存：避免复用页面里不带跨域头的缓存导致画布被污染
const direct = (url, n) => url + (url.includes('?') ? '&' : '?') + 'cors=' + n;
const PROXIED = /^https:\/\/(images\.evetech\.net|image\.evepc\.163\.com)\//;
let route = null;   // Promise<'proxy' | 'direct'>：本页测出的较快线路
function pickRoute(url) {
  if (!route) {
    route = new Promise((resolve) => {
      let done = false;
      const tag = Date.now().toString(36);   // 两边都不用缓存，比的是真实速度
      const win = (r) => (img) => { if (img && !done) { done = true; resolve(r); } };
      Promise.all([tryLoad(viaProxy(url) + '&probe=' + tag).then(win('proxy')), tryLoad(direct(url, 'p' + tag)).then(win('direct'))])
        .then(() => { if (!done) { route = null; resolve('proxy'); } });   // 都失败：这次先走中转，下次重测
    });
  }
  return route;
}
export function loadImage(url) {
  if (!url) return Promise.resolve(null);
  if (!imageCache.has(url)) {
    const p = (async () => {
      const proxied = PROXIED.test(url);
      const fast = proxied ? await pickRoute(url) : 'direct';
      await slot();
      try {
        const tries = !proxied ? [direct(url, 1), direct(url, 2)]
          : fast === 'proxy' ? [viaProxy(url), direct(url, 1), viaProxy(url) + '&r=2'] : [direct(url, 1), viaProxy(url), direct(url, 2)];
        for (const src of tries) {
          const img = await tryLoad(src);
          if (img) return img;
        }
        return null;
      } finally { release(); }
    })();
    imageCache.set(url, p);
    p.then((img) => { if (!img) imageCache.delete(url); });
  }
  return imageCache.get(url);
}
// 预览弹窗生成图片期间设置：每下载完一张回调 (已完成, 总数)，弹窗里显示进度
let progress = null;
export async function loadImages(urls) {
  const list = [...new Set(urls)].filter(Boolean);
  const report = progress;
  let done = 0;
  report?.(0, list.length);
  return new Map(await Promise.all(list.map(async (u) => {
    const img = await loadImage(u);
    report?.(++done, list.length);
    return [u, img];
  })));
}

// 图片页脚里的网址：本地 / 演示 / 桌面版都写正式站网址
export const SITE = /^https?:$/.test(location.protocol) && !/^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname) ? location.host : 'eve.navexor.top';
// 页脚左侧的站点胶囊：站名 + 网址（醒目），基线在 y；返回宽度
export function siteMark(g, C, x, y, family) {
  const name = 'EVE 市场总览';
  g.font = font(700, 14, family);
  const nw = g.measureText(name).width;
  g.font = font(700, 14, family);
  const uw = g.measureText(SITE).width;
  const w = 16 + nw + 12 + uw + 16;
  rr(g, x, y - 20, w, 30, 15);
  g.fillStyle = C.panel;
  g.fill();
  g.textAlign = 'left';
  g.fillStyle = C.text;
  g.fillText(name, x + 16, y);
  g.fillStyle = C.a;
  g.fillText(SITE, x + 16 + nw + 12, y);
  return w;
}

export function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

// 超出宽度时截断并加省略号
export function fit(g, text, max) {
  text = String(text ?? '');
  if (g.measureText(text).width <= max) return text;
  let s = text;
  while (s.length > 1 && g.measureText(s + '…').width > max) s = s.slice(0, -1);
  return s + '…';
}

export function font(weight, size, family) {
  return `${weight} ${size}px ${family}`;
}

// #rrggbb + 透明度
export function alpha(hex, a) {
  return hex + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
}

// 新画布：高度先按估计值，画完后用 crop 裁到实际内容高度
export function makeCanvas(H) {
  const canvas = document.createElement('canvas');
  canvas.width = W * SCALE;
  canvas.height = H * SCALE;
  const g = canvas.getContext('2d');
  g.scale(SCALE, SCALE);
  g.textBaseline = 'alphabetic';
  return { canvas, g };
}
export function crop(canvas, h) {
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = Math.min(canvas.height, Math.ceil(h * SCALE));
  out.getContext('2d').drawImage(canvas, 0, 0);
  return out;
}

// 常用画法：卡片、文字、胶囊标签、圆角图片、背景光晕、页眉与页脚
export function painter(g, C) {
  const family = getComputedStyle(document.body).fontFamily || 'sans-serif';
  const P = {
    family,
    card(x, y, w, h, r = 20, fill = C.panel) {
      rr(g, x, y, w, h, r);
      g.fillStyle = fill;
      g.fill();
    },
    // 文字：opts { size, weight, color, align, max（最大宽度，超出截断） }，返回实际宽度
    text(str, x, y, opts = {}) {
      g.font = font(opts.weight || 400, opts.size || 14, family);
      g.textAlign = opts.align || 'left';
      g.fillStyle = opts.color || C.text;
      const s = opts.max ? fit(g, str, opts.max) : String(str ?? '');
      g.fillText(s, x, y);
      return g.measureText(s).width;
    },
    measure(str, size, weight = 400) {
      g.font = font(weight, size, family);
      return g.measureText(String(str ?? '')).width;
    },
    // 圆角胶囊标签，返回宽度
    chip(str, x, y, opts = {}) {
      const h = opts.h || 30, size = opts.size || 14;
      const w = P.measure(str, size, opts.weight || 500) + (opts.dot ? 44 : 28);
      rr(g, x, y, w, h, h / 2);
      g.fillStyle = opts.bg || C.panel;
      g.fill();
      if (opts.dot) { rr(g, x + 14, y + h / 2 - 4, 8, 8, 4); g.fillStyle = opts.dot; g.fill(); }
      P.text(str, x + (opts.dot ? 30 : 14), y + h / 2 + size * 0.36, { size, weight: opts.weight || 500, color: opts.fg || C.sub });
      return w;
    },
    // 一排胶囊：放不下就换行，返回最后一行底部的 y
    chips(list, x, y, maxX, opts = {}) {
      let cx = x;
      for (const it of list) {
        const t = typeof it === 'string' ? it : it.text;
        const w = P.measure(t, opts.size || 14, opts.weight || 500) + (it.dot ? 44 : 28);
        if (cx > x && cx + w > maxX) { cx = x; y += (opts.h || 30) + 8; }
        cx += P.chip(t, cx, y, { ...opts, ...(typeof it === 'string' ? {} : it) }) + 8;
      }
      return y + (opts.h || 30);
    },
    pic(img, x, y, size, r) {
      rr(g, x, y, size, size, r);
      g.save();
      g.clip();
      if (img) g.drawImage(img, x, y, size, size); else { g.fillStyle = C.panel2; g.fillRect(x, y, size, size); }
      g.restore();
    },
    // 背景：底色 + 左上、右上两团光晕
    background(H, left = C.a, right = C.b) {
      g.fillStyle = C.bg;
      g.fillRect(0, 0, W, H);
      for (const [x, c] of [[0, left], [W, right]]) {
        const gr = g.createRadialGradient(x, 120, 0, x, 120, 560);
        gr.addColorStop(0, alpha(c, C.glow));
        gr.addColorStop(1, alpha(c, 0));
        g.fillStyle = gr;
        g.fillRect(0, 0, W, 700);
      }
    },
    // 页眉：左边类别标签，右边站点名
    header(label, y, color = C.a) {
      P.chip(label, 40, y, { bg: alpha(color, 0.14), fg: color, weight: 700, size: 13, h: 28 });
      P.text('EVE Market', W - 40, y + 20, { size: 18, weight: 800, align: 'right' });
    },
    footer(left, right, y) {
      const w = siteMark(g, C, 40, y, family);
      P.text(left, 40 + w + 14, y, { size: 13, color: C.muted });
      P.text(right, W - 40, y, { size: 13, color: C.muted, align: 'right' });
    },
    // 分区标题：小色块 + 标题 + 右侧小字
    title(str, x, y, opts = {}) {
      rr(g, x, y - 14, 4, 16, 2);
      g.fillStyle = opts.color || C.a;
      g.fill();
      P.text(str, x + 14, y, { size: 17, weight: 700 });
      if (opts.right) P.text(opts.right, opts.rightX, y, { size: 12, color: C.muted, align: 'right' });
    },
    // 横向比例条
    bar(x, y, w, h, ratio, color, track = C.panel2) {
      rr(g, x, y, w, h, h / 2);
      g.fillStyle = track;
      g.fill();
      if (ratio > 0) { rr(g, x, y, Math.max(h, w * Math.min(1, ratio)), h, h / 2); g.fillStyle = color; g.fill(); }
    }
  };
  return P;
}

export function shareTheme() {
  try { return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
}

const SHARE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>';
export { SHARE_ICON };

// 预览弹窗：先打开再生成；可切换浅色 / 深色（重新绘制），下载、复制图片、复制链接
// opts: { title, fileName, render(theme) → Promise<canvas>, link?: () => string, app: { esc, showToast, copyText } }
export function openShareModal(opts) {
  const { app } = opts;
  let theme = shareTheme(), blob = null, url = '', seq = 0;
  const canCopy = !!(navigator.clipboard && window.ClipboardItem);
  const modal = document.createElement('div');
  modal.className = 'modal share-image-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.innerHTML = `
    <div class="modal-backdrop"></div>
    <div class="modal-content">
      <div class="modal-header">
        <h3>${app.esc(opts.title)}</h3>
        <button class="modal-close" data-close aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="modal-body">
        <div class="share-image-stage">
          <div class="share-image-preview"></div>
          <div class="share-image-zoom" hidden>
            <button type="button" data-zoom="-1" aria-label="缩小">−</button>
            <button type="button" data-zoom="fit" title="适应窗口（双击图片也可切换）">100%</button>
            <button type="button" data-zoom="1" aria-label="放大">+</button>
          </div>
          <div class="share-image-busy"><span class="spinner"></span><span data-busy-text>正在准备数据…</span><div class="share-image-progress"><i data-busy-bar></i></div></div>
        </div>
        <div class="share-image-actions">
          <div class="segmented" role="group" aria-label="图片配色">
            <button type="button" data-theme-pick="light">浅色</button>
            <button type="button" data-theme-pick="dark">深色</button>
          </div>
          <span class="text-muted">滚轮 / 双指缩放，拖动查看细节；手机上可长按图片保存</span>
          ${opts.link ? '<button class="btn btn-ghost" data-link>复制链接</button>' : ''}
          ${canCopy ? '<button class="btn btn-ghost" data-copy disabled>复制图片</button>' : ''}
          <a class="btn btn-primary is-disabled" data-download download="${app.esc(opts.fileName)}">下载图片</a>
        </div>
      </div>
    </div>`;
  const box = modal.querySelector('.share-image-preview'), stage = modal.querySelector('.share-image-stage'), busy = modal.querySelector('.share-image-busy');
  const dl = modal.querySelector('[data-download]');
  const zoomBar = modal.querySelector('.share-image-zoom'), zoomLabel = zoomBar.querySelector('[data-zoom="fit"]');
  // 预览：默认整张图缩放到弹窗内完整显示；滚轮 / 双指 / 按钮缩放（以光标或双指中点为中心），放大后拖动平移，双击在适应与 2 倍之间切换
  const view = { img: null, nw: 0, nh: 0, s: 1, x: 0, y: 0, fit: 1 };
  const fitScale = () => Math.min(box.clientWidth / view.nw, box.clientHeight / view.nh);
  const apply = () => {
    if (!view.img) return;
    const bw = box.clientWidth, bh = box.clientHeight, w = view.nw * view.s, h = view.nh * view.s;
    // 小于窗口的方向居中，大于窗口的方向不留空边
    view.x = w <= bw ? (bw - w) / 2 : Math.min(0, Math.max(bw - w, view.x));
    view.y = h <= bh ? (bh - h) / 2 : Math.min(0, Math.max(bh - h, view.y));
    view.img.style.width = w + 'px';
    view.img.style.transform = `translate(${view.x}px, ${view.y}px)`;
    box.classList.toggle('is-zoomed', view.s > view.fit * 1.001);
    zoomLabel.textContent = Math.round(view.s / view.fit * 100) + '%';
  };
  const zoomTo = (s, cx = box.clientWidth / 2, cy = box.clientHeight / 2) => {
    s = Math.min(Math.max(s, view.fit), Math.max(view.fit * 6, 1));
    view.x = cx - (cx - view.x) * s / view.s;
    view.y = cy - (cy - view.y) * s / view.s;
    view.s = s;
    apply();
  };
  const refit = () => {
    if (!view.img) return;
    const zoomed = view.s > view.fit * 1.001, old = view.fit;
    view.fit = fitScale();
    view.s = zoomed ? Math.max(view.s, view.fit) : view.fit;
    if (!zoomed || old !== view.fit) apply();
  };
  const ro = new ResizeObserver(refit);
  ro.observe(box);
  box.addEventListener('wheel', (e) => {
    if (!view.img) return;
    e.preventDefault();
    const r = box.getBoundingClientRect();
    zoomTo(view.s * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.04 : 0.001)), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  box.addEventListener('dblclick', (e) => {
    if (!view.img) return;
    const r = box.getBoundingClientRect();
    zoomTo(view.s > view.fit * 1.001 ? view.fit : view.fit * 2, e.clientX - r.left, e.clientY - r.top);
  });
  // 拖动 / 双指缩放
  const pts = new Map();
  let pinch = null;
  box.addEventListener('pointerdown', (e) => {
    if (!view.img || (e.pointerType === 'mouse' && e.button !== 0)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    box.setPointerCapture(e.pointerId);
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: view.s };
    }
    box.classList.add('is-dragging');
  });
  box.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size >= 2 && pinch) {
      const [a, b] = [...pts.values()], r = box.getBoundingClientRect();
      zoomTo(pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
    } else if (pts.size === 1) {
      view.x += dx; view.y += dy;
      apply();
    }
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!pts.size) box.classList.remove('is-dragging');
  };
  box.addEventListener('pointerup', up);
  box.addEventListener('pointercancel', up);
  const draw = async () => {
    const my = ++seq;
    modal.querySelectorAll('[data-theme-pick]').forEach((b) => b.classList.toggle('active', b.dataset.themePick === theme));
    box.className = `share-image-preview theme-${theme}`;
    stage.className = `share-image-stage theme-${theme}`;
    busy.hidden = false;
    // 进度：准备数据 → 下载头像与图标（按张数）→ 绘制导出
    const busyText = busy.querySelector('[data-busy-text]'), busyBar = busy.querySelector('[data-busy-bar]');
    const setBusy = (text, pct) => { if (my !== seq) return; busyText.textContent = text; busyBar.style.width = pct.toFixed(1) + '%'; };
    setBusy('正在准备数据…', 3);
    try {
      progress = (d, t) => setBusy(t ? `正在加载头像与图标 ${d} / ${t}` : '正在准备数据…', 5 + (t ? d / t : 0) * 85);
      const canvas = await opts.render(theme);
      progress = null;
      setBusy('正在绘制并导出图片…', 95);
      const next = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!next) throw new Error('浏览器无法导出图片');
      if (my !== seq || !modal.isConnected) return;
      if (url) URL.revokeObjectURL(url);
      blob = next;
      url = URL.createObjectURL(blob);
      const img = new Image();
      img.src = url;
      img.alt = opts.title;
      img.draggable = false;
      await img.decode().catch(() => {});
      if (my !== seq || !modal.isConnected) return;
      // 切换深浅色时图片尺寸不变，保留当前缩放位置
      const same = view.img && view.nw === canvas.width && view.nh === canvas.height;
      view.img = img; view.nw = canvas.width; view.nh = canvas.height;
      box.replaceChildren(img);
      if (!same) { view.fit = fitScale(); view.s = view.fit; }
      apply();
      zoomBar.hidden = false;
      dl.href = url;
      dl.classList.remove('is-disabled');
      modal.querySelector('[data-copy]')?.removeAttribute('disabled');
    } catch (error) {
      if (my !== seq) return;
      if (!blob) box.innerHTML = `<p class="share-image-error">生成图片失败：${app.esc(error.message)}</p>`;
      else app.showToast('生成图片失败：' + error.message, 'error', 4000);
    } finally {
      if (my === seq) { busy.hidden = true; progress = null; }
    }
  };
  const close = () => { seq++; ro.disconnect(); modal.remove(); if (url) URL.revokeObjectURL(url); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  modal.addEventListener('click', async (e) => {
    if (e.target.closest('.modal-backdrop, [data-close]')) { close(); return; }
    const z = e.target.closest('[data-zoom]');
    if (z) {
      if (z.dataset.zoom === 'fit') zoomTo(view.fit);
      else zoomTo(view.s * (z.dataset.zoom === '1' ? 1.25 : 0.8));
      return;
    }
    const pick = e.target.closest('[data-theme-pick]');
    if (pick) {
      if (pick.dataset.themePick === theme) return;
      theme = pick.dataset.themePick;
      try { localStorage.setItem(THEME_KEY, theme); } catch { /* 隐私模式 */ }
      draw();
      return;
    }
    if (e.target.closest('[data-download]') && !blob) { e.preventDefault(); return; }
    if (e.target.closest('[data-link]')) { app.copyText(opts.link(), '链接已复制'); return; }
    if (e.target.closest('[data-copy]') && blob) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        app.showToast('图片已复制', 'success');
      } catch {
        app.showToast('浏览器不允许复制图片，请使用下载', 'error');
      }
    }
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(modal);
  draw();
}
