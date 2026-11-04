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

// 同一张图切换配色时不重复下载
const imageCache = new Map();
export function loadImage(url) {
  if (!url) return Promise.resolve(null);
  if (!imageCache.has(url)) imageCache.set(url, new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    // 加参数区分缓存：避免复用页面里不带跨域头的缓存导致画布被污染
    img.src = url + (url.includes('?') ? '&' : '?') + 'cors=1';
    setTimeout(() => resolve(null), 6000);
  }));
  return imageCache.get(url);
}
export async function loadImages(urls) {
  const list = [...new Set(urls)].filter(Boolean);
  return new Map(await Promise.all(list.map(async (u) => [u, await loadImage(u)])));
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
      P.text(left, 40, y, { size: 13, color: C.muted });
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
        <div class="share-image-preview"></div>
        <div class="share-image-actions">
          <div class="segmented" role="group" aria-label="图片配色">
            <button type="button" data-theme-pick="light">浅色</button>
            <button type="button" data-theme-pick="dark">深色</button>
          </div>
          <span class="text-muted">手机上可长按图片保存</span>
          ${opts.link ? '<button class="btn btn-ghost" data-link>复制链接</button>' : ''}
          ${canCopy ? '<button class="btn btn-ghost" data-copy disabled>复制图片</button>' : ''}
          <a class="btn btn-primary is-disabled" data-download download="${app.esc(opts.fileName)}">下载图片</a>
        </div>
      </div>
    </div>`;
  const box = modal.querySelector('.share-image-preview');
  const dl = modal.querySelector('[data-download]');
  const draw = async () => {
    const my = ++seq;
    modal.querySelectorAll('[data-theme-pick]').forEach((b) => b.classList.toggle('active', b.dataset.themePick === theme));
    box.className = `share-image-preview theme-${theme}`;
    if (!blob) box.innerHTML = '<div class="share-image-loading"><span class="spinner"></span>正在生成图片…</div>';
    box.classList.add('is-busy');
    try {
      const canvas = await opts.render(theme);
      const next = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!next) throw new Error('浏览器无法导出图片');
      if (my !== seq || !modal.isConnected) return;
      if (url) URL.revokeObjectURL(url);
      blob = next;
      url = URL.createObjectURL(blob);
      box.innerHTML = `<img src="${url}" alt="${app.esc(opts.title)}">`;
      dl.href = url;
      dl.classList.remove('is-disabled');
      modal.querySelector('[data-copy]')?.removeAttribute('disabled');
    } catch (error) {
      if (my !== seq) return;
      if (!blob) box.innerHTML = `<p class="text-muted share-image-loading">生成图片失败：${app.esc(error.message)}</p>`;
      else app.showToast('生成图片失败：' + error.message, 'error', 4000);
    } finally {
      if (my === seq) box.classList.remove('is-busy');
    }
  };
  const close = () => { seq++; modal.remove(); if (url) URL.revokeObjectURL(url); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  modal.addEventListener('click', async (e) => {
    if (e.target.closest('.modal-backdrop, [data-close]')) { close(); return; }
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
