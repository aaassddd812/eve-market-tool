#!/usr/bin/env bash
# 检查线上首页与 index-v2.html 是否引用同一批代码版本。
# 背景：nginx 首页 / 用的是 index.html，部署时如果只更新了 index-v2.html、
#   忘了复制成 index.html，首页会一直加载旧代码（JS 按 ?v= 长期缓存）。
# 比对三处 index-v2.html 引用的 ?v= 版本号：线上 /（index.html）、线上 /index-v2.html、仓库版。
# 用法：bash server/check-live.sh [线上地址，默认 https://eve.navexor.top]
set -euo pipefail
cd "$(dirname "$0")/.."
BASE=${1:-https://eve.navexor.top}

versions() {  # 从 HTML 内容里抽出 带版本号的 js/css 引用，排序去重
  grep -oE '[a-zA-Z0-9_-]+\.(js|css)\?v=[a-zA-Z0-9_-]+' | sort -u
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --max-time 30 "$BASE/" >"$tmp/live_index.html"
curl -fsSL --max-time 30 "$BASE/index-v2.html" >"$tmp/live_v2.html"

ok=1
[ "$(versions <"$tmp/live_index.html")" = "$(versions <"$tmp/live_v2.html")" ] \
  || { echo "✗ 线上 / 与 /index-v2.html 版本不一致——部署时忘了把 index-v2.html 复制成 index.html？"; ok=0; }
[ "$(versions <"$tmp/live_v2.html")" = "$(versions <index-v2.html)" ] \
  || { echo "✗ 线上 /index-v2.html 与仓库版不一致——这次改动还没部署。"; ok=0; }

if [ "$ok" = 1 ]; then
  echo "✓ 线上首页、index-v2.html 与仓库版本号全部一致："
  versions <index-v2.html
else
  echo
  echo "--- 线上 / 引用 ---";   versions <"$tmp/live_index.html"
  echo "--- 线上 v2 引用 ---"; versions <"$tmp/live_v2.html"
  echo "--- 仓库版引用 ---";   versions <index-v2.html
  exit 1
fi
