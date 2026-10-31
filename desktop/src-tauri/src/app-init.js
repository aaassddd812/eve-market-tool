// 桌面版 / 安卓版注入脚本：每个页面加载前运行（Tauri initialization_script）
// 桌面版设 __EVE_DESKTOP__（网页换左侧菜单），安卓版设 __EVE_APP__（网页用手机布局、隐藏下载入口）
window.__FLAG__ = '__VERSION__';
// 安卓版铺满全屏：壳（MainActivity 的 EveApp）给出状态栏 / 导航栏高度，写到 --sa-top / --sa-bottom 让网页顶栏、底栏让开；状态栏图标颜色跟网页主题
(function () {
  var app = window.EveApp;
  if (!app) return;
  window.__eveInsets = function (t, b) {
    var s = document.documentElement.style;
    s.setProperty('--sa-top', t + 'px');
    s.setProperty('--sa-bottom', b + 'px');
  };
  try { window.__eveInsets(app.top(), app.bottom()); } catch (e) {}
  var root = document.documentElement;
  var theme = function () { try { app.lightBars(root.getAttribute('data-theme') === 'light'); } catch (e) {} };
  new MutationObserver(theme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  theme();
})();
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
