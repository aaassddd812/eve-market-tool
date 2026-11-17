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

# 第二步：顺着引用链核对线上文件内容。首页版本号一致不代表子模块都部署了——
#   2026-11-17 只拷了最新一次提交改的文件，sim-3d.js 引入的 sim-stars.js 等上一批模块线上没有（404），
#   驾驶模拟一直「3D 画面加载失败」，第一步却全部通过。
#   从 index-v2.html 出发，跟着文件里写死的 'x.js?v=N' / import('./x.js?v=N') 往下找（变量拼出来的地址跟不到），
#   每个文件按引用时的完整地址到线上取一次，去掉 \r 后和仓库比。
refs() {  # $1 = 站点根下的相对路径；输出它引用的 js / css（"相对路径 完整地址"）
  local dir r p
  dir=$(dirname "$1")
  grep -oE "[\"'\`](\./|\.\./|/)?[A-Za-z0-9_./-]+\.(js|css)(\?v=[A-Za-z0-9_-]+)?[\"'\`]" "$1" | tr -d "\"'\`" |
  while read -r r; do
    p=${r%%\?*}
    case "$p" in /*) p=${p#/} ;; *) p=$(realpath -m --relative-to=. "$dir/$p") ;; esac
    [ -f "$p" ] && echo "$p ${p}${r#"${r%%\?*}"}"
  done
}
declare -A seen=()
queue=("index-v2.html")
bad=0; n=0
while [ ${#queue[@]} -gt 0 ]; do
  cur=${queue[0]}; queue=("${queue[@]:1}")
  while read -r p url; do
    [ -n "${seen[$url]:-}" ] && continue
    seen[$url]=1; n=$((n + 1))
    code=$(curl -s --max-time 30 -o "$tmp/f" -w '%{http_code}' "$BASE/$url" || true)
    if [ "$code" != 200 ]; then
      echo "✗ 线上缺：$url（HTTP $code，引用自 $cur）"; bad=1
    elif ! cmp -s <(tr -d '\r' <"$tmp/f") <(tr -d '\r' <"$p"); then
      echo "✗ 线上是旧内容：$url（引用自 $cur）"; bad=1
    fi
    queue+=("$p")
  done < <(refs "$cur" | sort -u)
done
if [ "$bad" = 1 ]; then
  echo "引用链上有文件没部署或不是最新（共查 $n 个）。补齐后注意：js / css 连 404 也按一年缓存，打开过的浏览器要换 ?v= 才会重新取。"
  exit 1
fi
echo "✓ 引用链上的 $n 个 js / css 线上内容与仓库一致"
