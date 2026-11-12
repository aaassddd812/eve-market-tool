"""游戏星空立方体贴图（dx9/scene/universe/*_cube.dds，BC6H HDR）→ 6 张 WebP。fetch.mjs --sky 调用。

用法：python3 sky.py <dds 路径> <输出目录> [边长]
输出 px / nx / py / ny / pz / nz.webp（DDS 立方体的面顺序，three.js CubeTextureLoader 直接用）。
HDR 解码成 8 位后偏暗，按游戏里的观感提亮（曝光 × 2.4，伽马 1/1.3）。
"""
import io
import os
import struct
import sys

import numpy as np
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
size = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
d = open(src, 'rb').read()
assert d[:4] == b'DDS ', 'not a DDS file'
h, w = struct.unpack('<2I', d[12:20])
dx10 = d[84:88] == b'DX10'
head = 148 if dx10 else 128
fmt = struct.unpack('<I', d[128:132])[0] if dx10 else None
bpp = {94: 1, 95: 1, 96: 1, 97: 1, 98: 1, 99: 1, 70: 0.5, 71: 0.5, 72: 0.5}.get(fmt, 1)
face = int(w * h * bpp)
mips = max(1, struct.unpack('<I', d[28:32])[0])
# 每个面带完整的 mip 链
per = 0
mw, mh = w, h
for _ in range(mips):
    per += int(max(4, mw) * max(4, mh) * bpp)
    mw, mh = max(1, mw // 2), max(1, mh // 2)
hdr = bytearray(d[:head])
hdr[28:32] = struct.pack('<I', 1)          # 只取最大一层
hdr[112:116] = struct.pack('<I', 0)        # 去掉立方体标记
if dx10:
    hdr[136:140] = struct.pack('<I', 0)
os.makedirs(out, exist_ok=True)
for i, name in enumerate(['px', 'nx', 'py', 'ny', 'pz', 'nz']):
    off = head + i * per
    im = Image.open(io.BytesIO(bytes(hdr) + d[off:off + face])).convert('RGB')
    a = np.asarray(im).astype(np.float32) / 255
    a = np.clip(a * 2.4, 0, 1) ** (1 / 1.3)
    im = Image.fromarray((a * 255 + 0.5).astype(np.uint8))
    if im.size[0] != size:
        im = im.resize((size, size), Image.LANCZOS)
    im.save(os.path.join(out, name + '.webp'), quality=82, method=6)
print('ok', src, '->', out)
