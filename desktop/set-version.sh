#!/usr/bin/env bash
# 发版版本号：标签 desktop-v1.2.3 取 1.2.3，否则用 tauri.conf.json 里的；写回 tauri.conf.json 与 Cargo.toml，并输出给后续步骤
set -euo pipefail
conf=desktop/src-tauri/tauri.conf.json
v=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$conf")
if [ "${GITHUB_REF_TYPE:-}" = tag ]; then v=${GITHUB_REF_NAME#desktop-v}; fi
sed -i.bak "s/^  \"version\": \"[^\"]*\"/  \"version\": \"$v\"/" "$conf"
sed -i.bak "0,/^version = \"[^\"]*\"/s//version = \"$v\"/" desktop/src-tauri/Cargo.toml
rm -f "$conf.bak" desktop/src-tauri/Cargo.toml.bak
echo "version=$v" >> "${GITHUB_OUTPUT:-/dev/null}"
echo "version $v"
