"""装备特效贴图 DDS → PNG。fx-effects.mjs 调用。

用法：python3 -I cfx-tex.py <DDS 目录> <输出目录> 名字...
  普通贴图 → <名>.png（RGBA，边长最多 256）
  立方体贴图（DDS caps2 带 CUBEMAP，无压缩 24 / 32 位）→ <名>/{px,nx,py,ny,pz,nz}.png
版权归 CCP。
"""
import os
import struct
import sys

import numpy as np
from PIL import Image

src, out, names = sys.argv[1], sys.argv[2], sys.argv[3:]
MAX = 256


def cube(name, d):
    h, w, mips = (struct.unpack('<I', d[o:o + 4])[0] for o in (12, 16, 28))
    bpp = struct.unpack('<I', d[88:92])[0] // 8
    rmask = struct.unpack('<I', d[92:96])[0]
    face = sum(max(1, w >> i) * max(1, h >> i) * bpp for i in range(max(1, mips)))
    os.makedirs(os.path.join(out, name), exist_ok=True)
    for i, f in enumerate(['px', 'nx', 'py', 'ny', 'pz', 'nz']):
        a = np.frombuffer(d, np.uint8, w * h * bpp, 128 + i * face).reshape(h, w, bpp)
        rgb = a[..., :3] if rmask == 0xff else a[..., 2::-1]   # 掩码 0xff0000 = BGR 顺序
        Image.fromarray(np.ascontiguousarray(rgb), 'RGB').save(os.path.join(out, name, f + '.png'), optimize=True)


for name in names:
    p = os.path.join(src, name + '.dds')
    d = open(p, 'rb').read()
    if struct.unpack('<I', d[112:116])[0] & 0x200:
        cube(name, d)
        print('cube', name)
        continue
    im = Image.open(p).convert('RGBA')
    w, h = im.size
    k = min(1, MAX / max(w, h))
    if k < 1:
        im = im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
    im.save(os.path.join(out, name + '.png'), optimize=True)
    print('tex', name, (w, h), '->', im.size)
