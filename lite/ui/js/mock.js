// 浏览器预览用的模拟数据：只有地址带 ?mock=1 时生效（程序里不会用到）。
// 在仓库 eve-market-tool 目录起静态服务，打开 /lite/ui/index.html?mock=1；物品名称读同仓库的 eve-overview-clone/type-names-zh.json。
(function () {
  var q = new URLSearchParams(location.search);
  if (!q.has('mock')) return;
  var CID = 2120000001, NAME = 'Demo Pilot';
  var now = Date.now();
  var ago = function (h) { return new Date(now - h * 3600e3).toISOString(); };
  // 假令牌：JWT 只需能解析出角色
  var jwt = 'x.' + btoa(JSON.stringify({ sub: 'CHARACTER:EVE:' + CID, name: NAME, scp: [] })).replace(/=+$/, '') + '.y';
  var scopes = ['esi-wallet.read_character_wallet.v1', 'esi-skills.read_skills.v1', 'esi-skills.read_skillqueue.v1', 'esi-assets.read_assets.v1', 'esi-markets.read_character_orders.v1', 'esi-location.read_location.v1', 'esi-location.read_ship_type.v1', 'esi-location.read_online.v1', 'esi-universe.read_structures.v1'];
  if (!localStorage.getItem('lite-accounts-tq')) {
    localStorage.setItem('lite-accounts-tq', JSON.stringify([{ character_id: CID, character_name: NAME, access_token: jwt, refresh_token: 'r', expires_at: now + 864e5 * 365, scopes: scopes }]));
  }
  // 深渊：?mock=abyss 时角色在深渊里（星系 32000123），否则在吉他
  var inAbyss = q.get('mock') === 'abyss';
  var ship = inAbyss ? 47466 : 670;

  var journal = [];
  var n = 0;
  [[0.2, 6], [26, 9]].forEach(function (s) {
    for (var k = 0; k < s[1]; k++) {
      var gross = 9000000 + ((n * 7919) % 6000000);
      journal.push({ id: 9700 + n, date: ago(s[0] + (s[1] - 1 - k) / 3), ref_type: 'bounty_prizes', first_party_id: 1000125, second_party_id: CID, amount: Math.round(gross * 0.9), tax: Math.round(gross * 0.1), context_id: 30002187, context_id_type: 'eve_system', reason: '23331: 3,23332: 1' });
      n++;
    }
  });
  journal.push({ id: 9900, date: ago(5), ref_type: 'market_transaction', first_party_id: 2120000002, second_party_id: CID, amount: 48500000 });
  journal.push({ id: 9901, date: ago(8), ref_type: 'brokers_fee', first_party_id: CID, second_party_id: 1000035, amount: -1200000 });
  journal.sort(function (a, b) { return Date.parse(b.date) - Date.parse(a.date); });
  var bal = 2345678901;
  journal.forEach(function (j) { j.balance = bal; bal -= j.amount; });

  var ESI = {
    '/characters/{c}/': { name: NAME, corporation_id: 98000001, alliance_id: 99000001, security_status: 3.42 },
    '/characters/{c}/wallet/': 2345678901.23,
    '/characters/{c}/location/': inAbyss ? { solar_system_id: 32000123 } : { solar_system_id: 30000142, station_id: 60003760 },
    '/characters/{c}/ship/': { ship_type_id: ship, ship_name: 'Gila Run', ship_item_id: 1 },
    '/characters/{c}/online/': { online: true },
    '/characters/{c}/skills/': { total_sp: 85432100, unallocated_sp: 120000, skills: [
      { skill_id: 3300, trained_skill_level: 5, skillpoints_in_skill: 256000 }, { skill_id: 3301, trained_skill_level: 4, skillpoints_in_skill: 45255 },
      { skill_id: 3436, trained_skill_level: 5, skillpoints_in_skill: 256000 }, { skill_id: 3437, trained_skill_level: 3, skillpoints_in_skill: 8000 },
      { skill_id: 3319, trained_skill_level: 5, skillpoints_in_skill: 256000 }, { skill_id: 3413, trained_skill_level: 4, skillpoints_in_skill: 45255 }] },
    '/characters/{c}/skillqueue/': [
      { skill_id: 3437, finished_level: 4, queue_position: 0, start_date: ago(5), finish_date: ago(-12) },
      { skill_id: 3301, finished_level: 5, queue_position: 1, start_date: ago(-12), finish_date: ago(-150) }],
    '/characters/{c}/wallet/journal/': journal,
    '/characters/{c}/assets/': [
      { item_id: 1, type_id: 17715, quantity: 1, location_id: 60003760, location_flag: 'Hangar', is_singleton: true },
      { item_id: 2, type_id: 34, quantity: 2500000, location_id: 60003760, location_flag: 'Hangar' },
      { item_id: 3, type_id: 47895, quantity: 12, location_id: 1, location_flag: 'Cargo' },
      { item_id: 4, type_id: 44992, quantity: 3, location_id: 60008494, location_flag: 'Hangar' },
      { item_id: 5, type_id: 47466, quantity: 1, location_id: 1035466617946, location_flag: 'Hangar', is_singleton: true }],
    '/characters/{c}/orders/': [
      { order_id: 1, type_id: 47895, price: 3900000, volume_remain: 8, volume_total: 10, location_id: 60003760, issued: ago(30) },
      { order_id: 2, type_id: 34, is_buy_order: true, price: 3.5, volume_remain: 500000, volume_total: 800000, location_id: 60003760, issued: ago(10), escrow: 1750000 }],
    '/characters/{c}/orders/history/': [
      { order_id: 11, type_id: 47895, price: 4100000, volume_remain: 0, volume_total: 5, location_id: 60003760, issued: ago(120), state: 'completed' }],
    '/universe/structures/1035466617946/': { name: 'Perimeter - Demo Industries 星城' }
  };
  var NAMES = { 98000001: 'Demo Industries', 99000001: 'Demo Alliance', 30000142: '吉他', 60003760: 'Jita IV - Moon 4 - Caldari Navy Assembly Plant', 60008494: 'Amarr VIII (Oris) - Emperor Family Academy', 30002187: '艾玛', 32000123: 'J-深渊 123', 1000125: '统一合作关系部', 1000035: '加达里海军', 2120000002: 'Trader Bob' };

  var json = function (body, status, headers) { return Promise.resolve(new Response(JSON.stringify(body), { status: status || 200, headers: headers || { 'Content-Type': 'application/json' } })); };
  window.__MOCK__ = function (url, opts) {
    var u = new URL(url);
    if (u.host === 'eve.navexor.top') {
      if (u.pathname === '/api/esi/config') return json({ client_id: 'demo', redirect_uri: 'https://eve.navexor.top/', scopes: scopes });
      if (u.pathname === '/type-names-zh.json') return fetch('/eve-overview-clone/type-names-zh.json');
      if (u.pathname === '/skill-data.json') return fetch('/eve-overview-clone/skill-data.json');
      if (u.pathname === '/map-data.json') return fetch('/eve-overview-clone/map-data.json');
      if (u.pathname === '/npc-names-zh.json') return fetch('/eve-overview-clone/npc-names-zh.json');
      if (u.pathname === '/i18n/names-en.json') return fetch('/eve-overview-clone/i18n/names-en.json');
      if (u.pathname === '/api/v1/prices') {
        var types = {};
        u.searchParams.get('types').split(',').forEach(function (id) { var base = { 34: 4.2, 17715: 280e6, 47895: 4.1e6, 44992: 2.4e6, 47466: 55e6, 47407: 92e6, 49734: 31e6, 52227: 8e6, 47762: 1.2e6, 2679: 300, 29668: 2.1e9 }[id] || ((Number(id) * 9301) % 5000000); types[id] = { sell: base, buy: base * 0.9 }; });
        return json({ hub: 10000002, types: types });
      }
    }
    var path = u.pathname.replace(/^\/latest/, '').replace('/' + CID + '/', '/{c}/');
    if (path === '/universe/names/') {
      var ids = JSON.parse(opts.body);
      return json(ids.filter(function (i) { return NAMES[i]; }).map(function (i) { return { id: i, name: NAMES[i] }; }));
    }
    if (ESI[path] !== undefined) return json(ESI[path], 200, { 'Content-Type': 'application/json', 'X-Pages': '1' });
    return json({ error: 'mock 404 ' + path }, 404);
  };

  // 游戏日志：一个文件，含上一趟深渊（约 2 小时前，持续 14 分钟）的战斗
  var t0 = now - 2 * 3600e3;
  var p2 = function (x) { return String(x).padStart(2, '0'); };
  var stamp = function (t) { var d = new Date(t); return d.getUTCFullYear() + '.' + p2(d.getUTCMonth() + 1) + '.' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds()); };
  var start = new Date(t0 - 3600e3);
  var fname = start.getUTCFullYear() + p2(start.getUTCMonth() + 1) + p2(start.getUTCDate()) + '_' + p2(start.getUTCHours()) + p2(start.getUTCMinutes()) + p2(start.getUTCSeconds()) + '_' + CID + '.txt';
  var lines = ['------------------------------------------------------------', '  Gamelog', '  Listener: ' + NAME, '  Session Started: ' + stamp(start), '------------------------------------------------------------'];
  lines.push('[ ' + stamp(t0) + ' ] (notify) 深渊空间的能量开始变得不稳定');
  for (var i = 0; i < 60; i++) {
    var t = t0 + 30e3 + i * 13e3;
    lines.push('[ ' + stamp(t) + ' ] (combat) <color=0xff00ffff><b>' + (420 + (i * 37) % 300) + '</b> <color=0x77ffffff><font size=10>to</font> <b><color=0xffffffff>' + (i < 25 ? 'Lucid Deepwatcher' : 'Vila Damavik') + '</b><font size=10><color=0x77ffffff> - Heavy Assault Missile - Hits');
    if (i % 3 === 0) lines.push('[ ' + stamp(t + 2e3) + ' ] (combat) <color=0xffcc0000><b>' + (120 + i) + '</b> <color=0x77ffffff><font size=10>from</font> <b><color=0xffffffff>Lucid Deepwatcher</b><font size=10><color=0x77ffffff> - Glances Off');
  }
  // 今天的赏金挂账与采矿（实时收益页）
  for (var k = 0; k < 30; k++) {
    var tk = now - 50 * 60e3 + k * 90e3;
    lines.push('[ ' + stamp(tk) + ' ] (bounty) <font size=12><b><color=0xff00aa00>' + (180000 + k * 3137).toLocaleString('en-US') + ' ISK</b><color=0xffbbbbbb> added to next bounty payout</font>');
    if (k % 2 === 0) lines.push('[ ' + stamp(tk + 5e3) + ' ] (mining) You mined <color=#ff8dc169>' + (1200 + k * 10).toLocaleString('en-US') + '</color> units of <color=#ffffffff><font size=12>Veldspar</font></color>');
  }
  lines.push('[ ' + stamp(now - 60e3) + ' ] (bounty) 152,300 星币已添加到下一次赏金支付');
  lines.push('[ ' + stamp(now - 50e3) + ' ] (mining) 你开采了 800 单位的 凝滞硬石');
  // UTF-16LE 带 BOM（游戏日志、聊天日志都是）
  var u16 = function (str) { var b = new Uint8Array(2 + str.length * 2); b[0] = 0xff; b[1] = 0xfe; for (var i = 0; i < str.length; i++) { var c = str.charCodeAt(i); b[2 + i * 2] = c & 255; b[3 + i * 2] = c >> 8; } return b; };
  var bytes = u16(lines.join('\r\n') + '\r\n');
  // 聊天日志本地频道：吉他 → 深渊（2 小时前一趟，与上面的战斗对得上）→ 吉他；6 小时前还有一趟 ESI 没记到的
  var chat = ['---------------------------------------------------------------', '  Channel ID:      local', '  Channel Name:    Local', '  Listener:        ' + NAME, '  Session started: ' + stamp(start), '---------------------------------------------------------------',
    '[ ' + stamp(now - 6 * 3600e3) + ' ] EVE System > Channel changed to Local : Jita*',
    '[ ' + stamp(now - 6 * 3600e3 + 60e3) + ' ] EVE System > Channel changed to Local : Abyssal Deadspace*',
    '[ ' + stamp(now - 6 * 3600e3 + 13 * 60e3) + ' ] EVE System > Channel changed to Local : Jita*',
    '[ ' + stamp(t0 - 5e3) + ' ] EVE System > Channel changed to Local : Abyssal Deadspace*',
    '[ ' + stamp(t0 + 14 * 60e3 + 12e3) + ' ] EVE System > Channel changed to Local : 吉他*',
    '[ ' + stamp(t0 + 14 * 60e3 + 12e3) + ' ] EVE System > Channel changed to Local : 吉他*'];
  var cname = 'Local_' + fname.replace(/_\d+\.txt$/, '') + '_' + CID + '.txt';
  var cbytes = u16(chat.join('\r\n') + '\r\n');
  var files = { Gamelogs: [[fname, bytes]], Chatlogs: [[cname, cbytes]] };
  window.__MOCK_INVOKE__ = function (cmd, args) {
    if (cmd === 'logs_dir') return Promise.resolve('C:\\Users\\demo\\Documents\\EVE\\logs');
    if (cmd === 'logs_list') return Promise.resolve(files[args.sub].map(function (f) { return [f[0], f[1].length]; }));
    if (cmd === 'logs_read') { var f = files[args.sub].find(function (x) { return x[0] === args.name; }); return Promise.resolve(f[1].slice(args.offset, args.offset + args.len).buffer); }
    if (cmd === 'clip_seq') return Promise.resolve(clip.seq);
    if (cmd === 'clip_text') return Promise.resolve(clip.text);
    return Promise.reject(new Error('mock: ' + cmd));
  };
  // 模拟游戏里 Ctrl+C：window.__mockCopy('名称\t数量\n…')
  var clip = { seq: 1, text: '' };
  window.__mockCopy = function (text) { clip.text = text; clip.seq++; };
  // 预置两趟深渊记录（一趟带日志时间）
  if (!localStorage.getItem('lite-abyss')) {
    localStorage.setItem('lite-abyss', JSON.stringify({ runs: [
      { id: 'm1', char: CID, charName: NAME, start: t0 - 20e3, end: t0 + 14 * 60e3, sys: 32000120, startShip: 47466, ship: 47466, died: false, filament: 47895, qty: 1, extra: 0, auto: true },
      { id: 'm2', char: CID, charName: NAME, start: now - 30 * 3600e3, end: now - 30 * 3600e3 + 17 * 60e3, sys: 32000110, startShip: 47466, ship: 670, died: true, filament: 47895, qty: 1, extra: 0, auto: true }
    ], set: { filament: 47895, qty: 1, extra: 0, side: 'sell', monitor: true, range: '7d' } }));
  }
})();
// 预览版本号与自动更新：?mock=…&upd=1 时假装有新版本 0.2.1
(function () {
  var q = new URLSearchParams(location.search);
  if (!q.has('mock')) return;
  window.__MOCK_VERSION__ = '0.2.0';
  if (q.get('upd') !== '1') return;
  window.__MOCK_UPDATER__ = {
    check: function () {
      return new Promise(function (ok) { setTimeout(function () { ok({ version: '0.2.1', downloadAndInstall: function (cb) {
        return new Promise(function (done) { cb({ event: 'Started', data: { contentLength: 100 } }); var n = 0;
          var t = setInterval(function () { n += 20; cb({ event: 'Progress', data: { chunkLength: 20 } }); if (n >= 100) { clearInterval(t); cb({ event: 'Finished' }); done(); } }, 300); });
      } }); }, 300); });
    }
  };
})();
