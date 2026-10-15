#!/usr/bin/env bash
# ============================================================
# package-share.sh — 把本项目打成干净、可分享的源码包
#
# 默认排除：node_modules / .git / .workbuddy / 个人数据（local-deploy/data、
# MemoryPanel/data）/ 日志 / pids / 密钥文件 / 内部设计文档（docs/）/ 临时目录。
# 打包后自动做密钥与个人数据扫描，通过才产出 tar.gz。
#
# 用法：
#   bash scripts/package-share.sh                      # 默认：干净源码包
#   bash scripts/package-share.sh --with-docs          # 含 docs/ 内部设计文档
#   bash scripts/package-share.sh --with-internal-html # 含根目录两份 L0-L3 内部 HTML
#   bash scripts/package-share.sh --with-local-deploy  # 含 local-deploy 脱敏版
#                                                        （剔除 data/logs/pids/plist，
#                                                          密钥替换为 sk-REPLACE_ME）
#   bash scripts/package-share.sh --no-assets          # 不含 assets/ 图片（-32MB，走邮件传时用）
#   bash scripts/package-share.sh -o <outdir>          # 自定义输出目录
#
# 产物：<outdir>/agent-memory-bank-src-<时间戳>.tar.gz（顶层目录 agent-memory-bank/）
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_NAME="agent-memory-bank"

WITH_DOCS=0
WITH_INTERNAL_HTML=0
WITH_LOCAL_DEPLOY=0
NO_ASSETS=0
OUT_DIR="$ROOT/dist-share"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-docs)          WITH_DOCS=1 ;;
    --with-internal-html) WITH_INTERNAL_HTML=1 ;;
    --with-local-deploy)  WITH_LOCAL_DEPLOY=1 ;;
    --no-assets)          NO_ASSETS=1 ;;
    -o|--out)             OUT_DIR="${2:?-o 需要目录参数}"; shift ;;
    -h|--help)            sed -n '2,28p' "$0"; exit 0 ;;
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

# ── 3. 密钥脱敏（安全网）────────────────────────────────────
SECRET_RE='sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}'
HITS="$(grep -rIlE "$SECRET_RE" "$STAGE" 2>/dev/null || true)"
if [[ -n "$HITS" ]]; then
  warn "以下文件命中疑似密钥，已替换为 sk-REPLACE_ME："
  echo "$HITS" | sed 's/^/       /' >&2
  echo "$HITS" | tr '\n' '\0' | xargs -0 sed -i '' "s/$SECRET_RE/sk-REPLACE_ME/g"
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
[[ -f "$STAGE/SHARE-README.md" ]] || warn "缺少 SHARE-README.md（建议先编写再打包）"
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
echo "  给对方的使用说明已打在包内 SHARE-README.md（三种部署方式：Docker 官方镜像 / 源码构建镜像 / 原生 Node）"
if [[ $NO_ASSETS -eq 1 ]]; then
  echo "  注意：--no-assets 已剔除 assets/，README 中的配图将不可见"
fi
