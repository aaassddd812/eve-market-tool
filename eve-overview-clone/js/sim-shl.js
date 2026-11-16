// 二次光照（行星 / 卫星反射的太阳光）：照客户端 trinity Tr2ShLightingManager（L2，7 行打包系数），
//   船壳 PS（实机 2f06fc）每物体常量 ShLighting[7]（cb4[15..21]）就是它算的。
// 光源（EveSpaceScene.SetShLightingManager 注册）：行星 / 卫星（EvePlanet：位置、半径、albedoColor、emissiveColor），
//   以及空间站 / 星门 / 舰船（EveSpaceObject2：半径 = 包围盒同体积球，反照率 = eveSpaceObject.GetAlbedoColor(model)）。
//   后者的 GetAlbedoColor 在反编译源码里没有（试过「反照率贴图平均色」和抓帧对不上），所以这里只做行星 / 卫星。
// 每个光源（CalculateSecondaryLighting）：
//   跳过：半径 < 接收者包围球半径 × 0.3；距离 < 1 米；半径 / 距离 × 最大颜色分量 < 0.315（s_cutoffRadiusRatio = 0.045 × 7）
//   球冠积分（SHEvalSphericalLight）：sin = 半径 / 距离（在球里 = 1），cos = √(1 − sin²)，
//     角系数 (1 − cos, sin², cos(cos² − 1))，基函数 (1, y, z, x, 2xy, zy, 3z² − 1, zx, x² − y²)
//   颜色 = (dot(光传播方向, 指向光源) × 0.5 + 0.5) × 反照率 × 二次光强度（太阳色传的是 (1,1,1)）+ 自发光
//   归一化系数、打包（PackCoefficients）照抄 L2 的常量；最后整体 × 接收者强度（sim-ships.js 着色器里乘）。
// 二次光强度（gfxsettings.SECONDARY_LIGHTING_INTENSITY）源码里拿不到数值：用抓帧 frame32757 拟合——
//   1DH-SX 血袭者空间站旁的 AF5，卫星 40298109（SDE 方向 / 张角、反照率 0.737）+ 船所在的空间站光球两路，
//   正向模型和抓帧 28 个系数最大误差 0.0012，强度 = 3.15。
// 反照率：行星类型 → graphicID → graphicIDs.albedoColor（客户端 planet.py _SetupPlanet；没有的 = 0，不发光）。
const SECONDARY = 3.15;
const ALBEDO = {
  14: [0.737, 0.737, 0.737],        // 卫星 → 10 moon.red
  11: [0.451, 0.749, 1.0],          // 温和 → 3832 Earthlike
  12: [0.447, 0.8, 1.0],            // 冰 → 3834 IcePlanet
  13: [0.941, 1.0, 0.682],          // 气态 → 3833 GasGiant
  2014: [0.396, 0.769, 1.0],        // 海洋 → 3835 Ocean
  2016: [1.0, 0.89, 0.663],         // 贫瘠 → 3837 SandStormPlanet
  2017: [0.482, 0.8, 1.0],          // 风暴 → 3935 ThunderStormPlanet
  30889: [1.0, 0.573, 0.424],       // 破碎 → 202 ShatteredPlanet
  // 熔岩 2015（3836）、等离子 2063（3941）的 graphicID 没有 albedoColor
};
const CUTOFF = 0.045 * 7;
const SQ = Math.sqrt, PI = Math.PI, S3141593 = SQ(3.141593);
const NORM = [
  2 * SQ(PI) * 0.282094791773878140 * S3141593,
  2 / 3 * SQ(3 * PI) * -0.488602511902919920 * (SQ(3) * S3141593 / 2),
  2 / 3 * SQ(3 * PI) * 0.488602511902919920 * (SQ(3) * S3141593 / 2),
  2 / 3 * SQ(3 * PI) * -0.488602511902919920 * (SQ(3) * S3141593 / 2),
  2 / 5 * SQ(5 * PI) * 0.546274215296039590 * (-SQ(5) * S3141593 / 2),
  2 / 5 * SQ(5 * PI) * -1.092548430592079200 * (-SQ(5) * S3141593 / 2),
  2 / 5 * SQ(5 * PI) * -0.315391565252520050 * (-SQ(5) * S3141593 / 2),
  2 / 5 * SQ(5 * PI) * -1.092548430592079200 * (-SQ(5) * S3141593 / 2),
  2 / 5 * SQ(5 * PI) * 0.546274215296039590 * (-SQ(5) * S3141593 / 2),
];
const P0 = 1 / (2 * SQ(PI)), P1 = SQ(3) / (3 * SQ(PI)), P2 = SQ(15) / (8 * SQ(PI)), P3 = SQ(5) / (16 * SQ(PI)), P4 = 0.5 * P2;

export function createSecondaryLighting() {
  let src = [];
  const sh = new Float64Array(27), r = new Float64Array(9);
  return {
    // cel：引擎记录的天体列表（group 7 行星、8 卫星；pos 米、radius 米、type）
    set(cel) {
      src = [];
      for (const c of cel || []) {
        if (c.group !== 7 && c.group !== 8) continue;
        const a = ALBEDO[c.group === 8 ? 14 : c.type];
        if (!a || !(c.radius > 0)) continue;
        const alb = a.map((x) => x * SECONDARY);
        src.push({ p: c.pos, r: c.radius, alb, max: Math.max(...alb) });   // maxColorComponent = max(反照率) × 太阳色最大分量 1
      }
    },
    has: () => src.length > 0,
    // pos：接收者世界坐标（米）；toSun：指向恒星的单位向量；cut：接收者包围球半径 × 0.3（米）；out：7 个 THREE.Vector4。有光返回 true
    at(pos, toSun, cut, out) {
      sh.fill(0);
      let any = false;
      for (const s of src) {
        if (s.r < cut) continue;
        const dx = s.p[0] - pos[0], dy = s.p[1] - pos[1], dz = s.p[2] - pos[2];
        const dist = Math.hypot(dx, dy, dz);
        if (!Number.isFinite(dist) || dist < 1 || (s.r / dist) * s.max < CUTOFF) continue;
        const x = dx / dist, y = dy / dist, z = dz / dist;
        const sa = dist <= s.r ? 1 : s.r / dist, ca = dist <= s.r ? 0 : SQ(1 - sa * sa);
        const a0 = 1 - ca, a1 = sa * sa, a2 = ca * (ca * ca - 1);
        r[0] = a0; r[1] = y * a1; r[2] = z * a1; r[3] = x * a1;
        r[4] = 2 * x * y * a2; r[5] = z * y * a2; r[6] = (3 * z * z - 1) * a2; r[7] = z * x * a2; r[8] = (x * x - y * y) * a2;
        // 光传播方向 = −指向恒星（EveSpaceScene：m_sunData.DirWorld = −sunDirection）
        const f = -(toSun.x * x + toSun.y * y + toSun.z * z) * 0.5 + 0.5;
        for (let i = 0; i < 9; i++) for (let ch = 0; ch < 3; ch++) sh[i * 3 + ch] += r[i] * f * s.alb[ch];
        any = true;
      }
      for (let i = 0; i < 9; i++) for (let ch = 0; ch < 3; ch++) sh[i * 3 + ch] *= NORM[i];
      const g = (i, ch) => sh[i * 3 + ch];
      for (let ch = 0; ch < 3; ch++) {
        out[ch].set(-P1 * g(3, ch), -P1 * g(1, ch), P1 * g(2, ch), P0 * g(0, ch) - P3 * g(6, ch));
        out[ch + 3].set(P2 * g(4, ch), -P2 * g(5, ch), 3 * P3 * g(6, ch), -P2 * g(7, ch));
      }
      out[6].set(g(8, 0) * P4, g(8, 1) * P4, g(8, 2) * P4, 1);
      return any;
    },
  };
}

// 接收者强度（EveSpaceObject2::UpdateShLighting）：屏幕直径 px（TriFrustum::GetPixelSizeAccrossEst = 半径 / √(距离² − 半径²) × proj._11 × 视口宽）
//   ≤ 低细节阈值 100 时为 0，(px − 100) / ((400 − 100) × 0.25) 截到 0~1
export function shIntensity(radius, dist, proj11, vpW) {
  if (!(radius > 0)) return 0;
  const px = dist <= radius ? Infinity : radius / SQ(dist * dist - radius * radius) * proj11 * vpW;
  return px <= 100 ? 0 : Math.min(1, (px - 100) / 75);
}
