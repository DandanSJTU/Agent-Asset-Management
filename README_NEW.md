# Agent 资产管理 · TencentDB-Agent-Memory（个人修改版）

> **本文档基于本地仓库当前代码重写（2026-10-15），反映最新逻辑**，与 `README.md`（官方英文版）/ `README_CN.md`（官方中文版）并存，不覆盖它们。
> 如需官方完整叙述请查看原两份 README；本文聚焦「这个仓库现在实际是什么、怎么跑、哪些是本地新增、哪些还没做」。

---

## 0. 这个仓库是什么

腾讯开源项目 **[TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)** 的**个人修改 / 派生版本**（非官方发布渠道），产品定位一句话：

> **让 Agent 的经验、文档、代码沉淀成可复用资产，让下一位 Agent 直接读档。**

- **许可**：完整保留官方 `LICENSE`（MIT）与 Tencent 版权声明，未做删改；本修改版同样以 MIT 提供，仅供个人学习 / 本地自用。
- **展示名**：**Agent 资产管理**（2026-10-15 由 Agent-Memory-Bank 更名，仅改 UI / 文档文案）。
- **代码身份不变**：npm scope `@tencentdb-agent-memory/*`、Python 包 `tencentdb_agent_memory`、目录名、Docker 镜像名均维持官方命名（改名属方案 B，需发布权限，未做）。
- **相对官方的新增**：**个人空间**（会话洞察 / 我的记忆 / 我的技能）+ `team` / `personal` 双 scope 隔离 + 本地无 Docker 部署链路（`local-deploy/`）。

---

## 1. 最新状态速览（结论先行）

| 能力 | 状态 | 说明 |
| :--- | :---: | :--- |
| 官方四大资产（对话记忆 / Skill / Wiki / CodeGraph） | ✅ | 随官方基线可用 |
| 本地无 Docker 部署（`local-deploy/`，四服务） | ✅ | core 8420 / knowledge 8424 / panel 8125 / proxy 8096 |
| **M3** `team`/`personal` 双 scope 隔离（SQLite + MongoDB） | ✅ | 46 例契约测试实跑通过（2026-10-13） |
| **M4a** 个人 L0 写入入口 + `personal-extract` 提炼管线 | ✅ | 7 例契约测试通过（2026-10-13） |
| **M4a′** L1 提炼管线 scope 透传（`writeMemory` / `extractL1Memories` / `createL1Runner`） | ✅ | 5 例契约测试通过（2026-10-13） |
| **M4b** 会话洞察侧入口 | ✅ 部分 | 观测面 + resume/handoff + 「我的技能」从对话洞察导入已通（2026-10-15） |
| 我的记忆 L2/L3（personal） | ⚠️ 默认关 | UI 与端点已接对话记忆管线，opt-in 开关默认关闭 |
| **TCVDB** 后端 personal scope | ❌ 未做 | `tcvdb/memory-store.ts` 无 scope 字段，涉及 personal 需后端探测禁用 |
| 代码身份改名（npm scope / 包名） | ❌ 未做 | 属方案 B，需发布权限 |

> **一句话**：官方主链路 + 个人空间写入/读取链路均已落地并测试通过；剩余阻断项集中在 **TCVDB scope** 与 **L2/L3 personal 默认开启策略**。

---

## 2. 快速开始

### 2.1 路径 A：官方 Docker 一键（需要 Docker Hub 可达）

```bash
git clone https://github.com/TencentCloud/TencentDB-Agent-Memory.git
cd TencentDB-Agent-Memory/deploy/global-images
cp .env.example .env
$EDITOR .env       # 填入两组 LLM 参数（memory 组 + proxy 组）
./start-all.sh     # 一键起 core + hub + proxy，结束会打印可直接粘贴给 Claude 的命令
```

打开面板：http://localhost:8125 。完整说明见 [INSTALL.md](./INSTALL.md)（中文：[INSTALL_CN.md](./INSTALL_CN.md)）。

### 2.2 路径 B：本地原生部署（无 Docker，本仓库默认形态）

没有 Docker / Docker Hub 被网络拦截时，用 Node 22 从源码直接跑四个服务，详见 [local-deploy/README-local.md](./local-deploy/README-local.md)。

**前置条件**：Node.js ≥ 22.16；一套 OpenAI 兼容 LLM 的 `base_url / api_key / model`。

**启动 / 停止**：

```bash
bash local-deploy/start-local.sh    # 顺序起 core → knowledge → panel → proxy，逐个等 health
bash local-deploy/stop-local.sh     # 停止
```

**端口与服务**：

| 服务 | 端口 | 职责 | 健康检查 |
| :--- | :---: | :--- | :--- |
| memory-core | 8420 | 记忆引擎内核 gateway | `/health` |
| knowledge | 8424 | 知识服务（wiki / code-graph ingest） | `/health` |
| panel | 8125 | 控制面板 UI（本仓库主要迭代对象） | `/health` |
| proxy | 8096 | coding agent 代理（注入 + 归档） | `/health` |

**LLM 配置有三处、互相独立（踩坑警告）**：

1. `local-deploy/tdai-gateway.yaml` 的 `llm.*` —— memory 组（core 抽取 / 召回用）；
2. `local-deploy/start-local.sh` 里 knowledge 服务的 `LLM_*` env —— 知识组（wiki ingest 抽取用）；
3. `local-deploy/proxy-config.yaml` 的 `upstream.*` —— proxy 组（转发上游 LLM 用）。

只填一处另一处仍报 `Failed to parse URL from REPLACE_ME/chat/completions`，**三处都要填**（值可相同）。

**本地默认凭据**：`start-local.sh` 自动 `init-admin` 写入固定 admin key `sk-mem-local-admin`（幂等）；面板零配置登录用它。

**面板地址**：http://localhost:8125/ （登录后默认落地页 = 会话洞察 `/insights`）。

**沙箱 / 非常驻会话注意**：`launchctl submit` 托管在本环境静默失效，`HOLD=1 bash start-local.sh` 在按进程组回收的会话里也会整批掉。**正解是用 `local-deploy/run_detached.py`**（`subprocess.Popen(start_new_session=True)` 让服务脱离会话进程组常驻），停止用 `python3 run_detached.py --stop`。

**个人空间演示数据**（本地 LLM 为占位时验证 UI 用）：

```bash
node local-deploy/seed-personal-demo.mjs            # 按真实写入格式落一批 demo 数据
node local-deploy/seed-personal-demo.mjs --remove   # 精确清除（record_id 前缀 demo-personal-）
```

---

## 3. 仓库结构

| 目录 | 职责 |
| :--- | :--- |
| `MemoryCore/` | 记忆引擎内核：gateway（:8420）、L0–L3 提炼管线、三种存储后端（sqlite / tcvdb / mongodb）、`core/record/personal-extract.ts` 等个人空间写入面 |
| `MemoryKnowledge/` | 知识服务（:8424）：Wiki ingest + CodeGraph 索引 |
| `MemoryPanel/` | 控制面板：后端 `src/panel/`（Hono，含 personal-space / personal-skills 路由）+ 前端 `web/`（React + Vite） |
| `MemoryProxy/` | Agent 代理（:8096）：双协议（Anthropic Messages / OpenAI Chat & Responses）、首轮引导、每轮资产注入、归档 |
| `agents/` | 8 类客户端适配（claude-code / codebuddy / codex / workbuddy / dsh / hermes / openclaw / opencode）+ `setup-proxy` 引导 skill + `personal-space` 派生事实引擎 + `asset-import.ts` 本地资产导入 |
| `adapters/opencode/` | OpenCode 官方 adapter 配置包（`opencode.json` / `opencode.v2.json` + 校验脚本） |
| `sdk/memory-core/` | 官方 SDK：TypeScript + Python |
| `local-deploy/` | 无 Docker 部署全套：启动脚本、配置、launchd plist、`run_detached.py`、演示种子 |
| `deploy/` | 官方 Docker 部署（global-images 一键三件套） |
| `docs/` | 设计文档（个人空间方案、M3 完工报告、我的记忆 tab 设计等，21 份 HTML） |
| `MemoryCore/scripts/migrate-v2-to-v3/` | 官方数据迁移工具（v1.x/v0.x → v2.0.0+） |

---

## 4. 核心概念

### 4.1 四种记忆资产

| 资产 | 沉淀来源 | 解决什么 |
| :--- | :--- | :--- |
| **对话记忆** | 对话逐层提炼 | 跨会话记住偏好、事实、决策、交互历史 |
| **Skill** | 跑通的任务 / 工具调用 | 可复用 SOP（带版本、资源文件、触发边界、执行步骤、验证规则） |
| **Wiki** | 文档 / 设计稿 / runbook | 结构化页面 + 链接图谱，按需检索而非全文注入 |
| **CodeGraph** | 代码仓库 | 符号 / 文件 / 调用关系 / 影响路径，改代码前先 impact analysis |

新建资产默认 `private`；分享是显式动作。可见性四档：`private`（仅 Owner，团队管理员也不可读）/ `team`（团队可读）/ `restricted`（User / Role / Agent ACL）/ `agent`（同团队内定向装配）。

### 4.2 对话记忆的 L0 → L3 分层提炼

| 层 | 存什么 | 用途 |
| :--- | :--- | :--- |
| **L0 Conversation** | 原始对话全量上下文 | 核对原文、时间戳、来源 |
| **L1 Atom** | 事实 / 偏好 / 约束 / 事件（带 type + priority） | 精确召回可执行信息 |
| **L2 Scenario** | 围绕项目 / 场景的叙事化知识块（Markdown） | 快速恢复工作上下文 |
| **L3 Core / Persona** | 长期画像 / 稳定模式 | 让 Agent 快速进入用户与团队语境 |

生成与检索都分层：日常 L2/L3 做上下文引导；查具体事实时 BM25 + 向量检索 + RRF 融合回退 L1/L0，并按条数 / 字符预算 / 超时封顶，防止记忆淹没上下文窗口。级联规则：L1 完成提前 L2 定时器 → L2 完成直接入队 L3。

### 4.3 Memory Proxy 注入链路

1. **双协议接入**：`/:agent/:spaceId/v1/messages`（Anthropic）与 `/:agent/:spaceId/v1/chat/completions`、`/:agent/:spaceId/v1/responses`（OpenAI）都接；
2. **首轮引导**：sessionInit 交互式表单（或 HTTP Header 预选）确定 team / agent / task 绑定；
3. **每轮注入**：把该 Agent 的 L2/L3 记忆、matched skill、wiki / code-graph 摘要拼进 system prompt，再转发上游 LLM；
4. **鉴权**：`x-tdai-user-key` → 内核 `/v3/meta/auth/verify` 换 `user_id`，按用户维度控制资产可见性；
5. **会话内命令**：`mem:sync`（刷新本会话注入的全部资产）、`mem:create-skill [prompt]`（把当前对话归档为 Skill）、`mem:help`。

### 4.4 与 RAG / 聊天记录的区别

不只是「能找到什么」，还回答「谁能用、哪版有效、该发给哪个 Agent」——资产带 Owner / 版本 / 状态 / 可见性 / 使用次数 / Agent 绑定，Memory Hub 是管控台不是展示板。

---

## 5. 客户端接入（8 类已适配）

| Agent | 协议 | Session Init | 配置文件 |
| :--- | :--- | :--- | :--- |
| Claude Code | Anthropic Messages | 交互式 Form | `~/.claude/settings.json` / env |
| CodeBuddy | OpenAI Chat | 交互式 Form | `~/.codebuddy/models.json` |
| Codex | OpenAI Responses | Form + Default Gate | `~/.codex/config.toml` |
| WorkBuddy | Responses(桌面) / Chat(Web) | 交互式 Form | `~/.workbuddy/models.json` |
| dsh (DeepSeek Harness) | OpenAI Chat | Form + Headless Bypass | `~/.dsh/settings.yaml` |
| Hermes | OpenAI Chat | Header 预选 | `~/.hermes/config.yaml` |
| OpenClaw | OpenAI Chat | Header 预选 | `~/.openclaw/openclaw.json` |
| OpenCode | OpenAI Chat | Header 预选 | `~/.config/opencode/opencode.json`（另见 `adapters/opencode/`） |

**零代码接入**：把客户端的 base URL 指向 Proxy 即可，无需插件 / hook / MCP。

**两种配置方式**：

```bash
# 方式一：交互式向导（自动扫描复用现有配置、健康探测、写配置并备份 .bak）
bash agents/setup-proxy.sh

# 方式二：让 AI Agent 读 agents/skills/setup-proxy/SKILL.md 替你完成配置
```

**Header 预选**（跳过表单，所有 agent 通用）：`Authorization: Bearer <user_key>` + `x-team-id` + `x-agent-id` + `x-task-id` + `x-conversation-id`，齐全即直接完成 session 注册 + 资产注入。

**本地资产导入**（把各客户端磁盘上的 skill / memory / session 导入 Hub）：

```bash
tsx agents/asset-import.ts --source claude-code --agent-id <id> --team-id <tid> -y
```

各客户端适配细节（协议 / 路由 / Header 速查 / 常见坑）见 [agents/README.md](./agents/README.md) 与 [agents/adapter-agent-development.md](./agents/adapter-agent-development.md)。

---

## 6. 个人空间（本修改版核心新增）

> 单机自用设计：多人部署（>1 活跃 user）下整个 tab 返回 `403 SINGLE_USER_ONLY`。

### 6.1 三个 tab 与路由

| 路由 | 页面 | 内容 |
| :--- | :--- | :--- |
| `/insights` | **会话洞察**（登录后默认落地页） | 本地 AI 会话全量观测：列表 / 时间线 / debrief / 文件变更 / commits / todos / 命令用量 / 成本 / 续会话就绪度（handoff verdict）/ 终端拉起新会话 |
| `/my-memory` | **我的记忆** | 个人 L1 观测 / L2 场景 / L3 画像三层浏览 + 源会话选择器 + 触发提炼 + 最近运行 |
| `/personal/skills` | **我的技能** | 个人私有技能库（与团队 Skills 隔离），支持目录导入 + **从对话洞察导入** |

**菜单 / 路由变化（2026-10-15）**：

- 「分层提炼」菜单项已隐藏——`LayeredRefinePage` 现在直接渲染 `MyMemoryPage`（数据全走对话记忆 personal 管线，旧 `agents/layered-refine` 引擎不再是数据源），路由 `/layered-refine` 仍可达；
- 「任务看板」菜单项已隐藏，`/` index 路由改跳 `/insights`；
- Code_Graph 前端入口隐藏（侧边栏 + 标签栏不展示，路由仍可达）。

### 6.2 后端端点

**观测面** `MemoryPanel/src/panel/http/routes/personal-space.ts`（前缀 `/api/v1/personal-space`，复用 `agents/personal-space` 派生事实引擎，单一事实来源）：

| 端点 | 说明 |
| :--- | :--- |
| `GET /mode` | 运行模式探测 |
| `GET /sessions` | 全量会话列表（索引化：stat-only 发现 + 命中零读盘） |
| `GET /facts?id=` | 单会话事实 + 时间线 + digest 事件流 + debrief / filesChanged / commits / todos / commands |
| `GET /records?id=` | 会话真实消息（归一化为 skill/extract 可消费的 messages，上限 500 条取尾部） |
| `GET /handoff?id=` | 续会话就绪度（context / compactions / branch / workspace / cache 五格 + resume/inspect/fresh 裁决） |
| `GET /synthesis?id=` | AI Synthesis 衍生（**默认关闭**，启用后 spawn 本机 codebuddy CLI，落盘缓存 + pending 轮询） |
| `POST /resume` | 拉起终端新会话（handoff 文本落盘后经 stdin 注入 CLI；纯本地动作不经 gateway） |

**个人数据面**（Panel 代理到 gateway 的对话记忆 personal 管线）：`GET /source-sessions`、`GET /pending`、`GET /memories`（L1）、`GET /scenes`（L2）、`GET /persona`（L3）、`POST /extract?layers=L1,L2,L3`。

**个人技能库** `/api/v1/personal-skills/*`：服务端注入 `team_id='personal'` + `agent_id='personal-<userId>'`（每用户虚拟 agent，保证按用户隔离）；白名单在 create / list / update / delete / versions / write-files / remove-files 之外**例外开放 `extract`**——即「从对话洞察导入对话」：选会话 → `GET /personal-space/records` 读消息 → 走与团队同一套归档→worker→`SkillCore.create` 链路，但落入个人命名空间、自动进「我的技能」列表（2026-10-15 实装）。

### 6.3 数据模型与隔离

- **scope 双轨**：`team`（团队资产）与 `personal`（个人资产），配合 `owner_user_id` 做归属；
- **存储后端三个**：`sqlite`（本机默认，零外部依赖）/ `tcvdb` / `mongodb`（试验特性，默认关闭）；
- **M3 scope 隔离已落地范围：SQLite + MongoDB**；**TCVDB 完全未做 scope**（`upsertL1` doc 无 scope 字段，失效模式是「写了也不存」而非「过滤失效」，且契约测试无 tcvdb runner 测不出）——**涉及 personal 的功能必须先做后端探测并禁用 tcvdb**；
- 切换存储后端**不迁移已有数据**（两套数据目录 / 实例相互独立）。

### 6.4 个人空间里程碑与设计文档

| 里程碑 | 状态 | 设计文档 |
| :--- | :---: | :--- |
| M0–M2 会话洞察观测面 | ✅ | `docs/personal-space-plan.html` |
| M3 双 scope 存储契约 | ✅（46 测试） | `docs/personal-space-m3-completion.html` |
| M4a 个人写入入口 | ✅（7 测试） | `docs/personal-memory-impl-plan.html` |
| M4a′ L1 管线 scope 透传 | ✅（5 测试） | 同上 |
| M4b 洞察侧入口 | ✅ 部分 | 同上 |
| M5 我的记忆 tab（联合版，7.25 人日） | 已拍板 | `docs/my-memory-tab-design.html` |

---

## 7. SDK

- **TypeScript**：`@tencentdb-agent-memory/memory-sdk-ts-v2`

  ```ts
  import { MemoryClient, SkillClient, MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

  const memory = new MemoryClient({
    endpoint, apiKey, serviceId,
    teamId, agentId, userId,     // v3 严格 isolation：三项必填
  });
  ```

- **Python**：`pip install tencentdb-agent-memory-sdk-python`

  ```python
  from tencentdb_agent_memory.v3 import MemoryClient, MetadataClient, SkillClient
  ```

---

## 8. 已知限制与注意事项

1. **TCVDB 无 personal scope**（见 6.3）：本机部署若切到 tcvdb，个人空间写入会静默丢失，需先补后端探测 + tab 禁用。
2. **L2/L3 personal 默认关**：管线已接对话记忆，但默认 opt-in 关闭，`/scenes`、`/persona` 多数情况下返回空属预期。
3. **改后端代码必须手动重启才生效**：panel 是 `tsx` 非 watch 常驻进程；前端改完要 `cd MemoryPanel/web && ./node_modules/.bin/vite build` 再到浏览器硬刷新（旧 bundle 缓存会导致白屏或旧 UI）。
4. **`local-deploy/pids/*.pid` 可能陈旧**：kill 进程一律按 `lsof -nP -iTCP:<port> -sTCP:LISTEN -t` 定位真实 PID。
5. **两套 LLM 配置互相独立**（见 2.2）：gateway `llm.*` 与 knowledge `LLM_*` env 填一处另一处仍报错。
6. **源会话 `session_id` 可能为 `null`**（无会话 ID 的整文件摄入源），前端展示需做空值兜底。
7. **Wiki / CodeGraph 异步构建**：导入后需等 processing 到 `ready`；CodeGraph 目前优先公开 HTTPS 仓库，私有仓凭据隔离已支持但仍在完善。
8. **Hub 支持手动资产绑定**：全自动记忆路由（auto-routing）仍在迭代。
9. **本仓库为个人修改版**：npm scope、Python 包名、Docker 镜像均属官方代码身份，未做改名；不要向官方仓库直接推流。

---

## 9. 本地开发验证闭环（改 MemoryPanel 的标准动作）

```bash
# 1. 改 MemoryPanel/web/src → 2. lint → 3. build → 4. 重启 → 5. 校验 bundle hash
cd MemoryPanel/web
./node_modules/.bin/eslint <改动的文件>     # rules-of-hooks 对 hook 顺序类错误是杀手锏
./node_modules/.bin/vite build
lsof -nP -iTCP:8125 -sTCP:LISTEN -t | xargs kill   # 按端口杀，别信 pids/*.pid
# 用 run_detached.py 以同参重启（HOST=0.0.0.0 PORT=8125 UI_DIST_DIR=... METADATA_INSTANCES_CONFIG=... KNOWLEDGE_SERVICE_URL=...）
curl -s http://127.0.0.1:8125/ | grep -o 'assets/main-[^"]*\.js'   # 与本地 dist/assets 最新哈希比对
```

**契约测试**（个人空间写入链路，改 `MemoryCore/src/core/record/` 后必跑）：

- `MemoryCore/src/core/record/personal-extract.test.ts` —— M4a 写入入口（7 例）
- `MemoryCore/src/core/record/l1-scope-passthrough.test.ts` —— M4a′ scope 透传（5 例）
- M3 存储契约测试 46 例（SQLite + MongoDB runner）

**无头浏览器回归**（验证页面真渲染而非静态推断）：本机 playwright + 系统 Chrome，登录（本地 admin key `sk-mem-local-admin`）→ goto `#/<route>` → 断言无 `Unexpected Application Error` / `Minified React error` → 截图。

---

## 10. 相关文档

| 文档 | 内容 |
| :--- | :--- |
| [CHANGELOG.md](./CHANGELOG.md) | 全模块变更记录（官方线最新 2.0.2 / 2026-10-09 + Unreleased 改名条目） |
| [ROADMAP.md](./ROADMAP.md) / [ROADMAP_CN.md](./ROADMAP_CN.md) | 官方路线图 |
| [INSTALL.md](./INSTALL.md) / [INSTALL_CN.md](./INSTALL_CN.md) | 完整安装（含 MongoDB 试验后端、数据分析可观测性） |
| [local-deploy/README-local.md](./local-deploy/README-local.md) | 无 Docker 原生部署细则 |
| [agents/README.md](./agents/README.md) | 客户端适配总览 |
| [MemoryCore/scripts/migrate-v2-to-v3/README.md](./MemoryCore/scripts/migrate-v2-to-v3/README.md) | v2 → v3 数据迁移工具 |
| [docs/personal-space-plan.html](./docs/personal-space-plan.html) | 个人空间总方案 + M0–M5 路线图 |
| [docs/my-memory-tab-design.html](./docs/my-memory-tab-design.html) | 我的记忆 tab UI/逻辑设计 |
| [L0-L3-记忆分层提炼机制详解.html](./L0-L3-记忆分层提炼机制详解.html) | 记忆分层提炼权威文档 |
| API 文档 | `MemoryCore/v3-api-memorycore-doc.md`、`MemoryKnowledge/v3-api-memoryknowledge-doc.md`、`MemoryProxy/v3-api-memoryproxy-doc.md`、`MemoryPanel/panel-api-doc.md` |

---

## 11. 许可与声明

- 官方 `LICENSE`（MIT）与 Tencent 版权声明完整保留；本修改版同样以 MIT 提供。
- 本仓库为**个人修改 / 派生版本**，非官方发布渠道，仅供个人学习 / 本地自用。
- 致谢：CodeGraph（colbymchenry/codegraph，CodeGraph 资产模块使用其代码）、Hermes Agent（Nous Research，Skill 资产管理使用其部分代码并持续优化）、Andrej Karpathy 的 LLM Wiki 实践（Wiki 层设计来源）。
- Benchmark：PersonaMem 48% → 76%（+59%，相对无记忆基线）。
