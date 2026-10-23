# TencentDB Agent Memory：个人与团队记忆管理总结

> 来源：`README_CN.md`（分支 `feat/server_team`）
> 定位：面向 Agent 团队的 **Memory Hub**——让经验自动沉淀、在团队内流动、被下一位 Agent 直接继承。
> 核心一句话：**记忆资产不是聊天记录仓库，而是带 Owner / 版本 / 状态 / 可见性 / 权限的"可复用经验资产"。**

---

## 一、总览：项目解决什么问题

传统做法里，换个 Session 要重讲背景，换 Agent 要从头学项目，跑通的做法下次再摸索一遍。

本项目把"凡是能让下一个 Agent 少走弯路的信息"统一沉淀为 **Memory Asset（记忆资产）**，并解决三个问题：

1. **什么值得留下** —— 对话 / 文档 / 代码经分层提炼成资产。
2. **谁可以使用** —— 通过 Owner、可见性、角色与 ACL 控制。
3. **下一次怎样少拿但拿对** —— Agent 按身份装配（Loadout），按需召回。

价值链路：

```
已有信息 → 可复用记忆资产 → 更少 Turns → 更少返工 → 更稳定的结果 + 更高效率
```

---

## 二、四类记忆资产

| 资产类型 | 是什么 | 关键特征 |
| :--- | :--- | :--- |
| **Chat Memory** | 保留偏好、事实、决策、交互历史 | L0–L3 分层提炼；每个 Agent 自动获得独立记忆，下次不必自我介绍 |
| **Skill** | 从对话/工具调用提炼的可复用技能 | 不只是一段 Prompt：有版本、资源文件、触发边界、执行步骤、验证规则；个人默认私有，审核后分享团队 |
| **Wiki** | 把产品文档/设计方案/运维手册生成结构化页面 + 链接图谱 | 灵感来自 Karpathy 的 LLM Wiki；异步构建 |
| **CodeGraph** | 索引代码符号、文件、调用关系、影响路径 | 支持查 callers/callees、改代码前做 impact analysis；异步构建 |

四类资产统一登记为 **Memory Asset**，由 Memory Hub 统一管理、审核、路由、配装。

---

## 三、记忆分层提炼机制（L0–L3）

对话首先作为 **L0** 保存，再由**异步 Pipeline** 逐层提炼为不同粒度的记忆。

| 层级 | 保存什么 | 主要用途 |
| :--- | :--- | :--- |
| **L0 Conversation** | 原始对话与完整上下文 | 核对原话、时间、来源 |
| **L1 Atom** | 从对话提取的事实、偏好、约束、事件 | 精确召回可执行信息 |
| **L2 Scenario** | 围绕项目/场景组织的知识块 | 快速恢复一个工作场景 |
| **L3 Core / Persona** | 长期画像、稳定模式、高层认知 | 让 Agent 迅速进入用户/团队语境 |

**生成与召回都分层**：

- 平时用 **L2 / L3** 快速进入语境；
- 需要具体事实时，通过 **BM25 + 向量检索 + RRF** 回到 L1 / L0；
- 结果会经过**条数、字符预算、超时限制**，避免记忆反过来占满上下文。

> 示例代价很高的上下文："别重构旧鉴权模块，移动端还在用。"——这类信息不该靠人每次提醒。

---

## 四、个人记忆 vs 团队记忆

这是本项目的核心设计张力：**让团队共享经验，但不共享隐私。**

### 4.1 可见性四档（Visibility）

| 可见性 | 语义 |
| :--- | :--- |
| `private` | 只有 **Owner** 可读，团队管理员也不例外 |
| `team` | 团队成员可读，Owner / Admin 负责管理 |
| `restricted` | 通过 **User / Role / Agent ACL** 精确授权 |
| `agent` | 用于同团队 Agent 的定向装配（Loadout） |

**默认行为**：新 Chat Memory 和 Skill **默认私有**。分享是一个**明确动作**，不是默认泄漏。

### 4.2 典型分发策略

- 把"发布 Skill"配给 Release Agent；
- 把"架构 Wiki"给所有开发 Agent；
- 把 CodeGraph 给 Coder 和 Reviewer；
- 不同角色 → 不同 Loadout（少给噪音，多给真正需要的记忆）。

### 4.3 资产归属与权限模型

- **资产归属通过 Owner 标记**，Owner 自动获得对应资产的管理权限。
- 新 Chat Memory / Skill 默认私有，审核后才进入团队共享池。
- 团队可以共享经验，却不必共享全部隐私；换 Agent / 换框架只需重新装配，不必重新训练。

### 4.4 角色两层

| 角色层级 | 角色 | 职责 |
| :--- | :--- | :--- |
| 全局 | **System Admin** | 管理用户与团队（建团队、录入成员）；也可使用 Wiki / CodeGraph / Skill 等资产管理功能 |
| 团队内 | **Team Admin** | 团队内资产协作与权限控制（审核、分享、配装） |
| 团队内 | **Team Member** | 普通成员，按 ACL 使用/贡献资产 |

---

## 五、记忆如何装配到 Agent（Loadout）

Chat Memory / Skill / Wiki / CodeGraph 被统一登记为 Memory Asset。Memory Hub 通过 **Fixed Binding + ACL** 决定某个 Agent 能带走哪些资产：

1. 先按 **Team / User / Agent / 可见性** 缩小权限范围；
2. 再按当前问题召回具体内容。

集成方式：**一套 Proxy，协议不变，零代码接入**——把 Agent 的 base URL 指向 Proxy 即可，不需要插件、Hook 或 MCP Server。已支持 Claude Code / Codex / CodeBuddy / WorkBuddy / DeepSeek Harness / Hermes / OpenClaw 等，也可按通用接入指南适配其他框架。

> 记忆不负责替 Agent 跑 Loop，它负责让下一轮继承上一轮的成果：有价值的交互留在 Chat Memory，跑通的做法提炼为 Skill，文档/代码变化通过 Wiki ingest 与 CodeGraph sync 更新。

---

## 六、冷启动：先读档，再开工

把已经付过的学习成本变成"存档"，新 Agent Team 从现有经验起步，不必从头学一遍。可直接在面板导入并处理：

- **代码库** → CodeGraph 自动索引符号、文件、调用关系、影响路径；
- **文档与文件** → Wiki 自动生成结构化页面与链接图谱；
- **对话 Session** → 自动提取可复用 Skill 与 Chat Memory。

---

## 七、Memory Hub 操作台能力

| 玩法 | 在 Hub 里做什么 |
| :--- | :--- |
| 组队 | 建立 Team，加入人和 Agent，确定共享边界 |
| 资产背包 | 打开/搜索/审核/管理 Chat Memory、Skill、Wiki、CodeGraph |
| Agent Loadout | 给不同 Agent 绑定不同记忆，调整优先级与使用方式 |
| Knowledge 工坊 | 构建 Wiki 和 CodeGraph，查看处理状态与资产信息 |
| 权限控制 | 在 private / team / ACL 授权间切换，必要时收回共享 |

---

## 八、技术实现要点

- **不追求存下所有东西**，而是解决"什么值得留下、谁可用、下次怎样少拿但拿对"。
- 知识**不整库注入，而是按需调用**：Agent 先通过 `/v3/tools/list` 发现能力，再用 `/v3/tools/call` 读取相关页面/源码/影响路径。
- 检索融合：**BM25 + 向量检索 + RRF**；召回带条数/字符预算/超时限制。
- 存储后端（来自项目整体，README 仅明确提及）：SQLite 为默认；**MongoDB 为试验特性（默认关闭）**；另有 TCVDB 选项。

### 相关 API 文档（README 列出）

- Memory Core v3 API：`MemoryCore/v3-api-memorycore-doc.md`
- Memory Knowledge v3 API：`MemoryKnowledge/v3-api-memoryknowledge-doc.md`
- Memory Proxy v3 API：`MemoryProxy/v3-api-memoryproxy-doc.md`
- Memory Panel API：`MemoryPanel/panel-api-doc.md`
- Knowledge OpenAPI：`MemoryKnowledge/openapi.yaml`

---

## 九、关键注意事项

- Wiki 与 CodeGraph **异步构建**，需等待处理完成才会 `ready`。
- CodeGraph 当前首先支持**公开 HTTPS 仓库**；私有仓库与 SSH 凭证接入仍在完善。
- Hub 已支持**人工绑定资产**；全自动记忆路由仍在迭代。
- 旧版（v1.x / v0.x）数据可用迁移工具迁到 v2.0.0+：`MemoryCore/scripts/migrate-v2-to-v3/README_CN.md`。

---

## 十、一句话结论

> **个人记忆 = 默认私有、按 Owner 归属、L0–L3 分层沉淀的 Chat Memory / Skill；团队记忆 = 通过审核+可见性(`team`/`restricted`/`agent`)+ACL，把资产装配(Fixed Binding)到团队成员与 Agent 的共享经验池。二者通过 Memory Hub 这套操作台实现"共享经验、不共享隐私"。**

---

*声明：本总结基于 `feat/server_team` 分支的 `README_CN.md` 提取整理，具体实现以仓库最新代码与 INSTALL_CN.md / 各 API 文档为准。*
