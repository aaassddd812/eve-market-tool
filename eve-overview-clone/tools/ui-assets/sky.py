"""游戏星空 → WebP。fetch.mjs --sky 调用（需要 Pillow、numpy）。

用法：
  python3 sky.py nebula <bc6h.mjs 输出的浮点文件> <输出目录> [边长]
      星云立方体（dx9/scene/universe/<名>_cube.dds，BC6H HDR）→ px / nx / py / ny / pz / nz.webp。
      HDR 线性值按原样做 sRGB 编码存成 8 位（星云中位亮度只有 0.01 左右，直接存 8 位线性值暗部只剩几级、会出色带），
      不另外提亮；场景的 nebulaIntensity 在着色器里乘（客户端 background.fx 的做法）。
  python3 sky.py refl <dds> <输出目录>
      反射立方体（<名>_cube_refl.dds，DXT3，128 像素）→ refl/{px..nz}.webp（无损 RGBA）。
      RGB 是船体反射用的环境贴图（客户端 EveSpaceSceneEnvMap），A 是背景着色器分配三层星点用的 AlphaMap。
  python3 sky.py stars <dds> <输出文件>
      星点平铺图（dx9/scene/starfield/stars01_tile2.dds）→ 一张 WebP。
"""
import io
import os
import struct
import sys

import numpy as np
from PIL import Image

FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz']   # DDS 立方体的面顺序，three.js CubeTextureLoader 直接用


def srgb(a):
    a = np.clip(a, 0, 1)
    return np.where(a < 0.0031308, a * 12.92, 1.055 * np.power(a, 1 / 2.4) - 0.055)


def nebula(src, out, size):
    d = open(src, 'rb').read()
    w = struct.unpack_from('<I', d, 0)[0]
    n = w * w * 4
    os.makedirs(out, exist_ok=True)
    for i, name in enumerate(FACES):
        a = np.frombuffer(d, dtype=np.float32, count=n, offset=4 + i * n * 4).reshape(w, w, 4)[:, :, :3]
        a = np.maximum(a, 0)
        if w != size:   # 在线性空间缩小
            a = np.stack([np.asarray(Image.fromarray(np.ascontiguousarray(a[:, :, c])).resize((size, size), Image.LANCZOS)) for c in range(3)], -1)
        im = Image.fromarray((srgb(a) * 255 + 0.5).astype(np.uint8))
        im.save(os.path.join(out, name + '.webp'), quality=90, method=6)


def cube_faces(src):
    """非 DX10 头的立方体 DDS（DXT1/3/5 或未压缩）→ 6 张最大一层 mip 的 PIL 图。"""
    d = open(src, 'rb').read()
    assert d[:4] == b'DDS ', 'not a DDS file'
    h, w = struct.unpack('<2I', d[12:20])
    mips = max(1, struct.unpack('<I', d[28:32])[0])
    four = d[84:88]
    bits = struct.unpack('<I', d[88:92])[0]
    if four in (b'DXT1',):
        size_of = lambda mw, mh: max(1, (mw + 3) // 4) * max(1, (mh + 3) // 4) * 8
    elif four in (b'DXT3', b'DXT5'):
        size_of = lambda mw, mh: max(1, (mw + 3) // 4) * max(1, (mh + 3) // 4) * 16
    else:
        size_of = lambda mw, mh: mw * mh * bits // 8
    per = 0
    mw, mh = w, h
    for _ in range(mips):
        per += size_of(mw, mh)
        mw, mh = max(1, mw // 2), max(1, mh // 2)
    hdr = bytearray(d[:128])
    hdr[28:32] = struct.pack('<I', 1)   # 只取最大一层
    hdr[108:116] = struct.pack('<II', 0x1000, 0)   # 去掉立方体标记
    return [Image.open(io.BytesIO(bytes(hdr) + d[128 + i * per:128 + i * per + size_of(w, h)])) for i in range(6)]


def refl(src, out):
    os.makedirs(out, exist_ok=True)
    for name, im in zip(FACES, cube_faces(src)):
        im.convert('RGBA').save(os.path.join(out, name + '.webp'), lossless=True, method=6)


def stars(src, out):
    im = Image.open(src)
    im.load()
    im.convert('RGB').save(out, quality=92, method=6)


if __name__ == '__main__':
    kind = sys.argv[1]
    if kind == 'nebula':
        nebula(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 1024)
    elif kind == 'refl':
        refl(sys.argv[2], sys.argv[3])
    elif kind == 'stars':
        stars(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit('unknown kind ' + kind)
    print('ok', kind, sys.argv[2])
