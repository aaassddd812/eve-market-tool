# 从游戏客户端的默认总览数据（old_default.py 里的 OLD_DEFAULT YAML 字符串）生成驾驶模拟用的 overview-default.json
# 只用 ast 取字面量，不执行源文件。用法：python3 -I tools/ui-assets/overview.py <old_default.py> assets/eveui/overview-default.json
# 数据版权归 CCP，仅供本站驾驶模拟画面使用。
import ast
import json
import sys

import yaml

src = open(sys.argv[1], encoding='utf-8').read()
text = None
for node in ast.parse(src).body:
    if isinstance(node, ast.Assign) and any(getattr(t, 'id', '') == 'OLD_DEFAULT' for t in node.targets):
        text = ast.literal_eval(node.value)
data = yaml.safe_load(text)

presets = {}
for name, opts in data['presets']:
    o = dict((k, v) for k, v in opts)
    presets[name] = sorted(o.get('groups') or [])
out = {
    'presets': presets,
    'columns': data['overviewColumns'],
    'columnOrder': data['columnOrder'],
    'tabs': [dict((k, v) for k, v in t[1]) for t in data['tabSetup']],
}
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
print({k: len(v) for k, v in presets.items()})
