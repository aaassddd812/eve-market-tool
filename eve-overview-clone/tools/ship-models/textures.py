"""DDS（BC4/BC5/BC7）→ WebP。convert.mjs 通过 stdin 传入任务列表（JSON 数组）。

每个任务：{"out": 输出路径, "kind": "a"|"n"|"x", "src": {...本地 dds 路径}, "max": 最大边长}
  a：反照率 RGB（有损）
  n：法线 RG（有损，高质量）
  x：打包 R=粗糙度 G=材质遮罩 B=发光 A=灰尘（无损，材质遮罩不能糊）
"""
import json
import sys

from PIL import Image


def load(path, size=None):
    if not path:
        return None
    im = Image.open(path)
    im.load()
    return im


def fit(im, mx):
    w, h = im.size
    s = max(w, h)
    if s <= mx:
        return im
    k = mx / s
    return im.resize((max(1, round(w * k)), max(1, round(h * k))), Image.LANCZOS)


def channel(path, size, fill):
    im = load(path)
    if im is None:
        return Image.new('L', size, fill)
    im = im.getchannel(0) if im.mode != 'L' else im
    return im if im.size == size else im.resize(size, Image.LANCZOS)


def run(job):
    src, mx, kind = job['src'], job.get('max', 2048), job['kind']
    if kind == 'a':
        im = fit(load(src['a']).convert('RGB'), mx)
        im.save(job['out'], 'WEBP', quality=90, method=6)
    elif kind == 'n':
        im = fit(load(src['n']).convert('RGB'), mx)
        r, g, _ = im.split()
        Image.merge('RGB', (r, g, Image.new('L', im.size, 255))).save(job['out'], 'WEBP', quality=95, method=6)
    else:
        base = next((load(src[k]) for k in ('m', 'r', 'g', 'd') if src.get(k)), None)
        size = fit(base, mx).size if base else (4, 4)
        bands = [channel(src.get('r'), size, 128), channel(src.get('m'), size, 0),
                 channel(src.get('g'), size, 0), channel(src.get('d'), size, 0)]
        Image.merge('RGBA', bands).save(job['out'], 'WEBP', lossless=True, method=4)


def main():
    jobs = json.load(sys.stdin)
    bad = 0
    for job in jobs:
        try:
            run(job)
        except Exception as e:  # 单张失败不影响整批
            bad += 1
            print('texture fail', job['out'], e, file=sys.stderr)
    print(json.dumps({'ok': len(jobs) - bad, 'bad': bad}))


if __name__ == '__main__':
    main()
