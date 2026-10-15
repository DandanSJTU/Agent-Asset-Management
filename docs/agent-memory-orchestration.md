# Agent 记忆编排方案：把「跨 Agent 部署与检索指南」映射到本项目数据

> 目标：基于 `context-infrastructure/跨Agent部署与检索指南.md` 的心智模型，重新编排本项目的
> **Wiki / Skill / 对话(L0) / 记忆(L0–L3)** 四类知识，让任意接入的 agent 都能「确定性地加载原则 + 按需检索索引」。

---

## 0. 结论先行（TL;DR）

1. **指南的模型 = 两区加载**：`L3 确定性被动加载`（入口文件强制每会话读 = 原则层）+ `L1/L2 主动检索`（grep/语义/路由表 = 索引层）。本项目 `auto-recall.ts` **已经在做这件事**，只不过只覆盖记忆与对话，**漏了 Wiki 和 Skill**。
2. **工具其实都存在**，但散落在三个服务面：
   - MemoryCore(`:8420`) → `tdai_memory_search`(L1) / `tdai_conversation_search`(L0)
   - MemoryKnowledge(`:8424`) → `wiki_search / wiki_read / wiki_list / wiki_graph`（MCP 工具）
   - MemoryProxy(`:8096`) → `skill_search / skill_view / skill_files_read`（注入式工具）
3. **真正断点不是"没有工具"，而是"没有统一的入口地图"**：`auto-recall.ts` 注入给 agent 的 `memory-tools-guide` **只列了前两个工具**，wiki/skill 不在其中 → 即使工具可用，agent 也不知道去调（指南说的"能塞进去 ≠ 真生效"）。
4. **编排核心 = 三件事**：① 把 `memory-tools-guide` 升级成**全量 `knowledge-router` 块**（本项目的 AGENTS.md 等价物）；② 新增**统一扇出工具 `tdai_knowledge_search`**（按 `source_type`+`scope`+`team_id` 四维扇出）；③ 把 gateway 当作 **canonical 单一事实源**，各 agent 用凭证 overlay 接入。

---

## 1. 指南心智模型 → 本项目对应物（一一映射）

| 指南概念 | 含义 | 本项目对应物（现状） |
|---|---|---|
| **`AGENTS.md`（入口）** | 每会话强制读取的路由表 | `auto-recall.ts` 注入的 system 块（`user-persona`+`scene-navigation`+`memory-tools-guide`） |
| **L3 确定性被动加载** | 关不掉、必进上下文 | `appendSystemContext`：L3 persona + L2 scene-nav（稳定可缓存）✅ 已做 |
| **L1/L2 主动检索** | 按需命中、不常驻 | `prependContext`：L1 每轮 recall + 搜索工具按需取 ✅ 已做（但只限记忆/对话） |
| **`rules/USER.md`** | 身份与偏好 | 本项目 L3 `persona.md`（长期画像/偏好）— 同一角色 |
| **`rules/WORKSPACE.md` / `skills/INDEX.md`** | 文件路由索引 | **缺失**：没有统一的"知识来源索引"，agent 不知有哪些源可查 |
| **`OBSERVATIONS.md`（L1/L2 动态记忆）** | append-only 动态记忆 | `l1_records` + `conversations/*.jsonl` + `scene_blocks/*.md` |
| **`semantic_search/` CLI** | 向量检索 | `tdai_memory_search`（FTS5+向量 RRF）已具备；wiki/skill 各有独立检索 |
| **canonical repo + 软链** | 跨 agent 单一事实源 | 本项目的 **gateway API 簇**（core/knowledge/proxy）已是单一事实源 |
| **`.env` 私有 overlay** | 各 agent 私有凭证 | 各 agent 的 `serviceToken` / `team_id` / `scope` / embedding endpoint |

**一句话**：指南的"文件夹 + 软链"模型，在本项目里等价于"**一个 gateway 事实源 + 各 agent 的凭证 + 一个注入的 knowledge-router 块**"。不需要软链，因为知识本来就是中心化存储的。

---

## 2. 现状盘点：四类知识的「原则 / 索引」角色 + 现有工具面

| 知识类型 | 原则层（常驻 system） | 索引层（按需检索） | 现有 agent 工具 | 个人空间覆盖 | 缺口 |
|---|---|---|---|---|---|
| **Wiki** | ❌ 否（纯团队态） | ✅ 是 | `wiki_search`/`wiki_read`/`wiki_list`/`wiki_graph`（MemoryKnowledge MCP） | ❌ 无 wiki 端点 | 未进 `knowledge-router`；无 personal |
| **Skill** | ❌ 否 | ✅ 是 | `skill_search`/`skill_view`/`skill_files_read`（MemoryProxy 注入） | ✅ 个人命名空间 `team_id='personal'` | 未进 `knowledge-router`；物理混放靠列隔离 |
| **对话 L0** | ❌ 否 | ✅ 是 | `tdai_conversation_search`（MemoryCore） | ✅ | 已基本 OK |
| **记忆 L1** | ⚠️ 部分（`instruction`/`priority=-1` 可常驻） | ✅ 是 | `tdai_memory_search`（hybrid RRF） | ✅ | 已基本 OK |
| **记忆 L2** scene | ✅ 是（scene-nav 全量注入） | ✅ 也是索引（指向 `scene_blocks/*.md`） | 经 memory_search/文件读 | ✅ | OK（双角色） |
| **记忆 L3** persona | ✅ 是（常驻 system） | ❌ 否 | 经 auto-recall 注入 | ✅ | OK（纯原则） |

> 关键事实：`auto-recall.ts` 的 `MEMORY_TOOLS_GUIDE` 仅指令 agent 调用 `tdai_memory_search` + `tdai_conversation_search`（且「每轮合计最多 3 次」）。**Wiki/Skill 工具完全不在这个指南里**——这就是"工具在、但 agent 不调"的根因。

---

## 3. 三大断点（为什么现在 agent 不能一站式检索调用）

### 断点 A：工具散落三处，无统一入口
- agent 必须分别连 core(:8420) + knowledge MCP(:8424) + proxy(:8096) 三套面，才知道"记忆/对话/ wiki/skill"各去哪查。
- 单接 core 的 agent 只能搜记忆+对话，**wiki/skill 对它完全不可见**。

### 断点 B：缺一张"知识地图"（AGENTS.md 等价物）
- `memory-tools-guide` 是"半张地图"：只画了记忆+对话两条路，没画 wiki/skill。
- 指南核心教训：**能塞进去 ≠ 真生效**。工具暴露了但 agent 没被明确告知"何时用哪个"，检索就靠运气。

### 断点 C：无统一 `source_type` 维度的扇出检索
- 现在每次要 agent 自己判断"该调 wiki_search 还是 skill_search 还是 memory_search"，跨源对比/联合召回做不到。
- personal/team 隔离在 wiki（路径级、无 personal）与 skill/conversation（列级）不一致；TCVDB 后端仍无 scope 下推（涉及 personal 必须运行时探测并禁用 tcvdb）。

---

## 4. 编排蓝图（怎么让 agent 检索调用）

### 4.1 原则层：升级 `memory-tools-guide` → 全量 `knowledge-router` 块
把 `auto-recall.ts` 里那段只列两个工具的指南，扩成**本项目的 AGENTS.md 等价物**，注入 system prompt（稳定、可缓存）：

```
<knowledge-router>
你有以下四类可检索知识源，按任务类型选用：
1. 记忆 L1（事实/偏好/指令/事件）：tdai_memory_search —— 回忆用户偏好、历史节点、规则
2. 对话 L0（原始消息/时间线）：tdai_conversation_search —— 查原文、核对上下文
3. Wiki 知识库（团队规范/文档）：tdai_wiki_search —— 查"我们团队关于 X 的官方定义/流程"
4. Skill 技能（怎么做 X 的 SOP）：tdai_skill_search —— 找可复用的执行配方
调用策略：先判断任务属于"记什么/查原文/查规范/找做法"哪一类，再选对应工具；
跨源综合问题优先用 tdai_knowledge_search 一次扇出。
</knowledge-router>
```

> 这就是指南里 `AGENTS.md` 的角色：把"有哪些源、何时用"确定性地塞进每轮上下文，消除检索运气。

### 4.2 索引层：新增统一扇出工具 `tdai_knowledge_search`
在 gateway 层新增一个**聚合检索**工具，后端并行扇出到四个子检索器，结果统一打 `source_type` 标签回传：

| 参数 | 说明 |
|---|---|
| `query` | 自然语言问题 |
| `source_type[]` | `wiki` / `skill` / `memory` / `conversation`（默认全扇出） |
| `scope` | `personal` / `team` |
| `team_id` / `user_id` / `agent_id` | 隔离维度（必带，防跨租户串数据） |
| `limit` / `score_threshold` | 总量预算（沿用现有 L1 的 budget 截断逻辑） |

后端实现：复用已有四个检索器——
- `memory-search.ts` 的 `recallL1Candidates`（hybrid RRF）
- MemoryKnowledge 的 `wiki_search`（FTS5 BM25 + 图谱多跳）
- MemoryProxy 的 `skill_search`（BM25 / vec / hybrid）
- `conversation-search.ts`

保留各子工具做**深查**：`wiki_read` 拿全文、`skill_view` 拿 SKILL.md、`tdai_memory_search` 带 `type`/`scene` 精筛。

### 4.3 层级 → 注入映射（复用 auto-recall 现有二分，不重造）
- **稳定区（system, 可缓存）= 原则层**：L3 persona + L2 scene-nav + **新增的 `knowledge-router` 块**。
- **动态区（每轮, prepend）= 索引层**：L1 `<relevant-memories>` 召回 + 按需 `tdai_knowledge_search` 命中。
- **检索预算**：指南说"最多 3 次"，建议统一为 `tdai_knowledge_search`（含子扇出）的调用预算，避免 agent 滥用。

### 4.4 个人/团队隔离在检索层落地（四维下推）
- `tdai_knowledge_search` 必须强制带 `scope + team_id + user_id + agent_id`。
- Wiki：仅 `team`（无 personal，个人 wiki 未实现，检索时直接过滤掉 personal 请求）。
- Skill/对话/记忆：按列 WHERE 过滤；**TCVDB 后端遇 `scope='personal'` 运行时探测并禁用**（写不进/串号风险）。
- 这相当于指南"rules/USER.md 填 dandan 画像"——本项目 L3 persona + scope 列就是那个"个人 overlay"。

### 4.5 跨 Agent 部署：gateway = canonical，凭证 = overlay
指南的"canonical 仓库 + 软链"在本项目天然成立，因为知识已是中心化存储：

```
                 ┌─────────────────────────────────────┐
                 │  Gateway 簇（单一事实源 / canonical）  │
                 │  core:8420  knowledge:8424  proxy:8096 │
                 └──────────────┬──────────────────────┘
                   暴露工具 ─────┼──── 暴露工具 ───────┐
                                │                     │
              ┌─────────────────▼───┐     ┌───────────▼────────┐
              │ Claude Code / Cursor │     │ WorkBuddy / OpenCode │
              │  接 MCP + gateway     │     │  接 gateway + proxy  │
              │  .env: serviceToken   │     │  .env: team_id/scope │
              │        + team_id       │     │   + embedding endpoint│
              └───────────────────────┘     └──────────────────────┘
                    每个 agent 只带自己的凭证 overlay
```

- **改 canonical 一处（如新增 wiki 源），所有 agent 下次会话自动同步**——因为都指向同一 gateway，且 `knowledge-router` 块由后端注入。
- 每个 agent 的私有信息（serviceToken、team_id、scope、embedding endpoint）走各自 `.env` / 配置，不进共享层（指南 `.env` 不进 git 的同一道理）。

### 4.6 真生效验证（指南验收标准）
指南的终极验收是"有一次纠正被永久记住"。对应到本项目：
- **补 recall-hit 埋点**：现有 `bridge-telemetry.ts` 只埋 skill 命中，需补 memory/wiki/conversation 的 recall 命中遥测，证明"检索真的被调用且命中"。
- **验收用例**：
  - 新会话问"介绍一下我/我们团队关于 X 的规范" → 能从 persona/wiki 答出（原则层生效）。
  - 问"上次关于 Y 的对话/skill/wiki" → 能 recall（索引层生效）。
  - **终极**：有一次纠正被永久记住，下次同类任务不再犯同一个错（L1 `instruction` + `priority=-1` 硬指令路径）。

---

## 5. 分阶段落地 Checklist

### P0（最小可用，不动现有存储）
- [ ] 把 `auto-recall.ts` 的 `MEMORY_TOOLS_GUIDE` 扩成 `knowledge-router` 块，列入 wiki/skill/memory/conversation 四源 + 选用策略。
- [ ] 在 MemoryCore 注册 `tdai_knowledge_search` 聚合工具（扇出到已存在的四个检索器，统一 `source_type` 标签）。
- [ ] 强制 `scope + team_id` 必传，TCVDB 后端 `personal` 请求运行时禁用。

### P1（隔离与一致性）
- [ ] Wiki 个人空间端点补完（或检索层显式拒绝 personal wiki）。
- [ ] 统一四维隔离（source_type × scope × team_id × agent_id）在各检索器落地。
- [ ] 跨 agent 部署文档：各客户端（Claude Code/Cursor/WorkBuddy/OpenCode）接 MCP + gateway 的接线说明。

### P2（真生效与可观测）
- [ ] 四类 recall-hit 遥测（复用 bridge-telemetry 模式）。
- [ ] 验收脚本：注入一条纠正 → 验证下次同类任务命中（指南终极标准）。
- [ ] （可选）`knowledge-router` 块内容由后端动态生成（按 agent 实际已授权的源列表裁剪），而非硬编码。

---

## 6. 一句话总结

本项目**已经有"原则层 vs 索引层"的骨架**（`auto-recall.ts` 的 system/dynamic 二分 + L0–L3 分层提炼），
缺口只是**把 Wiki 和 Skill 也接进这个骨架**——具体就是补一张 `knowledge-router` 入口地图 + 一个 `tdai_knowledge_search` 扇出工具，
再把 gateway 当作跨 agent 的 canonical 事实源用凭证 overlay 接入。
做完这步，agent 就能"确定性加载原则（L3 persona + L2 scene + router）+ 按需检索四类索引（wiki/skill/记忆/对话）"，
正好对应指南的全部心智模型，且不需要指南里那套"文件夹 + 软链"机制（因为我们的知识本来就是中心化存储的）。
