# 个人 vs 团队知识资产查看导航

> 适用版本：本机单机部署（`feat/server_team` 分支），面板 `:8125` + core `:8420` + knowledge `:8424`。
> 核心结论：**个人资产**走侧边栏「个人空间」，**团队资产**走「资产管理 + 组织与权限」两组。
> 个人资产语义为 `private`（仅 Owner 可读）；团队资产按 `team / restricted / agent` 可见性分级授权。

---

## 一、总览

打开面板 **http://localhost:8125**（本机当前已运行，返回 HTTP 200；`/api/v1/personal-space/mode` 返回 `singleUser:true`，即本机为你这名单机 Owner）。

左侧边栏按四个分组组织页面：

| 分组 | 用途 | 对应空间 |
| :--- | :--- | :--- |
| **个人空间** | 你自己的对话 / 记忆 / 私有技能 | 个人 |
| **资产管理** | 团队共享池：对话记忆 / 技能 / Wiki / Agent | 团队 |
| **组织与权限** | 成员维度矩阵、API 密钥 | 团队 |
| 可观测（隐藏） | 数据分析 | — |

---

## 二、看「个人知识资产」

侧边栏 **个人空间** 分组，三个入口：

### 1. 会话洞察（`/insights`）
- 本机所有对话 Session 列表：时长、token、成本、改动文件、git 提交、todos。
- 点进单个会话看派生事实、时间线、交接（Resume）状态。
- 后端路由：`/api/v1/personal-space/sessions`、`/facts`、`/records`。

### 2. 我的记忆（`/my-memory`）
- 个人 Chat Memory 的 L0→L3 分层产物：**L1 原子记忆（memories）/ L2 场景块（scenes）/ L3 画像（persona）**。
- 后端路由：`/api/v1/personal-space/memories`、`/scenes`、`/persona`。

### 3. 我的技能（`/personal/skills`）
- 个人**私有技能库**（`team_id='personal'` + 虚拟 agent），与团队 Skills 页平行但隔离。
- 默认私有，审核后才进入团队共享池。

> 个人资产语义 = `private`：仅 Owner 可读，团队管理员也看不到。本机单机部署下，你就是该 Owner。

---

## 三、看「所属团队的知识资产」

### 资产管理分组（团队共享池，`visibility='team'`）

| 入口 | 路由 | 内容 |
| :--- | :--- | :--- |
| 对话记忆 | `/memory` | 团队对话记忆资产 |
| 技能 | `/skills` | 团队共享技能（含你分享的 + 他人分享的） |
| 知识库 | `/wiki` | Wiki 结构化页面与链接图谱 |
| 团队 Agent | `/team/agents` | 团队内 Agent 及其绑定的 Loadout |

### 组织与权限分组

| 入口 | 路由 | 内容 |
| :--- | :--- | :--- |
| 团队成员 | `/team/members` | 成员维度**资产矩阵**与资产统计（谁贡献了什么、各成员资产分布） |
| API 密钥 | `/team/api-keys` | 团队接入凭证 |

> 想确认"我属于哪个团队"，进 **团队成员**（`/team/members`）页即可看到当前团队与成员归属。
> 团队资产按 `team / restricted / agent` 可见性分级，你能看到的是对你授权的那部分。

---

## 四、命令行 / 程序化查看（可选）

### 个人资产（面板代理，本机免鉴权）
```bash
curl http://127.0.0.1:8125/api/v1/personal-space/memories
curl http://127.0.0.1:8125/api/v1/personal-space/scenes
curl http://127.0.0.1:8125/api/v1/personal-space/persona
```

### 团队资产（直连 core `:8420`，需带鉴权头）
```bash
curl -H "Authorization: Bearer local" -H "x-tdai-service-id: default" \
  "http://127.0.0.1:8420/api/v1/team/status?team_id=<你的team_id>"
```

注意事项（来自本机实测）：
- 团队计数接口返回字段是 `data.total`，不是 `data.count`。
- 团队路由在 core `:8420` 上，不在面板 `:8125` 直连；面板 `:8125` 只代理个人空间类路由。
- v3 数据面必须带 `Authorization: Bearer <api_key>`（本地 `sk-mem-local-admin` 或 `local`）+ `x-tdai-service-id: default`，空 Bearer 直接 401。

---

## 五、一句话记忆

> 个人看「个人空间」三页（会话洞察 / 我的记忆 / 我的技能）= 你的私有资产；
> 团队看「资产管理 + 组织与权限」（对话记忆 / 技能 / Wiki / 团队Agent / 成员矩阵 / API密钥）= 对你授权的共享资产。
> 二者通过面板左侧分组切换，底层靠 `private / team / restricted / agent` 可见性 + Owner/ACL 隔离。

---

*声明：本导航基于本机面板源码（`MemoryPanel/web/src` 路由与 `menu.tsx`）及 `:8125`/`:8420` 实测整理；菜单项可能随分支迭代增减（如 CodeGraph、AI 协作当前在侧边栏隐藏但路由可达）。*
