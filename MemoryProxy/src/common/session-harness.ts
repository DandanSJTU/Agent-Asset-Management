/**
 * session-harness.ts — 会话层「注入内容剥离」共用工具（coslash 优化点②落地）。
 *
 * 背景：本仓库里「首问 / 用户输入里的 harness 包裹剥离」逻辑此前散落在三处，各自维护
 * 一份 tag 清单，新 harness 标签出现时极易漏改：
 *   1) agents/personal-space/session-facts.ts :: extractFirstPrompt（面板首问）
 *   2) MemoryProxy/src/common/user-query-extractor.ts :: extractUserQueryText（代理多 vendor 剥离）
 *   3) scripts/build-insights-dashboard.ts :: stripWrap（仪表盘展示预处理）
 *
 * 此处收敛成「session 包共用工具」：一份权威 harness wrapper tag 清单 + 两个纯函数，
 * 五家 vendor 的剥离统一走这里（对齐 coslash collector/internal/session/text.go 把
 * IsHarnessWrapped / systemReminderRe 收敛成统一「注入内容剥离」函数的思路）。
 * 新增 harness 标签只改这一个清单，五家同步生效。
 *
 * 运行约束：本文件是纯 TS（无外部依赖），同时被两种运行时加载 —— MemoryProxy 走
 * `node --import tsx/esm`（import 用 `.js` 后缀），agents / scripts 走 node24 原生
 * TS 类型擦除（import 用 `.ts` 后缀）。两种写法都指向本文件，互不冲突。
 */

/**
 * 权威 harness wrapper 标签清单（统一来源，五家共用）。
 *
 * 覆盖本仓库已知的所有「夹在 user role 里、但不是用户键入」的 XML 包裹：
 *   - user_query            → 不 block-strip，走 unwrap 保留块内真实提问（见 unwrapUserQuery）
 *   - system-reminder / system_reminder（WorkBuddy / Cursor / CC / CB 同款）
 *   - additional_data / user_info / open_and_recently_viewed_files（CodeBuddy 每条 user 首段）
 *   - session              → proxy 注入的 session context 包裹
 *   - persisted-output / persisted_output（CC "Output too large" 大文件占位）
 *   - tool_use_error / tool-use-error / tool_result / tool-result（伪 wrapper）
 *   - tdai_recalled_l1_memories（proxy 在 user role 注入的 L1 召回上下文，属模型上下文非用户输入）
 *   - conversation_history_summary / cb_summary（压缩后的历史摘要，与上面同类：属模型上下文
 *     非用户输入，被压缩会话的首条 user 记录就是这段机器摘要，必须剥离，否则 GOAL 会显示机器文本）
 *
 * `<*_context>` 类（agent_context / session_context / current_task_context /
 * history_task_context / working_memory_context …）结构不固定，用 CONTEXT_CATCHALL_RE
 * 兜底，不逐一列举，避免新 context 包裹出现时漏改。
 */
export const HARNESS_WRAPPER_TAGS: readonly string[] = [
  "system-reminder", "system_reminder",
  "additional_data",
  "user_info",
  "open_and_recently_viewed_files",
  "session",
  "persisted-output", "persisted_output",
  "tool_use_error", "tool-use-error",
  "tool_result", "tool-result",
  "tdai_recalled_l1_memories",
  "conversation_history_summary", "cb_summary",
  // P0（分层提炼 / 个人记忆）：压缩后系统把 AI 写的摘要塞进 user role 当续接上下文
  "previous_assistant_message",
  // task-notification：后台任务完成通知，非用户键入
  "task-notification",
];

/** 匹配 `<tag ...>...</tag>` block（tag 取自 HARNESS_WRAPPER_TAGS，大小写不敏感） */
function wrapperBlockRe(): RegExp {
  const alt = HARNESS_WRAPPER_TAGS.map((t) => t.replace(/[-_]/g, "[-_]")).join("|");
  return new RegExp(`<(?:${alt})[^>]*>[\\s\\S]*?</(?:${alt})>`, "gi");
}

/** 兜底：`<*_context>` 类包裹（agent_context / session_context / *_task_context …） */
const CONTEXT_CATCHALL_RE =
  /<[a-z][a-z-]*_context[^>]*>[\s\S]*?<\/[a-z][a-z-]*_context>/gi;

/**
 * 续接提示语（P0）：压缩会话后，harness 会把 AI 写的摘要塞进 user role 当续接上下文，
 * 并在其后注入一句 "Please continue with the conversation based on the summarized context…"
 * 作为续接指令。这句不是用户键入，必须剥离——否则分层提炼 / 个人记忆会把 AI 摘要当成
 * "用户的表达"去提炼，产出 consensus 复制品。只剥以该短语开头的整行，避免误伤正常文本。
 */
const CONTINUATION_PROMPT_RE = /Please continue with the conversation based on the summarized context[^\n]*/gi;

/**
 * 提取 `<user_query>…</user_query>` 块内文本（块可能不完整 / 被截断，见下）。
 * 返回非空块内文本数组（顺序即出现顺序）；无块返回空数组。
 *
 * 兼容性：旧数据里 `<user_query>` 闭合标签可能被定长截断吃掉（只剩 `<user_query>` 开头），
 * 调用方若需要「截断也能剥」的语义，请用 stripHarnessWrappers（其内部对截断块也按开启
 * 标签剥离，保留开启标签后的文本）。
 */
export function unwrapUserQuery(raw: string): string[] {
  const out: string[] = [];
  const re = /<user_query>([\s\S]*?)<\/user_query>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const inner = m[1].trim();
    if (inner) out.push(inner);
  }
  return out;
}

/**
 * 注入内容剥离（五家 vendor 共用核心）。
 *
 * 语义（对齐 coslash 优化点① + ②）：
 *   1) 优先提取 `<user_query>` 块内真实提问（join，保留原换行）；
 *   2) 无完整块时，剥离悬空的 `<user_query>` / `</user_query>` 开启标签，
 *      保留其后的用户文本（兼容旧数据被定长截断吃掉闭合标签的情况）；
 *   3) 剥掉 HARNESS_WRAPPER_TAGS 显式清单 + `<*_context>` catch-all 的整块；
 *   4) 不在此折叠空白（保留换行，方便上层做行级过滤 / 首行截取）。
 *
 * 返回「去包裹」后的文本；空白由调用方自行处理。
 */
export function stripHarnessWrappers(raw: string): string {
  if (typeof raw !== "string" || !raw) return raw;
  const queries = unwrapUserQuery(raw);
  // 完整块 → join 块内；否则 → 原文本并剥掉悬空 user_query 开启标签（截断兼容）
  const base = (queries.length > 0 ? queries.join("\n\n") : raw).replace(/<\/?user_query[^>]*>/gi, "");
  return base
    .replace(wrapperBlockRe(), "")
    .replace(CONTEXT_CATCHALL_RE, "")
    .replace(CONTINUATION_PROMPT_RE, "");
}

/**
 * 首问展示兜底清洗（coslash 优化点④）：从去包裹文本里取「首行 + 定长截断」，
 * 并抹掉仍可能露出的内网路径 / 内网 IP / token，防无 ai-title 时列表露出隐私。
 *
 * 设计：
 *   - 先取首行（真实提问通常在第一行；长日志 / 多段 harness 残留散在后续行，不进标题）。
 *   - 定长截断（默认 80 字符，与历史 firstPrompt 上限一致）。
 *   - 抹掉残余内网路径（/Users / /home / C:\Users / \\wsl$\）、内网 IPv4
 *     （10./192.168./172.16-31./127.0.0.1/localhost）、常见 token / 密钥形态。
 *
 * 入参 `text` 应为已 stripHarnessWrappers 的去包裹文本；本函数不再处理 wrapper。
 *
 * 路径抹除分两条规则（修复「探索 …」标题塌缩，见 docs/session-title-fallback-scrub-fix.html）：
 *   - A0（引号包裹）：整条引号串抹除。覆盖 "@/Users/dan/My Project/x.ts" 这类带空格的路径，
 *     隐私语义与原设计完全一致，必须最先执行，否则会被 A2 从内部击穿。
 *   - A2（无引号）：路径 token 遇【空白 / 引号 / 中文标点（含全角）】即止。子会话首问常是
 *     无引号的绝对路径（如 "探索 /Users/.../store/ 目录下…"），原规则 [^\n"]* 从 /Users 贪吃到
 *     行尾把真实提问整段吞掉；A2 在路径后的第一个空白处停止，保留后续中文提问。
 *   顺序约束：A0 必须先于 A2 执行。
 */
// 路径是 ASCII（字母/数字/./-/_/~/:），所以「遇空白 / 引号 / 非 ASCII（中文·全角）即止」即可
// 完整覆盖无引号绝对路径场景，又不会像旧规则 [^\n"]* 那样贪吃到行尾。
// 字符类用排除式：[^\s"'\x80-\uffff] = 匹配「ASCII 且非空白非引号」的路径字符，遇非 ASCII（CJK/全角）即停。
const INTERNAL_SCRUB_RES: readonly RegExp[] = [
  // A0 引号包裹路径：整条引号串抹除。必须最先执行，覆盖 "@/Users/dan/My Project/x.ts" 这类带空格路径，
  // 隐私语义与原设计完全一致（不回退）。
  /"[^"\n]*(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^"\n]*"/g,
  // A2 无引号 macOS / Linux 绝对路径：遇空白 / 引号 / 非 ASCII 即止（修复「探索 …」塌缩；隐私不回退于 A0）
  /\/(?:Users|home)\/[^\s"'\x80-\uffff]*/g,
  // Windows 用户路径（无引号）：同源修复，遇空白 / 引号 / 非 ASCII 即止
  /[A-Za-z]:\\Users\\[^\s"'\x80-\uffff]*/g,
  // WSL 路径
  /\\wsl\$\\[^\n"]*/g,
  // 内网 IPv4（10. / 127. / 192.168. / 172.16-31.）
  /\b(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?::\d+)?\b/g,
  /\blocalhost(?::\d+)?\b/g,
  // 常见 token / 密钥形态
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:Bearer|token|api[_-]?key)\s*[:=]\s*\S+/gi,
];

export function sanitizeFirstPromptForDisplay(text: string, max = 80): string {
  // 先取首行（真实提问通常在第一行）
  const firstLine =
    text
      .split("\n")
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? "";
  // 折叠多余空白
  let safe = firstLine.replace(/\s+/g, " ").trim();
  // 先抹掉残余内网路径 / IP / token，再定长截断 —— 顺序很关键：
  // 路径常在 80 字内占满，若先截断会把用户真实后半句吃掉，先抹除路径再截断
  // 才能保留「帮我看 @… 的改动」这种可读结果（coslash 优化点④）。
  for (const re of INTERNAL_SCRUB_RES) safe = safe.replace(re, "…");
  return safe.slice(0, max);
}
