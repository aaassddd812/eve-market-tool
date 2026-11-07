// ===== ESI 直连不通时走本站中转 =====
// 有些网络打得开本站，却连不上 CCP 的 ESI（esi.evetech.net）、登录服务器或图片服务器。这里接管页面的 fetch：
//   1. 平时照常直连；直连报网络错误（连不上、被重置）时，这一次改走本站中转 /api/kb/relay/... 重发；
//      GET 请求直连 6 秒还没响应，同时发一份中转，谁先回来用谁。
//   2. 2 分钟内直连失败两次（或中转比直连先回来），记为「本设备走中转」，之后直接走中转；2 小时后再试直连。
//   3. 走中转期间，images.evetech.net 的图片也改从本站图片中转取（/api/kb/img），中转取不到再换回原地址。
// 中转只原样转发请求（含 Authorization 令牌），服务器不保存任何内容。普通脚本，在所有模块之前加载。
(function () {
  'use strict';
  var RELAY = '/api/kb/relay/';
  var HOSTS = {
    'https://esi.evetech.net/': 'esi/',
    'https://ali-esi.evepc.163.com/': 'cnesi/',
    'https://login.eveonline.com/v2/oauth/token': 'login'
  };
  var KEY = 'eve-esi-relay';
  var HANG_MS = 6000;
  var TTL = 2 * 3600 * 1000;
  var native = window.fetch.bind(window);
  var fails = [];

  function relayUntil() {
    try { return Number(localStorage.getItem(KEY)) || 0; } catch (e) { return 0; }
  }
  var on = relayUntil() > Date.now();
  function setOn() {
    if (!on) console.info('[esi-relay] 直连 ESI 失败，改走本站中转');
    on = true;
    watchImages();
    try { localStorage.setItem(KEY, String(Date.now() + TTL)); } catch (e) { /* 忽略 */ }
  }
  function failed() {
    var now = Date.now();
    fails = fails.filter(function (t) { return now - t < 120000; });
    fails.push(now);
    if (fails.length >= 2) setOn();
  }
  function relayUrl(url) {
    for (var base in HOSTS) {
      if (url.indexOf(base) === 0) {
        if (base.slice(-1) !== '/') return url.split('?')[0] === base ? RELAY + HOSTS[base] : null;
        return RELAY + HOSTS[base] + url.slice(base.length);
      }
    }
    return null;
  }
  var aborted = function (init) { return Boolean(init && init.signal && init.signal.aborted); };

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input instanceof URL ? input.href : null;
    var alt = url && relayUrl(url);
    if (!alt) return native(input, init);
    if (on && relayUntil() > Date.now()) return native(alt, init);
    on = false;
    var method = String((init && init.method) || 'GET').toUpperCase();
    var direct = native(input, init);
    var retry = function (err) {
      if (aborted(init) || err.name === 'AbortError' || err.name === 'TimeoutError') throw err;
      failed();
      return native(alt, init);
    };
    if (method !== 'GET') return direct.catch(retry);
    // GET：卡住不回时并行发中转，先成功的那个为准
    return new Promise(function (resolve, reject) {
      var done = false, relayP = null;
      var finish = function (res) { if (!done) { done = true; clearTimeout(timer); resolve(res); } };
      var startRelay = function () {
        if (!relayP) relayP = native(alt, init);
        return relayP;
      };
      var timer = setTimeout(function () {
        if (done || aborted(init)) return;
        startRelay().then(function (res) { if (!done) { setOn(); finish(res); } }, function () { /* 等直连的结果 */ });
      }, HANG_MS);
      direct.then(finish, function (err) {
        if (done) return;
        if (aborted(init) || err.name === 'AbortError' || err.name === 'TimeoutError') { done = true; clearTimeout(timer); reject(err); return; }
        failed();
        startRelay().then(finish, function (e) { if (!done) { done = true; clearTimeout(timer); reject(e); } });
      });
    });
  };

  // 走中转期间：官方图片服务器的图片直接从本站图片中转取（连不上时图片常常一直卡着、不报错）；
  // 中转也失败（比如国服独有物品没有图标）就换回原地址，交给页面原来的「破图」处理
  var IMG = /^https:\/\/images\.evetech\.net\/(characters|corporations|alliances|types)\/\d+\/(portrait|logo|icon|render|bp|bpc)(\?size=\d+)?$/;
  var mine = new WeakMap();   // 自己改的 src，监听到时跳过
  var setSrc = function (img, src) { mine.set(img, src); img.src = src; };
  var viaProxy = function (img) {
    if (img.dataset.relaySrc || !IMG.test(img.src)) return;
    img.dataset.relaySrc = img.src;
    setSrc(img, '/api/kb/img?u=' + encodeURIComponent(img.src));
  };
  var sweep = function (root) {
    if (root.tagName === 'IMG') viaProxy(root);
    else if (root.querySelectorAll) root.querySelectorAll('img[src^="https://images.evetech.net/"]').forEach(viaProxy);
  };
  var watching = false;
  function watchImages() {
    if (watching || !document.documentElement) return;
    watching = true;
    sweep(document.documentElement);
    new MutationObserver(function (list) {
      list.forEach(function (m) {
        if (m.type !== 'attributes') { m.addedNodes.forEach(function (node) { if (node.nodeType === 1) sweep(node); }); return; }
        var img = m.target;
        if (img.tagName !== 'IMG' || mine.get(img) === img.getAttribute('src')) return;
        delete img.dataset.relaySrc;   // 页面换了新图片
        delete img.dataset.relayTried;
        viaProxy(img);
      });
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  }
  if (on) watchImages();
  document.addEventListener('error', function (e) {
    var img = e.target;
    if (!on || !img || img.tagName !== 'IMG' || img.dataset.relayTried) return;
    if (img.dataset.relaySrc) {
      img.dataset.relayTried = '1';
      e.stopImmediatePropagation();
      setSrc(img, img.dataset.relaySrc);
      return;
    }
    if (!IMG.test(img.src)) return;
    e.stopImmediatePropagation();
    viaProxy(img);
  }, true);

  window.__eveRelay = { active: function () { return on; } };
})();
