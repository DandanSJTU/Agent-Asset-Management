#!/usr/bin/env bash
# ============================================================
# start.sh — 启动 Agent 资产管理四件套（原生 Node，无需 Docker）
#
#   ./start.sh              # 启动全部服务
#   ./start.sh core         # 只启动某一个（core|knowledge|panel|proxy）
#   SKIP_PROXY=1 ./start.sh # 跳过 proxy（只跑面板三件套）
#
# 配置来源：runtime/config/llm.env（唯一真源）
#   改完 LLM 配置后重新执行本脚本即生效（会重新渲染各组件配置文件）。
#
# 端口冲突时可用环境变量覆盖（改完会自动渲染进对应配置文件）：
#   CORE_PORT=9420 PANEL_PORT=9125 KNOWLEDGE_PORT=9424 PROXY_PORT=9096 ./start.sh
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="$ROOT/runtime"
CONFIG="$RUNTIME/config"
LOGS="$RUNTIME/logs"
PIDS="$RUNTIME/pids"

CORE_PORT="${CORE_PORT:-8420}"
KNOWLEDGE_PORT="${KNOWLEDGE_PORT:-8424}"
PANEL_PORT="${PANEL_PORT:-8125}"
PROXY_PORT="${PROXY_PORT:-8096}"

# curl 直连本机：绕过可能存在的 http_proxy，否则 127.0.0.1 的健康检查会被代理拦掉。
# 带连接/总超时——服务异常时最坏等 15s 后继续走 warn 分支，不会把启动永久挂死。
CURL="curl --noproxy 127.0.0.1,localhost --connect-timeout 3 --max-time 15"

if [[ -t 1 ]]; then
  C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_RED=$'\033[31m'; C_BLU=$'\033[34m'; C_RST=$'\033[0m'
else
  C_GRN=""; C_YLW=""; C_RED=""; C_BLU=""; C_RST=""
fi
info() { echo "${C_BLU}[$(date +%H:%M:%S)]${C_RST} $*"; }
ok()   { echo "${C_GRN}[ok]${C_RST} $*"; }
warn() { echo "${C_YLW}[warn]${C_RST} $*" >&2; }
die()  { echo "${C_RED}[error]${C_RST} $*" >&2; exit 1; }

mkdir -p "$CONFIG" "$LOGS" "$PIDS" \
         "$RUNTIME/data/core" "$RUNTIME/data/knowledge"

# ── 1. 读取 LLM 配置（唯一真源）──────────────────────────────
[[ -f "$CONFIG/llm.env" ]] || die "缺少 $CONFIG/llm.env —— 请先执行 ./install.sh"
set -a; # shellcheck disable=SC1091
. "$CONFIG/llm.env"; set +a

LLM_BASE_URL="${LLM_BASE_URL:-https://api.deepseek.com/v1}"
LLM_API_KEY="${LLM_API_KEY:-REPLACE_ME}"
LLM_MODEL="${LLM_MODEL:-deepseek-chat}"
PROMPT_MODE="${PROMPT_MODE:-code}"
KNOWLEDGE_LLM_BASE_URL="${KNOWLEDGE_LLM_BASE_URL:-$LLM_BASE_URL}"
KNOWLEDGE_LLM_API_KEY="${KNOWLEDGE_LLM_API_KEY:-$LLM_API_KEY}"
KNOWLEDGE_LLM_MODEL="${KNOWLEDGE_LLM_MODEL:-$LLM_MODEL}"
PROXY_UPSTREAM_URL="${PROXY_UPSTREAM_URL:-$LLM_BASE_URL}"
PROXY_UPSTREAM_API_KEY="${PROXY_UPSTREAM_API_KEY:-$LLM_API_KEY}"

if [[ "$LLM_API_KEY" == "REPLACE_ME" || "$LLM_API_KEY" == sk-REPLACE* ]]; then
  warn "LLM_API_KEY 仍是占位值 —— 服务能起来，但记忆抽取 / 知识抽取不会生效。"
  warn "  编辑 $CONFIG/llm.env 填入真实 key 后重新执行 ./start.sh"
fi

# ── 2. 渲染各组件配置（每次启动都渲染，改 llm.env 即生效）──────
render() {
  local src="$1" dst="$2"; shift 2
  sed -e "s|__ROOT_DIR__|$ROOT|g" \
      -e "s|__LLM_BASE_URL__|$LLM_BASE_URL|g" \
      -e "s|__LLM_API_KEY__|$LLM_API_KEY|g" \
      -e "s|__LLM_MODEL__|$LLM_MODEL|g" \
      -e "s|__PROMPT_MODE__|$PROMPT_MODE|g" \
      -e "s|__PROXY_UPSTREAM_URL__|$PROXY_UPSTREAM_URL|g" \
      -e "s|__PROXY_UPSTREAM_API_KEY__|$PROXY_UPSTREAM_API_KEY|g" \
      -e "s|__CORE_PORT__|$CORE_PORT|g" \
      -e "s|__KNOWLEDGE_PORT__|$KNOWLEDGE_PORT|g" \
      -e "s|__PANEL_PORT__|$PANEL_PORT|g" \
      -e "s|__PROXY_PORT__|$PROXY_PORT|g" \
      "$src" > "$dst"
}

[[ -f "$ROOT/config-templates/tdai-gateway.yaml" ]] \
  || die "缺少 $ROOT/config-templates/tdai-gateway.yaml"
render "$ROOT/config-templates/tdai-gateway.yaml"       "$CONFIG/tdai-gateway.yaml"
render "$ROOT/config-templates/proxy-config.yaml"       "$CONFIG/proxy-config.yaml"
render "$ROOT/config-templates/metadata-instances.json" "$CONFIG/metadata-instances.json"

# ── 3. 进程启动函数 ─────────────────────────────────────────
# nohup + 子 shell 写 PID：exec 后该 PID 即 node 进程本身，便于 stop.sh 精确回收。
# Linux 下额外用 setsid 脱离进程组，避免被终端会话回收（macOS 无 setsid，跳过）。
launch_svc() {
  local name="$1" dir="$2"; shift 2
  nohup sh -c 'PF="$0"; D="$1"; LG="$2"; shift 2; echo $$ > "$PF"; cd "$D"; exec env "$@" >> "$LG" 2>&1' \
    "$PIDS/$name.pid" "$dir" "$LOGS/$name.log" "$@" >/dev/null 2>&1 &
  sleep 1
}

wait_health() {
  local port=$1 name=$2 i=0
  while [ "$i" -lt "${HEALTH_TIMEOUT:-60}" ]; do
    i=$((i + 1))
    if $CURL -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      ok "$name 就绪 → http://127.0.0.1:$port"
      return 0
    fi
    sleep 1
  done
  warn "$name ${HEALTH_TIMEOUT:-60}s 内未就绪，查看日志: $LOGS/$name.log"
  return 1
}

already_running() {
  local port=$1
  $CURL -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1
}

start_core() {
  already_running $CORE_PORT && { warn "core 已在运行，跳过"; return 0; }
  info "启动 memory-core :$CORE_PORT"
  launch_svc core "$ROOT/MemoryCore" \
    TDAI_GATEWAY_CONFIG="$CONFIG/tdai-gateway.yaml" \
    TDAI_GATEWAY_HOST=0.0.0.0 \
    TDAI_GATEWAY_PORT=$CORE_PORT \
    TDAI_DATA_DIR="$RUNTIME/data/core" \
    STORE_MODE=sqlite \
    NODE_OPTIONS=--max-old-space-size=1536 \
    node --import tsx src/gateway/server.ts
  wait_health $CORE_PORT core || return 1

  # 初始化 admin 账号（幂等：已有 admin 时内核返回既有 key，不会覆盖）
  sleep 2
  local admin_key="${ADMIN_KEY:-}"
  if [[ -z "$admin_key" && -f "$CONFIG/.admin-key" ]]; then
    admin_key="$(cat "$CONFIG/.admin-key")"
  fi
  if [[ -z "$admin_key" ]]; then
    # 纯 bash 生成，不起任何子进程：tr|head 读 /dev/urandom 的管道在部分环境
    # （后台任务 / 无头 shell / SIGPIPE 被屏蔽时）会挂死，卡住整个启动流程
    local _k="" _i _r
    for _i in 1 2 3 4 5 6; do
      printf -v _r '%05d' $((RANDOM % 100000))
      _k+="$_r"
    done
    admin_key="sk-mem-$_k"
    echo "$admin_key" > "$CONFIG/.admin-key"
    chmod 600 "$CONFIG/.admin-key"
  fi
  $CURL -fsS -X POST -H "Content-Type: application/json" -H "x-tdai-service-id: default" \
    "http://127.0.0.1:$CORE_PORT/v3/internal/meta/user/init-admin" \
    -d "{\"username\":\"admin\",\"user_key\":\"$admin_key\"}" >/dev/null 2>&1 \
    && ok "admin 账号就绪（登录 key 见 runtime/config/.admin-key）" \
    || warn "init-admin 未成功（core 可能尚未完全就绪，稍后可手动重试）"
}

start_knowledge() {
  already_running $KNOWLEDGE_PORT && { warn "knowledge 已在运行，跳过"; return 0; }
  info "启动 knowledge :$KNOWLEDGE_PORT"
  launch_svc knowledge "$ROOT/MemoryKnowledge" \
    PORT=$KNOWLEDGE_PORT \
    KNOWLEDGE_SERVICE_KEY= \
    KNOWLEDGE_DATA_DIR="$RUNTIME/data/knowledge" \
    KNOWLEDGE_DB_PATH="$RUNTIME/data/knowledge/knowledge.db" \
    KNOWLEDGE_PUBLIC_BASE_URL="http://127.0.0.1:$KNOWLEDGE_PORT/v3" \
    LLM_MODE=custom \
    LLM_PROTOCOL=openai \
    LLM_API_KEY="$KNOWLEDGE_LLM_API_KEY" \
    LLM_BASE_URL="$KNOWLEDGE_LLM_BASE_URL" \
    LLM_MODEL="$KNOWLEDGE_LLM_MODEL" \
    NODE_OPTIONS=--max-old-space-size=1536 \
    node_modules/.bin/tsx src/server.ts
  wait_health $KNOWLEDGE_PORT knowledge
}

start_panel() {
  already_running $PANEL_PORT && { warn "panel 已在运行，跳过"; return 0; }
  info "启动 panel :$PANEL_PORT"
  local ui_dist="$ROOT/MemoryPanel/web/dist"
  [[ -d "$ui_dist" ]] || warn "未找到前端构建产物 $ui_dist —— 面板会白屏，请先执行 ./install.sh"
  launch_svc panel "$ROOT/MemoryPanel" \
    HOST=0.0.0.0 \
    PORT=$PANEL_PORT \
    UI_DIST_DIR="$ui_dist" \
    METADATA_INSTANCES_CONFIG="$CONFIG/metadata-instances.json" \
    KNOWLEDGE_SERVICE_URL="http://127.0.0.1:$KNOWLEDGE_PORT" \
    KNOWLEDGE_AUTH_TOKEN= \
    KNOWLEDGE_TIMEOUT_MS=15000 \
    KNOWLEDGE_LLM_BINDING_SYNC=0 \
    LOG_LEVEL=info \
    LOG_FORMAT=pretty \
    NODE_OPTIONS=--max-old-space-size=1536 \
    node_modules/.bin/tsx src/index.ts
  wait_health $PANEL_PORT panel
}

start_proxy() {
  [[ "${SKIP_PROXY:-0}" == "1" ]] && { warn "SKIP_PROXY=1，跳过 proxy"; return 0; }
  already_running $PROXY_PORT && { warn "proxy 已在运行，跳过"; return 0; }
  info "启动 proxy :$PROXY_PORT"
  launch_svc proxy "$ROOT/MemoryProxy" \
    NODE_OPTIONS=--max-old-space-size=1536 \
    node --import tsx/esm src/index.ts --config "$CONFIG/proxy-config.yaml"
  wait_health $PROXY_PORT proxy
}

# ── 4. 主流程 ───────────────────────────────────────────────
case "${1:-all}" in
  core)      start_core ;;
  knowledge) start_knowledge ;;
  panel)     start_panel ;;
  proxy)     start_proxy ;;
  all)
    start_core || { echo ""; die "core 启动失败，后续服务依赖它 —— 查看 $LOGS/core.log"; }
    start_knowledge
    start_panel
    start_proxy
    echo ""
    echo "════════════════ 启动完成 ════════════════"
    echo "  面板 UI      http://localhost:$PANEL_PORT/"
    echo "  登录 key     $(cat "$CONFIG/.admin-key" 2>/dev/null || echo '见 runtime/config/.admin-key')"
    echo "  Core 健康    http://localhost:$CORE_PORT/health"
    echo "  Knowledge    http://localhost:$KNOWLEDGE_PORT/docs"
    echo "  Proxy        http://localhost:$PROXY_PORT/"
    echo "  日志目录     $LOGS/"
    echo "  停止服务     ./stop.sh"
    echo "══════════════════════════════════════════"
    ;;
  *) echo "用法: ./start.sh [all|core|knowledge|panel|proxy]"; exit 1 ;;
esac
