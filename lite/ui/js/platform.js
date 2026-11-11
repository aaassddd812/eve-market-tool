// 运行环境：程序里（Tauri）网络请求走 tauri-plugin-http（不受跨域限制），日志走 logs_* 命令，链接用系统浏览器打开；
// 直接用浏览器打开 ui/index.html?mock=1 时用 mock.js 的模拟数据（开发调试用）。
const T = window.__TAURI__;
export const inApp = !!T;

export async function http(url, opts = {}) {
  if (window.__MOCK__) return window.__MOCK__(url, opts);
  return T ? T.http.fetch(url, opts) : fetch(url, opts);
}

export function invoke(cmd, args) {
  if (window.__MOCK_INVOKE__) return window.__MOCK_INVOKE__(cmd, args);
  if (!T) return Promise.reject(new Error('只有在程序里才能读取游戏日志'));
  return T.core.invoke(cmd, args);
}

export function openUrl(url) {
  if (T) return T.opener.openUrl(url);
  window.open(url, '_blank', 'noopener');
  return Promise.resolve();
}

// localStorage 读写（失败时不影响使用）
export const store = {
  get(key, def) { try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(key, val) { try { if (val == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val)); } catch { /* 空间满等 */ } }
};
