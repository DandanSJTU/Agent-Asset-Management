#!/usr/bin/env bash
# ============================================================
# install.sh — Agent 资产管理 一键安装（原生 Node，无需 Docker）
#
#   ./install.sh                  # 交互式：引导填 LLM 配置 → 装依赖 → 构建 → 启动
#   ./install.sh --yes            # 非交互：配置从环境变量读（见下方"非交互变量"）
#   ./install.sh --skip-start     # 只安装不启动
#   ./install.sh --skip-deps      # 已有 node_modules 时跳过安装，直接构建+启动
#   ./install.sh --force-deps     # 强制重装依赖
#   ./install.sh --help
#
# 非交互变量（配合 --yes 使用）：
#   LLM_API_KEY=sk-xxx LLM_BASE_URL=https://api.deepseek.com/v1 \
#   LLM_MODEL=deepseek-chat PROMPT_MODE=code ./install.sh --yes
#
# 全流程：环境检查 → 依赖安装 → 前端构建 → 生成配置 → 启动四服务 → 健康检查
# 预计耗时 5~15 分钟（取决于网络与机器性能）。
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="$ROOT/runtime"
CONFIG="$RUNTIME/config"
TEMPLATES="$ROOT/config-templates"

ASSUME_YES=0
SKIP_START=0
SKIP_DEPS=0
FORCE_DEPS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)        ASSUME_YES=1 ;;
    --skip-start)    SKIP_START=1 ;;
    --skip-deps)     SKIP_DEPS=1 ;;
    --force-deps)    FORCE_DEPS=1 ;;
    -h|--help)       sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "[error] 未知参数: $1（用 --help 看用法）" >&2; exit 1 ;;
  esac
  shift
done

if [[ -t 1 ]]; then
  C_GRN=$'\033[32m'; C_YLW=$'\033[33m'; C_RED=$'\033[31m'; C_BLU=$'\033[34m'; C_BOLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_GRN=""; C_YLW=""; C_RED=""; C_BLU=""; C_BOLD=""; C_RST=""
fi
step() { echo ""; echo "${C_BOLD}${C_BLU}▶ $*${C_RST}"; }
info() { echo "  $*"; }
ok()   { echo "  ${C_GRN}✓${C_RST} $*"; }
warn() { echo "  ${C_YLW}!${C_RST} $*" >&2; }
die()  { echo ""; echo "${C_RED}[error]${C_RST} $*" >&2; exit 1; }

echo "${C_BOLD}Agent 资产管理 · 一键安装${C_RST}"
echo "安装目录: $ROOT"

# ── 步骤 1：环境检查 ─────────────────────────────────────────
step "步骤 1/5  检查运行环境"

command -v node >/dev/null 2>&1 \
  || die "未检测到 Node.js。请先安装 Node.js 22.16 或更高版本：
    · 官网下载  https://nodejs.org/
    · macOS    brew install node@22
    · Ubuntu   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"

NODE_VER="$(node -v 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
NODE_MINOR="$(echo "$NODE_VER" | cut -d. -f2)"
if [[ "$NODE_MAJOR" -lt 22 ]] || { [[ "$NODE_MAJOR" -eq 22 ]] && [[ "$NODE_MINOR" -lt 16 ]]; }; then
  die "Node 版本过低：当前 v$NODE_VER，要求 >= 22.16.0（MemoryCore 的 engines 约束）。
    升级后重新执行本脚本。建议用 nvm：nvm install 22 && nvm use 22"
fi
ok "Node v$NODE_VER"

command -v npm >/dev/null 2>&1 || die "未检测到 npm（通常随 Node 一起安装）"
ok "npm v$(npm -v)"

# 原生模块编译工具链（better-sqlite3 / node-pty 可能需要）
missing_build=0
for tool in python3 make; do
  command -v "$tool" >/dev/null 2>&1 || { warn "缺少 $tool（部分原生模块可能需要它编译）"; missing_build=1; }
done
if [[ $missing_build -eq 1 ]]; then
  warn "若后续 npm 安装报 node-gyp 相关错误，请先装编译工具链："
  warn "  macOS  → xcode-select --install"
  warn "  Ubuntu → sudo apt install -y python3 make g++"
fi

# ── 步骤 2：安装依赖 ─────────────────────────────────────────
step "步骤 2/5  安装依赖（首次约 5~10 分钟）"

install_deps() {
  local dir="$1" label="$2" optional="${3:-0}"
  [[ -d "$ROOT/$dir" ]] || { warn "目录不存在，跳过: $dir"; return 0; }
  if [[ -d "$ROOT/$dir/node_modules" && $FORCE_DEPS -eq 0 ]]; then
    ok "$label 依赖已存在，跳过（需要重装用 --force-deps）"
    return 0
  fi
  info "安装 $label 依赖 ..."
  ( cd "$ROOT/$dir" && npm ci --no-audit --no-fund ) >"$RUNTIME/logs/npm-$label.log" 2>&1 \
    || ( cd "$ROOT/$dir" && npm install --no-audit --no-fund ) >>"$RUNTIME/logs/npm-$label.log" 2>&1 \
    || {
      if [[ $optional -eq 1 ]]; then
        warn "$label 依赖安装失败（可选组件，不影响核心功能）—— 日志: runtime/logs/npm-$label.log"
        return 0
      fi
      # 直接把日志尾部打出来，省得再翻文件——多数情况是网络不通或编译工具链缺失
      echo ""
      echo "  ── 日志末尾（runtime/logs/npm-$label.log）──"
      tail -15 "$RUNTIME/logs/npm-$label.log" 2>/dev/null | sed 's/^/    /'
      echo ""
      die "$label 依赖安装失败。常见原因：
    · 网络不通 / npm 源被墙 → 换个源：npm config set registry https://registry.npmmirror.com
    · 原生模块编译失败（node-gyp）→ 先装工具链再跑：./install.sh --force-deps
        macOS: xcode-select --install
        Linux: sudo apt install -y python3 make g++"
    }
  ok "$label 依赖就绪"
}

mkdir -p "$RUNTIME/logs" "$CONFIG"

if [[ $SKIP_DEPS -eq 1 ]]; then
  info "已指定 --skip-deps，跳过依赖安装"
else
  install_deps MemoryCore      core      0
  install_deps MemoryPanel     panel     0
  install_deps MemoryPanel/web panel-web 0
  install_deps MemoryKnowledge knowledge 0
  # proxy 依赖 node-pty（需编译），失败不影响面板与记忆功能，故设为可选
  install_deps MemoryProxy     proxy     1
fi

# ── 步骤 3：构建前端 ─────────────────────────────────────────
step "步骤 3/5  构建面板前端"

UI_DIST="$ROOT/MemoryPanel/web/dist"
if [[ -d "$UI_DIST" && -n "$(ls -A "$UI_DIST" 2>/dev/null)" && $FORCE_DEPS -eq 0 ]]; then
  ok "前端产物已存在，跳过（需要重建请先删除 MemoryPanel/web/dist）"
else
  [[ -d "$ROOT/MemoryPanel/web" ]] || die "缺少 MemoryPanel/web 目录"
  info "构建中（约 1~3 分钟）..."
  if ( cd "$ROOT/MemoryPanel/web" && npm run build ) >"$RUNTIME/logs/build-web.log" 2>&1; then
    ok "前端构建完成 → MemoryPanel/web/dist"
  else
    warn "npm run build 失败，尝试跳过类型检查直接构建 ..."
    if ( cd "$ROOT/MemoryPanel/web" && npx vite build ) >>"$RUNTIME/logs/build-web.log" 2>&1; then
      ok "前端构建完成（已跳过 tsc 类型检查）"
    else
      die "前端构建失败，查看日志: $RUNTIME/logs/build-web.log"
    fi
  fi
fi

# ── 步骤 4：生成配置 ─────────────────────────────────────────
step "步骤 4/5  配置 LLM"

[[ -f "$TEMPLATES/llm.env.example" ]] || die "缺少配置模板: $TEMPLATES/llm.env.example"

if [[ -f "$CONFIG/llm.env" ]]; then
  ok "已存在 runtime/config/llm.env，保留现有配置"
  info "（如需重新配置，删除该文件后重新执行 ./install.sh）"
else
  cp "$TEMPLATES/llm.env.example" "$CONFIG/llm.env"

  if [[ $ASSUME_YES -eq 1 ]]; then
    info "非交互模式：使用环境变量/默认值"
  else
    echo ""
    echo "  ${C_BOLD}需要一组 LLM 凭据${C_RST}（OpenAI 兼容格式即可，如 DeepSeek / 通义 / Kimi）"
    echo "  记忆抽取（L1）、场景归纳（L2）、画像（L3）都靠它，不填服务能起来但不会产生记忆。"
    echo "  现在不填也可以，之后编辑 runtime/config/llm.env 再执行 ./start.sh 即可。"
    echo ""
    read -r -p "  LLM API Base URL [https://api.deepseek.com/v1]: " _base_url
    read -r -p "  LLM API Key [回车跳过]: " _api_key
    read -r -p "  LLM Model [deepseek-chat]: " _model
    echo ""
    echo "  promptMode：code = 代码工程/团队协作（默认）| chat = 个人对话/教学"
    read -r -p "  promptMode [code]: " _prompt_mode

    LLM_BASE_URL="${_base_url:-https://api.deepseek.com/v1}"
    LLM_API_KEY="${_api_key:-REPLACE_ME}"
    LLM_MODEL="${_model:-deepseek-chat}"
    PROMPT_MODE="${_prompt_mode:-code}"
  fi

  LLM_BASE_URL="${LLM_BASE_URL:-https://api.deepseek.com/v1}"
  LLM_API_KEY="${LLM_API_KEY:-REPLACE_ME}"
  LLM_MODEL="${LLM_MODEL:-deepseek-chat}"
  PROMPT_MODE="${PROMPT_MODE:-code}"

  sed -i.bak \
    -e "s|^LLM_BASE_URL=.*|LLM_BASE_URL=$LLM_BASE_URL|" \
    -e "s|^LLM_API_KEY=.*|LLM_API_KEY=$LLM_API_KEY|" \
    -e "s|^LLM_MODEL=.*|LLM_MODEL=$LLM_MODEL|" \
    -e "s|^PROMPT_MODE=.*|PROMPT_MODE=$PROMPT_MODE|" \
    -e "s|^KNOWLEDGE_LLM_BASE_URL=.*|KNOWLEDGE_LLM_BASE_URL=$LLM_BASE_URL|" \
    -e "s|^KNOWLEDGE_LLM_API_KEY=.*|KNOWLEDGE_LLM_API_KEY=$LLM_API_KEY|" \
    -e "s|^KNOWLEDGE_LLM_MODEL=.*|KNOWLEDGE_LLM_MODEL=$LLM_MODEL|" \
    -e "s|^PROXY_UPSTREAM_URL=.*|PROXY_UPSTREAM_URL=$LLM_BASE_URL|" \
    -e "s|^PROXY_UPSTREAM_API_KEY=.*|PROXY_UPSTREAM_API_KEY=$LLM_API_KEY|" \
    "$CONFIG/llm.env"
  rm -f "$CONFIG/llm.env.bak"
  chmod 600 "$CONFIG/llm.env"
  ok "配置已写入 runtime/config/llm.env"

  if [[ "$LLM_API_KEY" == "REPLACE_ME" || -z "$LLM_API_KEY" ]]; then
    warn "LLM key 未填写 —— 服务能启动，但不会产生任何记忆。填好后执行 ./start.sh 生效。"
  fi
fi

# ── 步骤 5：启动服务 ─────────────────────────────────────────
step "步骤 5/5  启动服务"

chmod +x "$ROOT/start.sh" "$ROOT/stop.sh" "$ROOT/status.sh" 2>/dev/null || true

if [[ $SKIP_START -eq 1 ]]; then
  info "已指定 --skip-start，跳过启动。需要时执行：./start.sh"
else
  "$ROOT/start.sh" || die "启动失败，查看日志: $RUNTIME/logs/"
fi

echo ""
echo "${C_BOLD}${C_GRN}安装完成${C_RST}"
if [[ $SKIP_START -eq 0 ]]; then
  echo "  面板地址   http://localhost:${PANEL_PORT:-8125}/"
  echo "  登录 key   $(cat "$CONFIG/.admin-key" 2>/dev/null || echo '见 runtime/config/.admin-key')"
fi
echo "  配置修改   编辑 runtime/config/llm.env 后执行 ./start.sh"
echo "  查看状态   ./status.sh"
echo "  停止服务   ./stop.sh"
echo "  使用文档   见包内 安装指南.md"
echo ""
