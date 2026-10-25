// 中英文切换（普通脚本，在所有模块之前加载）
// 默认语言：地址栏 ?lang=en|zh > 用户选过的（localStorage eve-lang）> 浏览器语言含中文 / 时区在中国大陆、港澳台 → 中文，否则英文。
// 英文模式：
//   1. 游戏名称：拦截站内静态数据文件（JSON），把与官方中文名完全相同的字符串换成官方英文名（i18n/names-en.json，build_names_en.py 由 CCP SDE 生成），
//      物品目录、星图等用到的名称在内存里就是英文，搜索也能输英文名；ESI 请求改为英文（Accept-Language / language 参数）。
//   2. 界面文字：页面上的中文文本、title / placeholder / aria-label、画布上绘制的文字、alert / confirm 按 i18n/en-ui.json 翻译
//      （exact 整句；patterns 为带 {0} 占位符的句式；都没有时按已知词条逐段替换）。带 translate="no" 或 .notranslate 的元素不翻译。
// 中文模式下本脚本只做语言判断，不加载任何词典。
(function () {
  'use strict';
  var KEY = 'eve-lang';
  var VER = '30';
  var CN_TZ = /^Asia\/(Shanghai|Chongqing|Chungking|Harbin|Urumqi|Kashgar|Hong_Kong|Macau|Macao|Taipei)$/;

  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  function detect() {
    var q = /[?&]lang=(en|zh)\b/.exec(location.search);
    if (q) { store(KEY, q[1]); return q[1]; }
    var saved = store(KEY);
    if (saved === 'en' || saved === 'zh') return saved;
    var langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']).map(function (l) { return String(l).toLowerCase(); });
    if (langs.some(function (l) { return l.indexOf('zh') === 0; })) return 'zh';
    var tz = '';
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* 忽略 */ }
    if (CN_TZ.test(tz)) return 'zh';
    // 首选语言不是中文、但列表里有中文（如 en-US, zh-CN）时上面已经按中文；其余一律英文
    return 'en';
  }

  var LANG = detect();
  document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN';
  var api = window.I18N = {
    lang: LANG,
    set: function (l) { store(KEY, l); var u = new URL(location.href); u.searchParams.delete('lang'); location.replace(u.toString()); },
    t: function (s) { return s; },
    ready: Promise.resolve()
  };

  // 切换按钮（页头 #langToggle）：中文模式显示 EN，英文模式显示 中文
  function bindToggle() {
    var btn = document.getElementById('langToggle');
    if (!btn) return;
    btn.textContent = LANG === 'en' ? '中文' : 'EN';
    btn.title = LANG === 'en' ? '切换到中文' : 'Switch to English';
    btn.setAttribute('aria-label', btn.title);
    btn.addEventListener('click', function () { api.set(LANG === 'en' ? 'zh' : 'en'); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindToggle); else bindToggle();
  if (LANG !== 'en') return;

  // ---------- 英文模式 ----------
  var CJK = /[㐀-鿿]/;
  var realFetch = window.fetch.bind(window);
  var EX = Object.create(null), NAMES = Object.create(null), PAT_HEAD = Object.create(null), PAT_TAIL = Object.create(null), PAT_MISC = [];
  var maxKey = 1;
  var ready = false;

  // 页面先隐藏，词典到了再显示（最多等 3 秒）
  document.documentElement.classList.add('i18n-pending');
  var reveal = function () { document.documentElement.classList.remove('i18n-pending'); };
  setTimeout(reveal, 3000);

  var namesP = realFetch('i18n/names-en.json?v=' + VER).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
    .then(function (d) { for (var k in d) NAMES[k] = d[k]; return NAMES; });
  var uiP = realFetch('i18n/en-ui.json?v=' + VER).then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })
    .then(function (d) {
      var ex = d.exact || {};
      for (var k in ex) EX[k] = ex[k];
      (d.patterns || []).forEach(function (p) { addPattern(p[0], p[1]); });
      // 同一组里固定文字多的句式先试：「途经 {0}」不能抢在「途经点 {0} 不能直接跳入…」前面
      var byLit = function (a, b) { return b.lit - a.lit; };
      [PAT_HEAD, PAT_TAIL].forEach(function (g) { for (var c in g) g[c].sort(byLit); });
    });
  api.ready = Promise.all([namesP, uiP]).then(function () {
    for (var k in EX) if (k.length > maxKey) maxKey = k.length;
    for (var n in NAMES) if (n.length > maxKey && n.length <= 40) maxKey = n.length;
    maxKey = Math.min(maxKey, 40);
    ready = true;
    cache = Object.create(null);
  });

  // ---------- 句式 ----------
  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function addPattern(key, val) {
    var parts = key.split(/\{(\d+)\}/);
    var src = '^';
    var order = [];
    var numOnly = parts.length === 3 && (parts[0] + parts[2]).replace(/\s/g, '').length < 2;
    for (var i = 0; i < parts.length; i++) {
      // 句首 / 句尾的占位符允许为空：模板里变量常放在单独的标签里，文字节点只剩前后的字
      if (i % 2 && numOnly) { src += '([-+]?[\\d.,]+(?:\\s*[A-Za-z%]{1,3})?)'; order.push(Number(parts[i])); }
      else if (i % 2) { src += (i === 1 && !parts[0]) || (i === parts.length - 2 && !parts[parts.length - 1]) ? '([\\s\\S]*?)' : '([\\s\\S]+?)'; order.push(Number(parts[i])); } else src += esc(parts[i]).replace(/ /g, '\\s*');
    }
    var re = new RegExp(src + '$');
    var pat = { re: re, order: order, val: val, lit: key.replace(/\{\d+\}|\s/g, '').length };
    var head = parts[0], tail = parts[parts.length - 1];
    if (head) (PAT_HEAD[head[0]] = PAT_HEAD[head[0]] || []).push(pat);
    else if (tail) (PAT_TAIL[tail[tail.length - 1]] = PAT_TAIL[tail[tail.length - 1]] || []).push(pat);
    else PAT_MISC.push(pat);
  }
  function tryPats(list, s) {
    if (!list) return null;
    for (var i = 0; i < list.length; i++) {
      var m = list[i].re.exec(s);
      if (!m) continue;
      var p = list[i];
      var caps = [];
      for (var j = 0; j < p.order.length; j++) caps[p.order[j]] = m[j + 1];
      return p.val.replace(/\{(\d+)\}/g, function (_, n) { var v = caps[Number(n)]; return v == null ? '' : tr(v); });
    }
    return null;
  }

  // ---------- 逐段替换（最长匹配）----------
  var PUNCT = { '，': ', ', '。': '. ', '：': ': ', '；': '; ', '（': ' (', '）': ') ', '、': ', ', '！': '! ', '？': '? ', '“': '"', '”': '"', '‘': "'", '’': "'", '《': '"', '》': '"', '【': '[', '】': ']', '～': '~', '…': '...', '—': '-' };
  var WORD = /[A-Za-z0-9%)\],;:]/;
  function piecewise(s) {
    var out = '';
    var i = 0, n = s.length;
    var push = function (piece) {
      if (out && piece && WORD.test(out[out.length - 1]) && /^[A-Za-z0-9(]/.test(piece)) out += ' ';
      out += piece;
    };
    while (i < n) {
      var ch = s[i];
      if (!CJK.test(ch)) {
        var p = PUNCT[ch];
        if (p !== undefined) { out = out.replace(/\s+$/, ''); out += p; i++; continue; }
        if (/[,;:]$/.test(out) && /[A-Za-z0-9]/.test(ch)) out += ' ';
        out += ch; i++; continue;
      }
      var hit = null, len = 0;
      for (var L = Math.min(maxKey, n - i); L >= 1; L--) {
        var sub = s.substr(i, L);
        var v = EX[sub] != null ? EX[sub] : (L >= 2 ? NAMES[sub] : null);   // 单字游戏名称（如「点」）不参与逐段替换，免得误伤
        if (v != null) { hit = v; len = L; break; }
      }
      if (hit != null) { push(hit); i += len; } else { out += ch; i++; }
    }
    return out.replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?)\]])/g, '$1');
  }

  function whole(core, noMisc) {
    var r = EX[core];
    if (r == null) r = NAMES[core];
    if (r == null) r = tryPats(PAT_HEAD[core[0]], core);
    if (r == null) r = tryPats(PAT_TAIL[core[core.length - 1]], core);
    if (r == null && !noMisc) r = tryPats(PAT_MISC, core);   // 首尾都是占位符的句式最宽泛，放最后
    return r;
  }
  var cache = Object.create(null);
  function tr(s) {
    if (!s || !CJK.test(s)) return s;
    var c = cache[s];
    if (c !== undefined) return c;
    var lead = /^\s*/.exec(s)[0], trail = /\s*$/.exec(s)[0];
    var core = s.slice(lead.length, s.length - trail.length).replace(/\s+/g, ' ');
    var r = whole(core, true);
    if (r == null) {   // 列表拼接时末尾多出的「，」「；」等：去掉再整句匹配
      var tp = /[，、；。：]+$/.exec(core);
      if (tp && tp.index > 0) { r = whole(core.slice(0, tp.index)); if (r != null) r += tp[0].split('').map(function (c) { return PUNCT[c].trim(); }).join('') + ' '; }
    }
    if (r == null) r = tryPats(PAT_MISC, core);
    if (r == null && core.indexOf(' · ') > 0) r = core.split(' · ').map(tr).join(' · ');   // 「A · B · C」拼接的状态行逐段翻
    if (r == null && /[^，；][，；][^，；]/.test(core)) r = core.split(/([，；])/).map(function (x) { return x === '，' ? ', ' : x === '；' ? '; ' : tr(x); }).join('');   // 逗号拼起来的几个短句
    if (r == null) r = piecewise(core);
    r = lead + r + trail;
    if (ready) cache[s] = r;
    return r;
  }
  api.t = tr;

  // ---------- 数据：游戏名称换成官方英文名 ----------
  var DATA = /\/(catalog|map-data(-\w+)?|npc-[\w-]+|type-names-zh|fit-data|industry-data|skill-data|sov-data|wh-data|pi-data|lp-data(-\w+)?|reprocess-data|mutaplasmid-data|dogma-attr-zh|type-volume|courier-\w+)\.json$/;
  function swapNames(o) {
    if (typeof o === 'string') return NAMES[o] != null ? NAMES[o] : o;
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) o[i] = swapNames(o[i]); return o; }
    if (o && typeof o === 'object') { for (var k in o) o[k] = swapNames(o[k]); return o; }
    return o;
  }
  function rewrap(res) {
    if (!res.ok) return res;
    var ct = res.headers.get('content-type') || '';
    if (ct.indexOf('json') < 0) return res;
    return res.clone().json().then(function (body) {
      return namesP.then(function () {
        var h = new Headers(res.headers);
        h.delete('content-length'); h.delete('content-encoding');
        return new Response(JSON.stringify(swapNames(body)), { status: res.status, statusText: res.statusText, headers: h });
      });
    }).catch(function () { return res; });
  }
  var ESI_HOST = /(^|\.)esi\.evetech\.net$|ali-esi\.evepc\.163\.com$/;
  window.fetch = function (input, init) {
    var url;
    try { url = new URL(typeof input === 'string' ? input : input.url, location.href); } catch (e) { return realFetch(input, init); }
    if (ESI_HOST.test(url.hostname)) {
      if (url.searchParams.get('language') === 'zh') url.searchParams.set('language', 'en');
      var opts = Object.assign({}, init || {});
      var h = new Headers(opts.headers || (typeof input !== 'string' && input.headers) || {});
      if (h.has('Accept-Language')) h.set('Accept-Language', 'en');
      opts.headers = h;
      if (typeof input !== 'string' && !init) { opts.method = input.method; if (input.method !== 'GET' && input.method !== 'HEAD') return realFetch(input, init); }
      // ESI 返回的名称已是英文；订单等大数据不再逐个改写（页面上残留的中文名由页面翻译兜底）
      return realFetch(url.toString(), opts);
    }
    if (url.origin === location.origin && DATA.test(url.pathname)) return realFetch(input, init).then(rewrap);
    return realFetch(input, init);
  };

  // ---------- 页面文字 ----------
  var ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'data-tip'];
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, NOSCRIPT: 1 };
  function skipEl(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentNode) {
      if (SKIP[e.tagName] || e.isContentEditable || e.getAttribute('translate') === 'no' || (e.classList && e.classList.contains('notranslate'))) return true;
    }
    return false;
  }
  function doText(node) {
    var v = node.nodeValue;
    if (!v || !CJK.test(v) || skipEl(node.parentNode)) return;
    var t = tr(v);
    if (t !== v) node.nodeValue = t;
  }
  function doAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute(ATTRS[i]);
      if (v && CJK.test(v)) { var t = tr(v); if (t !== v) el.setAttribute(ATTRS[i], t); }
    }
  }
  function doTree(root) {
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) { if (skipEl(root)) return; doAttrs(root); }
    var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) { return n.nodeType === 1 && (SKIP[n.tagName] || n.getAttribute('translate') === 'no' || n.classList.contains('notranslate')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
    });
    var n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doAttrs(n); }
  }
  var pending = [];
  var mo = new MutationObserver(function (list) {
    if (!ready) { pending.push.apply(pending, list); return; }
    handle(list);
  });
  function handle(list) {
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      if (m.type === 'childList') { for (var j = 0; j < m.addedNodes.length; j++) doTree(m.addedNodes[j]); }
      else if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes' && m.target.nodeType === 1 && !skipEl(m.target)) doAttrs(m.target);
    }
  }
  mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  api.ready.then(function () {
    doTree(document.documentElement);
    if (pending.length) { var p = pending; pending = []; handle(p); }
    document.title = tr(document.title);
    reveal();
  });

  // 画布上绘制的文字（星图标签、图表、战报图片）
  var C2D = window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype;
  if (C2D) ['fillText', 'strokeText', 'measureText'].forEach(function (fn) {
    var orig = C2D[fn];
    C2D[fn] = function (text) { var args = Array.prototype.slice.call(arguments); if (typeof text === 'string') args[0] = tr(text); return orig.apply(this, args); };
  });
  // alert / confirm / prompt
  ['alert', 'confirm', 'prompt'].forEach(function (fn) {
    var orig = window[fn];
    if (typeof orig !== 'function') return;
    window[fn] = function (msg) { var args = Array.prototype.slice.call(arguments); if (typeof msg === 'string') args[0] = tr(msg); return orig.apply(window, args); };
  });
})();
