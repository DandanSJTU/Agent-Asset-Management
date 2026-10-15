# 知识存储：个人 vs 团队 位置对照

> 结论先行：**三类知识在「个人 / 团队」下的物理位置策略完全不同**——
> - **Wiki**：路径级隔离（`team_id` 直接是目录段，团队不同目录就不同）
> - **Skill**：元数据级隔离（个人/团队共用同一棵 `core/skills/` 树，靠库内 `team_id`/`scope` 列区分）
> - **对话 L0**：行级隔离（共用一个 `core/conversations/` 目录，靠每行字段 + 库内列区分）
>
> 关键坑：**「个人空间」目前不含 Wiki**（personal-space 路由里没有 wiki 端点）。

---

## 1. Wiki（MemoryKnowledge 服务，:8424）

**隔离方式：物理路径级**（按 `service_id` + `team_id` 分目录）

| 维度 | 团队（Team） | 个人（Personal） |
|---|---|---|
| 主库 | `knowledge/knowledge.db`（`knowledge_wiki` 表，行带 `service_id`+`team_id` 列） | 同库同表，只是 `team_id` 取值不同 |
| 正文目录 | `knowledge/<service_id>/<team_id>/wiki-<id>/` | **未实现**：个人空间不含 wiki；若强行用，只是另一个 `team-<personalId>` 目录 |
| 单 wiki 内部 | `raw/sources/`（源 md）+ `wiki/`（提炼页）+ `index.db`（FTS5 BM25+图谱边）+ `.llm-wiki/` | 同左 |

**路径是否不同：是。** `team_id` 是字面目录段，团队之间目录天然隔离。

**隔离证据（代码）**
- `MemoryKnowledge/src/module.ts:387`
  ```ts
  const dir = join(dataDir, row.service_id, row.team_id, row.wiki_id);
  ```
- `MemoryKnowledge/src/store/code-graph-service.ts:153`
  ```ts
  dirFor(serviceId, teamId, codeGraphId) => join(this.dataRoot, serviceId, teamId, codeGraphId)
  ```
- 越权门控：`routes/source-credential.ts` —— `team_id` 只取自请求头 `x-tdai-team-id`，**绝不收 body 里的 team_id**。

**本地实测目录**（local-deploy/data）
```
knowledge/default/team-03mo42js4f/wiki-u8xwfqdw/...
knowledge/default/team-0rwboa34ej/...
```

> 备注：本地部署里只看到 `team-*` 目录，**没有 personal wiki 目录**——与「个人空间不含 wiki」一致。

---

## 2. Skill（MemoryCore 服务，:8420）

**隔离方式：元数据级**（物理位置不分团队，全靠库内列）

| 维度 | 团队（Team） | 个人（Personal） |
|---|---|---|
| 正文文件 | `core/skills/skl-<id>/v<ver>/files/` | **同一棵树**（只看 skill id，无 team 段） |
| 主库 | `core/vectors.db` 的 `skills` / `skill_fts` / `skill_vec` 表，列含 `team_id`、`scope`、`owner_agent_id`、`user_id` | 同库，个人技能写 `team_id='personal'` + `agent_id='personal-<userId>'` |
| 缓冲 | `core/skill_buffer/` | 同左 |

**路径是否不同：否。** 跨团队共用同一棵 `core/skills/` 目录树。

**隔离证据（代码）**
- `MemoryCore/src/core/store/tcvdb/skill-store.ts:209`
  ```ts
  const storageDir = `skills/${sid}/v${newVersion}`;  // 只含 skill id，无 team 段
  ```
- `MemoryCore/src/core/skill/skill-store.interface.ts:146`
  > `teamId` 传入 → WHERE 强制过滤，跨 team 不生效（返回 0）

**个人技能约定**（来自 gateway/skill-handlers.ts 注释）
- Panel 端 `/api/v1/personal-skills/*` 使用同一份 `personalAgentId()` 约定：`team_id='personal'`、`agent_id='personal-<userId>'`。
- 即：个人技能**落同一个物理库、同一个 `core/skills/` 目录**，只是库内打上了 personal 标签。

**本地实测目录**（local-deploy/data/core/skills）
```
skills/skl-jRFgonfOl3Jv/   ← 团队/个人共用，靠 vectors.db 里的 team_id 区分
```

---

## 3. 对话 L0（MemoryCore 服务，:8420）

**隔离方式：行级**（共享目录，每条消息自带归属字段）

| 维度 | 团队（Team） | 个人（Personal） |
|---|---|---|
| 镜像文件 | `core/conversations/YYYY-MM-DD.jsonl`（所有会话合并的日文件，**无 team 子目录**） | **同一目录** |
| 规范存储 | `core/vectors.db` 的 `l0_conversations` + `l0_fts`，按行存 `scope`/`team_id`/`user_id`/`agent_id`/`session_key` | 同左 |

**路径是否不同：否。** 所有租户的 L0 对话写进同一个 `core/conversations/` 目录下的日文件。

**隔离证据（代码）**
- `MemoryCore/src/core/conversation/l0-recorder.ts:302`
  ```ts
  const outDir = path.default.join(baseDir, "conversations");
  const outPath = path.default.join(outDir, `${shardDate}.jsonl`);  // 无 team 段
  ```
- `l0-recorder.ts:278-289` 每条记录写入归属字段：
  ```ts
  const record: L0MessageRecord = {
    sessionKey,
    userId: userId || DEFAULT_ISOLATION_ID,   // 缺省落入默认兼容桶
    agentId: agentId || DEFAULT_ISOLATION_ID,
    ...
  };
  ```
- 隔离靠**行内字段** + `l0_conversations` 表的 `scope`/`team_id` 列过滤实现，而非路径。

**本地实测目录**（local-deploy/data/core/conversations）
```
conversations/2026-10-15.jsonl   ← 团队与个人会话混在同一日文件
```

---

## 4. 补充：记忆 L1/L2/L3 与 Profile

| 类型 | 物理位置 | 个人/团队是否同路径 | 隔离方式 |
|---|---|---|---|
| 记忆 L1 | `core/vectors.db`（`l1_records` + `l1_fts`） | 同库同表 | 列级 `scope`/`team_id`（M3 已落地 SQLite+Mongo） |
| 记忆 L2（场景） | `core/scene_blocks/*.md` + `scene_index.json` | 同目录 | 同上 |
| 记忆 L3（画像） | persona 文件 | 同目录 | 同上 |
| Agent Profile | `core/profiles/<team>\|<agent>/` | **不同**（路径级，含 personal） | 路径段 |

**本地实测**（personal profile 已生成）
```
core/profiles/team%3Adefault%7Cagent%3Apersonal%3Aworkbuddy/
```
解码即 `team:default|agent:personal:workbuddy` —— Profile 是唯一**按 team+agent 分路径**的（除了 wiki）。

> ⚠️ 已知缺口：TCVDB 后端**完全未做 scope 下推**（无 `scope`/`owner_user_id` 字段、无过滤），用 TCVDB 时个人/团队隔离会失效（失效模式是「写了也不存」而非「过滤失效」）。涉及 personal 的功能需做后端探测并禁用 tcvdb。

---

## 5. 对照总表

| 知识类型 | 服务 | 团队物理路径 | 个人物理路径 | 路径是否不同 | 隔离粒度 | 主库 / 文件 |
|---|---|---|---|---|---|---|
| **Wiki** | Knowledge :8424 | `knowledge/<svc>/<team_id>/wiki-<id>/` | 未实现（仅作另一个 `team-*` 目录） | ✅ 是 | 路径段 + DB 列 | `knowledge.db` + 每 wiki `index.db` |
| **Skill** | Core :8420 | `core/skills/skl-<id>/v<ver>/files/` | **同左（共用一棵树）** | ❌ 否 | 元数据列 | `core/vectors.db`（`skills` 等表） |
| **对话 L0** | Core :8420 | `core/conversations/YYYY-MM-DD.jsonl` | **同左（共用一目录）** | ❌ 否 | 行级字段 | `core/vectors.db`（`l0_*`） |
| 记忆 L1 | Core :8420 | `core/vectors.db`（`l1_*`） | 同库同表 | ❌ 否 | 列级 scope | `core/vectors.db` |
| 记忆 L2/L3 | Core :8420 | `core/scene_blocks/`、`persona` | 同左 | ❌ 否 | 列级 scope | 文件 + `core/vectors.db` |
| Profile | Core :8420 | `core/profiles/<team>\|<agent>/` | 个人有独立路径段 | ✅ 是 | 路径段 | 目录 |

---

## 6. 对「怎么编排」的含义

1. **Wiki 天然按团队分目录** → 团队知识互不污染，编排时可直接按 `team_id` 目录做增量 ingest；但**个人 wiki 缺位**，个人知识若要进 wiki 需先解决 personal team 命名。
2. **Skill / 对话 / 记忆物理混放** → 任何统一检索或编排**必须显式带 `scope`/`team_id` 过滤**，否则会跨租户串数据。
3. **TCVDB 后端 scope 缺口** → 凡涉及 personal 的功能，运行时需探测后端类型并在 tcvdb 时禁用，否则隔离失效。
4. **统一编排入口建议**：在检索路由层按 `source_type`（wiki / skill / conversation / memory）+ `scope`（personal / team）+ `team_id` 四维扇出，物理存储差异对上层透明。
