"""游戏星空 → WebP。fetch.mjs --sky 调用（需要 Pillow、numpy）。

用法：
  python3 sky.py nebula <bc6h.mjs 输出的浮点文件> <输出目录> [边长]
      星云立方体（dx9/scene/universe/<名>_cube.dds，BC6H HDR）→ px / nx / py / ny / pz / nz.webp。
      HDR 线性值按原样做 sRGB 编码存成 8 位（星云中位亮度只有 0.01 左右，直接存 8 位线性值暗部只剩几级、会出色带），
      不另外提亮；场景的 nebulaIntensity 在着色器里乘（客户端 background.fx 的做法）。
      同时存一份 AVIF（4:4:4，质量 90）：星云很暗（8 位里中位数只有 12 左右），有损 WebP 在暗部压出 8×8 的方块，
      开了自动曝光一提亮就很明显；AVIF 体积差不多、没有块边界。网页先用 AVIF，加载失败（旧版 Safari）再用 WebP。
  python3 sky.py nebula-avif <bc6h.mjs 输出的浮点文件> <输出目录> [边长]
      只补 AVIF（已有 WebP 的星空升级用）。
  python3 sky.py refl <dds> <输出目录>
      反射立方体（<名>_cube_refl.dds，DXT3，128 像素）→ refl/{px..nz}.webp（无损 RGBA）。
      RGB 是船体反射用的环境贴图（客户端 EveSpaceSceneEnvMap），A 是背景着色器分配三层星点用的 AlphaMap。
  python3 sky.py stars <dds> <输出文件>
      星点平铺图（dx9/scene/starfield/stars01_tile2.dds）→ 一张 WebP（最大一层），
      另把 DDS 自带的其余各层 mip（1024² … 1²）从左到右排成一张无损 WebP（<输出文件名>-mips.webp，2048×1024）。
      客户端用的就是这些 mip（各向异性采样，屏幕上一般落在第 2 层左右）；它们比按线性空间缩小的暗得多，
      让浏览器自己生成 mip 星点会偏亮、偏多。
  python3 sky.py tex <dds> <输出.png>
      一张普通贴图（最大一层 mip）原样转成 RGBA PNG（镜头周围尘埃的 whiteglobe.dds 等）。
  python3 sky.py starfield <staratlas.dds> <starcolors.dds> <输出目录>
      近处闪烁星精灵（EveStarfield）的图集和调色板 → staratlas.png、starcolors.png。
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


def nebula(src, out, size, webp=True):
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
        if webp:
            im.save(os.path.join(out, name + '.webp'), quality=90, method=6)
        im.save(os.path.join(out, name + '.avif'), quality=90, subsampling='4:4:4', speed=4)


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
    d = open(src, 'rb').read()
    h, w = struct.unpack_from('<2I', d, 12)
    mips = max(1, struct.unpack_from('<I', d, 28)[0])
    bits, rm, gm, bm = struct.unpack_from('<4I', d, 88)
    assert d[84:88] == b'\0\0\0\0' and bits in (24, 32) and w == h, '星点平铺图不是未压缩的正方形 RGB'
    bpp = bits // 8
    byte = lambda m: ((m & -m).bit_length() - 1) // 8
    atlas = np.zeros((w // 2, w, 3), np.uint8)
    o, s, x = 128 + w * h * bpp, w // 2, 0
    for _ in range(1, mips):
        px = np.frombuffer(d, dtype=np.uint8, count=s * s * bpp, offset=o).reshape(s, s, bpp)
        atlas[:s, x:x + s] = px[:, :, [byte(rm), byte(gm), byte(bm)]]
        o += s * s * bpp
        x += s
        s //= 2
    Image.fromarray(atlas).save(os.path.splitext(out)[0] + '-mips.webp', lossless=True, method=6)


def starfield(atlas, colors, out):
    """近处闪烁星精灵（EveStarfield，res:/dx9/scene/starfield/spritestars.black）的两张贴图 → PNG（原样，不改像素）。
    staratlas.dds：DX10 头、R8_UNORM（DXGI 61）512²，2×2 图集；只取最大一层 mip。
    starcolors.dds：32×1 未压缩 BGRX（没有 alpha，采样时 a = 1），星点调色板。"""
    os.makedirs(out, exist_ok=True)
    d = open(atlas, 'rb').read()
    assert d[:4] == b'DDS ' and d[84:88] == b'DX10' and struct.unpack_from('<I', d, 128)[0] == 61, 'staratlas 不是 R8_UNORM'
    h, w = struct.unpack_from('<2I', d, 12)
    Image.fromarray(np.frombuffer(d, dtype=np.uint8, count=w * h, offset=148).reshape(h, w)).save(os.path.join(out, 'staratlas.png'))
    d = open(colors, 'rb').read()
    h, w = struct.unpack_from('<2I', d, 12)
    bits, rm, gm, bm = struct.unpack_from('<4I', d, 88)
    assert d[84:88] == b'\0\0\0\0' and bits == 32 and (rm, gm, bm) == (0xff0000, 0xff00, 0xff), 'starcolors 不是 32 位 BGRX'
    px = np.frombuffer(d, dtype=np.uint8, count=w * h * 4, offset=128).reshape(h, w, 4)
    Image.fromarray(np.ascontiguousarray(px[:, :, [2, 1, 0]])).save(os.path.join(out, 'starcolors.png'))


if __name__ == '__main__':
    kind = sys.argv[1]
    if kind in ('nebula', 'nebula-avif'):
        nebula(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 1024, webp=kind == 'nebula')
    elif kind == 'refl':
        refl(sys.argv[2], sys.argv[3])
    elif kind == 'stars':
        stars(sys.argv[2], sys.argv[3])
    elif kind == 'tex':
        im = Image.open(sys.argv[2])
        im.load()
        im.convert('RGBA').save(sys.argv[3])
    elif kind == 'starfield':
        starfield(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit('unknown kind ' + kind)
    print('ok', kind, sys.argv[2])
