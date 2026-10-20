#!/usr/bin/env python3
"""打包教程 Wiki：python3 build_guides.py <文章目录>

文章目录里每篇一个 <id>.json（块结构）：
  - EVE University 译文 / EVE Academy 视频字幕：逐块对齐的 en + zh
  - 中文原文（新伊甸学院、BWIKI、萌娘百科、本站摘要）：lang = "zh"，只有 zh
  - 整理字段：cat 分类、group 小组、desc 摘要、src 来源（nea / bw / moe / uni / site）
输出到 eve-overview-clone/guides/<id>.json（压缩，去掉整理字段），并生成 guides/index.json：
  {id: {zh, en: 英文标题（译文才有）, c, g, s, m: 阅读分钟, d}}；视频字幕为 {zh, en, dur: 秒}
"""
import json, os, re, sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'eve-overview-clone', 'guides')
CJK = re.compile(r'[一-鿿]')
PROMO = re.compile(r'EVE University offers|EVE ?(?:University|大学) ?提供')


def strs(v):
    if isinstance(v, str): return [v]
    if v and isinstance(v[0], list): return [c for r in v for c in r]
    return list(v or [])


def minutes(blocks):
    """中文约每分钟 500 字"""
    text = ''.join(re.sub(r'<[^>]+>', '', s) for b in blocks if b['t'] != 'img' for s in strs(b.get('zh', b.get('en'))))
    return max(1, round(len(CJK.findall(text)) / 500 + len(re.findall(r'[A-Za-z]+', text)) / 250))


def main(src):
    os.makedirs(OUT, exist_ok=True)
    for name in os.listdir(OUT):
        if name.endswith('.json'): os.remove(os.path.join(OUT, name))
    index = {}
    for name in sorted(os.listdir(src)):
        if not name.endswith('.json'): continue
        doc = json.load(open(os.path.join(src, name), encoding='utf-8'))
        # 去掉原站「EVE University offers classes on:」课程推广框（含 BWIKI 译文版本；课程列表是站内组件，抽取不到）
        blocks = doc['blocks'] = [b for b in doc['blocks'] if not (b['t'] == 'table' and PROMO.search(json.dumps(b.get('en') or b.get('zh'), ensure_ascii=False)))]
        if doc.get('lang') != 'zh':
            missing = sum(1 for b in blocks if 'zh' not in b)
            if missing: print(f'  {name}: {missing} 块没有译文，阅读时显示英文')
        info = {'zh': doc['title'].get('zh') or doc['title']['en']}
        if doc.get('yt'):
            info.update(en=doc['title']['en'], dur=round(blocks[-1]['e']) if blocks else 0)
        else:
            if doc.get('lang') != 'zh': info['en'] = doc['title']['en']
            info.update(c=doc['cat'], s=doc['src'], m=minutes(blocks))
            if doc.get('group'): info['g'] = doc['group']
            if doc.get('desc'): info['d'] = doc['desc']
        for k in ('cat', 'group', 'desc', 'src'): doc.pop(k, None)
        if not doc.get('note'): doc.pop('note', None)
        json.dump(doc, open(os.path.join(OUT, doc['id'] + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
        index[doc['id']] = info
    json.dump(index, open(os.path.join(OUT, 'index.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print(f'{len(index)} 篇 → {OUT}')


if __name__ == '__main__':
    if len(sys.argv) != 2: sys.exit(__doc__)
    main(sys.argv[1])
