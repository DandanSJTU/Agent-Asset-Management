# AI 协作 tab 设计规格（前端 + 后端）

> 配套文档：`docs/ai-collab-memory-example.md`（演示脚本与增量论证）。
> 目标：在「资产管理（Asset Management）」分组下新增 **AI 协作** tab，演示
> **「不带记忆资产直接提问」vs「检索 记忆 / Skill / Wiki 后提问」** 两种大模型回答的差异。
> LLM 调用方案：**方案 A —— 复用 gateway 已配置的 DeepSeek**（core:8420 `config.llm`）。

---

## 一、目标与场景

- 入口：侧边栏「资产管理」分组新增 `AI 协作` 菜单项，路由 `#/ai-collab`。
- 交互：用户粘贴/输入一个问题（预填示例问题），点「运行对比」。
- 输出：**双栏对比**——左「无记忆（基线）」、右「检索资产后」。右栏附带
  **检索轨迹**（命中记忆/Skill/Wiki 数量）与**资产明细**（用了哪些资产、来源类型、摘要）。
- 价值演示：基线回答是放之四海皆准的通用稿；增强回答接入了用户真实沉淀的
  身份/项目/技术栈/资产上下文，给出贴合项目的可落地建议。

### 示例问题与数据说明（重要）

示例问题取自 `mem0-vs-agent-memory-example.md`：

> "上周把双塔的 user embedding 维度从 64 调到 128，离线 AUC 涨了 0.8%，但线上 CTR 反而降了 0.1%，奇怪"

注意：该问题是**推荐算法**场景，而你资产库当前真实沉淀的是
**携程推荐 PM / Agent 资产管理 / 技术栈**相关记忆。
要让 demo 的「增强」栏完美复现文档中那段针对推荐研发的答案，需要资产库里
**先有推荐算法相关记忆**（可手动 seed 几条，如「负责召回策略，双塔+FM」「AB 实验 hash 分桶有偏移」等）。
否则增强栏注入的是你的真实项目上下文——这本身就是 valid 的增量演示，但和文档示例不完全一致。
**实现时把这作为可选项，默认走「注入真实上下文」即可。**

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────┐
│ 前端 AI 协作 tab (MemoryPanel/web, :8125)                      │
│  POST /api/v1/ai-collab/ask { question, useMemory,             │
│                                useSkill, useWiki }            │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 面板编排路由 (MemoryPanel/src/panel/http/routes/ai-collab.ts)  │
│   1. 检索三类资产（复用现有适配器，不新造索引）                  │
│      · 记忆  → gateway /api/v1/personal/memories（个人 L1）    │
│                + 团队记忆（metaKernel / skill 体系对齐）        │
│      · Skill → skillKernel.listAccessible（team + personal）   │
│      · Wiki  → knowledgeClientFactory(iid).wikiList + wikiSearch│
│   2. 组装两套 system prompt（基线 / 增强）                      │
│   3. 调 LLM ×2（基线无上下文 / 增强带资产上下文）               │
│   4. 记录耗时 + token，返回统一契约                            │
└───────────────────────────┬─────────────────────────────────┘
                            │ POST /v3/internal/llm/chat（新增，方案A）
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ MemoryCore gateway (:8420)                                     │
│   复用 config.llm（已填 DeepSeek）+ resolveStandaloneLlmForRuntime│
│   直连 ${baseUrl}/chat/completions                            │
└─────────────────────────────────────────────────────────────┘
```

---

## 三、前端设计

### 3.1 文件改动清单

| 文件 | 改动 |
| --- | --- |
| `MemoryPanel/web/src/constants/menu.tsx` | `PageId` 加 `ai_collab`；`usePageMeta` 加条目（`group:'assets'`，`order` 排在 `skills` 之后）；`ITEM_ICON` 加图标 |
| `MemoryPanel/web/src/routes/index.tsx` | import `AiCollabPage` + 加 `{ path: 'ai-collab', element: <AiCollabPage /> }` |
| `MemoryPanel/web/src/i18n/zh-CN.ts` | 加 `menu.ai_collab`、`menu.desc.ai_collab` 及页面文案 |
| `MemoryPanel/web/src/i18n/en-US.ts` | 同上英文 |
| `MemoryPanel/web/src/pages/AiCollabPage/index.tsx` | **新建** 页面组件 |
| `MemoryPanel/web/src/pages/AiCollabPage/styles/ai-collab.css` | **新建** 样式（深蓝金主题） |
| `MemoryPanel/web/src/lib/api/ai-collab.ts` | **新建** API client `postAiCollabAsk` |

### 3.2 页面结构（AiCollabPage）

```
┌──────────────────────────────────────────────────────────┐
│ AI 协作 · 记忆资产对比演示                                  │
│ ┌────────────────────────────────────────────────────┐   │
│ │ [问题输入框（Textarea，预填示例）............]      │   │
│ │  ☑ 记忆  ☑ Skill  ☑ Wiki      [ 运行对比 ]       │   │
│ └────────────────────────────────────────────────────┘   │
│                                                            │
│ ┌─────────────── 无记忆（基线） ──────────────┐ ┌───────── 检索资产后 ─────────┐
│ │ 回答正文……                              │ │ 记忆 3 · Skill 2 · Wiki 1   │
│ │                                            │ │ ▸ 用了哪些资产（展开）       │
│ │                                            │ │   • [记忆] 你是携程推荐PM…   │
│ │                                            │ │   • [Skill] xxx            │
│ │                                            │ │ 回答正文……                │
│ │ 耗时 1.2s · 1.1k tokens                    │ │ 耗时 1.8s · 1.6k tokens    │
│ └────────────────────────────────────────────┘ └─────────────────────────────┘
│                                                            │
│ 加载态 / 错误态 / 空态齐备                                  │
└──────────────────────────────────────────────────────────┘
```

- 双栏复用 tea `Card`；指标用 tea `Tag`/`Text`；开关用 tea `Checkbox`/`Segment`；
  检索轨迹用 `Tag`（带类型色：记忆=蓝 / Skill=金 / Wiki=绿）；资产明细用可折叠 `Collapse` 或 `Table`。
- 主题：深蓝金（与项目一致，见 `skills-list.css` 的 `_mysk-*` 配色锚点）。
- 三断点（参考「我的技能」推挤详情）：≥1180 并排 / 960–1180 上下堆叠 / <960 单栏滚动。

### 3.3 状态与交互

- `question`（受控，默认示例问题）、`toggles {useMemory,useSkill,useWiki}`（默认全开）、
  `loading`、`result: AiCollabResult | null`、`error`。
- 点「运行对比」→ `postAiCollabAsk` → 渲染双栏。`AbortController` 支持取消；
  非 2xx 或业务 `code>=40000` 显示错误条（参考面板既有 502 映射逻辑，看 `err.code` 区分瞬时/确定性失败）。

### 3.4 i18n key（建议）

```
menu.ai_collab             = 'AI 协作' / 'AI Collaboration'
menu.desc.ai_collab        = '对比「直接提问」与「检索记忆资产后」的回答差异' / ...
aiCollab.title             = 'AI 协作 · 记忆资产对比演示'
aiCollab.questionPlaceholder = '输入一个问题，对比有无记忆资产时的回答差异…'
aiCollab.run               = '运行对比'
aiCollab.toggleMemory      = '记忆'
aiCollab.toggleSkill       = 'Skill'
aiCollab.toggleWiki        = 'Wiki'
aiCollab.baseline          = '无记忆（基线）'
aiCollab.enhanced          = '检索资产后'
aiCollab.trail             = '检索轨迹'
aiCollab.assetsUsed        = '用了哪些资产'
aiCollab.empty             = '暂无检索到的资产'
aiCollab.err               = '对比失败'
```

---

## 四、后端设计（方案 A）

### 4.1 面板编排路由 —— `MemoryPanel/src/panel/http/routes/ai-collab.ts`

`POST /api/v1/ai-collab/ask`，在 `app.ts` 注册 `registerAiCollabRoutes(api, deps)`。

输入：
```ts
interface AiCollabAskReq {
  question: string;
  useMemory?: boolean; // 默认 true
  useSkill?: boolean;  // 默认 true
  useWiki?: boolean;   // 默认 true
}
```

处理流程：
1. **检索**（并行，各自 try/catch 容错，单类失败不影响其他类）：
   - 记忆：`deps.kernelHttp` / `metaKernel` 调 gateway `GET /api/v1/personal/memories`
     （个人 L1 记录 `PersonalMemory[]`）；团队记忆走 metaKernel 的团队记忆列表。
     取与 `question` 关键词/语义最相关的 top N（前端也可传 `limit`，默认 5）。
   - Skill：`deps.skillKernel.listAccessible(...)`（team 池）+ 个人技能，取 top N（默认 4）。
   - Wiki：`knowledgeClientFactory(instanceId).wikiList(teamId)` → 取前 K 个 wiki →
     逐个 `wikiSearch(wikiId, question, limit)` → 合并按 `score` 取 top N（默认 4）。
2. **组装 prompt**：
   - 基线：`system` = "你是一个乐于助人的助手。" + `user` = question（**无资产上下文**）。
   - 增强：`system` = 资产上下文块（标注来源：`[记忆]…`、`[Skill: name]…`、`[Wiki: title]…`）
     + 指令"结合上方资产上下文回答，并在回答中自然引用相关资产"；`user` = question。
3. **调 LLM ×2**：经 `deps.kernelHttp` `POST gateway /v3/internal/llm/chat`，分别传基线/增强 messages，
   记录 `ms` 与 `usage.tokens`。可并行（`Promise.all`）。
4. **返回**：
```ts
interface AiCollabAskResp {
  baseline: { answer: string; ms: number; tokens: number };
  enhanced: { answer: string; ms: number; tokens: number };
  retrieval: {
    memories: { id: string; content: string; type?: string }[];
    skills:   { name: string; description?: string }[];
    wiki:     { title: string; snippet: string; score?: number }[];
  };
}
```
统一信封 `{ code, message, data }`（与 meta/personal-space 一致，前端用 `unwrapEnvelope`）。

### 4.2 gateway 内部 chat 路由（方案 A 核心新增）

在 `MemoryCore/src/gateway/server.ts` 的 dispatch 中**新增内联块**（仿 `/api/v1/personal/` 与
`buildOffloadLlmClient` 的写法），复用已配置的 DeepSeek：

```ts
// server.ts dispatch，约 1018 行 personal 块之后
if (pathname === "/v3/internal/llm/chat") {
  if (!this.checkAuthForV2(req, res)) return;          // 与 personal 同鉴权（默认开放）
  if (method !== "POST") { /* 405 */ return; }
  const body = await parseJsonBody(req);
  const llmCfg = this.config.llm;
  if (!llmCfg?.baseUrl || !llmCfg?.model) { /* 503 LLM_UNAVAILABLE */ return; }
  if ((llmCfg.provider ?? "openai") === "openai" && !llmCfg.apiKey) { /* 503 */ return; }
  const eff = resolveStandaloneLlmForRuntime(llmCfg, body.instanceId); // 已在本文件 import
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), body.timeoutMs ?? 60000);
  try {
    const r = await fetch(`${eff.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${eff.apiKey}` },
      body: JSON.stringify({
        model: eff.model || body.model,
        messages: body.messages,          // [{role, content}]
        temperature: body.temperature ?? 0.3,
        max_tokens: body.max_tokens ?? 1500,
      }),
      signal: controller.signal,
    });
    if (!r.ok) { /* 透传错误 */ return; }
    const json = await r.json();
    sendJson(res, 200, {
      code: 0, message: "ok",
      data: {
        content: json.choices?.[0]?.message?.content ?? "",
        usage: json.usage ?? null,         // {prompt_tokens, completion_tokens, total_tokens}
      },
    });
  } finally { clearTimeout(timer); }
}
```

- 复用点：`resolveStandaloneLlmForRuntime`（server.ts:3588 已用）、`parseJsonBody`、`sendJson`、
  `checkAuthForV2` —— 均为现有 helper，新增仅为**一个内联分支**，不改动既有路由。
- provider=proxy 时（本机默认可能走代理），`resolveStandaloneLlmForRuntime` 已处理 env 注入，
  行为与现有 offload LLM 客户端一致。

### 4.3 面板 → gateway 调用方式

面板经 `deps.kernelHttp`（`FetchKernelHttpAdapter`，与 `metaKernel` 同源）`POST` 到
gateway `/v3/internal/llab/chat`（修正：`/v3/internal/llm/chat`），带实例 `service-id` + 鉴权头，
与现有 meta/skill 调用同源，无需新加认证。

---

## 五、完整文件改动清单（实现时对照）

**前端（MemoryPanel/web）**
1. `src/constants/menu.tsx` — 加 `ai_collab` 菜单元 + 图标
2. `src/routes/index.tsx` — 加路由
3. `src/i18n/zh-CN.ts` / `src/i18n/en-US.ts` — 加 i18n
4. `src/pages/AiCollabPage/index.tsx` — 新建页面
5. `src/pages/AiCollabPage/styles/ai-collab.css` — 新建样式
6. `src/lib/api/ai-collab.ts` — 新建 API client

**后端**
7. `MemoryPanel/src/panel/http/routes/ai-collab.ts` — 新建编排路由
8. `MemoryPanel/src/panel/http/app.ts` — 注册 `registerAiCollabRoutes`
9. `MemoryCore/src/gateway/server.ts` — 新增 `/v3/internal/llm/chat` 内联分支

（可选）`docs/ai-collab-design.md` 本文件。

---

## 六、验证 / 上线步骤

1. 前端：`cd MemoryPanel/web && ./node_modules/.bin/vite build`
   → 按 `lsof -nP -iTCP:8125 -sTCP:LISTEN -t` kill 旧 panel → 用 `run_detached.py` 同参重启 panel
   → `curl -s http://127.0.0.1:8125/ | grep -o 'assets/main-[^"]*\.js'` 与 `ls dist/assets` 比对确认新版已生效
   → 浏览器硬刷新（panel 已内置 bundle hash 轮询，见工作记忆）。
2. 后端（gateway）：改 `server.ts` 后**必须先 kill 旧 8420 listener**
   （`lsof -nP -iTCP:8420 -sTCP:LISTEN`）再启，否则 EADDRINUSE（参考 `/tmp/restart_core.py` 模式）。
   面板路由改完重启 panel 即可。
3. 验证：打开 `#/ai-collab`，点「运行对比」，确认双栏都有回答、右栏有检索轨迹与资产明细。

---

## 七、风险与备选

- **实时 LLM 依赖**：增强栏真调 DeepSeek，需 core:8420 `config.llm` 已填（工作记忆确认已填）。
  若未填，gateway 返回 503，前端应优雅降级（增强栏显示「LLM 未配置」而非崩溃）。
- **检索需真实数据**：三类资产要有内容，对比才明显；空库时两栏都会偏通用。
- **token / 耗时**：增强栏因带上下文会更长，前端已设计指标展示，符合「差异可视化」诉求。
- **备选（若不想动 gateway）**：退回方案 B（KS 内部 chat 路由）或方案 C（面板直连 key），
  接口契约不变，仅 LLM 调用那一跳不同。
