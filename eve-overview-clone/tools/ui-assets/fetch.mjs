// 游戏界面素材：EVE 客户端资源服务器 → 驾驶模拟用的静态文件（assets/eveui/）
//
// 用法：node fetch.mjs [--out <输出目录>] [--sky a01,c01,g01,m01] [--fx]
//   --sky：同时转换这几张游戏星空（dx9/scene/universe/<名>_cube.dds）到 sky/<名>/{px,nx,py,ny,pz,nz}.webp（sky.py，需要 Pillow、numpy）
//   --fx：同时转换武器 / 爆炸特效贴图（texture/fx/ 下的 DDS）到 fx/（fx.py，需要 Pillow、numpy）
//
// 和 tools/ship-models/convert.mjs 一样只用公开资源：binaries.eveonline.com 取当前客户端版本 → resfileindex，
// 再从 resources.eveonline.com 下载需要的界面贴图（客户端里本来就是 PNG，不用转换）和 EVE Sans Neue 字体。
// 输出路径 = res:/ui/texture/ 之后的路径（字体放在 fonts/），例如 assets/eveui/classes/shipui/gauge1.png。
//
// 素材与字体版权归 CCP，仅供本站驾驶模拟画面使用。
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((s) => { const [k, ...v] = s.trim().split(/\s+/); return [k, v.join(' ') || true]; }));
const OUT = resolve(args.out || join(HERE, '../../assets/eveui'));
const BIN = 'https://binaries.eveonline.com/';
const RES = 'https://resources.eveonline.com/';

// 要下载的素材：整个目录（不含子目录）或单个文件
const DIRS = [
  'ui/texture/classes/shipui/',          // 底部船体面板：表盘、电容格、装备槽、过载、热量、速度表
  'ui/texture/classes/shipui/ewarbar/',  // 受到的电子战提示条
  'ui/texture/classes/target/',          // 锁定目标框：背景、三层血弧、锁定倒计时
  'ui/texture/classes/sensorsuite/',     // 雷达、罗盘
  'ui/texture/classes/bracket/',         // 太空中的选中 / 锁定 / 敌对标记
  'ui/texture/classes/flagicon/8/',      // 总览状态旗上的 8×8 符号（人形、星、加、减、等号…）
  'ui/texture/classes/radialmenu/',      // 右键环形菜单
  'ui/texture/classes/radialmenuactions/',
  'ui/texture/classes/window/',          // 窗口：边框、标题栏按钮
  'ui/texture/shared/darkstyle/',        // 窗口标题栏、面板角、按钮
  'ui/texture/classes/togglebuttongroup/', // 总览标签页
  'ui/texture/classes/scroll/',          // 列表：表头、滚动条
  'ui/texture/classes/neocom/',          // 左侧 Neocom 栏
  'ui/texture/classes/loadingwheel/',    // 加载转圈
  'ui/texture/classes/button/',          // 按钮：切角底板、边框、悬停光
  'ui/texture/classes/framewithpointer/', // 提示框（带指针的底板）
  'ui/texture/classes/utilmenu/',        // 小菜单（船体面板选项）：勾选框、分隔
  'ui/cursor/'                           // 鼠标指针（含 _x2 / _x3 高清版）
];
// 单个文件
const SHARED = ['frame', 'framehover', 'windowframe', 'windowshadow', 'windowshapeandshadow', 'windowbuttongradient', 'windowbuttonshadow'].map((n) => `ui/texture/shared/${n}.png`);
const CONTROL = ['approach', 'orbit', 'keep_at_distance', 'warp_to', 'align_to', 'target', 'look_at', 'show_info', 'launch_drones', 'recall_drones', 'engage_target', 'return_and_orbit', 'camera_track', 'camera_untrack'];
const FILES = [
  ...SHARED,
  // 窗口图标（Neocom、窗口标题栏）
  ...['overview', 'info', 'drones', 'dronebay', 'combatlog', 'fitting', 'settings', 'ships', 'log', 'navigation'].map((n) => `ui/texture/windowicons/${n}.png`),
  // 总览图标（舰船类别，16 像素）
  ...['frigate', 'destroyer', 'cruiser', 'battlecruiser', 'battleship', 'carrier', 'dreadnought', 'titan', 'industrial', 'capsule', 'shuttle', 'rookie', 'miningbarge', 'freighter', 'forceauxiliary', 'supercarrier', 'industrialcommand', 'miningfrigate'].map((n) => `ui/texture/shared/brackets/${n}_16.png`),
  ...CONTROL.flatMap((n) => [`ui/texture/eveicon/control_icons/${n}_16px.png`, `ui/texture/eveicon/control_icons/${n}_32px.png`]),
  'ui/texture/loadingwheel.png', 'ui/texture/loadingwheel_full.png',
  'ui/texture/shared/hamburgermenu_large.png',   // Neocom 顶上的 EVE 菜单
  'ui/texture/icons/73_16_251.png', 'ui/texture/icons/73_16_252.png',   // 装备栏「全部编组 / 取消编组」
  ...['56_64_5', 'target_killed', 'target_killed_skull'].map((n) => `ui/texture/icons/${n}.png`),   // 锁定目标：无人机图标、击毁标记
  ...['44_32_10', '44_32_12', '44_32_42'].map((n) => `ui/texture/icons/${n}.png`),   // HUD 左边按钮：货舱、自动驾驶、战术叠加层
  // 受到的电子战 / 遥修提示条图标（appConst.iconModule* → SDE icons 表）
  ...['76_64_1', '4_64_9', '12_64_6', '4_64_12', '4_64_11', '56_64_1', '1_64_3', '12_64_4', '1_64_16', 'remote_armor_repair', 'remote_hull_repairer'].map((n) => `ui/texture/icons/${n}.png`),
  'ui/texture/eveicon/system_icons/caret_up_16px.png', 'ui/texture/eveicon/system_icons/caret_down_16px.png',   // 总览表头排序箭头
  // 窗口标题栏「⋮ / —」、总览「+ 添加标签」、无人机分组展开箭头；选中物体窗口反向动作（解除锁定 / 重置视角）叠加图
  ...['more_vertical', 'minimize', 'add', 'caret_right', 'hourglass'].map((n) => `ui/texture/eveicon/system_icons/${n}_16px.png`),
  'ui/texture/icons/44_32_8.png',
  // 装备提示（ModuleButtonTooltip）各行的图标：射程、伤害、属性（SDE dogmaAttributes.iconID → icons）；船体面板选项按钮
  ...['22_32_15', '26_64_1', '81_64_16', '1_64_7', '2_64_7', '1_64_11', '22_32_7', '22_32_23', '22_32_22', '22_32_13', '22_32_12', '22_32_11', '22_32_9', '22_32_10', '3_64_9', '22_32_14', '22_32_21', '73_16_50', '4_64_9', '4_64_12', '8_64_9', '8_64_10', '8_64_11'].map((n) => `ui/texture/icons/${n}.png`),
  ...['electromagnetic', 'thermal', 'kinetic', 'explosive'].map((n) => `ui/texture/classes/damagetypes/${n}.png`),   // 战斗日志伤害类型
  'ui/fonts/evesansneue-regular.otf', 'ui/fonts/evesansneue-bold.otf', 'ui/fonts/evesansneue-condensed.otf'
];

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function fetchBuf(url, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      let b = Buffer.from(await r.arrayBuffer());
      if (b[0] === 0x1f && b[1] === 0x8b) b = gunzipSync(b);
      return b;
    } catch (e) {
      if (i >= tries - 1) throw e;
      await new Promise((ok) => setTimeout(ok, 1000 * (i + 1)));
    }
  }
}

const INDEX = new Map();
const build = JSON.parse((await fetchBuf(BIN + 'eveclient_TQ.json')).toString()).build;
const app = (await fetchBuf(`${BIN}eveonline_${build}.txt`)).toString();
for (const [, path] of app.split('\n').map((l) => l.split(',')).filter((p) => p[0] === 'app:/resfileindex.txt')) {
  for (const l of (await fetchBuf(BIN + path)).toString().split('\n')) {
    const p = l.split(',');
    if (p[1]) INDEX.set(p[0].toLowerCase().replace(/^res:\//, ''), p[1]);
  }
}
log('客户端版本', build, '资源条目', INDEX.size);

// 太空 / 总览图标：客户端的 type / group / category → 图标对照表（brackets.py 解析 staticdata/brackets*.static）→ brackets.json，
// 表里用到的图标全部下载
{
  const tmp = join(tmpdir(), 'eve-brackets');
  mkdirSync(tmp, { recursive: true });
  for (const n of ['brackets', 'bracketsbytype', 'bracketsbygroup', 'bracketsbycategory']) writeFileSync(join(tmp, n + '.static'), await fetchBuf(RES + INDEX.get(`staticdata/${n}.static`)));
  const r = spawnSync('python3', ['-I', join(HERE, 'brackets.py'), tmp, join(OUT, 'brackets.json')], { stdio: 'inherit' });
  if (r.status) throw new Error('图标对照表解析失败');
  for (const p of Object.values(JSON.parse(readFileSync(join(OUT, 'brackets.json'), 'utf8')).icon)) FILES.push('ui/texture/' + p);
}
const want = new Set(FILES.filter((f) => INDEX.has(f)));
for (const k of INDEX.keys()) for (const d of DIRS) if (k.startsWith(d) && !k.slice(d.length).includes('/') && /\.png$/.test(k)) want.add(k);
const list = [...want].sort();
let done = 0, skip = 0;
const outOf = (k) => join(OUT, k.startsWith('ui/fonts/') ? 'fonts/' + k.slice(9) : k.startsWith('ui/cursor/') ? 'cursor/' + k.slice(10) : k.slice('ui/texture/'.length));
let i = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < list.length) {
    const k = list[i++];
    const f = outOf(k);
    if (existsSync(f) && !args.force) { skip++; continue; }
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, await fetchBuf(RES + INDEX.get(k)));
    done++;
  }
}));
// 游戏星空
for (const name of String(args.sky || '').split(',').filter(Boolean)) {
  const k = `dx9/scene/universe/${name}_cube.dds`;
  if (!INDEX.has(k)) { log('没有这张星空', name); continue; }
  const dir = join(OUT, 'sky', name);
  if (existsSync(join(dir, 'nz.webp')) && !args.force) continue;
  const tmp = join(tmpdir(), `eve-sky-${name}.dds`);
  writeFileSync(tmp, await fetchBuf(RES + INDEX.get(k)));
  const r = spawnSync('python3', ['-I', join(HERE, 'sky.py'), tmp, dir], { stdio: 'inherit' });
  if (r.status) throw new Error('星空转换失败 ' + name);
}
// 特效贴图：fx.py 拼成 fx/sprites.webp（柔光 / 星芒 / 光环）、fx/explosion.webp（9 × 9 帧爆炸序列）、fx/beam.webp（光束横截面），
// 以及游戏炮塔特效用的流动噪声（turret.webp：射弹 / 激光 / 混合三格）、护盾受击格纹、死亡爆炸色带、火团
const FX = { glow: 'texture/fx/particles/whiteglobe_01b.dds', flare: 'texture/fx/flares/flare_02_bw.dds', ring: 'texture/fx/flares/flarex_01b.dds', burst: 'texture/fx/beam/outburst_01a.dds',
  explosion: 'texture/fx/motionparticles/explosion/explosion_08a.dds', beam: 'texture/fx/beam/beam_wide_01b.dds',
  tproj: 'dx9/model/turret/shared_textures/projectileautofx_01a.dds', tlaser: 'dx9/model/turret/shared_textures/laserbeamfx_01a.dds', thybrid: 'dx9/model/turret/shared_textures/hybridblastfx_01a.dds',
  tpulse: 'dx9/model/turret/shared_textures/laserpulsefx_01a.dds', trail: 'dx9/model/turret/shared_textures/hybridrailfx_01a.dds', tarty: 'dx9/model/turret/shared_textures/projectileartilleryfx_01a.dds',
  shield: 'texture/fx/3d/3dfx_shield_generic_01a.dds', ramp: 'texture/fx/gradients/deathexplosion_01a.dds', fire: 'texture/fx/fire/fireshape_01a.dds' };
if (args.fx && (!existsSync(join(OUT, 'fx', 'turret.webp')) || args.force)) {
  const tmp = join(tmpdir(), 'eve-fx');
  mkdirSync(tmp, { recursive: true });
  const fx = [];
  for (const [name, k] of Object.entries(FX)) {
    if (!INDEX.has(k)) throw new Error('没有这张特效贴图 ' + k);
    writeFileSync(join(tmp, name + '.dds'), await fetchBuf(RES + INDEX.get(k)));
    fx.push(name);
  }
  const r = spawnSync('python3', ['-I', join(HERE, 'fx.py'), tmp, join(OUT, 'fx')], { stdio: 'inherit' });
  if (r.status) throw new Error('特效贴图转换失败');
}
writeFileSync(join(OUT, 'BUILD.txt'), `EVE client build ${build}\n素材版权归 CCP，仅供本站驾驶模拟画面使用。\n\ntactical/anchor.png、tactical/arrow_tactical.png：由客户端 res:/ui/inflight/tactical/{anchor,arrow_tactical}.dds 用 Pillow 转成 PNG（原样，不改像素）。\n`);
log('下载', done, '已有', skip, '共', list.length, '→', OUT);
