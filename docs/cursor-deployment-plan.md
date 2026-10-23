# 推荐策略组记忆资产在 Agent 中的检索调用机制 & Cursor 部署方案

> 研究对象：`team-7xulumcvyl`（推荐策略组）4 位真实成员的 **对话记忆 / Skill / Wiki**
> 目标：搞清楚"这部分数据在本项目的 agent 里是怎么被检索调用的"，并给出在 **Cursor** 部署的实现方案。
> 结论：**数据已就位、检索通路已验证可行**，Cursor 走 **MCP Server** 是最顺、最原生的落地方式（脚手架已交付）。

---

## 0. 结论先行（TL;DR）

1. **本项目的记忆检索有两条通路**：
   - **透明代理模式**（MemoryProxy `:8096`）：把 LLM 的 API 请求拦截下来，自动把 L2/L3 记忆、Skill、Wiki **注入 system prompt**，再转发上游。适合"零代码、被动注入"。
   - **SDK / MCP 直接模式**（MemoryCore `:8420` v3 数据面 + MemoryKnowledge `:8421`）：Agent 主动调工具检索。适合"按需检索、工具式调用"。**Cursor 原生支持 MCP，走这条。**
2. **作用域靠隔离三元组**：每条检索都带 `(team_id, agent_id, user_id)`。4 位成员只是 `agent_id/user_id` 不同，全在同一个 `team-7xulumcvyl` 下。
3. **已实测**：对 `core:8420` 直接调 v3 接口，4 位成员的 L1/L2/L3 全部可达（见 §2 验证表）。`memory_search('曝光衰减')` 扇出结果 product=3 / algorithm=3 / qa=2 / engineering=0。
4. **Cursor 落地 = 一个 MCP Server**（已写：`agents/cursor/mcp-server/memory_mcp_server.py`）+ 一份 `.cursorrules`（知识路由指引）。Agent 用 `member="all"` 即可一次性检索全团队，或指定某位成员精准检索。

---

## 1. 本项目里"agent 检索调用记忆"到底怎么发生的

### 1.1 架构全景

```
┌──────────────────────────────────────────────────────────────┐
│  Agent 客户端（Claude Code / Cursor / CodeBuddy / WorkBuddy…）│
└───────────────┬──────────────────────────┬──────────────────┘
                │ ① 透明代理模式           │ ② SDK / MCP 直接模式
                ▼                          ▼
        MemoryProxy :8096            MemoryCore :8420 (v3 数据面)
   auth→sessionInit(form)→注入→转发     /v3/atomic|conversation|scenario|core|skill
                                          │
                                          └─ 团队 Wiki/CodeGraph → MemoryKnowledge :8421 (/v3/wiki/*)
```

两套通路共享同一个 **v3 数据面**（同一套隔离三元组、同一套信封 `{code,data}`），所以"检索什么、怎么隔离"在两种模式下完全一致，区别只在**谁触发、谁决定注入**。

### 1.2 模式一：透明代理（被动注入）

- 把客户端的 LLM API Base URL 指向 Proxy（如 `http://127.0.0.1:8096/codebuddy/default`），协议伪装成 7 种已适配源之一。
- Proxy 链路：`auth（校验 user_key）→ sessionInit（team/agent/task 表单）→ injection（把 L2/L3 记忆 + Skill + knowledge 注入 system prompt）→ 转发上游 LLM`。
- 注入内容（以 codebuddy 为例，`MemoryProxy/src/injection/agents/codebuddy/profile.ts`）：persona / skills(`<agent_skills>`) / memories / knowledge 分别落到对应 XML tag。
- **优点**：零代码，Agent 启动时自动获得团队上下文。
- **缺点**：需要客户端能配合走"表单选 team/agent"或能带预选 Header（`x-team-id`/`x-agent-id`/`x-task-id`/`x-conversation-id`）。**Cursor 的自定义 Base URL 不支持自定义 Header、也不渲染交互表单** → 直连 Proxy 会卡在 sessionInit。要走通需加一个"Header 注入 shim"（见 §3.2）。

### 1.3 模式二：SDK / MCP（主动检索）

- 记忆 SDK（`sdk/memory-core/python`，已含 v3 全部接口）暴露给 Agent 一组工具：
  - `search_atomic` → `POST /v3/atomic/search`（L1 原子记忆）
  - `search_conversation` → `POST /v3/conversation/search`（L0 原始对话）
  - `list_scenarios` / `read_scenario` → `/v3/scenario/ls|read`（L2 场景块）
  - `read_core` → `/v3/core/read`（L3 用户画像 persona.md）
  - Skill：`/v3/skill/search|get`（scope=team 可跨成员）
  - Wiki：MemoryKnowledge 的 MCP（`MemoryKnowledge/src/mcp/server.ts`）暴露 `wiki_search|wiki_read|wiki_list|wiki_graph`。
- **Cursor 原生支持 MCP**，把这套工具以 MCP Server 形式接进去即可 → 这就是本方案选的路。

### 1.4 隔离三元组与作用域（关键）

| 资产 | 隔离字段 | 备注 |
|---|---|---|
| 对话记忆 L1 (`atomic`) | `team_id / agent_id / user_id` | 读可省略 `session_id` → 跨会话聚合 |
| 对话 L0 (`conversation`) | `team_id / agent_id / user_id` | 同上 |
| 场景 L2 / 画像 L3 | `team_id / agent_id` | 团队+Agent 画像，不含 session |
| Skill | `team_id / agent_id / user_id`；`scope="team"` 可忽略 agent | 团队级检索用 scope=team |
| Wiki | `team_id`（共享，`agent_id=null`，owner=admin） | 需先 `wiki_list` 拿 `wiki_id` |

> ⚠️ 已知坑（来自项目记忆）：`tcvdb` 后端**完全无 scope**（写了不存），personal 功能必须探测并禁用 tcvdb；本地部署用 `sqlite` 后端可规避。本方案只读、且走 v3 数据面，不受影响。

### 1.5 两层加载（来自 `docs/agent-memory-orchestration.md`）

该文档已把"记忆怎么进 Agent"抽象成两层，并指出 **Cursor 是目标客户端之一**：
- **原理层（常驻 system）**：L3 persona + L2 scene-nav + 一张"知识地图(knowledge-router)"，每轮稳定注入。
- **索引层（按需）**：L1/L0 召回 + 工具检索，Agent 自己决定何时调。
- 文档核心教训：**"工具在 ≠ 真生效"**——必须明确告诉 Agent"何时用哪个工具"。本方案用 `.cursorrules` 扮演这张知识地图。

---

## 2. 4 位成员的数据现状（已实测）

团队 `team-7xulumcvyl` 成员绑定（终态）：

| member key | 角色 | agent_id | user_id |
|---|---|---|---|
| `product` | 产品 | `agt-rec-product` | `usr-0rwbvul43m` |
| `engineering` | 工程 | `agt-ar4478rrd5` | `usr-ar449snyl0` |
| `algorithm` | 算法 | `agt-ar6gyp3yv7` | `usr-ar6gbwfwon` |
| `qa` | 质量 | `agt-ar6z1agmqn` | `usr-ar6zd4p8vv` |

**实测（直连 `core:8420`，`Bearer sk-mem-local-admin` + `x-tdai-service-id: default`）：**

```
member      role     L1   L2  L3?  scenario examples
product     产品     ✓     3    Y   内容治理-曝光衰减与视频分发.md, 指标口径与AB决策.md
engineering 工程     ✓     3    Y   AI协同编码与review.md, 发布与稳定性-模型上线与回滚.md
algorithm   算法     ✓     3    Y  召回与向量化.md, 实验方法论-离线在线一致性.md
qa          质量     ✓     3    Y  Badcase分层归因.md, Evals体系与维护.md

memory_search('曝光衰减') 跨成员扇出：product=3, algorithm=3, qa=2, engineering=0
```

> 说明：L1 `atomic/count` 返回字段为空（计数口径问题），但 `atomic/search` 能正常返回命中条目，说明 **L1 原子记忆确实已落库并可读**。L2/L3 全部就位。
> Wiki 走 `KS:8421`，需确保 Knowledge Service 已启动（`/health` 才通），否则 wiki_* 工具返回错误——属正常，不影响记忆/Skill 检索。

---

## 3. Cursor 部署方案

### 3.1 推荐方案：MCP Server（已实现）

把"记忆检索"封装成一个 stdio MCP Server，Cursor 通过 `.cursor/mcp.json` 拉起。这是 **Cursor 最原生、最可控** 的方式。

**已交付文件：**

| 文件 | 作用 |
|---|---|
| `agents/cursor/mcp-server/memory_mcp_server.py` | 统一记忆 MCP Server（FastMCP），封装 4 位成员的 L0-L3 / Skill / Wiki 检索，`member` 参数支持 `all` 扇出 |
| `agents/cursor/mcp-server/requirements.txt` | 依赖：`mcp>=1.0`, `httpx` |
| `agents/cursor/.cursor/mcp.json` | Cursor MCP 配置示例（改绝对路径后复制到项目 `.cursor/`） |
| `agents/cursor/.cursorrules` | 知识路由指引，告诉 Agent 何时调哪个工具 |
| `agents/cursor/README.md` | 完整部署步骤 |

**暴露的工具（均带 `member` 参数，`all` = 4 成员扇出合并）：**
`list_members` · `team_status` · `memory_search`(L1) · `conversation_search`(L0) · `list_scenarios`(L2) · `scene_read`(L2) · `persona_read`(L3) · `skill_search`(team 级) · `skill_view` · `wiki_search` · `wiki_read` · `wiki_list`

**运行步骤（详见 `agents/cursor/README.md`）：**
```bash
# 1) 装依赖
python3 -m venv .venv && . .venv/bin/activate
pip install -r agents/cursor/mcp-server/requirements.txt
# 2) 把 .cursor/mcp.json 与 .cursorrules 复制到 Cursor 项目根 .cursor/
# 3) 重启 Cursor → Settings → MCP → team7-memory 工具全绿
```

### 3.2 备选方案：透明代理模式（零代码被动注入）

若你想要"Agent 一启动就自动带上团队记忆/L2/L3 画像"（而非靠工具主动检索），可走 Proxy 模式：
- 把 Cursor 的 LLM API Base URL 指向 `http://<proxy>:8096/codebuddy/default`，伪装成 `codebuddy`（OpenAI Chat Completions，与 Cursor 协议最接近）。
- **卡点**：Cursor 无法发 `x-team-id/x-agent-id/x-task-id` 预选 Header，也不会渲染 sessionInit 表单 → 需在你机器前加一个**极薄的反向代理 shim**（nginx/caddy/小脚本），把 team/agent headers 注入后再转给 MemoryProxy，让它跳过表单直接注入。
- 该模式**一次只能绑定 1 个 member**（header 写死 agent_id）；想覆盖 4 位成员需跑多个实例或动态切 header。

**对比：**

| 维度 | MCP Server（推荐） | 透明代理 + shim |
|---|---|---|
| Cursor 适配度 | 原生 MCP，零 hack | 需 shim 注入 header |
| 检索粒度 | 可 `all` 扇出 或 指定单人 | 仅 header 写死的单人 |
| 是否自动注入 L3 画像 | 靠 `.cursorrules` + `persona_read` 按需 | 自动注入 system |
| 实现成本 | 已交付，改路径即用 | 需另写 shim、维护多实例 |
| 写回记忆 | 本 server 只读（安全） | 代理会归档对话（有副作用） |

> 建议：**先用 MCP 方案**拿到"可检索 4 人资产"的能力；等想要"长期画像自动常驻"时再叠加 Proxy 方案。

---

## 4. 验证结果（已实跑）

- ✅ Server 语法 `py_compile` 通过。
- ✅ 直连 `core:8420` 复刻 server 检索逻辑，4 位成员 L1/L2/L3 **全部可达**（§2 表）。
- ✅ 跨成员扇出检索 `memory_search('曝光衰减')` 正确分成员返回命中数。
- ⚠️ `KS:8421` 当前 `/health` 返回 502（Knowledge Service 未随一体镜像启动），wiki_* 工具需先 `pnpm --filter ... dev` 或起 KS 容器；不影响记忆/Skill。

---

## 5. 注意事项 / 坑

1. **鉴权**：v3 数据面**必须**带 `Authorization: Bearer <api_key>`（本地 `sk-mem-local-admin`，生产用面板业务 user_key）+ `x-tdai-service-id`。空 Bearer 直接 401。
2. **改团队/成员**：只改 `memory_mcp_server.py` 顶部 `MEMBERS` 字典 + `TEAM_ID` 即可，无需动路由。
3. **`session_id`**：读接口省略即跨会话聚合；只有 `add_conversation`（写）才强制 session_id——本 server 只读，不涉及。
4. **Wiki 共享模型**：Wiki 是团队共享（`agent_id=null`），所以 `wiki_*` 不走 member 隔离，需先 `wiki_list(wiki_id)` 拿库 id。
5. **检索预算**：`.cursorrules` 已约束"一轮检索 ≤3 次"，避免 Agent 反复瞎搜。
6. **service 在线**：记忆/Skill 依赖 `core:8420`；Wiki 依赖 `KS:8421`。部署前确认两者在跑。
