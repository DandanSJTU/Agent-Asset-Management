#!/usr/bin/env bash
# ============================================================
# package-share.sh — 把本项目打成干净、可分享的源码包
#
# 默认排除：node_modules / .git / .workbuddy / 个人数据（local-deploy/data、
# MemoryPanel/data）/ 日志 / pids / 密钥文件 / 内部设计文档（docs/）/ 临时目录。
# 打包后自动做密钥与个人数据扫描，通过才产出 tar.gz。
#
# 默认形态是「无 Docker 一键包」：scripts/dist-assets/ 里的 install.sh、
# start.sh / stop.sh / status.sh、配置模板与安装指南会铺到包顶层，对方解压后
# ./install.sh 即可跑起来。加 --no-native 则只出纯源码包。
#
# 用法：
#   bash scripts/package-share.sh                      # 默认：无 Docker 一键包
#   bash scripts/package-share.sh --no-native          # 纯源码包（不含一键安装脚本）
#   bash scripts/package-share.sh --with-docs          # 含 docs/ 内部设计文档
#   bash scripts/package-share.sh --with-internal-html # 含根目录两份 L0-L3 内部 HTML
#   bash scripts/package-share.sh --with-local-deploy  # 含 local-deploy 脱敏版
#                                                        （剔除 data/logs/pids/plist，
#                                                          密钥替换为 sk-REPLACE_ME）
#   bash scripts/package-share.sh --no-assets          # 不含 assets/ 图片（-32MB，走邮件传时用）
#   bash scripts/package-share.sh -o <outdir>          # 自定义输出目录
#
# 产物：<outdir>/agent-asset-management-src-<时间戳>.tar.gz
#        （顶层目录 agent-asset-management/）
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_NAME="agent-asset-management"

WITH_DOCS=0
WITH_INTERNAL_HTML=0
WITH_LOCAL_DEPLOY=0
NO_ASSETS=0
WITH_NATIVE=1
OUT_DIR="$ROOT/dist-share"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-docs)          WITH_DOCS=1 ;;
    --with-internal-html) WITH_INTERNAL_HTML=1 ;;
    --with-local-deploy)  WITH_LOCAL_DEPLOY=1 ;;
    --no-assets)          NO_ASSETS=1 ;;
    --no-native)          WITH_NATIVE=0 ;;
    -o|--out)             OUT_DIR="${2:?-o 需要目录参数}"; shift ;;
    -h|--help)            sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "[error] 未知参数: $1（-h 看用法）" >&2; exit 1 ;;
  esac
  shift
done

info() { echo "[$(date +%H:%M:%S)] $*"; }
ok()   { echo "[ok] $*"; }
warn() { echo "[warn] $*" >&2; }
die()  { echo "[error] $*" >&2; exit 1; }

# ── 1. 暂存目录 ──────────────────────────────────────────────
TMP_PKG="$(mktemp -d "${TMPDIR:-/tmp}/pkgshare.XXXXXX")"
trap 'rm -rf "$TMP_PKG"' EXIT
STAGE="$TMP_PKG/$PKG_NAME"
mkdir -p "$STAGE"

# ── 2. rsync 拷贝（排除清单）────────────────────────────────
# rsync 规则：不含 "/" 的模式匹配任意层级的同名文件/目录；含 "/" 且以 "/"
# 开头的模式锚定到仓库根。
EXCLUDES=(
  --exclude='.git'
  --exclude='.workbuddy'
  --exclude='.DS_Store'
  --exclude='__pycache__'
  --exclude='*.pyc'
  --exclude='*.log'
  --exclude='node_modules'
  --exclude='dist-share'
  --exclude='.env'
  --exclude='.admin-key'
  --exclude='zzzz'                     # 本地临时分析目录
  --exclude='start-panel-offline.sh'   # 写死本机绝对路径的启动脚本
  --exclude='/MemoryPanel/data'        # 个人 facts 缓存 + 本地 template
  --exclude='/scripts/dist-assets'     # 打包资产：单独铺到包顶层，不留在 scripts/ 下
)

if [[ $WITH_DOCS -eq 0 ]]; then
  EXCLUDES+=( --exclude='docs' )       # 内部设计文档
fi
if [[ $WITH_INTERNAL_HTML -eq 0 ]]; then
  EXCLUDES+=( --exclude='/L0-L3-*.html' --exclude='/L1-L2-L3-*.html' )
fi
if [[ $NO_ASSETS -eq 1 ]]; then
  EXCLUDES+=( --exclude='assets' )
fi
if [[ $WITH_LOCAL_DEPLOY -eq 0 ]]; then
  EXCLUDES+=( --exclude='/local-deploy' )   # 原生部署目录：含密钥与个人数据，默认整体剔除
else
  # 脱敏版 local-deploy：保留脚本与配置模板，剔除数据/日志/进程/plist/演示数据
  EXCLUDES+=(
    --exclude='/local-deploy/data'
    --exclude='/local-deploy/logs'
    --exclude='/local-deploy/pids'
    --exclude='/local-deploy/launchagents'
    --exclude='/local-deploy/*.plist'
    --exclude='/local-deploy/seed-personal-demo.mjs'
    --exclude='/local-deploy/skill-extract-input.json'
    --exclude='/local-deploy/web-dist-placeholder'
  )
fi

info "暂存到 $STAGE ..."
rsync -a "${EXCLUDES[@]}" "$ROOT/" "$STAGE/"

# ── 2b. 铺一键安装资产到包顶层（无 Docker 形态）─────────────
if [[ $WITH_NATIVE -eq 1 ]]; then
  NATIVE_SRC="$ROOT/scripts/dist-assets"
  [[ -d "$NATIVE_SRC" ]] || die "缺少打包资产目录: $NATIVE_SRC"
  info "铺一键安装资产到包顶层 ..."
  rsync -a "$NATIVE_SRC/" "$STAGE/"
  chmod +x "$STAGE/install.sh" "$STAGE/start.sh" "$STAGE/stop.sh" "$STAGE/status.sh"
  for f in install.sh start.sh stop.sh status.sh 安装指南.md; do
    [[ -f "$STAGE/$f" ]] || die "包顶层缺少 $f"
  done
  [[ -d "$STAGE/config-templates" ]] || die "包顶层缺少 config-templates/"
fi

# ── 3. 密钥脱敏（安全网）────────────────────────────────────
SECRET_RE='sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}'
HITS="$(grep -rIlE "$SECRET_RE" "$STAGE" 2>/dev/null || true)"
if [[ -n "$HITS" ]]; then
  warn "以下文件命中疑似密钥，已替换为 sk-REPLACE_ME："
  echo "$HITS" | sed 's/^/       /' >&2
  # BSD sed（macOS）要求 -i 后带备份后缀参数，GNU sed 不用——按实现分流
  if sed --version >/dev/null 2>&1; then SED_INPLACE=(sed -i); else SED_INPLACE=(sed -i ''); fi
  echo "$HITS" | tr '\n' '\0' | xargs -0 "${SED_INPLACE[@]}" "s/$SECRET_RE/sk-REPLACE_ME/g"
fi

# ── 4. 个人数据 / 机器路径检查 ───────────────────────────────
DB_FILES="$(find "$STAGE" \( -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' -o -name '*.sqlite' \) -type f 2>/dev/null || true)"
[[ -z "$DB_FILES" ]] || die "包内发现数据库文件（个人数据）：$DB_FILES"
JSONL_FILES="$(find "$STAGE" -name '*.jsonl' -type f 2>/dev/null || true)"
if [[ -n "$JSONL_FILES" ]]; then
  warn "包内存在 .jsonl 文件（请人工确认非个人数据）："; echo "$JSONL_FILES" | sed 's/^/       /' >&2
fi
PATH_LEAKS="$(grep -rIl '/Users/dandan' "$STAGE" 2>/dev/null || true)"
if [[ -n "$PATH_LEAKS" ]]; then
  warn "以下文件仍含本机绝对路径 /Users/dandan（对方机器上不会报错，但属无效路径）："
  echo "$PATH_LEAKS" | sed 's/^/       /' >&2
fi

# ── 5. 结构自检 ──────────────────────────────────────────────
for d in MemoryCore MemoryPanel MemoryKnowledge MemoryProxy deploy agents sdk adapters scripts; do
  [[ -d "$STAGE/$d" ]] || die "缺少目录: $d"
done
if [[ $WITH_NATIVE -eq 1 ]]; then
  [[ -f "$STAGE/安装指南.md" ]] || warn "缺少 安装指南.md"
  # 脱敏 sed 可能误伤脚本里的 key 模板串（如 sk-mem-<随机>），打包前断言其完好
  grep -q 'sk-mem-' "$STAGE/start.sh" \
    || die "start.sh 里的 admin key 模板被脱敏规则误改，请检查 secret 正则"
  grep -q '__ROOT_DIR__' "$STAGE/config-templates/tdai-gateway.yaml" \
    || die "配置模板的占位符被误替换，请检查脱敏规则"
else
  [[ -f "$STAGE/SHARE-README.md" ]] || warn "缺少 SHARE-README.md（建议先编写再打包）"
fi
NM_COUNT="$(find "$STAGE" -name node_modules -type d | wc -l | tr -d ' ')"
[[ "$NM_COUNT" == "0" ]] || die "包内残留 node_modules x$NM_COUNT"

# ── 6. 打 tar + 报告 ────────────────────────────────────────
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/$PKG_NAME-src-$TS.tar.gz"
tar czf "$OUT" -C "$TMP_PKG" "$PKG_NAME"

SIZE="$(du -kh "$OUT" | cut -f1 | tr -d ' ')"
SHA="$(shasum -a 256 "$OUT" | cut -d' ' -f1)"
FCOUNT="$(find "$STAGE" -type f | wc -l | tr -d ' ')"

ok "打包完成"
echo "  产物:   $OUT"
echo "  体积:   $SIZE"
echo "  文件数: $FCOUNT"
echo "  sha256: $SHA"
echo ""
if [[ $WITH_NATIVE -eq 1 ]]; then
  echo "  对方用法： tar xzf <产物> && cd $PKG_NAME && ./install.sh"
  echo "            （无 Docker 一键包，详见图安装指南.md）"
else
  echo "  纯源码包：使用说明见包内 SHARE-README.md"
fi
if [[ $NO_ASSETS -eq 1 ]]; then
  echo "  注意：--no-assets 已剔除 assets/，README 中的配图将不可见"
fi
