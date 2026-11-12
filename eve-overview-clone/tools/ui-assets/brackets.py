"""太空 / 总览图标对照表：客户端 staticdata/brackets*.static（FSD 二进制，头部带 pickle 形式的 schema）→ brackets.json。
fetch.mjs 调用。客户端 bracketMgr.GetBracketIcon 的查法：先按 typeID，没有再按 groupID，再按 categoryID → bracketID → texturePath。

用法：python3 -I brackets.py <目录（brackets / bracketsbytype / bracketsbygroup / bracketsbycategory .static，已解压）> <输出 json>
只读：schema 用受限 Unpickler 读（只放行 OrderedDict，不构造其他对象），数据按 schema 的布局解析。
"""
import collections
import io
import json
import os
import pickle
import struct
import sys


class Safe(pickle.Unpickler):
    def find_class(self, module, name):
        if (module, name) == ('collections', 'OrderedDict'):
            return collections.OrderedDict
        raise pickle.UnpicklingError(f'blocked {module}.{name}')


def entries(path):
    """FSD 字典：u32 数据长度 | 值… | 页脚（u32 个数 + (key, offset, size)×n）| u32 页脚长度"""
    b = open(path, 'rb').read()
    n = struct.unpack_from('<I', b, 0)[0]
    schema = Safe(io.BytesIO(b[4:4 + n]), encoding='latin1').load()
    body = b[4 + n + 4:4 + n + 4 + struct.unpack_from('<I', b, 4 + n)[0]]
    fs = struct.unpack_from('<I', body, len(body) - 4)[0]
    foot = body[len(body) - 4 - fs:len(body) - 4]
    cnt = struct.unpack_from('<I', foot, 0)[0]
    for i in range(cnt):
        k, o, sz = struct.unpack_from('<iii', foot, 4 + 12 * i)
        yield schema, k, body[o:o + sz]


def strings(v):
    """brackets 的对象：u32 可选位 | u32 | 各变长属性偏移（name、texturePath + 每个出现的可选属性）| 字符串（u32 长度 + 字节）…"""
    bits = struct.unpack_from('<I', v, 0)[0]
    p = 8 + 4 * (2 + bin(bits).count('1'))
    out = []
    for _ in range(2):
        n = struct.unpack_from('<I', v, p)[0]
        out.append(v[p + 4:p + 4 + n].decode('utf-8'))
        p += 4 + n
    return out


src, dst = sys.argv[1], sys.argv[2]
icon = {}
for _, k, v in entries(os.path.join(src, 'brackets.static')):
    name, tex = strings(v)
    icon[k] = tex.lower().replace('res:/ui/texture/', '').replace('res:/', '')   # 相对 res:/ui/texture/ 的路径（下载到 assets/eveui/ 下同一路径）
maps = {}
for key in ('type', 'group', 'category'):
    maps[key] = {k: struct.unpack('<i', v[:4])[0] for _, k, v in entries(os.path.join(src, f'brackets{"by" + key}.static'))}
json.dump({'icon': icon, **maps}, open(dst, 'w'), separators=(',', ':'))
print('brackets', len(icon), {k: len(v) for k, v in maps.items()})
