// ===== 殖民地球面坐标工具 =====
// 坐标与殖民地模板一致：La 为极角（π/2 为赤道），Lo 为经度，单位弧度。
// 编辑器以正交投影把殖民地附近的球面画到屏幕上（拉近后近似平面），只负责坐标换算，不渲染地表。
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---------- 相机 ----------
// 相机朝向 (th0, ph0)，rpx 为球体半径（像素），screen 中心为 (cx, cy)
export function basis(cam) {
  const st = Math.sin(cam.th), ct = Math.cos(cam.th), sp = Math.sin(cam.ph), cp = Math.cos(cam.ph);
  return {
    c: [st * cp, st * sp, ct],             // 指向观察者
    e: [-sp, cp, 0],                       // 东
    n: [-ct * cp, -ct * sp, st]            // 北
  };
}
export const toVec = (th, ph) => [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];

// 球面点 -> 屏幕；不可见（在背面）时 visible=false
export function project(cam, b, th, ph) {
  const v = toVec(th, ph);
  const x = dot(v, b.e), y = -dot(v, b.n), z = dot(v, b.c);
  return { x: cam.cx + x * cam.rpx, y: cam.cy + y * cam.rpx, visible: z > 0, z };
}

// 屏幕 -> 球面 (th, ph)；落在球外返回 null
export function unproject(cam, b, sx, sy) {
  const x = (sx - cam.cx) / cam.rpx, y = (sy - cam.cy) / cam.rpx;
  const r2 = x * x + y * y;
  if (r2 > 1) return null;
  const z = Math.sqrt(1 - r2);
  const v = [x * b.e[0] - y * b.n[0] + z * b.c[0], x * b.e[1] - y * b.n[1] + z * b.c[1], x * b.e[2] - y * b.n[2] + z * b.c[2]];
  let ph = Math.atan2(v[1], v[0]);
  if (ph < 0) ph += Math.PI * 2;
  return { th: Math.acos(Math.max(-1, Math.min(1, v[2]))), ph };
}

// 两点间大圆上的插值点（画链接用）
export function arc(a, b, steps = 16) {
  const va = toVec(a.th, a.ph), vb = toVec(b.th, b.ph);
  const om = Math.acos(Math.max(-1, Math.min(1, dot(va, vb))));
  if (om < 1e-9) return [a, b];
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const s1 = Math.sin((1 - t) * om) / Math.sin(om), s2 = Math.sin(t * om) / Math.sin(om);
    const v = [va[0] * s1 + vb[0] * s2, va[1] * s1 + vb[1] * s2, va[2] * s1 + vb[2] * s2];
    let ph = Math.atan2(v[1], v[0]);
    if (ph < 0) ph += Math.PI * 2;
    out.push({ th: Math.acos(Math.max(-1, Math.min(1, v[2]))), ph });
  }
  return out;
}

export function angle(a, b) {
  const c = Math.cos(a.th) * Math.cos(b.th) + Math.sin(a.th) * Math.sin(b.th) * Math.cos(a.ph - b.ph);
  return Math.acos(Math.max(-1, Math.min(1, c)));
}

