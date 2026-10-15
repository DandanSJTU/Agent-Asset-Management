#!/usr/bin/env bash
# ============================================================
# status.sh — 查看四个服务的运行状态
#   ./status.sh          # 一次快照
#   ./status.sh --watch  # 每 5 秒刷新
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDS="$ROOT/runtime/pids"
LOGS="$ROOT/runtime/logs"
CURL="curl --noproxy 127.0.0.1,localhost"

# 与 start.sh 保持一致：端口可用同名环境变量覆盖
CORE_PORT="${CORE_PORT:-8420}"
KNOWLEDGE_PORT="${KNOWLEDGE_PORT:-8424}"
PANEL_PORT="${PANEL_PORT:-8125}"
PROXY_PORT="${PROXY_PORT:-8096}"

if [[ -t 1 ]]; then C_GRN=$'\033[32m'; C_RED=$'\033[31m'; C_YLW=$'\033[33m'; C_RST=$'\033[0m'
else C_GRN=""; C_RED=""; C_YLW=""; C_RST=""; fi

show() {
  printf "%-12s %-8s %-24s %s\n" "服务" "端口" "状态" "地址"
  printf "%s\n" "────────────────────────────────────────────────────────────────"
  check core      "$CORE_PORT"     "http://localhost:$CORE_PORT/health"
  check knowledge "$KNOWLEDGE_PORT" "http://localhost:$KNOWLEDGE_PORT/health"
  check panel     "$PANEL_PORT"     "http://localhost:$PANEL_PORT/"
  check proxy     "$PROXY_PORT"     "http://localhost:$PROXY_PORT/health"
  echo ""
  if [[ -f "$ROOT/runtime/config/.admin-key" ]]; then
    echo "面板登录 key: $(cat "$ROOT/runtime/config/.admin-key")"
  fi
  echo "日志目录:     $LOGS"
}

check() {
  local name=$1 port=$2 url=$3 pid_state="—"
  if [[ -f "$PIDS/$name.pid" ]]; then
    local pid; pid="$(cat "$PIDS/$name.pid" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      pid_state="pid=$pid"
    else
      pid_state="pid失效"
    fi
  fi
  if $CURL -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    printf "%-12s %-8s ${C_GRN}%-24s${C_RST} %s\n" "$name" "$port" "运行中 ($pid_state)" "$url"
  else
    printf "%-12s %-8s ${C_RED}%-24s${C_RST} %s\n" "$name" "$port" "未运行 ($pid_state)" "$url"
  fi
}

if [[ "${1:-}" == "--watch" ]]; then
  while true; do clear; show; echo "(Ctrl-C 退出，每 5s 刷新)"; sleep 5; done
else
  show
fi
