// 桌面版注入脚本：每个页面加载前运行（Tauri initialization_script）
window.__EVE_DESKTOP__ = '__VERSION__';
(function () {
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return;
  // 本站以外的地址、新窗口打开的地址（ESI 登录、API 文档、外部资料）交给系统浏览器
  var openExternal = function (url) {
    var ipc = window.__TAURI_INTERNALS__;
    if (ipc && ipc.invoke) return ipc.invoke('plugin:opener|open_url', { url: url }).catch(function () {});
  };
  var abs = function (u) { try { var x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href : null; } catch (e) { return null; } };
  var nativeOpen = window.open;
  window.open = function (u, target) {
    var url = u && abs(String(u));
    if (url && target !== '_self') { openExternal(url); return null; }
    return nativeOpen.apply(window, arguments);
  };
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || a.hasAttribute('download')) return;
    var url = abs(a.getAttribute('href'));
    if (!url) return;
    var external = new URL(url).origin !== location.origin;
    if (a.target === '_blank' || external) { e.preventDefault(); openExternal(url); }
  }, true);
})();
