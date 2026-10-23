# 简历项目整理：Agent 资产管理（TencentDB-Agent-Memory）

> 用途：投递「企业 AI 办公助手 / AI 产品经理」岗位的实践项目条目。
> 说明：本项目为你基于腾讯云官方开源项目做的**产品化演进与个人修改版**，你在其中承担**产品设计 + 架构对齐 + 数据指标**的核心角色。文中 `[ ]` 处需你补真实时间/数据。

---

## 一、简历可直接用的中文条目（精简版，建议占简历 1 段）

**Agent 资产管理（TencentDB-Agent-Memory）— 面向 AI Agent 团队的记忆基础设施**
*产品负责人（产品设计 / 架构对齐 / 数据指标）　|　[2025.x] – 至今*

为企业 AI Agent 团队打造「记忆中枢」：把人与 AI 协作产生的对话、文档、代码自动沉淀为可复用记忆资产（对话记忆 / Skill / 知识地图），并按权限装配给不同 Agent，解决「每次新会话都要重述上下文、重复造轮子」的办公效率痛点。

- **产品抽象与机制设计**：将「AI 如何记住经验」这一模糊命题拆为可落地的三层结构——① 内容分层（L0 原始对话→L1 原子记忆→L2 场景块→L3 用户/团队画像）；② 资产治理（统一登记 Chat Memory / Skill / Wiki / CodeGraph 四类 Memory Asset）；③ 权限装配（Team→User→Agent + 可见性 + Fixed Binding + ACL 的 Loadout 模型），让「共享经验而不共享隐私」成为可执行机制。
- **零代码接入产品化**：设计统一 Proxy 协议，使 Claude Code / Codex / CodeBuddy / WorkBuddy / DeepSeek 等 7+ 主流 Agent 框架无需插件、无需改代码即可接入同一记忆服务器，把接入成本从「改代码」降到「改一行 base URL」。
- **指标体系与数据驱动迭代**：主导资产统计模块，定义时间档位、4 项核心指标卡与趋势视图，覆盖团队/个人双维度，把「记忆资产的沉淀与使用」变成可观测、可决策的运营指标，推动冷启动与资产复用率闭环优化。
- **技术方案对齐与架构参与**：与研发共定 MemoryCore / MemoryProxy / MemoryKnowledge / MemoryPanel 四件套服务边界与三协议（数据面 / 治理面 / 接入面），参与 BM25+向量+RRF 融合召回与「条数/字符/超时」预算约束的方案取舍。
- **开源与国际化**：基于腾讯云官方开源做产品化演进并独立发布（GitHub / npm），撰写英文产品与架构文档，对接海外 Agent 生态（Discord 社区、Trendshift 榜单、海外框架原生适配），英文文档与跨时区协作无障碍。

**量化成果（挑 2–3 条填）：**
- PersonaMem 长期记忆基准：启用后 Agent 理解准确率 48% → 76%（相对 +59%）。
- 支持 7+ 主流 Agent 框架零代码接入；双存储后端（SQLite / MongoDB）scope 隔离经 46 例契约测试验证。
- 开源仓库获 Trendshift 收录、GitHub 星标增长，形成 Discord 开发者社区。

---

## 二、English Version（对应任职资格第 5 条「英文无障碍」）

**Agent 资产管理 / TencentDB-Agent-Memory — Memory Infrastructure for AI Agent Teams**
*Product Owner (Product Design · Architecture Alignment · Metrics)　|　[2025] – Present*

Built a "memory hub" for enterprise AI agent teams: automatically distilling conversations, docs, and code co-created by humans and AI into reusable memory assets (chat memory / skills / knowledge maps), then assembling them to different agents by permission — solving the office-efficiency pain of re-explaining context and re-inventing workflows in every new session.

- **Product abstraction & mechanism design**: decomposed the fuzzy goal "how should AI remember" into a shippable three-layer structure — (1) content layering L0 conversation → L1 atomic memory → L2 scenario block → L3 persona; (2) unified asset governance registering Chat Memory / Skill / Wiki / CodeGraph as Memory Assets; (3) a permission-centric "Loadout" model (Team→User→Agent + visibility + Fixed Binding + ACL) that makes "share experience, not privacy" an enforceable mechanism.
- **Zero-code onboarding**: designed a unified Proxy protocol letting 7+ mainstream agent frameworks (Claude Code, Codex, CodeBuddy, WorkBuddy, DeepSeek Harness, Hermes, OpenClaw) connect to one memory server with no plugin or code change — lowering integration cost from "code edits" to "one base-URL change."
- **Metrics & data-driven iteration**: owned the asset-analytics module — defined time buckets, 4 core KPI cards and trend views across team/personal scopes, turning memory usage & accumulation into observable, decision-grade operational metrics; drove cold-start and asset-reuse-rate loop optimizations.
- **Tech alignment & architecture**: partnered with engineering to define the 4-service stack (Core / Proxy / Knowledge / Panel) and the three-protocol design; contributed to trade-off decisions on BM25 + vector + RRF fusion retrieval and count/char/timeout budget guardrails.
- **Open source & internationalization**: productized and independently released a fork of Tencent Cloud's official OSS (GitHub / npm), authored English product & architecture docs, engaged the overseas agent ecosystem (Discord, Trendshift, native adapters), working in English daily.

**Outcomes**: +59% relative gain on the PersonaMem long-term memory benchmark (48% → 76%); 7+ frameworks supported; dual-backend scope isolation verified by 46 contract tests.

---

## 三、JD 能力映射（帮你面试时讲清楚「为什么这条项目能证明我」）

| JD 要求 | 本项目对应证据 | 面试可讲的一个例子 |
|---|---|---|
| 1. 企业 AI 办公助手产品设计/迭代 | 记忆中枢本身即「AI 办公助手的基础设施」；持续迭代 L0–L3 提炼、资产治理面板 | 把"AI 记住经验"从概念做成可运营的产品闭环 |
| 2. 模糊组织需求→清晰产品结构/机制 | L0–L3 分层 + Team/User/Agent/ACL 权限装配模型 | 用"共享经验而不共享隐私"一句话收敛了权限设计 |
| 3. 与研发协同、懂技术、参与架构 | 四件套服务边界 + 三协议 + 检索方案取舍 | 与研发定 BM25+向量+RRF 融合与预算约束，保证机制可落地 |
| 4. 完善指标体系、主导数据分析决策 | 资产统计模块（时间档位+4 指标卡+趋势，团队/个人双维） | 用资产复用率指标驱动冷启动优化闭环 |
| 任职 2. 产品抽象能力 | 三问技术方案（什么值得留/谁能看/怎么消费） | 三层抽象即最大单点证据 |
| 任职 3. 数据敏感、定义指标跑分析 | 资产统计 dashboard + 基准测试 | PersonaMem 48%→76% 用数据证明价值 |
| 任职 4. 沟通推动、跨部门推进 | 开源社区、多框架接入协同、文档体系 | 推动 7+ 框架零代码接入的统一协议 |
| 任职 5. 海外/国际化 + 英文 | GitHub/npm 英文文档、Discord、Trendshift、海外框架原生适配 | 英文架构文档 + 跨时区社区协作 |

---

## 四、投递前的 3 个提醒（避免踩坑）

1. **时间线诚实**：条目里 `[2025.x]` 请换成你实际开始投入的月份；若这是副业/并行项目，建议标注「个人项目 / 开源贡献」，避免被误认为全职雇主项目。
2. **开源血缘如实写**：底层引擎是腾讯云官方开源，你的核心贡献在**产品设计 + 个人空间模块（personal scope）+ 指标体系 + 多框架接入产品化**。面试被深挖时，讲清楚"我在官方底座上做了哪些产品层决策"比泛泛而谈更加分。
3. **量化别硬凑**：基准 +59%、7+ 框架、46 例契约测试都是仓库里真实可查的；星标/社区类数据若无法核实就写「形成开发者社区」而非具体数字。
