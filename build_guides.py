#!/usr/bin/env python3
"""打包教程译文：python3 build_guides.py <译文目录>

译文目录里每篇一个 <id>.json（EVE University 文章或 EVE Academy 视频字幕，逐块对齐的中英文），
输出到 eve-overview-clone/guides/<id>.json（压缩），并生成 guides/index.json：{id: {zh, en, w: 英文词数, dur: 视频秒数}}。
"""
import json, os, re, sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'eve-overview-clone', 'guides')


def words(v):
    if isinstance(v, str): s = v
    elif v and isinstance(v[0], list): s = ' '.join(' '.join(r) for r in v)
    else: s = ' '.join(v)
    return len(re.sub(r'<[^>]+>', ' ', s).split())


def main(src):
    os.makedirs(OUT, exist_ok=True)
    index = {}
    for name in sorted(os.listdir(src)):
        if not name.endswith('.json'): continue
        doc = json.load(open(os.path.join(src, name), encoding='utf-8'))
        # 去掉原站「EVE University offers classes on:」推广框（课程列表是站内组件，抽取不到）
        blocks = doc['blocks'] = [b for b in doc['blocks'] if not (b['t'] == 'table' and 'EVE University offers' in json.dumps(b['en']))]
        missing = sum(1 for b in blocks if 'zh' not in b)
        if missing: print(f'  {name}: {missing} 块没有译文，阅读时显示英文')
        json.dump(doc, open(os.path.join(OUT, doc['id'] + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
        info = {'zh': doc['title'].get('zh', doc['title']['en']), 'en': doc['title']['en'], 'w': sum(words(b['en']) for b in blocks if b['t'] != 'img')}
        if doc.get('yt') and blocks: info['dur'] = round(blocks[-1]['e'])
        index[doc['id']] = info
    json.dump(index, open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f'{len(index)} 篇 → {OUT}')


if __name__ == '__main__':
    if len(sys.argv) != 2: sys.exit(__doc__)
    main(sys.argv[1])
