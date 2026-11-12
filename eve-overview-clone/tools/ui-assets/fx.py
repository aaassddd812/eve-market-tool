"""游戏武器 / 爆炸特效贴图（texture/fx/ 下的 DDS）→ 驾驶模拟用的灰度贴图。fetch.mjs --fx 调用。

用法：python3 fx.py <DDS 目录（glow / flare / ring / burst / explosion / beam .dds）> <输出目录>
输出（都是亮度 = 颜色亮度 × 不透明度，着色器里按特效颜色上色、叠加混合）：
  sprites.webp   4 格 × 256：柔光、星芒、光束喷口（outburst）、光环
  explosion.webp 爆炸序列 9 × 9 帧（explosion_08a）
  beam.webp      光束横截面（beam_wide_01b，横向是光束宽度方向）
  turret.webp    炮塔弹道的流动噪声 6 格 × 128（射弹 projectileautofx / 光束激光 laserbeamfx / 疾速 hybridblastfx /
                 脉冲激光 laserpulsefx / 磁轨 hybridrailfx / 火炮 projectileartilleryfx），
                 保留原图 RGB 三个通道（游戏里三个通道各是一层噪声，着色器里分别沿弹道滚动）
  shield.webp    护盾受击的格纹（3dfx_shield_generic_01a，红绿通道里的亮线）
  ramp.png       死亡爆炸色带（deathexplosion_01a）：横向 = 冷却程度，纵向 = 时间
  fire.webp      火团（fireshape_01a）
"""
import os
import sys

import numpy as np
from PIL import Image

src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)


def lum(name, size=None):
    im = Image.open(os.path.join(src, name + '.dds')).convert('RGBA')
    if size and im.size != size:
        im = im.resize(size, Image.LANCZOS)
    a = np.asarray(im).astype(np.float32) / 255
    rgb = a[..., :3].max(axis=2)
    alpha = a[..., 3]
    # 有的贴图 alpha 全白（亮度就在颜色里），有的颜色全白（形状在 alpha 里）
    v = rgb * alpha
    return Image.fromarray((np.clip(v, 0, 1) * 255 + 0.5).astype(np.uint8), 'L')


T = 256
sheet = Image.new('L', (T * 4, T))
# 去掉底色、边缘淡出到 0（有的贴图底色不是纯黑，拼在一起会看到方框）
yy, xx = np.mgrid[0:T, 0:T]
r = np.hypot(xx - T / 2 + 0.5, yy - T / 2 + 0.5) / (T / 2)
edge = np.clip((1 - r) / 0.12, 0, 1)
for i, name in enumerate(['glow', 'flare', 'burst', 'ring']):
    v = np.asarray(lum(name, (T, T))).astype(np.float32)
    v = np.clip(v - np.percentile(v[r > 0.95], 50), 0, 255) * (edge if name != 'burst' else 1)
    sheet.paste(Image.fromarray((v + 0.5).astype(np.uint8), 'L'), (i * T, 0))
sheet.save(os.path.join(out, 'sprites.webp'), quality=90, method=6)
lum('explosion').save(os.path.join(out, 'explosion.webp'), quality=88, method=6)
lum('beam', (64, 8)).save(os.path.join(out, 'beam.webp'), lossless=True)


def rgba(name, size=None):
    im = Image.open(os.path.join(src, name + '.dds')).convert('RGBA')
    return im.resize(size, Image.LANCZOS) if size and im.size != size else im


TUR = ['tproj', 'tlaser', 'thybrid', 'tpulse', 'trail', 'tarty']
tur = Image.new('RGB', (128 * len(TUR), 128))
for i, name in enumerate(TUR):
    tur.paste(rgba(name, (128, 128)).convert('RGB'), (i * 128, 0))
tur.save(os.path.join(out, 'turret.webp'), quality=92, method=6)
sh = np.asarray(rgba('shield', (128, 128))).astype(np.float32) / 255
shv = sh[..., :2].max(axis=2)
shv = np.clip((shv - np.percentile(shv, 5)) / (shv.max() - np.percentile(shv, 5)), 0, 1)   # 去掉底色，只留格线
Image.fromarray((shv * 255 + 0.5).astype(np.uint8), 'L').save(os.path.join(out, 'shield.webp'), quality=92, method=6)
rgba('ramp', (64, 64)).convert('RGB').save(os.path.join(out, 'ramp.png'), optimize=True)
lum('fire', (256, 256)).save(os.path.join(out, 'fire.webp'), quality=88, method=6)
print('ok fx ->', out)
