"""深渊环境特效贴图 DDS → PNG / 体积贴图。fx-env.mjs 调用。

用法：python3 -I env-tex.py <DDS 目录> <输出目录> <边长上限> 名字...
  普通贴图 → <名>.png（RGBA，边长不超过上限）
  体积贴图（DDS caps2 带 VOLUME）→ <名>.bin（原始字节，x 最快、再 y、再 z）+ <名>.bin.json [宽, 高, 深, 通道数]
    边长超过 64 的按 2×2×2 盒式平均缩到 64；RGB 三通道一样（灰度）时只存 1 个通道，否则存 RGB（24 位）/ RGBA（DXT5、32 位）
    DXT5 体积：每一层套一个 2D DDS 头交给 Pillow 解码
版权归 CCP。
"""
import io
import json
import os
import struct
import sys

import numpy as np
from PIL import Image

src, out, MAX, names = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4:]
VOL_MAX = 64


def volume(name, d):
    h, w, depth = (struct.unpack('<I', d[o:o + 4])[0] for o in (12, 16, 24))
    fourcc = d[84:88]
    bits = struct.unpack('<I', d[88:92])[0]
    if fourcc == b'DXT5':
        size = max(1, w // 4) * max(1, h // 4) * 16
        hdr = bytearray(d[:128])
        hdr[8:12] = struct.pack('<I', struct.unpack('<I', hdr[8:12])[0] & ~0x800000 & ~0x20000)  # 去掉 DEPTH / MIPMAPCOUNT
        hdr[24:28] = struct.pack('<I', 0)
        hdr[28:32] = struct.pack('<I', 1)
        hdr[112:116] = struct.pack('<I', 0)
        layers = []
        for z in range(depth):
            im = Image.open(io.BytesIO(bytes(hdr) + d[128 + z * size:128 + (z + 1) * size])).convert('RGBA')
            layers.append(np.asarray(im))
        a = np.stack(layers)  # z, y, x, 4
    else:
        bpp = bits // 8
        rmask = struct.unpack('<I', d[92:96])[0]
        a = np.frombuffer(d, np.uint8, w * h * depth * bpp, 128).reshape(depth, h, w, bpp)
        if bpp >= 3 and rmask != 0xff:  # 掩码 0xff0000 = BGR 顺序
            a = np.concatenate([a[..., 2::-1], a[..., 3:]], axis=-1)
    while max(a.shape[:3]) > VOL_MAX:
        a = a.reshape(a.shape[0] // 2, 2, a.shape[1] // 2, 2, a.shape[2] // 2, 2, a.shape[3]).astype(np.float32).mean(axis=(1, 3, 5)).round().astype(np.uint8)
    if a.shape[3] >= 3 and np.array_equal(a[..., 0], a[..., 1]) and np.array_equal(a[..., 0], a[..., 2]):
        a = a[..., :1]
    a = np.ascontiguousarray(a)
    open(os.path.join(out, name + '.bin'), 'wb').write(a.tobytes())
    meta = [a.shape[2], a.shape[1], a.shape[0], a.shape[3]]
    json.dump(meta, open(os.path.join(out, name + '.bin.json'), 'w'))
    print('vol', name, (w, h, depth, fourcc.decode('latin-1').strip('\0') or bits), '->', meta)


for name in names:
    p = os.path.join(src, name + '.dds')
    d = open(p, 'rb').read()
    if struct.unpack('<I', d[112:116])[0] & 0x200000:
        volume(name, d)
        continue
    im = Image.open(p).convert('RGBA')
    w, h = im.size
    k = min(1, MAX / max(w, h))
    if k < 1:
        im = im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)
    im.save(os.path.join(out, name + '.png'), optimize=True)
    print('tex', name, (w, h), '->', im.size)
