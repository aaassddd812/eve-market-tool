// ===== 驾驶模拟「练习」：固定场景 + 分步提示 + 指引箭头 + 自动检查 + 打分 =====
// 每一课：固定的船和装配（裂谷级）、一个或几个训练目标（只有船体、不动手：引擎里由「玩家驾驶」接管、不下任何指令），
// 一串步骤（提示文字、箭头指向的界面元素或太空中的位置、完成条件）。全部步骤完成后打分：
//   时间分：用时不超过标准时间满分，超过后线性下降，到 3 倍标准时间为 0；
//   有精度项的课（环绕、保持距离、超载）：总分 = 精度 50% + 时间 50%，没有精度项的总分 = 时间分。
//   90 分以上三星、70 分以上两星、其余一星；每课的最好成绩记在本机。
// pilot.js 用法：initTutor(钩子) → 设置页「练习」标签放 tutListHtml(选中的课) → 开课 tutSpec(id) 准备船和目标、建好战斗后 tutBegin(id)
// → 每帧 tutTick() → 战斗结束时先问 tutEnd()（返回 true 表示练习自己处理了结算）→ 离开 tutStop()。

const STORE_KEY = 'eve-pilot-tut';
const PAR_SLACK = 2;   // 超过标准时间后，再过 PAR_SLACK 倍标准时间降到 0 分

// 我的船：裂谷级，三门 200mm 自动加农炮 II（冰雹 S）、微型跃迁推进器、扰频、网子、损控
const M = (type, state = 'online', charge = null) => ({ type, state, charge });
const AU = 149597870700, GRID = 8e6;   // 天文单位（米）；同一网格的范围（同 sim-engine 的 GRID）
const RIFTER = { id: null, name: '练习', ship: 587, slots: { high: [M(2889, 'active', 12608), M(2889, 'active', 12608), M(2889, 'active', 12608)], mid: [M(5973), M(447), M(527)], low: [M(2048), M(1541)], rig: [], sub: [] }, drones: [], implants: [] };
const BADGER = 648, RIFTER_HULL = 587, STABBER = 622;
// 后面几章的装配（engine 不检查装配资源，这里尽量按游戏里装得下的来配）
const SAR = 1183, MWD = 5973, SCRAM1 = 447, MJD = 33915, COVOPS = 11578, AB = 438;
const RIFTER_REP = { ...RIFTER, slots: { ...RIFTER.slots, low: [M(SAR), M(2048), M(1541)] } };
// 中型微型跳跃引擎只能装在战列巡洋舰、指挥舰、深空运输舰等上（canFitShipGroup），巡洋舰装不了：用暴风级
const HURRICANE_MJD = { id: null, name: '练习', ship: 24702, slots: { high: [M(2897, 'active', 192), M(2897, 'active', 192), M(2897, 'active', 192), M(2897, 'active', 192)], mid: [M(MJD), M(3831), M(3831)], low: [M(2048)], rig: [], sub: [] }, drones: [], implants: [] };
const TRISTAN = { id: null, name: '练习', ship: 593, slots: { high: [], mid: [M(AB)], low: [M(4405), M(2048)], rig: [], sub: [] }, drones: [{ type: 2456, count: 5, active: 5 }], implants: [] };
const STRATIOS = { id: null, name: '练习', ship: 33470, slots: { high: [M(COVOPS)], mid: [M(5973)], low: [M(2048)], rig: [], sub: [] }, drones: [], implants: [] };
// 假隐跳：普通隐形装置（加强型隐形装置 II）+ 50MN 微型跃迁推进器 II 的狂暴级（普通巡洋舰，不能隐形跃迁）
const IMPCLOAK = 11577, MWD50 = 12076;
const STABBER_CLOAKY = { id: null, name: '练习', ship: STABBER, slots: { high: [M(IMPCLOAK)], mid: [M(MWD50)], low: [M(2048)], rig: [], sub: [] }, drones: [], implants: [] };
const KESTREL = { id: null, name: '练习', ship: 602, slots: { high: [M(2404, 'active', 210), M(2404, 'active', 210), M(2404, 'active', 210), M(2404, 'active', 210)], mid: [M(AB), M(380), M(380)], low: [M(22291), M(2048)], rig: [], sub: [] }, drones: [], implants: [] };
// 舰队、电子战、杂项几课的装配
const SRSB = 3588, NEUT = 13003, CAPB = 3568, ECM = 2567, BUBBLE = 22782;
const BURST = { id: null, name: '练习', ship: 599, slots: { high: [M(SRSB), M(SRSB)], mid: [M(AB), M(380)], low: [M(2048)], rig: [], sub: [] }, drones: [], implants: [] };
const RIFTER_NEUT = { ...RIFTER, slots: { ...RIFTER.slots, high: [...RIFTER.slots.high.slice(0, 2), M(NEUT)] } };   // 裂谷级只有三个高槽：两门炮 + 中和器
const RIFTER_CAPB = { ...RIFTER, slots: { ...RIFTER.slots, mid: [M(MWD), M(CAPB, 'active', 31998), M(527)] } };
const GRIFFIN = { id: null, name: '练习', ship: 584, slots: { high: [], mid: [M(ECM), M(ECM), M(ECM), M(AB)], low: [M(2048)], rig: [], sub: [] }, drones: [], implants: [] };
const SVIPUL = { id: null, name: '练习', ship: 34562, slots: { high: [M(2889, 'active', 12608), M(2889, 'active', 12608), M(2889, 'active', 12608), M(2889, 'active', 12608)], mid: [M(MWD)], low: [M(2048)], rig: [], sub: [] }, drones: [], implants: [] };
// 探索护卫舰苍鹭级：核心探针发射器 I（装核心扫描探针 I）+ 加力燃烧器
const PROBE_LAUNCHER = 17938, CORE_PROBE = 30013;
const HERON = { id: null, name: '练习', ship: 605, slots: { high: [M(PROBE_LAUNCHER, 'active', CORE_PROBE)], mid: [M(AB)], low: [], rig: [], sub: [] }, drones: [], implants: [] };
const SABRE = { id: null, name: '练习', ship: 22456, slots: { high: [M(BUBBLE, 'active', 22778), M(2889, 'active', 12608), M(2889, 'active', 12608), M(2889, 'active', 12608)], mid: [M(MWD)], low: [M(2048)], rig: [], sub: [] }, drones: [], implants: [] };
// 敌船：扰频你的（一门炮 + 扰频）、对打的（两门炮）、近战疾速炮、拦截（网 + 扰频 + 一门炮）
const TACKLER = { id: null, name: '敌船', ship: 587, slots: { high: [M(2889, 'active', 12608)], mid: [M(448)], low: [], rig: [], sub: [] }, drones: [], implants: [] };
const BRAWLER = { id: null, name: '敌船', ship: 587, slots: { high: [M(2889, 'active', 12608), M(2889, 'active', 12608)], mid: [], low: [], rig: [], sub: [] }, drones: [], implants: [] };
const BRAWLER_WEAK = { id: null, name: '敌船', ship: 587, slots: { high: [M(2873, 'active', 12608)], mid: [], low: [], rig: [], sub: [] }, drones: [], implants: [] };
const BLASTER = { id: null, name: '敌船', ship: 594, slots: { high: [M(3178, 'active', 222), M(3178, 'active', 222), M(3178, 'active', 222)], mid: [], low: [], rig: [], sub: [] }, drones: [], implants: [] };
const ATRON_TACKLE = { id: null, name: '敌船', ship: 608, slots: { high: [M(3162, 'active', 222)], mid: [M(448), M(527)], low: [], rig: [], sub: [] }, drones: [], implants: [] };

// 训练目标：ship、at = 相对我的位置（米，我在原点、船头朝 +x），move = 慢速直线飞（方向、速度比例）
// 步骤：text 提示；at(T) 箭头指向（CSS 选择器、{ unit: i } 太空中的船、{ x, y } 屏幕坐标），没有就不出箭头；
//   done(T) 完成条件；hold = { secs, need(T), ok(T) }：need 成立时计时，满 secs 秒完成，期间按 ok 统计精度；
//   enter(T) 进入这一步时调用（记下当时的状态）
const CH = [
  { n: 1, name: '飞行' },
  { n: 2, name: '目标与武器' },
  { n: 3, name: '生存' },
  { n: 4, name: '抓人与被抓' },
  { n: 5, name: '无人机与隐形' },
  { n: 6, name: '实战' },
  { n: 7, name: '舰队' },
  { n: 8, name: '电子战' },
  { n: 9, name: '其他技巧' },
  { n: 10, name: '扫描' },
];
// 基础：飞行、目标与武器、生存；其余是进阶
const LEVELS = [{ name: '基础练习', ch: [1, 2, 3] }, { name: '进阶练习', ch: [4, 5, 6, 7, 8, 9, 10] }];
const ovRow = (i) => `#plOv tr[data-k="u${i}"]`;
// 火力点名：舰队广播写进日志（客户端舰队广播是「目标 XX」这样一行）
// 队长点名：发一条「锁定」舰队广播（舰队窗口底部的广播条、广播窗口、总览里目标那一行的广播图标都能看到）
const call = (T, k) => { T.v.called = k; H.broadcast?.('target', { u: T.d[k], who: T.S.fleet?.fc }); };
const bubbleR = (T) => (T.me.t.bubbles || [])[0]?.range || 20000;
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// 总览里第一个够远、能跃迁的天体（距离列是 AU 的那一行；近处的星门跃迁不了）
const farRow = () => [...H.root().querySelectorAll('#plOv tr[data-k^="c"]')].find((tr) => /AU/.test(tr.cells[1]?.textContent || '')) || '#plOv tr[data-k^="c"]';
const LESSONS = [
  {
    id: '1-1', ch: 1, name: '视角', desc: '转动、缩放镜头，看清周围',
    targets: [{ ship: BADGER, at: [12000, 0, 3000] }], par: 30,
    steps: [
      { text: '按住鼠标左键在太空中拖动，转动视角（转过 90° 以上）', at: () => ({ center: true }), enter: (T) => { T.v.cam0 = T.cam(); T.v.turn = 0; }, done: (T) => T.v.turn >= 90 },
      { text: '滚动鼠标滚轮，把镜头拉远到 2 倍以上', enter: (T) => { T.v.dLo = Infinity; }, done: (T) => { const d = T.cam()?.d || 0; T.v.dLo = Math.min(T.v.dLo, d); return d >= T.v.dLo * 2; } },
      { text: '再把镜头拉近到一半以内', enter: (T) => { T.v.dHi = 0; }, done: (T) => { const d = T.cam()?.d || Infinity; T.v.dHi = Math.max(T.v.dHi, d === Infinity ? 0 : d); return d <= T.v.dHi * 0.5; } },
    ],
  },
  {
    id: '1-2', ch: 1, name: '飞行与速度', desc: '双击太空飞行、用速度表调速、停船',
    targets: [{ ship: BADGER, at: [30000, 0, 8000] }], par: 50,
    steps: [
      { text: '在太空中双击，让船朝那个方向飞', done: (T) => T.P.cmd === 'dir' },
      { text: '点速度表下半圈的中间，把速度设为一半左右，并等船速稳定下来', at: () => '#plHudC', done: (T) => T.P.speed >= 0.35 && T.P.speed <= 0.65 && near(T.spd(), T.P.speed * T.vmax(), T.vmax() * 0.08) },
      { text: '点速度表右边的「+」全速前进，等船速到最大', at: () => '[data-pl-spd="max"]', done: (T) => T.P.speed >= 0.99 && T.spd() >= T.vmax() * 0.92 },
      { text: '按 Ctrl + 空格（或点速度表左边的「−」）停船，等船停下', at: () => '[data-pl-spd="stop"]', done: (T) => T.P.cmd === 'stop' && T.spd() < 5 },
    ],
  },
  {
    id: '1-3', ch: 1, name: '接近', desc: '在总览里选中目标，用 Q 接近',
    targets: [{ ship: BADGER, at: [25000, 0, 0] }], par: 45,
    steps: [
      { text: '在总览里点一下训练目标，选中它', at: (T) => ovRow(T.d[0].i), done: (T) => T.S.sel === T.d[0].i },
      { text: '按住 Q 点击训练目标（总览里或太空中都可以），开始接近', at: (T) => ({ unit: T.d[0].i }), done: (T) => T.P.cmd === 'approach' && T.P.tgt === T.d[0] },
      { text: '飞到距离训练目标 2,500 m 以内（嫌慢可以按 Alt + F1 开微型跃迁推进器）', done: (T) => T.dist(T.d[0]) <= 2500 },
    ],
  },
  {
    id: '1-4', ch: 1, name: '环绕', desc: '设置环绕距离，用 W 环绕目标', acc: '环绕距离误差 1.5 km 以内的时间',
    targets: [{ ship: BADGER, at: [15000, 0, 0] }], par: 55,
    steps: [
      { text: '在总览里选中训练目标，然后右键「选中的物体」窗口里的「环绕」按钮，把默认环绕距离设为 10000 米', at: (T) => (T.S.sel === T.d[0].i ? '[data-pl-act="orbit"]' : ovRow(T.d[0].i)), done: (T) => T.S.orbit === 10000 },
      { text: '按住 W 点击训练目标，开始环绕', at: (T) => ({ unit: T.d[0].i }), done: (T) => T.P.cmd === 'orbit' && T.P.tgt === T.d[0] && near(T.P.dist, 10000, 1) },
      { text: '飞进 10 km 的环绕轨道后，保持环绕 20 秒', hold: { secs: 20, need: (T) => T.P.cmd === 'orbit' && T.P.tgt === T.d[0], ok: (T) => near(T.dist(T.d[0]), 10000, 1500) } },
    ],
  },
  {
    id: '1-5', ch: 1, name: '保持距离', desc: '用 E 跟住一个在飞的目标', acc: '距离误差 3 km 以内的时间',
    targets: [{ ship: BADGER, at: [20000, 0, 0], move: { dir: [0, 0, 1], speed: 0.6 } }], par: 50,
    steps: [
      { text: '在总览里选中训练目标，右键「选中的物体」窗口里的「保持距离」按钮，把默认距离设为 15000 米', at: (T) => (T.S.sel === T.d[0].i ? '[data-pl-act="keep"]' : ovRow(T.d[0].i)), done: (T) => T.S.keep === 15000 },
      { text: '按住 E 点击训练目标，和它保持距离', at: (T) => ({ unit: T.d[0].i }), done: (T) => T.P.cmd === 'keep' && T.P.tgt === T.d[0] && near(T.P.dist, 15000, 1) },
      { text: '到 15 km 附近以后，跟住它 30 秒', hold: { secs: 30, need: (T) => T.P.cmd === 'keep' && T.P.tgt === T.d[0], ok: (T) => near(T.dist(T.d[0]), 15000, 3000) } },
    ],
  },
  {
    id: '1-6', ch: 1, name: '跃迁', desc: '在总览里跃迁到天体',
    targets: [{ ship: BADGER, at: [20000, 0, 0] }], par: 75,
    steps: [
      { text: '点总览上方的「跃迁到」页签', at: () => '[data-pl-ovtab="2"]', done: (T) => T.S.ovTab === 2 },
      { text: '按住 S 点击总览里的一个天体，跃迁至 0 m（也可以右键天体选「跃迁至」）', at: () => farRow(), done: (T) => T.P.cmd === 'warp' || Boolean(T.me.warp) },
      { text: '等待对准、跃迁、落地', done: (T) => T.warped() },
    ],
  },
  {
    id: '1-7', ch: 1, name: '指定空间点航行', desc: '按住 Q 在太空中选一个点飞过去（Q 走位）',
    targets: [{ ship: BADGER, at: [20000, 0, 0] }], par: 40,
    steps: [
      { text: '按住 Q 不放，在太空中移动鼠标：船周围的水平面上会出现落点和连线。点一下左键，定下水平位置', done: (T) => T.S.mv?.state === 'y' || T.P.cmd === 'point' },
      { text: '继续按住 Q，上下移动鼠标调高度，再点一下左键出发', done: (T) => T.P.cmd === 'point' },
      { text: '朝选好的点飞出 3 km（到了会自己停下）', enter: (T) => { T.v.p0 = T.me.pos.slice(); }, done: (T) => Math.hypot(T.me.pos[0] - T.v.p0[0], T.me.pos[1] - T.v.p0[1], T.me.pos[2] - T.v.p0[2]) >= 3000 || T.P.cmd !== 'point' },
    ],
  },
  {
    id: '2-1', ch: 2, name: '总览与选中', desc: '切换总览页签，在总览和太空中选中目标',
    targets: [{ ship: RIFTER_HULL, at: [9000, 0, -3000] }, { ship: RIFTER_HULL, at: [14000, 0, 4000] }, { ship: RIFTER_HULL, at: [20000, 1000, 0] }], par: 25,
    steps: [
      { text: '点总览的「PVP」页签（只显示敌对的船）', at: () => '[data-pl-ovtab="4"]', done: (T) => T.S.ovTab === 4 },
      { text: '在总览里点最近的训练目标（按距离排在第一行）', at: (T) => ovRow(T.nearest().i), done: (T) => T.S.sel === T.nearest().i },
      { text: '直接在太空中点另一个训练目标选中它', at: (T) => { const v = T.d.find((x) => x.i !== T.v.sel0); return v ? { unit: v.i } : null; }, enter: (T) => { T.v.sel0 = T.S.sel; }, done: (T) => T.d.some((x) => x.i === T.S.sel && x.i !== T.v.sel0) },
    ],
  },
  {
    id: '2-2', ch: 2, name: '锁定', desc: 'Ctrl + 点击锁定两个目标，切换当前目标',
    targets: [{ ship: RIFTER_HULL, at: [8000, 0, -2500] }, { ship: RIFTER_HULL, at: [10000, 0, 3000] }], par: 25,
    steps: [
      { text: '按住 Ctrl 点击一个训练目标，锁定它（等锁定完成）', at: (T) => ({ unit: T.d[0].i }), done: (T) => T.locked().length >= 1 },
      { text: '再锁定另一个训练目标', at: (T) => { const v = T.d.find((x) => !T.P.locks.has(x)); return v ? { unit: v.i } : null; }, done: (T) => T.locked().length >= 2 },
      { text: '点画面上方另一个目标的图标，把它设为当前目标', at: (T) => { const v = T.locked().find((x) => x !== T.P.active); return v ? `[data-pl-tgt="${v.i}"]` : null; }, enter: (T) => { T.v.act0 = T.P.active; }, done: (T) => T.P.active && T.P.active !== T.v.act0 && T.locked().includes(T.P.active) },
    ],
  },
  {
    id: '2-3', ch: 2, name: '开火', desc: '锁定后用 F1 开火，击毁目标',
    targets: [{ ship: RIFTER_HULL, at: [3000, 0, 0] }], par: 40,
    steps: [
      { text: '按住 Ctrl 点击训练目标锁定它', at: (T) => ({ unit: T.d[0].i }), done: (T) => T.locked().includes(T.d[0]) },
      { text: '按 F1（或点高槽的武器）开火：三门炮编成了一组，一起开', at: (T) => T.gunSel(), done: (T) => T.gunsOn() },
      { text: '击毁训练目标', done: (T) => !T.d[0].alive },
    ],
  },
  {
    id: '2-4', ch: 2, name: '射程', desc: '用战术视图看射程，飞进射程再开火',
    targets: [{ ship: RIFTER_HULL, at: [22000, 0, 0] }], par: 75,
    steps: [
      { text: '按 Ctrl + D（或点船体面板左边的战术视图按钮）打开战术视图', at: () => '[data-pl-tac]', done: (T) => T.S.set.tac },
      { text: '把鼠标移到武器上，太空中会画出最佳射程和失准范围的圈', at: (T) => T.gunSel(), done: (T) => T.S.tacMod != null && T.isGun(T.S.tacMod) },
      { text: '训练目标在射程外：接近到失准范围以内，锁定并开火击毁它', at: (T) => ({ unit: T.d[0].i }), done: (T) => !T.d[0].alive },
    ],
  },
  {
    id: '2-5', ch: 2, name: '弹药', desc: '右键武器换弹药，装填完成后开火',
    targets: [{ ship: RIFTER_HULL, at: [4000, 0, 0] }], par: 45,
    steps: [
      { text: '右键武器，换一种弹药（换上就开始装填）', at: (T) => T.gunSel(), done: (T) => T.guns().some((m) => (T.S.charges?.[m] || 0) && T.S.charges[m] !== T.S.on.rack[m].charge) },
      { text: '锁定训练目标，装填完成后开火击毁它', at: (T) => ({ unit: T.d[0].i }), done: (T) => !T.d[0].alive },
    ],
  },
  {
    id: '2-6', ch: 2, name: '超载', desc: '超载武器提高伤害，注意热量', acc: '武器剩余耐久（过热损伤越少越好）',
    targets: [{ ship: STABBER, at: [3500, 0, 0] }], par: 70,
    steps: [
      { text: '点武器上方的超载按钮（或 Shift + 点击武器）开启超载', at: (T) => T.ovlSel(), done: (T) => T.guns().some((m) => T.S.rk.ovl.has(m)) },
      { text: '锁定训练目标并开火，击毁它（超载会积热、损伤武器，打完记得关掉）', at: (T) => ({ unit: T.d[0].i }), done: (T) => !T.d[0].alive },
    ],
    score: (T) => { const g = T.guns(); return g.length ? g.reduce((s, m) => s + (T.S.rk.burnt.has(m) ? 0 : 1 - Math.min(1, (T.S.rk.dmg.get(m) || 0) / (T.S.rk.heat[m]?.hp || 40))), 0) / g.length : 1; },
  },
  // ---------- 第三章 · 生存 ----------
  {
    id: '3-1', ch: 3, name: '本地维修', desc: '用装甲维修器把装甲修回来', fit: RIFTER_REP,
    targets: [{ ship: BADGER, at: [30000, 0, 0] }], par: 45,
    setup: (T) => { T.me.hp[1] = T.me.t.max[1] * 0.3; },
    steps: [
      { text: '你的装甲只剩三成。把鼠标移到船体面板的血量圈上，看护盾、装甲、结构的具体数值', at: () => '#plHudC', done: (T) => T.S.htip?.k === 'hp' },
      { text: '按 Ctrl + F1（或点低槽第一个装备）开启装甲维修器', at: (T) => T.modSel(SAR), done: (T) => T.modOn(SAR) },
      { text: '等装甲修到 95% 以上', done: (T) => T.layer(1) >= 0.95 },
      { text: '修好以后关掉装甲维修器，省下电容', at: (T) => T.modSel(SAR), done: (T) => !T.modOn(SAR) },
    ],
  },
  {
    id: '3-2', ch: 3, name: '电容', desc: '装备开太多电容会见底，学会只开要用的', fit: RIFTER_REP,
    targets: [{ ship: BADGER, at: [30000, 0, 0] }], par: 50,
    setup: (T) => { T.me.cap = T.me.t.cap.max * 0.4; T.me.hp[1] = T.me.t.max[1] * 0.6; },
    steps: [
      { text: '同时开启微型跃迁推进器（Alt + F1）和装甲维修器（Ctrl + F1）', at: (T) => (T.propOn() ? T.modSel(SAR) : T.modSel(MWD)), done: (T) => T.propOn() && T.modOn(SAR) },
      { text: '看船体面板中间的电容：一直往下掉，直到有装备因为电容不够自己停下（日志里会写）', at: () => '#plHudC', done: (T) => T.logHas(/单位电荷/) },
      { text: '只开要用的：关掉推进器和维修器，等电容回到 50% 以上', at: (T) => (T.propOn() ? T.modSel(MWD) : T.modOn(SAR) ? T.modSel(SAR) : null), done: (T) => !T.propOn() && !T.modOn(SAR) && T.capFrac() >= 0.5 },
    ],
  },
  {
    id: '3-3', ch: 3, name: '推进器', desc: '开微型跃迁推进器拉开距离，看速度和信号半径的变化', fit: RIFTER,
    targets: [{ ship: RIFTER_HULL, at: [3000, 0, 0] }], par: 35,
    steps: [
      { text: '把鼠标移到中槽第一个装备（微型跃迁推进器）上，看提示里开启后的速度和信号半径', at: (T) => T.modSel(MWD), done: (T) => T.S.tacMod != null && T.S.tacMod === T.S.prop },
      { text: '在太空中双击，朝远离训练目标的方向飞', done: (T) => T.P.cmd === 'dir' },
      { text: '按 Alt + F1 开启微型跃迁推进器，速度会升到原来的约 5 倍（信号半径也会变大，更容易被打中）', at: (T) => T.modSel(MWD), done: (T) => T.propOn() && T.spd() >= T.baseVel() * 2.5 },
      { text: '把和训练目标的距离拉开到 30 km 以外', done: (T) => T.dist(T.d[0]) >= 30000 },
    ],
  },
  // ---------- 第四章 · 抓人与被抓 ----------
  {
    id: '4-1', ch: 4, name: '扰频', desc: '运输舰要跃迁逃跑，用扰频器把它留下', fit: RIFTER,
    targets: [{ ship: BADGER, at: [6000, 0, 1500], name: '逃跑的运输舰' }], par: 60,
    // 运输舰开局 2 秒后开始对准跃迁（被扰住就每 2 秒再试一次）
    script: (T) => {
      const h = T.d[0];
      if (!h.alive || h.warp || T.t < 2 || h.pilot.cmd === 'warp' || (T.v.tryAt || 0) > T.t) return;
      T.v.tryAt = T.t + 2;
      T.S.b.warpTo(h, { cel: T.farCel(h) }, 0);
    },
    setup: (T) => { const h = T.d[0]; h.hp = h.hp.map((x) => x * 0.5); },   // 运输舰已经挨过打
    failIf: (T) => (T.d[0].warp?.go ? '运输舰跃迁逃走了' : null),
    steps: [
      { text: '运输舰正在对准、准备跃迁逃走！按住 Ctrl 点击它，马上锁定', at: (T) => ({ unit: T.d[0].i }), done: (T) => T.locked().includes(T.d[0]) },
      { text: '按 Alt + F2（中槽第二个）开启跃迁扰频器扰住它（射程约 7 km）', at: (T) => T.modSel(SCRAM1), done: (T) => T.pointed(T.d[0]) },
      { text: '它跑不掉了：按住 Q 点击它靠近，开火击毁它', at: (T) => ({ unit: T.d[0].i }), done: (T) => !T.d[0].alive },
    ],
  },
  {
    id: '4-2', ch: 4, name: '被扰频', desc: '被扰频时跃迁不了，先打掉扰频你的船再走', fit: RIFTER, hostile: true,
    targets: [{ ship: RIFTER_HULL, at: [5000, 0, -1000], fit: TACKLER, ai: true, name: '扰频你的敌船' }], par: 90,
    steps: [
      { text: '敌船正在锁定你。等船体面板上方出现「被跃迁扰频」的图标', done: (T) => T.pointed(T.me) },
      { text: '按住 S 点击总览里一个远处的天体，试着跃迁（会失败）', at: (T) => (T.pointed(T.me) ? farRow() : null), done: (T) => T.logHas(/禁止你的跃迁/) },
      { text: '跃迁不了就先解决它：锁定敌船，开火击毁它', at: (T) => ({ unit: T.d[0].i }), done: (T) => !T.d[0].alive },
      { text: '扰频解除了：现在跃迁到一个天体离开', at: () => farRow(), done: (T) => T.warped() },
    ],
    score: (T) => T.hpFrac(),
    acc: '剩余血量',
  },
  {
    id: '4-3', ch: 4, name: '微型跳跃引擎', desc: '用微型跳跃引擎一下跳出 100 km', fit: HURRICANE_MJD,
    targets: [{ ship: RIFTER_HULL, at: [2000, 0, 0] }], par: 30,
    steps: [
      { text: '微型跳跃引擎沿船头方向跳。先在太空中双击，让船朝远离训练目标的方向飞', done: (T) => T.P.cmd === 'dir' },
      { text: '按 Alt + F1（中槽第一个）开启微型跳跃引擎，预热几秒后跳出', at: (T) => T.modSel(MJD), done: (T) => T.modOn(MJD) },
      { text: '等它跳出去：离训练目标 90 km 以外', done: (T) => T.dist(T.d[0]) >= 90000 },
    ],
  },
  // ---------- 第五章 · 无人机、隐形 ----------
  {
    id: '5-1', ch: 5, name: '无人机', desc: '放出无人机攻击目标，再收回来', fit: TRISTAN,
    targets: [{ ship: RIFTER_HULL, at: [8000, 0, 0] }], par: 45,
    steps: [
      { text: '按住 Ctrl 点击训练目标锁定它', at: (T) => ({ unit: T.d[0].i }), done: (T) => T.locked().includes(T.d[0]) },
      { text: '按 Shift + F（或点「无人机」窗口里的释放按钮）放出无人机，它们会攻击当前目标', at: () => '[data-pl-drbtn="launch"]', done: (T) => T.P.drones && T.me.drones.some((d) => d.pos) },
      { text: '等无人机击毁训练目标', done: (T) => !T.d[0].alive },
      { text: '按 Shift + R（或点「返回至无人机挂舱」按钮）收回无人机', at: () => '[data-pl-drbtn="recall"]', done: (T) => !T.P.drones },
    ],
  },
  {
    id: '5-2', ch: 5, name: '隐形', desc: '开隐形装置，隐形状态下跃迁', fit: STRATIOS,
    targets: [{ ship: BADGER, at: [1200, 0, 0] }], par: 120,
    steps: [
      { text: '按 F1 开启隐秘行动隐形装置：现在离训练目标太近（2,000 m 以内），会开不起来', at: (T) => T.modSel(COVOPS), done: (T) => T.logHas(/距离其他物体太近/) },
      { text: '飞到离训练目标 2,500 m 以外（双击太空朝外飞）', done: (T) => T.dist(T.d[0]) >= 2500 },
      { text: '再按 F1 开启隐形装置', at: (T) => T.modSel(COVOPS), done: (T) => Boolean(T.me.cloak) },
      { text: '隐秘行动隐形装置可以隐形跃迁：保持隐形，按住 S 点击一个远处的天体跃迁过去', at: () => farRow(), done: (T) => T.warped() && Boolean(T.me.cloak) },
    ],
    failIf: (T) => (T.X.k >= 3 && T.me.warp?.go && !T.me.cloak ? '跃迁时没有隐形' : null),
  },
  {
    id: '5-3', ch: 5, name: '假隐跳', desc: '普通隐形装置 + 微型跃迁推进器，隐形加速后瞬间跃迁', fit: STABBER_CLOAKY, hostile: true, acc: '暴露时间',
    targets: [
      // 放在头顶上方（天体大致都在黄道面上，对准方向和它们差不多垂直，不会飞过去撞上解除隐形）
      { ship: RIFTER_HULL, at: [5000, 42000, 3000], fit: TACKLER, ai: true, name: '蹲门的' },
      { ship: RIFTER_HULL, at: [-4000, 40000, -5000], fit: TACKLER, ai: true, name: '蹲门的' },
    ],
    par: 40,
    steps: [
      { text: '普通隐形装置不能隐形跃迁，开着微型跃迁推进器对准又太慢。先双击总览里一个远处的天体（150 km 以外双击是对准，不会跃迁）', at: () => farRow(), done: (T) => T.P.cmd === 'dir' },
      { text: '马上按 F1 开启隐形装置', at: (T) => T.modSel(IMPCLOAK), done: (T) => Boolean(T.me.cloak) },
      { text: '隐形后 5 秒内按 Alt + F1 开启微型跃迁推进器：这时开不会解除隐形，它会跑完这一轮', at: (T) => T.modSel(MWD50), done: (T) => Boolean(T.me.cloak) && T.propOn() },
      { text: '推进器这一轮快跑完时（看装备按钮的进度圈），按 F1 解除隐形，马上按住 S 点击那个天体跃迁', at: (T) => (T.me.cloak ? T.modSel(IMPCLOAK) : farRow()), done: (T) => Boolean(T.me.warp) },
    ],
    // 暴露时间：解除隐形到起跳
    script: (T, dt) => { if (T.X.k === 3 && !T.me.cloak && !T.me.warp && T.me.alive) T.v.exp = (T.v.exp || 0) + dt; },
    score: (T) => Math.max(0, Math.min(1, 1 - ((T.v.exp || 0) - 1) / 4)),
    failIf: (T) => (T.pointed(T.me) ? '被蹲门的扰频了，没能跑掉' : null),
  },
  // ---------- 第六章 · 实战 ----------
  {
    id: '6-1', ch: 6, name: '单挑', desc: '打一艘会还手的护卫舰', fit: RIFTER, hostile: true, acc: '剩余血量',
    targets: [{ ship: RIFTER_HULL, at: [12000, 0, 0], fit: BRAWLER, ai: true, name: '敌船' }], par: 90,
    steps: [
      { text: '这艘敌船会还手。锁定它，靠近到 5 km 以内（Q 接近，或 W 环绕）', at: (T) => ({ unit: T.d[0].i }), done: (T) => T.locked().includes(T.d[0]) && T.dist(T.d[0]) <= 5000 },
      { text: '开火，网住它（Alt + F3）让它甩不开你，击毁它', at: (T) => T.gunSel(), done: (T) => !T.d[0].alive },
    ],
    score: (T) => T.hpFrac(),
  },
  {
    id: '6-2', ch: 6, name: '风筝', desc: '在对方射程外边飞边打', fit: KESTREL, hostile: true, acc: '剩余血量',
    targets: [{ ship: 594, at: [14000, 0, 0], fit: BLASTER, ai: true, name: '近战敌船' }], par: 150,
    steps: [
      { text: '敌船带的是疾速炮，只能打 2–3 km 以内。按 Alt + F1 开启加力燃烧器，你比它快', at: (T) => T.modSel(AB), done: (T) => T.propOn() },
      { text: '按住 W 点击敌船环绕它，环绕距离设成 15 km 以上（右键「环绕」按钮改默认距离）', at: (T) => ({ unit: T.d[0].i }), done: (T) => T.P.cmd === 'orbit' && T.P.tgt === T.d[0] && T.P.dist >= 15000 },
      { text: '锁定并开火（轻型导弹射程约 40 km），保持在它射程外把它打掉', at: (T) => T.gunSel(), done: (T) => !T.d[0].alive },
    ],
    score: (T) => T.hpFrac(),
  },
  {
    id: '6-3', ch: 6, name: '以一敌二', desc: '两艘敌船，先打带网子和扰频的那艘', fit: RIFTER_REP, hostile: true, acc: '剩余血量',
    targets: [
      { ship: 608, at: [9000, 0, -3000], fit: ATRON_TACKLE, ai: true, name: '拦截船' },
      { ship: RIFTER_HULL, at: [11000, 0, 3000], fit: BRAWLER_WEAK, ai: true, name: '输出船' },
    ],
    par: 150,
    steps: [
      { text: '阿特龙级会网住、扰频你。先锁定它、集中火力击毁它（装甲掉了就按 Ctrl + F1 开维修器）', at: (T) => (T.d[0].alive ? { unit: T.d[0].i } : null), done: (T) => !T.d[0].alive },
      { text: '再击毁裂谷级', at: (T) => ({ unit: T.d[1].i }), done: (T) => !T.d[1].alive },
    ],
    score: (T) => T.hpFrac() * (T.v.order === 1 ? 1 : 0.7),
    script: (T) => { if (!T.v.order && !T.d[1].alive) T.v.order = 2; if (!T.v.order && !T.d[0].alive) T.v.order = 1; },
  },
  // ---------- 第七章 · 舰队 ----------
  {
    id: '7-1', ch: 7, name: '跟队', desc: '跟住队长移动，队长跃迁后跃迁到他身边', acc: '跟队距离',
    targets: [{ ship: STABBER, at: [3000, 0, 1500], ally: true, name: '队长' }], fleet: { fc: 0 }, par: 90,
    steps: [
      { text: '队长开始带队移动了。按住 E 点击总览里的队长（保持距离，默认 2,500 m）跟住他', at: (T) => ({ unit: T.d[0].i }),
        enter: (T) => Object.assign(T.d[0].pilot, { cmd: 'dir', dir: [0.6, 0, 0.8], speed: 0.6, tgt: null }),
        hold: { secs: 20, need: () => true, ok: (T) => T.dist(T.d[0]) >= 1000 && T.dist(T.d[0]) <= 5000 } },
      { text: '队长发了「跃迁」广播，跃迁走了（舰队窗口底部的广播条能看到）。等他落地，右键舰队窗口里的队长或按住 S 点击总览里的队长，跃迁到他身边', at: (T) => (T.d[0].warp ? null : { unit: T.d[0].i }),
        enter: (T) => { const c = T.farCel(T.d[0]); H.broadcast?.('warp', { who: 'u' + T.d[0].i, cel: c }); T.S.b.warpTo(T.d[0], { cel: c }, 0); },
        done: (T) => T.warped() && T.dist(T.d[0]) < 30000 },
    ],
  },
  {
    id: '7-2', ch: 7, name: '火力点名', desc: '按队长广播的顺序集火，只打点名的目标', acc: '火力集中',
    targets: [
      { ship: RIFTER_HULL, at: [2500, 0, -2000], name: '敌船 A' },
      { ship: RIFTER_HULL, at: [3000, 0, 0], name: '敌船 B' },
      { ship: RIFTER_HULL, at: [2500, 0, 2000], name: '敌船 C' },
    ],
    fleet: { virt: [{ name: '队长', ship: STABBER, fc: true }] },
    par: 90,
    steps: [
      { text: '舰队作战只打队长点名的目标：队长发「锁定」广播，舰队窗口底部的广播条会显示，总览里那艘船后面也会出现广播图标。先按住 Ctrl 点击三艘敌船全部锁定', at: (T) => ({ unit: T.d[1].i }), done: (T) => T.locked().length >= 3 },
      { text: '队长点名敌船 B：点目标栏里的它选中，开火击毁它', at: (T) => ({ unit: T.d[1].i }), enter: (T) => call(T, 1), done: (T) => !T.d[1].alive },
      { text: '下一个点名敌船 C：切换目标，击毁它', at: (T) => ({ unit: T.d[2].i }), enter: (T) => call(T, 2), done: (T) => !T.d[2].alive },
      { text: '最后是敌船 A：击毁它', at: (T) => ({ unit: T.d[0].i }), enter: (T) => call(T, 0), done: (T) => !T.d[0].alive },
    ],
    // 打到没点名的目标：按掉的血量扣分（一艘船的总血量算 100%）
    script: (T) => {
      const p = (T.v.hp ||= T.d.map((u) => u.hp.reduce((a, c) => a + c, 0)));
      T.d.forEach((u, k) => {
        const h = u.alive ? u.hp.reduce((a, c) => a + c, 0) : 0;
        if (h < p[k] && T.v.called !== k) T.v.wrong = (T.v.wrong || 0) + (p[k] - h) / u.t.max.reduce((a, c) => a + c, 0);
        p[k] = h;
      });
    },
    score: (T) => Math.max(0, 1 - (T.v.wrong || 0)),
  },
  {
    id: '7-3', ch: 7, name: '后勤遥修', desc: '开后勤护卫舰，锁定队友、看谁掉血就修谁', fit: BURST, hostile: true, acc: '队友血量', fleet: { watch: true },
    targets: [
      { ship: RIFTER_HULL, at: [1500, 0, 1500], fit: BRAWLER, ai: true, ally: true, name: '队友 1' },
      { ship: RIFTER_HULL, at: [1500, 0, -1500], fit: BRAWLER, ai: true, ally: true, name: '队友 2' },
      { ship: RIFTER_HULL, at: [9000, 0, 2000], fit: BRAWLER, ai: true, name: '敌船' },
      { ship: RIFTER_HULL, at: [9000, 0, -2000], fit: BRAWLER, ai: true, name: '敌船' },
    ],
    par: 90,
    steps: [
      { text: '你是后勤：不打人，只修队友。按住 Ctrl 点击两个队友锁定他们，锁上后上方目标栏能看到他们的血量', at: (T) => ({ unit: T.d[T.locked2().includes(T.d[0]) ? 1 : 0].i }), done: (T) => T.locked2().length >= 2 },
      { text: '看目标栏里谁的护盾在掉，点他选中，按 F1、F2 开远程护盾回充增量器修他（射程约 7 km，离远了按住 Q 点击他靠近）', at: (T) => T.modSel(SRSB), done: (T) => T.d.slice(0, 2).includes(T.me.repTarget) },
      { text: '一直盯着目标栏和关注列表：队友掉血会发「需要护盾」广播，谁掉血就切过去修谁，保住两个队友直到敌船全灭', done: (T) => !T.d[2].alive && !T.d[3].alive },
    ],
    failIf: (T) => (T.d.slice(0, 2).some((u) => !u.alive) ? '有队友被击毁了' : null),
    score: (T) => (T.hpFrac(T.d[0]) + T.hpFrac(T.d[1])) / 2,
  },
  // ---------- 第八章 · 电子战 ----------
  {
    id: '8-1', ch: 8, name: '能量中和', desc: '中和敌船的电容，让它的疾速炮打不出来', fit: RIFTER_NEUT, hostile: true, acc: '剩余血量',
    targets: [{ ship: 594, at: [7000, 0, 0], fit: BLASTER, ai: true, name: '敌船' }], par: 90,
    steps: [
      { text: '敌船的疾速炮每一发都要用电容。按住 Ctrl 点击它锁定', at: (T) => ({ unit: T.d[0].i }), done: (T) => T.locked().includes(T.d[0]) },
      { text: '点高槽里的能量中和器（F2）开启，把它的电容吸干（射程约 6 km，选中它后在「选中物体」窗口里能看到电容）', at: (T) => T.modSel(NEUT), done: (T) => T.capFrac(T.d[0]) < 0.1 },
      { text: '它的炮没电了。开火（F1）击毁它', at: (T) => T.gunSel(), done: (T) => !T.d[0].alive },
    ],
    score: (T) => T.hpFrac(),
  },
  {
    id: '8-2', ch: 8, name: 'ECM 干扰', desc: '用 ECM 干扰敌船的锁定，让它打不了你', fit: GRIFFIN, hostile: true, acc: '剩余血量',
    targets: [{ ship: RIFTER_HULL, at: [14000, 0, 0], fit: BRAWLER, ai: true, name: '敌船' }], par: 60,
    steps: [
      { text: '狮鹫级没有武器，靠 ECM 让敌人锁不住你。按住 Ctrl 点击敌船锁定', at: (T) => ({ unit: T.d[0].i }), done: (T) => T.locked().includes(T.d[0]) },
      { text: '按 Alt + F1、Alt + F2、Alt + F3 开启三个 ECM。干扰有几率，没成功会在下一个周期再试', at: (T) => T.modSel(ECM), done: (T) => T.d[0].jam > T.S.b.t },
      { text: '干扰成功了：被干扰的船锁定会掉、也锁不了你。保持干扰 20 秒', hold: { secs: 20, need: () => true, ok: (T) => T.d[0].jam > T.S.b.t } },
    ],
    score: (T) => T.hpFrac(),
  },
  // ---------- 第九章 · 其他技巧 ----------
  {
    id: '9-1', ch: 9, name: '跃迁到指定距离', desc: '右键跃迁按钮，选择跃迁到天体外多少公里',
    targets: [{ ship: BADGER, at: [8000, 0, 3000] }], par: 60,
    steps: [
      { text: '在总览里点一个远处的天体（距离是 AU 的）选中它', at: () => farRow(), done: (T) => T.S.selC >= 0 && Math.hypot(...T.S.b.cel[T.S.selC].pos.map((x, k) => x - T.me.pos[k])) > 1e9 },
      { text: '在「选中物体」窗口里右键「跃迁」按钮，选「跃迁至 30 km内」（落在离它 30 km 的地方，蹲点的人不会正好在你身边）', at: () => '.pl-sel-acts [data-pl-act="warp"]', done: (T) => T.v.wd === 30000 },
      { text: '等跃迁落地', done: (T) => T.warped() },
    ],
    script: (T) => { if (T.P.cmd === 'warp' && T.P.wp) T.v.wd = T.P.wp.dist; },
  },
  {
    id: '9-2', ch: 9, name: '镜头与战术层', desc: '镜头跟踪目标、打开战术叠加层看射程',
    targets: [{ ship: RIFTER_HULL, at: [12000, 0, 4000], move: { dir: [0, 0, -1], speed: 0.5 } }], par: 45,
    steps: [
      { text: '按住 C 点击训练目标：镜头会一直对着它（再按住 C 点一下取消）', at: (T) => ({ unit: T.d[0].i }), done: (T) => H.view()?.tracking?.() === T.d[0].i },
      { text: '按 Ctrl + D 切换战术叠加层：太空中会画出距离刻度和你的武器射程圈', enter: (T) => { T.v.tac0 = T.S.set?.tac; }, done: (T) => T.S.set?.tac !== T.v.tac0 },
      { text: '按住 C 点击训练目标，取消镜头跟踪', at: (T) => ({ unit: T.d[0].i }), done: (T) => H.view()?.tracking?.() !== T.d[0].i },
    ],
  },
  {
    id: '9-3', ch: 9, name: '电容注电器', desc: '电容见底时用电容注电器一下充回来', fit: RIFTER_CAPB,
    targets: [{ ship: BADGER, at: [15000, 0, 3000] }], par: 30,
    setup: (T) => { T.me.cap = T.me.t.cap.max * 0.1; },
    steps: [
      { text: '电容只剩一成，推进器都开不起来。按 Alt + F2 开启电容注电器（装着电容注电器装料，每个周期充一大截）', at: (T) => T.modSel(CAPB), done: (T) => T.capFrac() >= 0.6 },
      { text: '电容回来了：关掉电容注电器省装料，开启微型跃迁推进器（Alt + F1）', at: (T) => (T.modOn(CAPB) ? T.modSel(CAPB) : T.modSel(MWD)), done: (T) => !T.modOn(CAPB) && T.propOn() },
    ],
  },
  {
    id: '9-4', ch: 9, name: '舰船模式', desc: '战术驱逐舰切换防御 / 狙击 / 推进模式', fit: SVIPUL,
    targets: [{ ship: BADGER, at: [20000, 0, 3000] }], par: 60,
    steps: [
      { text: '斯威普级有三个模式，按钮在船体面板旁边。按 Shift + 3 切到推进模式：速度和灵活度大增', at: () => '[data-pl-stance="2"]', done: (T) => T.S.mode === T.S.modes?.[2] },
      { text: '切换后有 10 秒冷却。冷却过了按 Shift + 2 切到狙击模式：武器射程变远、锁定距离变远', at: () => '[data-pl-stance="1"]', done: (T) => T.S.mode === T.S.modes?.[1] },
      { text: '再按 Shift + 1 切回防御模式：受到的伤害降低', at: () => '[data-pl-stance="0"]', done: (T) => T.S.mode === T.S.modes?.[0] },
    ],
  },
  {
    id: '9-5', ch: 9, name: '拦截泡', desc: '用拦截舰的拦截泡拦住要跑的运输舰', fit: SABRE,
    targets: [{ ship: BADGER, at: [16000, 0, 3000] }], par: 60,
    // 运输舰开局 3 秒后开始对准跃迁（在泡里就每 2 秒再试一次）
    script: (T) => {
      const h = T.d[0];
      if (!h.alive || h.warp || T.t < 3 || h.pilot.cmd === 'warp' || (T.v.tryAt || 0) > T.t) return;
      T.v.tryAt = T.t + 2;
      T.S.b.warpTo(h, { cel: T.farCel(h) }, 0);
    },
    setup: (T) => { const h = T.d[0]; h.hp = h.hp.map((x) => x * 0.3); },
    failIf: (T) => (T.d[0].warp?.go ? '运输舰跃迁逃走了' : null),
    steps: [
      { text: '运输舰要跑！开微型跃迁推进器（Alt + F1），按住 Q 点击它靠近，进到拦截泡的范围里', at: (T) => ({ unit: T.d[0].i }), done: (T) => T.dist(T.d[0]) <= bubbleR(T) * 0.9 },
      { text: '按 F1 放出拦截泡：泡里的船都跃迁不了（不用锁定，对所有人都有效）', at: (T) => T.modSel(BUBBLE), done: (T) => T.pointed(T.d[0]) },
      { text: '它跑不掉了：锁定它，开火（F2）击毁它', at: (T) => ({ unit: T.d[0].i }), done: (T) => !T.d[0].alive },
    ],
  },
  // ---------- 第十章 · 扫描 ----------
  {
    id: '10-1', ch: 10, name: '定向扫描', desc: '用定向扫描器找出藏在某颗行星旁边的敌船，跃迁过去',
    targets: [{ ship: RIFTER_HULL, at: [0, 0, 0], name: '敌船' }], par: 150,
    // 找一对相距 3 ~ 12 AU 的天体（在定向扫描 14.3 AU 的范围里）：玩家放在 A 旁边，敌船藏在行星 B 旁边（跃迁到 B 会落在它附近）
    setup: (T) => {
      const me = T.me, cel = T.S.b.cel || [];
      const D = (a, c) => Math.hypot(a.pos[0] - c.pos[0], a.pos[1] - c.pos[1], a.pos[2] - c.pos[2]);
      const pairs = [];
      cel.forEach((b, kb) => { if (b.group !== 7) return; cel.forEach((a, ka) => { if (ka !== kb && [7, 10, 15].includes(a.group) && D(a, b) > 3 * AU && D(a, b) < 12 * AU) pairs.push([ka, kb]); }); });
      const pr = pairs[Math.floor(Math.random() * pairs.length)];
      if (!pr) return;
      const A = cel[pr[0]], B = cel[pr[1]];
      // 玩家：A 外面 (半径 + 50 km)，朝 B 的反方向一点（别正好在 A 和 B 的连线上）
      const ab = [B.pos[0] - A.pos[0], B.pos[1] - A.pos[1], B.pos[2] - A.pos[2]], lab = Math.hypot(...ab);
      const ra = (A.radius || 0) + 50000;
      me.pos = [A.pos[0] - ab[2] / lab * ra, A.pos[1], A.pos[2] + ab[0] / lab * ra];
      const v = [me.pos[0] - B.pos[0], me.pos[1] - B.pos[1], me.pos[2] - B.pos[2]], l = Math.hypot(...v) || 1, r = (B.radius || 0) + 60000;
      T.d[0].pos = [B.pos[0] + v[0] / l * r, B.pos[1] + v[1] / l * r, B.pos[2] + v[2] / l * r];
      T.v.cel = pr[1];
    },
    steps: [
      { text: '敌船藏在星系里某颗行星旁边，总览里看不到它（不在同一网格）。点船体面板左边的扫描器按钮，选「定向扫描器」（或按 Alt + D）', at: () => '[data-pl-scanbtn]', done: () => H.winOpen?.('dscan') },
      { text: '把角度拉到 360°、范围拉到最大，点「扫描」（或按 V）：结果里有一艘裂谷级，但还不知道它在哪个方向', at: () => '[data-sl="ds-a"]', done: (T) => { const l = H.scan?.()?.d.last; return Boolean(l && l.angle >= 360 && l.units.includes(T.d[0].i)); } },
      { text: '把角度调到 30° 或更小，朝每颗行星扫一次：总览切到「跃迁到」页签，按住 V 点击一颗行星，就朝那颗行星的方向扫描（只按 V 不点东西 = 朝镜头看的方向扫）。一颗颗试，直到结果里还有那艘裂谷级', at: () => '[data-ds-scan]', done: (T) => { const l = H.scan?.()?.d.last; return Boolean(l && l.angle <= 30 && l.units.includes(T.d[0].i)); } },
      { text: '找到方向了。缩小范围（输入框里填 AU 数，比如那颗行星的距离 + 1）确认是哪颗行星，然后在总览「跃迁到」页签里跃迁到它', done: (T) => T.warped() && T.dist(T.d[0]) < GRID },
    ],
  },
  {
    id: '10-2', ch: 10, name: '探针扫描', desc: '开探索护卫舰，用扫描探针找到隐藏的信号地点并跃迁过去', fit: HERON,
    targets: [], par: 240,
    // 信号放在 3 ~ 8 AU 外（大致在黄道面上）
    setup: (T) => {
      const a = Math.random() * 2 * Math.PI, d = (3 + Math.random() * 5) * AU, me = T.me;
      const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', rl = () => L[Math.floor(Math.random() * 26)];
      const id = `${rl()}${rl()}${rl()}-${100 + Math.floor(Math.random() * 900)}`;
      H.setSigs?.([{ id, group: '数据地点', name: '练习信号', f: 0.6, pos: [me.pos[0] + Math.cos(a) * d, me.pos[1] + (Math.random() - 0.5) * 0.05 * AU, me.pos[2] + Math.sin(a) * d] }]);
      T.v.sig = id;
    },
    steps: [
      { text: '点船体面板左边的扫描器按钮，选「探针扫描器」（或按 Alt + P）', at: () => '[data-pl-scanbtn]', done: () => H.winOpen?.('probe') },
      { text: '点扫描面板左下角第一个按钮「精确式发射」：8 个探针发射到你身边（探针扫描器左边是恒星系图，青色的球是探针的范围）', at: () => '[data-ps-form="pin"]', done: () => (H.scan?.()?.p.probes.length || 0) > 0 },
      { text: '把「探针尺寸」拉到最大（32 AU），点「分析」（或按 B）：探针盖住整个星系，结果里会出现一个空间信号', at: () => '[data-sl="ps-size"]', done: () => (H.scan?.()?.p.res.size || 0) > 0 },
      { text: '恒星系图上红色的球、圆、点是信号可能在的位置（只有 1 个探针盖到是球，2 个是圆，3 个是两个点，4 个以上才是一个点）。拖动阵型中心那组箭头，把探针挪到结果那里，尺寸缩小一档再分析；重复几次，直到信号强度到 100%（变绿）', at: () => '[data-ps-map]', done: (T) => (H.scan?.()?.p.res.get(T.v.sig)?.s || 0) >= 1 },
      { text: '信号可以跃迁了：点结果里的「跃迁至」按钮', at: () => '[data-ps-warp]', done: (T) => { const r = H.scan?.()?.p.res.get(T.v.sig); return T.warped() && Boolean(r) && Math.hypot(r.sig.pos[0] - T.me.pos[0], r.sig.pos[1] - T.me.pos[1], r.sig.pos[2] - T.me.pos[2]) < 200000; } },
    ],
  },
];
const byId = new Map(LESSONS.map((l) => [l.id, l]));

let H = null;   // 钩子：{ S, root(), esc, tr, store, view(), gunSel(), ovlSel(), isGun(m), guns() }
let X = null;   // 进行中的一课：{ L, k 当前步, t0, stepT, holdT, okT, allT, v 各步自己记的东西, done 各步完成时间, last 上一帧时间, result }
export function initTutor(hooks) { H = hooks; }
export const tutLessons = () => LESSONS;
export const tutHas = (id) => byId.has(id);

function bests() { try { return H.store.getJSON(STORE_KEY, {}) || {}; } catch { return {}; } }
function saveBest(id, r) {
  const all = bests();
  const old = all[id];
  if (!old || r.score > old.score || (r.score === old.score && r.time < old.time)) all[id] = { score: r.score, stars: r.stars, time: Math.round(r.time * 10) / 10 };
  H.store.setJSON(STORE_KEY, all);
  return all[id];
}
const stars = (n) => '★★★'.slice(0, n) + '☆☆☆'.slice(0, 3 - n);

// 设置页「练习」标签：用战场模拟页的同一套样式——每章一行课程按钮（同「常见打法」），选中的课在下面的面板里（同「从哪里开始」）
// 显示说明、步骤、标准时间、最好成绩，底部「开始练习」（同「起飞」）
export function tutListHtml(sel, loading = false) {
  const B = bests(), esc = H.esc;
  const L = byId.get(sel) || LESSONS[0];
  const b = B[L.id];
  const lv = LEVELS.find((x) => x.ch.includes(L.ch)) || LEVELS[0];
  // 基础 / 进阶：点了跳到那一级的第一课（沿用选课按钮）
  const tabs = `<div class="segmented pl-tut-lv" role="tablist">${LEVELS.map((x) => { const f = LESSONS.find((l) => x.ch.includes(l.ch)); return `<button type="button" role="tab" data-pl-tutsel="${f.id}" class="${x === lv ? 'active' : ''}">${esc(x.name)}</button>`; }).join('')}</div>`;
  return `<div class="pl-tut-page">
    ${tabs}
    <div class="sim-opts">${CH.filter((c) => lv.ch.includes(c.n)).map((c) => `<div class="sim-opt-row"><span class="sim-opt-label">${esc(c.name)}</span><div class="sim-scenes">${LESSONS.filter((l) => l.ch === c.n).map((l) => {
      const x = B[l.id];
      return `<button type="button" class="sim-scene${l === L ? ' active' : ''}" data-pl-tutsel="${l.id}" title="${esc(l.desc)}"><b><span>${l.id}</span> <span>${esc(l.name)}</span></b><small>${x ? `<span>${x.score} 分</span> <i class="pl-tut-star">${stars(x.stars)}</i>` : '未完成'}</small></button>`;
    }).join('')}</div></div>`).join('')}</div>
    <section class="sim-start">
      <h3><span>${esc(L.id)}</span> <span>${esc(L.name)}</span></h3>
      <span class="sim-start-hint">${esc(L.desc)}</span>
      <ol class="pl-tut-steps0">${L.steps.map((st) => `<li>${esc(st.text)}</li>`).join('')}</ol>
      <div class="pl-tut-meta"><span><span>标准时间 ${L.par} 秒</span>${L.acc ? ` · <span>精度：</span><span>${esc(L.acc)}</span>` : ''}</span>
        <span>${b ? `<span>最好成绩 ${b.score} 分 · ${b.time} 秒</span> <i class="pl-tut-star">${stars(b.stars)}</i>` : '还没有完成过'}</span></div>
    </section>
  </div>
  <div class="pl-setup-foot"><button type="button" class="btn btn-primary" data-pl-tut="${L.id}"${loading ? ' disabled' : ''}>${loading ? '准备中…' : '开始练习'}</button><span class="text-muted"><span>${esc(H.typeName((L.fit || RIFTER).ship))}</span> <span>${L.hostile ? ({ 暴露时间: '+ 固定装配，敌船会还手；完成后按用时和暴露时间打分', 队友血量: '+ 固定装配，敌船会还手；完成后按用时和队友血量打分' }[L.acc] || '+ 固定装配，敌船会还手；完成后按用时和剩余血量打分') : '+ 固定装配，训练目标不会反击；完成后按用时（部分课加上精度）打分'}</span></span></div>`;
}

// 开课要准备的：我的装配、训练目标（只有船体；会还手的敌船带 fit）
export function tutSpec(id) {
  const L = byId.get(id);
  if (!L) return null;
  const cp = (x) => JSON.parse(JSON.stringify(x));
  return { L, fit: cp(L.fit || RIFTER), targets: L.targets.map((x) => ({ ship: x.ship, fit: x.fit ? cp(x.fit) : null, ally: Boolean(x.ally) })) };
}

// 战斗建好以后：摆好位置、训练目标交给「玩家驾驶」（不下指令 = 不动手）、起名字、显示提示框
export function tutBegin(id) {
  const L = byId.get(id), S = H.S, b = S.b;
  const me = S.me;
  me.pos = [0, 0, 0];
  me.vel = [0, 0, 0];
  me.face = [1, 0, 0];
  me.hv = [1, 0, 0];
  // 训练目标按课里的顺序：敌方的按出场顺序对应 ally 不为真的，队友对应 ally 的
  const foes = b.units.filter((u) => u.side !== me.side && !u.isDrone), mates = b.units.filter((u) => u.side === me.side && u !== me && !u.isDrone);
  let fi = 0, ai = 0;
  const d = L.targets.map((spec) => (spec.ally ? mates[ai++] : foes[fi++])).filter(Boolean);
  d.forEach((u, k) => {
    const spec = L.targets[k];
    if (!spec) return;
    u.pos = spec.at.slice();
    u.vel = [0, 0, 0];
    u.face = [-1, 0, 0];
    u.hv = [-1, 0, 0];
    // 训练目标交给「玩家驾驶」不下指令 = 不动手；ai: true 的敌船照常由电脑控制（会还手）
    if (!spec.ai) b.takeControl(u.i, 1);
    if (spec.move) Object.assign(u.pilot, { cmd: 'dir', dir: spec.move.dir.slice(), speed: spec.move.speed, tgt: null });
    S.names[u.i] = spec.name ? H.tr(spec.name) : d.length > 1 ? `${H.tr('训练目标')} ${k + 1}` : H.tr('训练目标');
  });
  // 舰队：名字起好后重新组一次（成员历史里的名字、谁是队长）；fleet.watch：队友加进关注列表并打开
  const fl = L.fleet || {};
  H.fleetReset?.({ virt: fl.virt, fc: fl.fc != null ? d[fl.fc]?.i : undefined });
  if (fl.watch) d.forEach((u, k) => { if (L.targets[k].ally) H.watch?.(u); });
  X = { L, k: 0, float: {}, mouse: null, t0: b.t, stepT: b.t, holdT: 0, okT: 0, allT: 0, v: {}, done: [], last: b.t, result: null, d };
  const stage = H.root().querySelector('#plStage');
  for (const sel of ['#plTut', '#plTutP', '#plTutS', '#plTutF']) stage?.querySelector(sel)?.remove();
  // 箭头视频是白色的，客户端用颜色叠加染成 (172, 213, 241)：这里用 SVG 滤镜
  stage?.insertAdjacentHTML('beforeend', `<div class="pl-ip" id="plTut" aria-live="polite"></div><div class="pl-uip" id="plTutP" hidden></div><div class="pl-sop" id="plTutS" hidden></div>
    <svg id="plTutF" width="0" height="0" aria-hidden="true" style="position:absolute"><filter id="plUipTint" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="0.675 0 0 0 0 0 0.835 0 0 0 0 0 0.945 0 0 0 0 0 1 0"/></filter></svg>`);
  if (stage && !stage.dataset.tutMouse) {
    stage.dataset.tutMouse = '1';
    stage.addEventListener('mousemove', (e) => { if (X) X.mouse = [e.clientX, e.clientY]; });
  }
  L.setup?.(ctxT());
  enterStep();
  renderBox();
}
export function tutStop() { X = null; }
export const tutActive = () => Boolean(X);

// 每一步要用的读数
function ctxT() {
  const S = H.S, me = S.me;
  const T = {
    S, me, P: me.pilot, d: X.d, v: X.v,
    t: S.b.t - X.t0,
    spd: () => Math.hypot(...me.vel),
    vmax: () => me.t.vel * (me.velMult || 1),
    dist: (v) => Math.max(0, Math.hypot(v.pos[0] - me.pos[0], v.pos[1] - me.pos[1], v.pos[2] - me.pos[2]) - me.t.radius - (v.t?.radius || 0)),
    nearest: () => X.d.filter((v) => v.alive).sort((a, c) => T.dist(a) - T.dist(c))[0] || X.d[0],
    locked: () => X.d.filter((v) => v.alive && me.pilot.locks.has(v) && me.pilot.locks.get(v) <= 0),
    // 锁定好的队友
    locked2: () => X.d.filter((v) => v.alive && v.side === me.side && me.pilot.locks.has(v) && me.pilot.locks.get(v) <= 0),
    cam: () => H.view()?.camInfo?.() || null,
    guns: () => H.guns(),
    isGun: (m) => H.guns().includes(m),
    gunsOn: () => H.guns().some((m) => me.pilot.on.has(m)),
    gunSel: () => H.gunSel(),
    ovlSel: () => H.ovlSel(),
    X,
    // 这一步开始以后日志里有没有这句（电容不够、跃迁被禁止、隐形开不了……都是客户端原话）
    logHas: (re) => (S.log || []).some((x) => x.t >= X.stepT - 0.01 && re.test(x.text)),
    hpFrac: (u = me) => { const h = u.hp.reduce((a, c) => a + Math.max(0, c), 0), m = u.t.max.reduce((a, c) => a + c, 0); return m > 0 ? Math.min(1, h / m) : 0; },
    layer: (k, u = me) => (u.t.max[k] > 0 ? u.hp[k] / u.t.max[k] : 0),
    capFrac: (u = me) => (u.t.cap?.max > 0 ? u.cap / u.t.cap.max : 0),
    // 装备：按物品类型找装备栏里的那一件
    modIdx: (type) => (S.on?.rack || []).findIndex((x) => x?.type === type),
    modOn: (type) => { const m = T.modIdx(type); return m >= 0 && me.pilot.on.has(m); },
    modSel: (type) => { const m = T.modIdx(type); return m >= 0 ? `.pl-mod[data-pl-mod="${m}"]` : null; },
    propOn: () => S.prop >= 0 && me.pilot.on.has(S.prop),
    baseVel: () => S.off?.vel || me.t.vel,
    // 被扰住（扰频强度超过跃迁稳定）
    pointed: (u) => (u.pointed || 0) > (u.t.stab || 0),
    // 跃迁过、已经落地
    warped: () => { if (me.warp) X.v.warped = true; return Boolean(X.v.warped) && !me.warp && me.pilot.cmd !== 'warp'; },
    // 离这艘船最远的天体（跃迁目标）
    farCel: (u) => { let best = 0, bd = -1; (S.b.cel || []).forEach((c, k) => { const dd = Math.hypot(c.pos[0] - u.pos[0], c.pos[1] - u.pos[1], c.pos[2] - u.pos[2]); if (dd > bd) { bd = dd; best = k; } }); return best; },
  };
  return T;
}
function enterStep() {
  const st = X.L.steps[X.k];
  X.stepT = H.S.b.t;
  X.holdT = 0;
  X.v.settled = false;
  if (st?.enter) st.enter(ctxT());
}

// 每帧：查当前步骤完成没有、累计保持时间和精度、更新提示框和箭头
export function tutTick() {
  if (!X || X.result) return;
  const S = H.S;
  if (!S.me) return;
  const T = ctxT();
  const now = S.b.t, dt = Math.max(0, now - X.last);
  X.last = now;
  // 镜头转过的角度：和上一帧的方向比，累加
  const c = T.cam();
  if (c && X.v.camPrev) X.v.turn = (X.v.turn || 0) + Math.acos(Math.max(-1, Math.min(1, c.dir[0] * X.v.camPrev[0] + c.dir[1] * X.v.camPrev[1] + c.dir[2] * X.v.camPrev[2]))) * 180 / Math.PI;
  if (c) X.v.camPrev = c.dir;
  // 这一课自己的脚本（敌船对准跃迁等）、失败条件
  X.L.script?.(T, dt);
  T.warped();
  const why = X.L.failIf?.(T);
  if (why) { fail(why); return; }
  let moved = false;
  for (let n = 0; n < 4 && X.k < X.L.steps.length; n++) {
    const st = X.L.steps[X.k];
    let ok = false;
    if (st.hold) {
      // 第一次进到要求的距离以后才开始计时、算精度
      if (S.me.alive && st.hold.need(T) && (X.v.settled ||= st.hold.ok(T))) {
        X.holdT += dt;
        X.allT += dt;
        if (st.hold.ok(T)) X.okT += dt;
      }
      ok = X.holdT >= st.hold.secs;
    } else ok = Boolean(st.done(T));
    if (!ok) break;
    X.done[X.k] = now - X.t0;
    X.k++;
    moved = true;
    if (X.k < X.L.steps.length) enterStep();
  }
  if (X.k >= X.L.steps.length) { finish(T); return; }
  if (moved) renderBox();
  else updBox();
  pointer(T);
}

// 战斗结束（目标全灭 / 自己被打爆）：先按最后一帧查一遍步骤；返回 true = 练习自己处理结算
export function tutEnd() {
  if (!X) return false;
  // 已经完成了：之后被击毁 / 超时就按普通战斗结束；已经失败：面板里已经写了
  if (X.result) return Boolean(X.result.fail);
  tutTick();
  if (X.result && !X.result.fail) return false;
  if (!X.result) fail(H.S.me?.alive === false ? '你的船被击毁了，这一课没有完成' : '训练目标已经没有了，这一课没有完成');
  return true;
}

function finish(T) {
  const L = X.L, time = H.S.b.t - X.t0;
  const timeS = time <= L.par ? 1 : Math.max(0, 1 - (time - L.par) / (L.par * PAR_SLACK));
  let acc = null;
  if (L.score) acc = L.score(T);
  else if (L.acc) acc = X.allT > 0 ? X.okT / X.allT : 0;
  const score = Math.round(100 * (acc == null ? timeS : 0.5 * acc + 0.5 * timeS));
  const stars = score >= 90 ? 3 : score >= 70 ? 2 : 1;
  const old = bests()[L.id];
  const r = { time, timeS, acc, score, stars, best: null, first: !old, record: !old || score > old.score };
  r.best = saveBest(L.id, r);
  X.result = r;
  hidePointer();
  renderDone(r);
}
// 失败（跑掉了、被击毁）：同样只在任务面板里说明
function fail(why) {
  if (X.result) return;
  X.result = { fail: true, why };
  hidePointer();
  renderDone(X.result);
}
// 完成 / 失败：不弹结算框，任务面板里显示「目标完成」和成绩；战斗照常进行，玩家可以接着飞，自己退出
function renderDone(r) {
  const box = H.root().querySelector('#plTut');
  if (!box) return;
  const L = X.L, esc = H.esc;
  const next = LESSONS[LESSONS.indexOf(L) + 1];
  const pct = (x) => `${Math.round(x * 100)}%`;
  box.hidden = false;
  box.innerHTML = `<div class="pl-ip-top"><span class="pl-ip-ic"><img src="${UIP}infopanels/operationsicon_main.png" alt=""></span><b class="pl-ip-h">${esc(H.tr('练习'))}</b><button type="button" class="pl-ip-x" data-pl-exit title="${esc(H.tr('退出练习'))}"><img src="${UIP}infopanels/quitoperation_icon.png" alt=""></button></div>
    <div class="pl-ip-main">
      <div class="pl-ip-op"><span>${esc(L.id)}</span> <span>${esc(L.name)}</span></div>
      <div class="pl-ip-obj${r.fail ? ' fail' : ' ok'}"><span class="pl-ip-oi"><img src="${UIP}missiontracker/${r.fail ? 'tracker_kill' : 'tracker_check'}.png" alt=""></span><span class="pl-ip-ot">${r.fail ? '未完成' : '目标完成'}</span></div>
      ${r.fail ? `<p class="pl-ip-p">${esc(r.why)}</p>` : `<p class="pl-ip-p"><span>得分 ${r.score}</span> <i class="pl-tut-star">${stars(r.stars)}</i>${r.record && !r.first ? ' <span>新纪录</span>' : ''}</p>
      <p class="pl-ip-p">${r.acc != null ? `用时 ${r.time.toFixed(1)} 秒（标准 ${L.par} 秒）· 时间分 ${pct(r.timeS)} · 精度 ${pct(r.acc)}` : `用时 ${r.time.toFixed(1)} 秒（标准 ${L.par} 秒）· 时间分 ${pct(r.timeS)}`}</p>
      <p class="pl-ip-p">最好成绩 ${r.best.score} 分 · ${r.best.time} 秒</p>`}
      <p class="pl-ip-p pl-ip-note">${H.S.me?.alive ? '可以继续自由飞行，随时点右上角的按钮退出练习' : '点右上角的按钮退出练习'}</p>
      <div class="pl-ip-btns"><button type="button" class="pl-btn" data-pl-restart>再练一次</button>${next && !r.fail ? `<button type="button" class="pl-btn" data-pl-tut="${next.id}"><span>下一课：</span><span>${esc(next.name)}</span></button>` : ''}</div>
    </div>`;
}

// ---------- 任务面板：照客户端 InfoPanelOperations（左上角信息面板，宽 312，左边 56 放图标；只显示当前这一步） ----------
const UIP = 'assets/eveui/classes/';
function renderBox() {
  const box = H.root().querySelector('#plTut');
  if (!box || !X) return;
  const L = X.L, esc = H.esc, st = L.steps[X.k];
  box.hidden = false;
  box.innerHTML = `<div class="pl-ip-top"><span class="pl-ip-ic"><img src="${UIP}infopanels/operationsicon_main.png" alt=""></span><b class="pl-ip-h">${esc(H.tr('练习'))}</b><button type="button" class="pl-ip-x" data-pl-exit title="${esc(H.tr('退出练习'))}"><img src="${UIP}infopanels/quitoperation_icon.png" alt=""></button></div>
    <div class="pl-ip-main">
      <div class="pl-ip-op"><span>${esc(L.id)}</span> <span>${esc(L.name)}</span><em>${X.k + 1} / ${L.steps.length}</em></div>
      <div class="pl-ip-obj" data-k="${X.k}"><span class="pl-ip-oi"><img src="${UIP}missiontracker/tracker_kill.png" alt=""></span><span class="pl-ip-ot">${esc(st?.text || '')}</span></div>
      ${st?.hold ? `<div class="pl-ip-bar"><i id="plTutHold"></i><span><span>已保持</span> <span id="plTutHoldT"></span></span></div>` : ''}
      <div class="pl-ip-meta"><span id="plTutT"></span><span>标准时间 ${L.par} 秒</span>${L.acc ? `<span><span>精度：</span><span>${esc(L.acc)}</span></span>` : ''}</div>
    </div>`;
  updBox();
}
function updBox() {
  const t = H.root().querySelector('#plTutT');
  if (t) t.textContent = `${Math.max(0, H.S.b.t - X.t0).toFixed(1)} s`;
  const st = X.L.steps[X.k], h = H.root().querySelector('#plTutHold');
  if (h && st?.hold) {
    h.style.width = `${Math.min(100, X.holdT / st.hold.secs * 100)}%`;
    const ht = H.root().querySelector('#plTutHoldT');
    if (ht) ht.textContent = `${Math.min(X.holdT, st.hold.secs).toFixed(1)} / ${st.hold.secs} s`;
  }
}

// ---------- 指引：照客户端 uihighlighting ----------
// 界面元素 → UiPointer（指引框：边框 + 光晕 + 顶上的亮条 + 箭头，默认放在元素左边，放不下放右边，上下出界改放下方 / 上方）
// 太空中的船 → SpaceObjectPointer（船上一个高亮圈；说明框带船的图标，慢慢飘到离圈 48 像素的地方，中间一条细线连着）
// 船在画面外 / 镜头后面：圈贴在画面边上（客户端 bracket dock）
const POINTER_W = 276, SPACE_W = 220, PAD = 10, ICON = 48, ICON_PAD = 8;
const FLOAT_D = 48, ACCEL = 6, MAX_SPEED = 10, SLOW_D = 100, MAX_DT = 0.1, DOCK = 20;
function uipHtml(text, o = {}) {
  const esc = H.esc;
  const tw = (o.w || POINTER_W - 32) - 2 * PAD;   // 客户端：指向左右时框宽 276 − 32，文字宽 = 框宽 − 两边内边距
  return `<div class="pl-uip-tr">
    <div class="pl-uip-bg"><i class="pl-uip-aura"></i><i class="pl-uip-frame"></i></div>
    <div class="pl-uip-in"><i class="pl-uip-side"></i><i class="pl-uip-sideg"></i><i class="pl-uip-blink"></i><i class="pl-uip-swoop"></i>
      <div class="pl-uip-c">${o.icon ? `<img class="pl-uip-icon" src="${o.icon}" alt="">` : ''}<div class="pl-uip-txt" style="width:${tw}px">${o.title ? `<b>${esc(o.title)}</b><hr>` : ''}<p>${esc(text)}</p></div></div></div>
    ${o.arrow === false ? '' : `<video class="pl-uip-arrow" src="${UIP}highlighttool/highlightarrow_loop.webm" autoplay loop muted playsinline></video><i class="pl-uip-glow"></i>`}
  </div>`;
}
function els() {
  const r = H.root();
  return { p: r.querySelector('#plTutP'), s: r.querySelector('#plTutS'), stage: r.querySelector('#plStage') };
}
function hidePointer() {
  const { p, s } = els();
  if (p) { p.hidden = true; p.dataset.key = ''; }
  if (s) { s.hidden = true; s.dataset.key = ''; }
}
// 鼠标移到指引框上：框变半透明（客户端 OPACITY_MOUSE_OVER 0.5），不挡住后面的东西
function hoverFade(el, list) {
  const m = X?.mouse;
  const on = Boolean(m) && list.some((e) => { const r = e.getBoundingClientRect(); return r.width && m[0] >= r.left && m[0] <= r.right && m[1] >= r.top && m[1] <= r.bottom; });
  el.classList.toggle('is-hover', on);
}

// 界面元素：照 uipointersvc.GetLocation 摆放
function placeUi(p, el, stage) {
  const r = el.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const eL = r.left - sr.left, eT = r.top - sr.top, eW = r.width, eH = r.height;
  const size = (dir) => { p.dataset.dir = dir; return [p.offsetWidth, p.offsetHeight]; };
  let dir = 'r', [w, h] = size('r');
  const cumL = eL - 2, cumT = eT - 2;
  let top = cumT + eH / 2 - h / 2, left;
  if (cumL - w <= 0) { [w, h] = size(dir = 'l'); left = cumL + eW + 2; }
  else left = cumL - w + 2;
  const clampX = (x, pw) => Math.max(0, Math.min(sr.width - pw, x));
  if (top < 0) {
    [w, h] = size(dir = 'u');
    top = eT - 2 + eH;
    left = clampX(eL + eW / 2 - w / 2, w);
  } else if (top + h > sr.height) {
    [w, h] = size(dir = 'd');
    top = eT - h;
    left = clampX(eL + eW / 2 - w / 2, w);
  }
  p.dataset.dir = dir;
  p.style.left = `${Math.round(left)}px`;
  p.style.top = `${Math.round(top)}px`;
}

// 太空中的船：圈跟着船（出了画面贴边），说明框照 SpaceObjectPointer.UpdateBoxPosition 慢慢飘过去
function placeSpace(s, sx, sy, host, stage) {
  const sr = stage.getBoundingClientRect(), hr = host.getBoundingClientRect();
  const br = s.querySelector('.pl-sop-br'), box = s.querySelector('.pl-sop-box'), ln = s.querySelector('line');
  const bx = Math.max(hr.left - sr.left + DOCK, Math.min(hr.right - sr.left - DOCK, hr.left - sr.left + sx));
  const by = Math.max(hr.top - sr.top + DOCK, Math.min(hr.bottom - sr.top - DOCK, hr.top - sr.top + sy));
  br.style.left = `${bx}px`;
  br.style.top = `${by}px`;
  const w = box.offsetWidth, h = box.offsetHeight, F = X.float;
  if (F.x == null) { F.x = (sr.width - w) / 2; F.y = (sr.height - h) / 2; F.speed = 0; F.t = performance.now(); }
  const now = performance.now();
  const cx = F.x + w / 2, cy = F.y + h / 2, vx = bx - cx, vy = by - cy;
  // 点到框的距离（框外最近的点；在框里 = 0）
  const dx = bx < F.x ? F.x - bx : bx > F.x + w ? bx - F.x - w : 0;
  const dy = by < F.y ? F.y - by : by > F.y + h ? by - F.y - h : 0;
  const diff = Math.hypot(dx, dy) - FLOAT_D;
  if (Math.abs(diff) < 15) F.speed = 0;
  else {
    const ratio = Math.abs(diff) < SLOW_D ? Math.abs(diff) / SLOW_D : 1;
    const dt = Math.min(MAX_DT, (now - F.t) / 1000);
    F.speed = Math.min(F.speed + ACCEL * dt, MAX_SPEED * ratio);
    // 客户端每帧挪一次（按 60 帧算）；这里按实际帧间隔折算，帧率低时不会飘得太慢
    // （一步最多走 |diff|，帧率低时不冲过头）
    const fr = dt * 60;
    let sx = vx / diff * F.speed * fr, sy = vy / diff * F.speed * fr;
    const sl = Math.hypot(sx, sy), cap = Math.abs(diff);
    if (sl > cap) { sx *= cap / sl; sy *= cap / sl; }
    F.x += sx;
    F.y += sy;
    F.x = Math.max(DOCK, Math.min(sr.width - w - DOCK, F.x));
    F.y = Math.max(DOCK, Math.min(sr.height - h - DOCK, F.y));
  }
  F.t = now;
  box.style.left = `${Math.round(F.x)}px`;
  box.style.top = `${Math.round(F.y)}px`;
  // 连线：框上离圈最近的角 / 边中点 → 圈心，圈那头缩短 ICON / 2
  const hx = w / 2, hy = h / 2, px = bx - (F.x + hx), py = by - (F.y + hy);
  const kx = px < -hx ? -1 : px > hx ? 1 : 0, ky = py < -hy ? -1 : py > hy ? 1 : 0;
  let ax = kx * hx, ay = ky * hy;
  if (!kx && !ky) { ax = px < 0 ? -hx : hx; ay = py < 0 ? -hy : hy; }
  const x0 = F.x + hx + ax, y0 = F.y + hy + ay;
  const lx = bx - x0, ly = by - y0, len = Math.hypot(lx, ly) || 1, k = Math.max(0, (len - ICON / 2) / len);
  ln.setAttribute('x1', x0); ln.setAttribute('y1', y0);
  ln.setAttribute('x2', x0 + lx * k); ln.setAttribute('y2', y0 + ly * k);
  hoverFade(s, [box]);
}

function pointer(T) {
  const { p, s, stage } = els();
  if (!p || !s || !stage) return;
  const st = X.L.steps[X.k];
  let at = null;
  try { at = st?.at ? st.at(T) : null; } catch { at = null; }
  // 太空中的船
  if (at?.unit != null) {
    const v = H.S.b.units[at.unit], view = H.view(), host = H.root().querySelector('#pl3d');
    const pos = v?.alive && view?.drawnPos?.(v.i);
    const sc = pos && host && (view.projectEdge || view.project)(pos);
    if (sc) {
      p.hidden = true; p.dataset.key = '';
      const key = `${X.k}|${at.unit}`;
      if (s.dataset.key !== key) {
        s.dataset.key = key;
        X.float = {};
        const name = H.S.names[v.i] || H.typeName(v.r?.row?.ship);
        s.innerHTML = `<div class="pl-sop-br"><video class="pl-sop-intro" src="${UIP}highlighttool/highlightring_intro.webm" autoplay muted playsinline></video><video class="pl-sop-loop" src="${UIP}highlighttool/highlightring_loop.webm" loop muted playsinline></video><i class="pl-sop-glow"></i></div>
          <svg class="pl-sop-ln"><line></line></svg>
          <div class="pl-uip pl-sop-box" data-dir="n">${uipHtml(st.text, { title: name, icon: H.img(v.r?.row?.ship, 'icon', 64), arrow: false, w: SPACE_W })}</div>`;
        const intro = s.querySelector('.pl-sop-intro'), loop = s.querySelector('.pl-sop-loop');
        intro.onended = () => { intro.hidden = true; loop.play().catch(() => {}); };
        s.hidden = false;
      }
      placeSpace(s, sc[0], sc[1], host, stage);
      return;
    }
    at = ovRow(at.unit);
  }
  s.hidden = true; s.dataset.key = '';
  const el = at instanceof Element ? (at.offsetParent ? at : null) : typeof at === 'string' ? [...H.root().querySelectorAll(at)].find((e) => e.offsetParent && !e.closest('[hidden]')) : null;
  if (!el) { p.hidden = true; p.dataset.key = ''; return; }
  const key = `${X.k}|${typeof at === 'string' ? at : 'el'}`;
  if (p.dataset.key !== key) {
    p.dataset.key = key;
    p.innerHTML = uipHtml(st.text);
    p.hidden = false;
  }
  placeUi(p, el, stage);
  hoverFade(p, [p]);
}
