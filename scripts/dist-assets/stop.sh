#!/usr/bin/env bash
# ============================================================
# stop.sh — 停止全部服务
#
#   ./stop.sh          # 按 PID 文件优雅停止（SIGTERM → 等待 → SIGKILL）
#   ./stop.sh --force  # 立刻强杀，并清理残留占用端口的进程
#
# 数据保留在 runtime/data/，停止不会丢记忆。
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDS="$ROOT/runtime/pids"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

if [[ -t 1 ]]; then C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_RST=$'\033[0m'
else C_GRN=""; C_YLW=""; C_RST=""; fi
ok()   { echo "${C_GRN}[ok]${C_RST} $*"; }
warn() { echo "${C_YLW}[warn]${C_RST} $*"; }

stop_by_pidfile() {
  local name="$1" pf="$PIDS/$name.pid"
  [[ -f "$pf" ]] || return 0
  local pid; pid="$(cat "$pf" 2>/dev/null || true)"
  [[ -n "$pid" ]] || { rm -f "$pf"; return 0; }
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    # 等待最多 10s 优雅退出，超时再 SIGKILL
    local i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 10 ]; do
      sleep 1; i=$((i + 1))
      [[ $FORCE -eq 1 ]] && break
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
      sleep 1
    fi
    ok "$name 已停止 (pid=$pid)"
  fi
  rm -f "$pf"
}

for svc in proxy panel knowledge core; do
  stop_by_pidfile "$svc"
done

# --force：清理没被 PID 文件记录、但仍占着端口的残留进程
if [[ $FORCE -eq 1 ]]; then
  # 与 start.sh 保持一致：端口可用同名环境变量覆盖
  for port in "${CORE_PORT:-8420}" "${KNOWLEDGE_PORT:-8424}" \
              "${PANEL_PORT:-8125}" "${PROXY_PORT:-8096}"; do
    leftover="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
    if [[ -n "$leftover" ]]; then
      warn "端口 $port 仍有残留进程，强杀: $leftover"
      echo "$leftover" | xargs kill -KILL 2>/dev/null || true
    fi
  done
fi

ok "全部服务已停止（数据保留在 $ROOT/runtime/data/）"
