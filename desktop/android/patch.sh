#!/usr/bin/env bash
# 安卓工程补丁：在 `cargo tauri android init` 与 `cargo tauri icon` 之后运行（工作目录 desktop/）
#   1. MainActivity 换成避开状态栏 / 导航栏的版本（MainActivity.kt）
#   2. 自适应图标换成矢量版：背景铺满、图案缩在安全区里（tauri icon 直接拿整张图标当前景，手机上会被放大裁掉一圈）
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
main=src-tauri/gen/android/app/src/main
act=$(find "$main/java" -name MainActivity.kt | head -1)
pkg=$(sed -n 's/^package[[:space:]]\+\([A-Za-z0-9_.]*\).*/\1/p' "$act" | head -1)
sed "s/__PACKAGE__/$pkg/" "$here/MainActivity.kt" > "$act"
cp -r "$here/res/." "$main/res/"
echo "patched $act ($pkg) and launcher icons"
