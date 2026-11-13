// ===== 回到顶部：任何页面往下滚超过一屏，右下角出现按钮，点一下滚回顶部 =====
// 各页面的滚动区不一样（整页、.kb-scroll、各页自己的内容区），所以不挂在某个元素上：捕获阶段监听所有滚动，
// 只认够大的滚动区（高度至少半个窗口，弹窗、悬浮窗里的不算），按钮贴着这个滚动区的右下角（手机上不会压到底部标签栏）。
(function () {
  var btn = null, cur = null, raf = 0;
  function make() {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'to-top';
    btn.title = '回到顶部';
    btn.setAttribute('aria-label', '回到顶部');
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.addEventListener('click', function () {
      if (cur) cur.scrollTo({ top: 0, behavior: 'smooth' });
    });
    document.body.appendChild(btn);
  }
  function rootOf(t) { return t === document || t === document.documentElement || t === document.body ? document.scrollingElement || document.documentElement : t; }
  // 额外的「回首页」按钮（击杀页往里点了好几层时由页面登记）：贴在回到顶部按钮上面；只在地址以 prefix 开头时显示
  var home = null, homeFn = null, homePrefix = '';
  window.toTopHome = function (fn, prefix, label) {
    homeFn = fn; homePrefix = prefix || '';
    if (fn && !home) {
      home = document.createElement('button');
      home.type = 'button';
      home.className = 'to-top to-top-home';
      home.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-8 9 8M5 10v10h14V10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      home.addEventListener('click', function () { if (homeFn) homeFn(); });
      document.body.appendChild(home);
    }
    if (home && label) { home.title = label; home.setAttribute('aria-label', label); }
    if (!raf) raf = requestAnimationFrame(update);
  };
  function update() {
    raf = 0;
    placeHome();
    var el = cur;
    var show = Boolean(el && el.isConnected && el.scrollTop > Math.max(400, el.clientHeight) && el.getClientRects().length);
    if (!btn) { if (!show) return; make(); }
    btn.classList.toggle('show', show);
    if (!show) return;
    var whole = el === (document.scrollingElement || document.documentElement);
    var r = whole ? { right: innerWidth, bottom: innerHeight } : el.getBoundingClientRect();
    btn.style.right = Math.max(0, document.documentElement.clientWidth - r.right) + 20 + 'px';
    btn.style.bottom = Math.max(0, innerHeight - r.bottom) + 20 + 'px';
    placeHome();
  }
  function placeHome() {
    if (!home) return;
    var on = Boolean(homeFn) && location.hash.indexOf(homePrefix) === 0;
    home.classList.toggle('show', on);
    if (!on) return;
    // 回到顶部按钮在：贴在它上面；不在：占它的位置（按当前滚动区的右下角）
    var up = btn && btn.classList.contains('show');
    var el = cur && cur.isConnected && cur.getClientRects().length ? cur : null;
    var whole = !el || el === (document.scrollingElement || document.documentElement);
    var r = whole ? { right: innerWidth, bottom: innerHeight } : el.getBoundingClientRect();
    home.style.right = Math.max(0, document.documentElement.clientWidth - r.right) + 20 + 'px';
    home.style.bottom = Math.max(0, innerHeight - r.bottom) + 20 + (up ? 52 : 0) + 'px';
  }
  document.addEventListener('scroll', function (e) {
    var el = rootOf(e.target);
    if (!(el instanceof Element)) return;
    if (el !== cur) {
      if (el.clientHeight < innerHeight * 0.5 || el.closest('.modal, .float-pop, .msheet, .lw-pick')) return;
      cur = el;
    }
    if (!raf) raf = requestAnimationFrame(update);
  }, true);
  // 换页（滚动区被替换或隐藏）时收起
  addEventListener('hashchange', function () { setTimeout(update, 50); });
  addEventListener('resize', function () { if (!raf) raf = requestAnimationFrame(update); });
})();
