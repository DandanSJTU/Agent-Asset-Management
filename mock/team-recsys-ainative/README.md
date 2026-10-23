# 推荐策略组 · AI-Native 四角色团队资产（mock 数据）

一套可直接灌入本项目的**四角色团队资产**：Agent 载体、对话记忆（L1/L2/L3）、Skill、Wiki。
业务域是「携程 Trip 首页信息流推荐（T 站 + C 站）」，团队形态是 4 人 AI-Native 小队
（产品 / 工程 / 算法 / 测试）——**1 人 + 1 个角色 Agent** 的配置。

> **它不是业务数据**：所有 id 带 `-rec-` 标记（自建模式为 `-mock-`），数据由
> `seed-team-demo.mjs` 写入，可一条命令清除。
> **但口径是真的**：指标定义、通道代号、模型演进、实验结论均锚定真实知识库（见「数据来源」），
> 未拍板事项一律标注 `discussing / pending / 待确认`，不臆造结论。

---

## 一、当前绑定：推荐策略组（team-7xulumcvyl）

数据**已绑到你本地真实团队的成员**上，团队与成员本身没有被改动：

| 角色 | Agent（载体） | 归属成员 | 说明 |
|---|---|---|---|
| 产品 | `agt-rec-product` 产品策略 Agent（PE Hybrid） | admin（owner）`usr-0rwbvul43m` | 新建（该成员在本团队没有默认 Agent） |
| 工程 | `agt-ar4478rrd5` 全栈工程 Agent（Builder） | PengShi `usr-ar449snyl0` | 复用其默认 Agent 并改名 |
| 算法 | `agt-ar6gyp3yv7` 推荐算法 Agent（Builder） | PengChengZhuo `usr-ar6gbwfwon` | 复用其默认 Agent 并改名 |
| 测试 | `agt-ar6z1agmqn` 质量与 Evals Agent | YaoYao `usr-ar6zd4p8vv` | 复用其默认 Agent 并改名 |

- 共享 Wiki（3 篇）挂**团队级**：owner = admin，不绑 Agent。
- `--remove` 会把复用的 3 个 Agent 的 name/description/prompt 与记忆资产名/可见性**原样还原**，
  并删掉新建的产品 Agent。团队与成员不动。
- 每个角色 Agent 上还挂着各自的 3 个 Skill + 1 本角色 Wiki + 1 个对话记忆资产（`meta_agent_fixed_assets`）。

### 数据规模

| 角色 | L1 原子记忆 | L2 场景块 | L3 persona | Skill | Wiki |
|---|---|---|---|---|---|
| 产品 | 14 | 3 | 1 | 3 | 3 |
| 工程 | 13 | 3 | 1 | 3 | 3 |
| 算法 | 14 | 3 | 1 | 3 | 3 |
| 测试 | 12 | 3 | 1 | 3 | 3 |
| 共享 | — | — | — | — | 3 |
| **合计** | **53** | **12** | **4** | **12** | **15**（5 库） |

L1 类型分布：`work_fact` 28 / `work_method` 12 / `work_task` 8 / `work_artifact` 5。

## 二、目录结构

```
mock/team-recsys-ainative/
├── README.md                      本文件
├── seed-team-demo.mjs             灌库 / 清除脚本（--remove / --dry-run）
├── .team-demo-seed-manifest.json  写入清单（含 Agent 原值备份，脚本生成，勿手改）
└── dataset/
    ├── entities.json              团队/角色/Agent/Wiki 的**内容定义**（自建模式用）
    ├── mapping.json               **绑定关系**：team_id + 角色 → 成员 user_id / Agent
    ├── roles/<slug>/
    │   ├── l1-memories.json       L1：3 个源会话 × 若干原子记忆（type/priority/scene_name/content）
    │   ├── scenes/*.md            L2：3 个场景块
    │   ├── persona.md             L3：Team Operating Doctrine + Scene Navigation
    │   ├── skills/*.md            Skill：带 frontmatter 的 SKILL.md
    │   └── wiki/*.md              角色百科 3 篇（正文含 [[双链]]）
    └── shared/wiki/*.md           团队共享百科 3 篇（策略地图 / 指标口径 / 团队作战手册）
```

**两种模式**（由 `dataset/mapping.json` 是否存在决定）：

| | 绑定模式（有 mapping.json） | 自建模式（删掉 mapping.json） |
|---|---|---|
| 团队/成员 | 用真实团队，**一个字都不改** | 自建 `team-mockrec01` + 4 人 |
| Agent | 复用/新建角色 Agent 并改名 | 新建 `agt-mock-*` |
| id 标记 | `-rec-` | `-mock-` |
| `--remove` | 只删自己写的，复用 Agent 还原 | 整体删除团队与成员 |

## 三、落盘位置（两层，缺一不可）

面板读的是**元数据面**，Agent 运行时读的是**数据面**：

| 资产 | 元数据面（面板列表 / 计数） | 数据面（内容） |
|---|---|---|
| Agent | `metadata/…/metadata.db` → `meta_agents`（面板权威源） | `vectors.db` → `entity_agents`（镜像） |
| Skill | `meta_assets`（asset_id = skill_id，`visibility='team'`）+ `meta_agent_fixed_assets` 挂载 | `vectors.db` → `skills` / `skill_fts` + `skills/<skill_id>/v1/SKILL.md` |
| Wiki | `meta_assets`（`llm_wiki`）+ 挂载 | `data/knowledge/default/<team_id>/<wiki_id>/`（md + `index.db`）+ `knowledge.db` → `knowledge_wiki` |
| 对话记忆 | `meta_assets`（`chat_memory-team-<id>-agt-<id>`）+ 挂载 | `vectors.db` → `l1_records` / `l1_fts`（team scope） |
| L2 / L3 | — | `profiles/team%3A<teamId>%7Cagent%3A<agentId>/{scene_blocks,.metadata,persona.md}` |

关键点（踩过的坑）：
1. **只写数据面，面板列表是空的**。团队资产列表走 `asset/list-accessible`，且要求 `visibility='team'`。
2. 对话记忆资产默认 `private`（只有 owner 可见，团队池不显示）；本项目定位团队共享资产库，故写 `team`。
3. `chat-memory/team-assets` 返回的 `layer_counts` 是占位 0；真实条数在点开记忆块时由
   `/chat-memory/layer` 懒加载（已实测 product 14 / engineering 13）。
4. `#/team/agents` 页的 **Agent 卡片网格被 `showAgentModules={false}` 刻意隐藏**（`AgentsPage/index.tsx`），
   所以那页只看到「资产统计」；Agent 名称改动可在「成员管理」或 API 里核对。
5. skills 表有唯一索引 `(team_id, owner_agent_id, name) WHERE is_head=1 AND status='active'`，
   残留会导致下次 UNIQUE 冲突 —— 脚本每次先按 id 精确清再写，重复执行安全。

## 四、使用方法

```bash
cd /Users/dandan/Projects/TencentDB-Agent-Memory
N=/Users/dandan/.workbuddy/binaries/node/versions/24.4.1/bin/node   # 必须 Node 22.22+/24（node:sqlite）

$N mock/team-recsys-ainative/seed-team-demo.mjs            # 灌库（幂等）
$N mock/team-recsys-ainative/seed-team-demo.mjs --dry-run  # 只统计不写库
$N mock/team-recsys-ainative/seed-team-demo.mjs --remove   # 精确清除（团队/成员不动）
```

写完重启服务才在面板生效：

```bash
python3 /tmp/restart_core.py        # Agent 改名 / 资产注册（:8420）
python3 /tmp/restart_knowledge.py   # 新注册的 Wiki（:8424）
# 面板是静态目录，不用重启，浏览器硬刷新即可
```

**换绑到别的团队 / 成员**：改 `dataset/mapping.json` 的 `teamId` 与各角色 `userId`；
`reuseAgentId` 填要改名的 Agent（留 `null` 则新建 `agt-rec-<slug>`），重跑即可。

## 五、面板查看路径

- `#/team/agents` → 资产统计（团队 · 个人构成、Skill / Wiki / 对话记忆）
- `#/skills` → 切「团队资产」tab：12 个 Skill，owner 分别显示 admin / PengShi / PengChengZhuo / YaoYao
- `#/wiki` → 5 个知识库 / 15 篇（1 共享 + 4 角色），正文双链可跳
- `#/memory` → 对话记忆 · 团队资产：4 条记忆块（每角色 1 个），点开懒加载 L1 原子记忆

## 六、数据来源与可信度约定

**知识底座**（真实来源）：
- `~/WorkBuddy/策略产品/推荐系统/推荐知识库`：指标口径、召回通道、粗排/精排模型、重排策略、退场机制、视频分发策略、漏斗总览、实验记录。
- `~/WorkBuddy/认知-总结-提问/多agents管理/团队提效/AI-Native团队角色特点总结.md`：4 人 AI-Native 团队的角色融合与分工（AI 80% 执行、协调 45%→12%、Side Quest 与 Evals 机制）。

**写入约定**（防止把演示数据当结论）：
1. 真实存在的机制按原样记录（退场接口、PCGrad 幅度、SWI 替换 ICF 的指标等）。
2. 团队未拍板的事项显式标注状态：`discussing`（曝光衰减阈值）、`pending`（热点分发排期）、`researching`（生成式推荐）、`in_progress`（训练平台迁移）。
3. 未 ingest / 未标显著性的，写「指标待补」「未标显著」，不臆造数值。
4. L1 遵循 team 模式「准确归因」原则：个人建议 ≠ 团队决策，未拍板写成「团队正在讨论」。

## 七、扩展点

1. **加角色**：`entities.json` 的 `users/agents/roles/wikis` 增一项 + `mapping.json` 的 `bindings` 增一项，
   并在 `dataset/roles/` 建同名目录（l1-memories.json + scenes + persona.md + skills + wiki）。
2. **加场景 / 记忆**：直接编辑对应角色的 `l1-memories.json` 与 `scenes/*.md`，重跑脚本。
3. **接真实提炼管线**：把 `l1-memories.json` 的 session 文本喂给 L1 抽取器，产物与这里同结构，可直接替换。
4. **换业务域**：替换团队 / 角色描述与 dataset 内容即可（脚本与业务无关）。
