# team7-memory · ChatGPT 本地 MCP 接入指南

把 **推荐策略组（team-7xulumcvyl）4 位成员**的「对话记忆(L0-L3) / Skill / Wiki」通过本地 MCP 接进 ChatGPT，
让对话能按需检索团队的真实资产，从而做「**有无记忆**」A/B 对照测试。

> 这份部署与 Cursor 版共用同一个 `memory_mcp_server.py`（stdio，直连本机 8420/8424，已实测跑通）。
> 区别只在**客户端配置格式**和 **ChatGPT 必须在 Work/Codex 模式**。

---

## 0. 前置确认（一次性）

本 MCP 只读检索本机记忆服务，需要以下端口在跑（MemoryCore/Knowledge/Proxy）：

```bash
lsof -iTCP:8420 -sTCP:LISTEN -n -P   # MemoryCore  ✓
lsof -iTCP:8424 -sTCP:LISTEN -n -P   # MemoryKnowledge  ✓
```

若没起，先启动本项目本地服务（见 `local-deploy/`）。本脚本默认连 `127.0.0.1:8420` 与 `:8424`。

---

## 1. 关键认知（避免白折腾）

- **模型供应商不影响 MCP**：无论你的 ChatGPT 客户端背后是 DeepSeek、GPT 还是其它模型，MCP 检索层都照常工作，模型只是「消费」注入/调用的记忆。
- **官方 ChatGPT 桌面端只在 Work 模式 / Codex 模式支持本地 STDIO MCP**；标准 Chat 模式只能连远程 HTTP MCP，看不到本机服务。→ 测试前先切到 **Work** 或 **Codex** 模式。
- 从 Dock / Finder 启动的 GUI 客户端继承不到终端的 PATH，所以启动命令必须用**绝对路径**。
- **⚠️ 坑（已踩过）**：command 不要填 `run_memory_mcp.sh` 这类裸 shell 脚本——ChatGPT 桌面端拉起 `.sh` 容易失败、且会缓存一份**空的**工具目录，表现为「Plugins 里已启用、但对话里从不触发」。正确做法是 `command` 直接指向 python 解释器 + `args` 指向脚本 + 显式 `env` 块（与 `node_repl` 同构，见下方配置）。`run_memory_mcp.sh` 仅留给「只认单条命令」的客户端用。

---

## 2. 三种接入方式（任选其一，适配不同客户端）

### A. 官方 ChatGPT 桌面端（Work / Codex 模式）— 推荐
方式一（图形界面）：
1. 打开 ChatGPT 桌面端 → 左下角头像 → **Settings** → **Integrations / Plugins** → **Add MCP Server**。
2. 类型选 **STDIO**；Name 填 `team7-memory`；**Command to launch** 填：
   ```
   <你的受管 python 解释器绝对路径>
   ```
   **Args** 填：
   ```
   <项目根目录>/agents/chatgpt/memory_mcp_server.py
   ```
   **Environment**（5 项）：`MEMORY_ENDPOINT=http://127.0.0.1:8420`、`MEMORY_API_KEY=sk-mem-local-admin`、`SERVICE_ID=default`、`TEAM_ID=team-7xulumcvyl`、`KNOWLEDGE_ENDPOINT=http://127.0.0.1:8424`。
   > ⚠️ 别用 `run_memory_mcp.sh` 当 command —— 见 §1 的坑。
3. 保存 → **完全退出并重启** ChatGPT 桌面端（仅切模式不会重载 MCP 配置）→ 切到 **Work** 模式（或 Codex 模式），底部应能看到 `team7-memory` 工具。

方式二（直接改配置，等价于方式一）：
把 `codex_config.toml` 的内容追加到 `~/.codex/config.toml`，**完全退出并重启**客户端即可。

### B. 第三方 / JSON 配置客户端（Cursor、Claude Desktop 类，认 `mcpServers`）
把 `mcp.json` 里的 `team7-memory` 段合并进你客户端的 MCP 配置文件（如 `~/.cursor/mcp.json`、Claude 的 `claude_desktop_config.json`）。
> 此文件里 env 已写死，客户端无需额外传环境变量。

### C. 只接受「单条命令」的客户端
把启动命令直接填 `run_memory_mcp.sh` 的绝对路径（同 A 的命令框）。wrapper 已包好全部 env。

---

## 3. 验证连通

连上后，在 Work/Codex 对话里问一句：

> **列出团队 4 位成员，并给我 team_status。**

预期返回 4 位成员（product/engineering/algorithm/qa）及各自的 L1/L2/L3/Skill 计数，说明 MCP 已实时打到本机 8420/8424。

也可用 `tools/list` 自查：本 server 暴露 12 个工具
`list_members · team_status · memory_search · conversation_search · scene_read · list_scenarios · persona_read · skill_search · skill_view · wiki_search · wiki_read · wiki_list`。

---

## 4. A/B 测试题（带/不带 MCP 各跑一遍）

同一道题，**开 MCP（有记忆）vs 关 MCP（无记忆）** 对比回答质量。两题都针对推荐策略组真实业务，且含**团队私有词**，无记忆时必然答偏或答空。

### 题一：曝光衰减打压策略
> 我们首页信息流要做「曝光衰减打压」，用 embedding 相似度过滤重复内容。7天/30天/180天/全生命周期各自怎么设阈值和指数？林夏那边这个需求现在排期到哪了？有没有现成的 Skill 或 Wiki 能直接复用？

- 私有词：`林夏`、`7d/30d/180d 多窗口`、`embedding 相似度过滤`、`进 AB` / `排期`。
- 有记忆时：`memory_search/member=all` 能捞出林夏相关的衰减方案讨论与排期；`skill_search` 命中指标口径/打压类 Skill；`wiki_search` 命中策略地图 Wiki。

### 题二：视频五维打分准入
> 视频内容要进首页信息流分发，得先过「五维打分」。这五维分别是什么、怎么定级（level 1/2/3）、什么标准才允许进排序？有没有对应的 Skill 或 Wiki？

- 私有词：`16 子维度`、`level 1/2/3 分级`、`评级 1+`、`不进入排序`、`首页信息流策略地图`。
- 有记忆时：`skill_search` 命中视频打分 SOP；`wiki_search` 命中策略地图；`memory_search` 捞出之前关于分级门槛的评审结论。

### 对照记录建议
| 维度 | 无记忆(关MCP) | 有记忆(开MCP) |
|---|---|---|
| 是否认得私有词 | | |
| 是否引用团队既有决策 | | |
| 是否给出可复用 Skill/Wiki | | |
| 方案可落地程度 | | |

---

## 5. 排错

- **MCP 已在 Plugins 启用、但对话里从不触发（最关键）**：根因是 command 用了 `run_memory_mcp.sh`，客户端拉起失败并缓存了**空工具目录**，于是「已启用但 0 工具可调用」。修复：command 改成 python 直连（见 §2-A）+ **完全退出并重启**桌面端（仅切 Work 模式不会重载配置），让客户端用新 command 路径重新做 `tools/list`。改完 command 路径后旧空缓存自动失效。
- **Work 模式里看不到工具**：确认没在标准 Chat 模式；确认已**完全退出**客户端再重开（不是仅切模式）；确认 `command`/`args`/`env` 三项齐全。
- **调用报错 401/400**：本机服务密钥默认 `sk-mem-local-admin` + `x-tdai-service-id: default`，env 已写死；若你改过本地密钥，同步改配置里的 env。
- **返回空数据**：先用 `team_status` 确认本机 8420/8424 有数据；服务没起则 MCP 连通但查不到内容。
- **进程残留**：GUI 客户端退出时偶尔不杀 MCP 子进程，可 `pkill -f memory_mcp_server.py` 清理后重连。

---

## 6. 文件清单

- `memory_mcp_server.py` — 复用的 MCP server（12 工具，只读检索）。
- `run_memory_mcp.sh` — 启动器（写死 env + 受管 python 绝对路径），给「单命令」类客户端用。
- `mcp.json` — `mcpServers` 格式配置（Cursor/Claude 类 JSON 客户端用）。
- `codex_config.toml` — 追加到 `~/.codex/config.toml`（官方 ChatGPT Work/Codex 模式用）。
- `README.md` — 本文件。
