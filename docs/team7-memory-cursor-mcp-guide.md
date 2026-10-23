# 在 Cursor 中调用推荐策略组团队 MCP 的方法（team7-memory）

> 适用对象：推荐策略组 `team-7xulumcvyl`（4 位真实成员）
> 用途：把团队的「对话记忆(L0–L3) / Skill / Wiki」通过 MCP 工具暴露给 Cursor，让 Agent 按需检索。
> 性质：**只读检索**，不回写记忆（区别于 MemoryProxy 的透明注入 + 回写模式）。
> 本文为可复用的操作参考，后续移植到 WorkBuddy 见第 9 节。

---

## 1. 这是什么 / 数据流

```
Cursor (Agent 模式)
   │  MCP over stdio
   ▼
memory_mcp_server.py  (本仓库 agents/cursor/mcp-server/)
   │  HTTP /v3/*
   ├──────────────────▶  MemoryCore        :8420   （记忆 / Skill 数据面）
   └──────────────────▶  MemoryKnowledge   :8424   （Wiki 数据面）
```

- 鉴权：`Authorization: Bearer <API_KEY>` + `x-tdai-service-id: <SERVICE_ID>`
- 隔离三元组：`(team_id, agent_id, user_id)` 决定检索归属
- `member="all"` 会对 4 位成员分别检索并合并结果（每条带 `member` 标签，便于溯源）

---

## 2. 前置条件

| 项 | 说明 | 当前状态（本机） |
|---|---|---|
| MemoryCore | 端口 **8420**，记忆 / Skill 来源（必需） | ✅ 200 在运行 |
| MemoryKnowledge | 端口 **8424**（**不是 8421**，见第 8 节坑 2），Wiki 来源（用 wiki 工具时必需） | ✅ 200 在运行 |
| MemoryProxy | 端口 8096，透明代理模式用，**MCP 方案非必需** | ✅ 200（可不管） |
| Python 依赖 | `mcp>=1.9,<2` + `httpx>=0.24`（见坑 1） | ✅ 已装于受管 venv |

> 三个后端服务只要「在运行」，Cursor 侧无需安装任何东西。重启电脑后服务会停，只需重新起 core(8420) 与 KS(8424)。

---

## 3. 配置（写进 Cursor 的 mcp.json）

Cursor 通过 `mcp.json` 拉起 server。**全局**写到 `~/.cursor/mcp.json`（对所有项目生效）；**项目级**写到你的项目根 `.cursor/mcp.json`。

```json
{
  "mcpServers": {
    "team7-memory": {
      "command": "/Users/dandan/.workbuddy/binaries/python/envs/default/bin/python",
      "args": [
        "/Users/dandan/Projects/TencentDB-Agent-Memory/agents/cursor/mcp-server/memory_mcp_server.py"
      ],
      "env": {
        "MEMORY_ENDPOINT": "http://127.0.0.1:8420",
        "KNOWLEDGE_ENDPOINT": "http://127.0.0.1:8424",
        "SERVICE_ID": "default",
        "MEMORY_API_KEY": "sk-mem-local-admin",
        "TEAM_ID": "team-7xulumcvyl"
      }
    }
  }
}
```

环境变量含义：

| 变量 | 作用 | 本地值 |
|---|---|---|
| `MEMORY_ENDPOINT` | core 地址（记忆 / Skill） | `http://127.0.0.1:8420` |
| `KNOWLEDGE_ENDPOINT` | KS 地址（Wiki，注意是 **8424**） | `http://127.0.0.1:8424` |
| `SERVICE_ID` | 隔离 service-id，缺它会 400 | `default` |
| `MEMORY_API_KEY` | core 鉴权 Bearer；本地为固定值，生产换业务 user_key | `sk-mem-local-admin` |
| `TEAM_ID` | 团队 ID（改团队时改这里 + 脚本内 `MEMBERS`） | `team-7xulumcvyl` |

另需把 `agents/cursor/.cursorrules` 复制到项目根 `.cursorrules`（或在 Cursor 的 Project Rules 粘贴），让 Agent 知道「何时调哪个工具 / 复合任务三类同调」。

---

## 4. 12 个工具清单

| # | 工具 | 作用 | 关键参数 |
|---|---|---|---|
| 1 | `list_members()` | 列出 4 成员及 `agent_id`/`user_id`/角色 | — |
| 2 | `team_status()` | 团队资产快照：逐成员 L1/L2/L3/Skill 计数，确认数据已灌入 | — |
| 3 | `memory_search(query, member="all", limit=5, type=None)` | L1 原子记忆检索（偏好/规则/事件/事实） | `member`=all/product/engineering/algorithm/qa；`type` 可过滤 preference/rule/event/fact |
| 4 | `conversation_search(query, member="all", limit=5)` | L0 原始对话片段检索（核对原文） | 同上 |
| 5 | `scene_read(path, member="product")` | 读某成员 L2 场景块全文 | `path` 来自 `list_scenarios` / `memory_search` 返回 |
| 6 | `list_scenarios(member="all")` | 列出 L2 场景块路径索引（只读路径） | — |
| 7 | `persona_read(member="all")` | 读 L3 persona.md（长期画像/原则） | — |
| 8 | `skill_search(query, member="all", scope="team", limit=10)` | 检索 Skill（可复用 SOP/配方） | `scope=team` 跨成员；`scope=member` 仅单人 |
| 9 | `skill_view(skill_id, member="product")` | 读单个 Skill 的 SKILL.md 全文 + manifest | `skill_id` 来自 `skill_search` |
| 10 | `wiki_search(query, wiki_key="shared", limit=20, hop=0)` | 检索 Wiki（BM25 + 可选图谱多跳） | `wiki_key`=shared/product/engineering/algorithm/qa/all |
| 11 | `wiki_read(wiki_key="shared", refs=None)` | 按页面 id/路径读 Wiki 正文 | `refs` 为页面引用数组 |
| 12 | `wiki_list(wiki_key="shared")` | 列出某 Wiki 全部页面（标题/类型/路径） | — |

---

## 5. 成员与 Wiki 映射（member / wiki_key 取值）

**4 位成员（隔离三元组，终态绑定）：**

| member | 角色 | agent_id | user_id |
|---|---|---|---|
| `product` | 产品 | `agt-rec-product` | `usr-0rwbvul43m`（admin） |
| `engineering` | 工程 | `agt-ar4478rrd5` | `usr-ar449snyl0`（PengShi） |
| `algorithm` | 算法 | `agt-ar6gyp3yv7` | `usr-ar6gbwfwon`（PengChengZhuo） |
| `qa` | 质量 | `agt-ar6z1agmqn` | `usr-ar6zd4p8vv`（YaoYao） |

**5 个 Wiki（KS:8424，均 ready）：**

| wiki_key | wiki_id | 说明 |
|---|---|---|
| `shared` | `wiki-rec-shared` | 推荐策略组·共享百科（团队级首选） |
| `product` | `wiki-rec-product` | 产品 |
| `engineering` | `wiki-rec-engineering` | 工程 |
| `algorithm` | `wiki-rec-algorithm` | 算法 |
| `qa` | `wiki-rec-qa` | 质量 |

> 改团队 / 换成员：改 `memory_mcp_server.py` 顶部的 `MEMBERS` 字典 + `WIKI_IDS` + 环境变量 `TEAM_ID` 即可，其余不动。

---

## 6. 在 Cursor 中如何调用（操作步骤）

1. **配置已写入** `~/.cursor/mcp.json`（见第 3 节），并已复制 `.cursorrules`。
2. **重启 Cursor**（或 `Cmd+Shift+P → Reload`）。
3. 打开 `Customize → MCPs`，确认 `team7-memory` 显示 **绿色 · 12 tools enabled**。
4. **必须切到 Agent / Composer 模式**（纯 Chat 模式不加载 MCP 工具，调用会失败或根本不触发）。
5. **新开一个对话**，直接提问。复合任务可显式点名工具，例如末尾加一句：
   > 「请先调用 `memory_search`、`skill_search`、`wiki_search` 三类工具检索后再综合回答。」

**三类同调示例问题（推荐场景，直接复制）：**

> 我们打算在首页信息流新上一个「低质内容曝光衰减打压」策略，准备向老板汇报。请帮我：① 先回顾团队之前对曝光衰减打压的讨论结论和当前状态（**对话记忆**）；② 找一个能规范我汇报口径/实验结论的 **skill** 来复用；③ 去团队 **Wiki** 查「推荐指标口径」的官方定义，确保我用对 pv/uv 口径。综合这三类信息，给我一份汇报要点。

**冒烟验证（接通用）：** 在 Agent 模式问「调用 `list_members` 工具，列出推荐策略组有哪些成员」——返回 4 位成员即链路通。

---

## 7. A/B 对照：验证「有无记忆」的差异

- **无记忆组**：`Customize → MCPs` 关掉 `team7-memory` → 问同一题。
- **有记忆组**：重新打开 `team7-memory` → 问**完全一样**的题（若没主动调工具，点名三类工具名）。
- 关/开开关后建议**新开对话**，避免上下文串味。

**判定标准（差异强度从高到低）：**

| 信号 | 无记忆 | 有记忆（命中私有知识） |
|---|---|---|
| 特征词 | 只说「指标要定义清楚」「要打压低质内容」等常识 | 出现 **林夏 / 三件套 / 7d·30d·180d 窗口 / metric-caliber-guard / 推荐指标口径速查 / 待排期进 AB** |
| 状态感 | 泛泛而谈 | 能说出团队真实的「未拍板 / 待验证」状态 |

有记忆组只要冒出上表右列任意一个私有词，即证明记忆生效。

---

## 8. 关键技术坑（已踩过，务必注意）

1. **`mcp` 必须锁 `<2`**：`mcp` 2.x 把 `FastMCP` 改名为 `MCPServer`（`from mcp.server.mcpserver import MCPServer`）。裸 `pip install mcp` 在全新环境会装到 2.x，直接 `ModuleNotFoundError: mcp.server.fastmcp`。依赖已锁 `mcp>=1.9,<2`（实测 1.30.0 可用）。
2. **KS 端口是 8424，不是 8421**：文档里偶尔写的 8421 是过时的；`local-deploy/knowledge-wrapper.sh` 里 `export PORT=8424`，本机 8421 无任何服务。`KNOWLEDGE_ENDPOINT` 必须填 8424，否则 wiki 工具永远连不上。
3. **KS 缺 `x-tdai-service-id` 头会 400**：该头 core 不用但 KS 强制要，server 的 `_ks_headers()` 已补。
4. **返回信封兼容**：`atomic/search`、`conversation/search` 返回平铺 `{items:[...]}`，没有 `code/data` 外层；`count`/`skill/list` 返回 `data.total`。server 的 `_call` 已做信封无关处理（早期版本曾因假设 `data` 包装导致全部检索假阴性，已修）。
5. **Skill 空检 ≠ 没数据**：本机 `embedding.provider=none` 时向量召回弱，但 `skill_search(..., scope="team")` 走关键词/元数据仍能命中（已验证 `metric-caliber-guard`、`ab-experiment-review`、`recsys-spec-writer` 等可搜到）。若仍空，可用 `skill_view(skill_id, member="product")` 直接按 id 读。
6. **代理不拦内网**：沙箱/本机的 `CODEBUDDY_SERVICE_PROXY_URL` 不被 httpx 识别（httpx 只认 `HTTP_PROXY/HTTPS_PROXY`），故直连 `127.0.0.1:8420/8424` 成功。

---

## 9. 移植到 WorkBuddy 的注意事项（供后续使用）

本文档的方法可直接复用到 WorkBuddy，要点：

- **server 脚本可直接复用**：`agents/cursor/mcp-server/memory_mcp_server.py` 是独立的 stdio MCP server，与客户端无关，WorkBuddy 也能以 MCP 方式挂载。
- **MCP 配置位置同构**：WorkBuddy 的 MCP 配置在 `~/.workbuddy/mcp.json`，格式与 Cursor 的 `mcp.json` 完全一致（同样的 `mcpServers.{name}.command/args/env`）。把第 3 节的 JSON 原样写进去即可。
- **python 路径**：`command` 需用 WorkBuddy 环境下能 import `mcp` 的 python 绝对路径（本机受管 venv 已装；换环境先 `pip install "mcp>=1.9,<2" httpx`）。
- **远程 / 生产部署**：把 `MEMORY_ENDPOINT` / `KNOWLEDGE_ENDPOINT` 改成对端地址（如 `http://<远程IP>:8420`），`MEMORY_API_KEY` 换成面板「API Key」页的业务 user_key，`SERVICE_ID` 按对端填。
- **只读定位不变**：该 server 只检索不回写；若要在 WorkBuddy 里让对话沉淀回团队记忆（类似 Proxy 的 L0 回写），需另接回写 endpoint，不在本 server 范围内。

---

## 10. 相关文件索引

| 文件 | 说明 |
|---|---|
| `agents/cursor/mcp-server/memory_mcp_server.py` | MCP server 主程序（12 工具） |
| `agents/cursor/mcp-server/requirements.txt` | 锁版依赖（`mcp>=1.9,<2` + `httpx>=0.24`） |
| `agents/cursor/.cursor/mcp.json` | Cursor 项目级配置模板 |
| `agents/cursor/.cursorrules` | 检索指引（何时调哪个工具 / 三类同调） |
| `agents/cursor/README.md` | Cursor 接入说明 |
| `docs/cursor-deployment-plan.md` | 部署方案研究文档（机制 / 两种模式对比） |
| `~/.cursor/mcp.json` | 本机已写入的全局 Cursor 配置（已生效） |
