#!/bin/bash
# 站点数据定时更新（systemd：eve-data@tq.timer 每天北京时间 20:00，eve-data@cn.timer 每天 12:00）
#   data_update.sh tq  宁静：CCP 发布了新的 SDE 才重建（物品目录、装配、制造、星图、NPC、LP 商店等），没有新版直接退出；
#                      重建后国服数据也跟着重算（cn-extra 只收宁静没有的条目）
#   data_update.sh cn  晨曦 / 曙光：网易 ESI 的独有舰船、装备、技能（cn-extra-<服>.json）与 LP 商店
#   FORCE=1            宁静没有新 SDE 也重建
# 构建在专用的仓库克隆里进行（每次先还原再拉最新脚本），全部成功后只把内容变了的文件替换进站点目录；
# 任何一步失败就不动站点。前端每次加载都会向服务器确认数据文件有没有新版（js/i18n.js），不用改版本号。
# 路径可用环境变量改：SITE 站点静态目录，WORK 工作目录（仓库克隆、SDE、缓存）
set -euo pipefail
{   # 整段先读完再执行：下面会拉取新版脚本，替换掉正在运行的这个文件也不影响本次
MODE=${1:?用法: data_update.sh tq|cn}
SITE=${SITE:-/opt/eve/dist}
WORK=${WORK:-/opt/eve/data-update}
REPO=$WORK/repo
SRC=$REPO/eve-overview-clone
SDE=$WORK/sde
REPO_URL=${REPO_URL:-git@github.com:wbw5780/eve-market-tool.git}
log() { echo "[$(date '+%F %T')] $*"; }

mkdir -p "$WORK"
exec 9>"$WORK/.lock"
flock -n 9 || { log "上一次更新还没结束，跳过"; exit 0; }

# 仓库克隆：构建会改动里面的数据文件，先还原再拉最新脚本（拉取失败就用现有脚本）
if [ ! -d "$REPO/.git" ]; then git clone -q "$REPO_URL" "$REPO"; fi
git -C "$REPO" reset -q --hard
git -C "$REPO" clean -qfd -e .cn-cache
git -C "$REPO" pull -q --ff-only || log "拉取脚本失败，用现有版本"

# 站点里内容变了的文件才替换（只差生成时间 generatedAt 不算；先复制成临时文件再改名，正在读的请求不会读到一半）
UPDATED=()
same() {
  cmp -s "$1" "$2" && return 0
  [ -f "$2" ] || return 1
  python3 -c 'import json,sys
a,b=(json.load(open(f)) for f in sys.argv[1:])
for x in (a,b):
    if isinstance(x,dict): x.pop("generatedAt",None)
sys.exit(a!=b)' "$1" "$2"
}
deploy() {
  local rel
  for rel in "$@"; do
    [ -f "$SRC/$rel" ] || { log "缺少 $rel"; exit 1; }
    if ! same "$SRC/$rel" "$SITE/$rel"; then
      cp "$SRC/$rel" "$SITE/$rel.tmp" && chmod 644 "$SITE/$rel.tmp" && mv -f "$SITE/$rel.tmp" "$SITE/$rel"
      UPDATED+=("$rel")
    fi
  done
}

# 国服：独有物品直接写站点目录（build_cn_extra.py 自己只在变了时写），LP 商店在克隆里生成再替换
update_cn() {
  python3 "$SRC/server/build_cn_extra.py" "$SDE" --root "$SITE" --cache "$WORK/cn-cache" --refresh-hours 20
  (cd "$REPO" && node build_lp.mjs "$SDE" --serenity && node build_lp.mjs "$SDE" --infinity)
  deploy lp-data-serenity.json lp-data-infinity.json
}

if [ "$MODE" = tq ]; then
  latest=$(curl -fsS -m 60 https://developers.eveonline.com/static-data/tranquility/latest.jsonl | python3 -c 'import json,sys; print(json.load(sys.stdin)["buildNumber"])')
  current=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["buildNumber"])' "$SDE/_sde.jsonl" 2>/dev/null || echo 0)
  if [ "$latest" = "$current" ] && [ -z "${FORCE:-}" ]; then log "宁静 SDE 没有新版（$current）"; exit 0; fi
  if [ "$latest" != "$current" ]; then
    log "下载 SDE $latest（当前 $current）"
    rm -rf "$WORK/sde-new" && mkdir -p "$WORK/sde-new"
    curl -fsSL -m 1800 -o "$WORK/sde-new/sde.zip" "https://developers.eveonline.com/static-data/tranquility/eve-online-static-data-$latest-jsonl.zip"
    python3 -m zipfile -e "$WORK/sde-new/sde.zip" "$WORK/sde-new/"
    rm -rf "$WORK/sde-old"; [ -d "$SDE" ] && mv "$SDE" "$WORK/sde-old"
    mv "$WORK/sde-new" "$SDE"
  fi
  cd "$REPO"
  for s in build_map build_npc_names build_npc build_npc_bp build_pi build_reprocess build_sov build_volumes \
           build_ind_rigs build_dogma_names build_industry build_mutaplasmids build_wormholes build_lp; do
    log "$s"; node "$s.mjs" "$SDE" > /dev/null
  done
  log build_fit_data; python3 "$SRC/server/build_fit_data.py" "$SDE/sde.zip" "$SRC/fit-data.json"
  log build_fit_info; python3 "$SRC/server/build_fit_info.py" "$SDE/sde.zip" "$SRC/fit-data.json" "$SRC/fit-info.json"
  # 物品目录（ESI 市场分组 + 中文名）：在临时目录里跑（脚本写 ./dist/），中文名缓存用站点现有的
  log build_catalog
  rm -rf "$WORK/catalog" && mkdir -p "$WORK/catalog/dist"
  cp "$SITE/type-names-zh.json" "$WORK/catalog/dist/" 2>/dev/null || true
  (cd "$WORK/catalog" && node "$REPO/build_catalog.mjs" > /dev/null)
  cp "$WORK/catalog/dist/catalog.json" "$WORK/catalog/dist/type-names-zh.json" "$SRC/"
  # 英文名对照表要并入国服独有物品的英文名：用站点上最新的那份
  cp "$SITE/i18n/names-en-cn.json" "$SRC/i18n/" 2>/dev/null || true
  log build_names_en; python3 build_names_en.py "$SDE" > /dev/null
  deploy map-data.json npc-names-zh.json npc-data.json npc-corp-faction.json npc-bp.json pi-data.json reprocess-data.json \
         sov-data.json type-volume.json ind-rigs.json dogma-attr-zh.json industry-data.json skill-data.json mutaplasmid-data.json \
         wh-data.json lp-data.json fit-data.json fit-info.json catalog.json type-names-zh.json i18n/names-en.json
  rm -rf "$WORK/sde-old"
  log "国服数据按新的宁静数据重算"
  update_cn
else
  update_cn
fi
if [ ${#UPDATED[@]} -gt 0 ]; then log "已替换：${UPDATED[*]}"; else log "其他数据文件没有变化"; fi
exit 0
}
