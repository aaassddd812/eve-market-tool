"""3D 体积贴图（DDS DXT5 volume）→ 平铺 PNG。驾驶模拟船身特效 fx3dv5 用。

用法：python3 -I vol-tex.py <输入.dds> <输出.png> [边长=64]
  只取最高一级 mip，按边长降采样；切片 z 从上到下竖着排（边长 × 边长²，和 noise32.png 一样），
  RGBA 原样保留（fx3dv5 的两层分别读 .x、.y）。
版权归 CCP。
"""
import struct
import sys

import numpy as np
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
S = int(sys.argv[3]) if len(sys.argv) > 3 else 64
d = open(src, 'rb').read()
h, w, depth = (struct.unpack('<I', d[o:o + 4])[0] for o in (12, 16, 24))
assert d[84:88] == b'DXT5', d[84:88]


def bc3(buf, w, h):
    bw, bh = w // 4, h // 4
    b = np.frombuffer(buf, np.uint8, bw * bh * 16).reshape(bh * bw, 16)
    # 透明度：两个端点 + 48 位 3 位索引
    a0 = b[:, 0].astype(np.float32); a1 = b[:, 1].astype(np.float32)
    k = np.arange(8, dtype=np.float32)
    big = np.stack([a0, a1] + [((7 - i) * a0 + i * a1) / 7 for i in range(1, 7)], 1)
    small = np.stack([a0, a1] + [((5 - i) * a0 + i * a1) / 5 for i in range(1, 5)] + [np.zeros_like(a0), np.full_like(a0, 255)], 1)
    pal_a = np.where((a0 > a1)[:, None], big, small)
    bits = np.zeros(len(b), np.uint64)
    for i in range(6): bits |= b[:, 2 + i].astype(np.uint64) << np.uint64(8 * i)
    ai = np.stack([(bits >> np.uint64(3 * j)) & np.uint64(7) for j in range(16)], 1).astype(np.int64)
    A = np.take_along_axis(pal_a, ai, 1)
    # 颜色：两个 565 端点（DXT5 里总是四色模式）
    c0 = b[:, 8].astype(np.uint32) | (b[:, 9].astype(np.uint32) << 8)
    c1 = b[:, 10].astype(np.uint32) | (b[:, 11].astype(np.uint32) << 8)
    def rgb(c): return np.stack([((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31], 1)
    p0, p1 = rgb(c0), rgb(c1)
    pal = np.stack([p0, p1, (2 * p0 + p1) / 3, (p0 + 2 * p1) / 3], 1)
    ci = b[:, 12].astype(np.uint32) | (b[:, 13].astype(np.uint32) << 8) | (b[:, 14].astype(np.uint32) << 16) | (b[:, 15].astype(np.uint32) << 24)
    idx = np.stack([(ci >> (2 * j)) & 3 for j in range(16)], 1).astype(np.int64)
    C = np.take_along_axis(pal, idx[..., None].repeat(3, 2), 1)
    px = np.concatenate([C, A[..., None]], 2).reshape(bh, bw, 4, 4, 4).transpose(0, 2, 1, 3, 4).reshape(h, w, 4)
    return px


slice_b = (w // 4) * (h // 4) * 16
vol = np.stack([bc3(d[128 + z * slice_b:], w, h) for z in range(depth)], 0)   # z, y, x, c
f = depth // S
vol = vol.reshape(S, f, S, h // S, S, w // S, 4).mean((1, 3, 5)) if f > 1 else vol
atlas = vol.reshape(S * S, S, 4)
Image.fromarray(np.clip(atlas + 0.5, 0, 255).astype(np.uint8), 'RGBA').save(dst, optimize=True)
print(src, (w, h, depth), '->', S)
