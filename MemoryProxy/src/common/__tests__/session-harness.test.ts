/**
 * session-harness.test.ts — 回归测试：首问路径清洗（修复「探索 …」标题塌缩，plan A）。
 *
 * 覆盖 docs/session-title-explore-bug-report.html 中「A0 引号路径 + A2 无引号绝对路径」两条规则：
 *   - A0 最先执行，整条引号包裹路径（含空格路径）抹除为 "…"，隐私语义不回退；
 *   - A2 无引号绝对路径遇空白 / 引号 / 非 ASCII（中文·全角）即止，保留路径后真实提问；
 *   - 纯路径 / IP / token 仍被抹除（交前端 C 护栏降级为「未命名会话」）。
 */
import { describe, it, expect } from "vitest";
import { sanitizeFirstPromptForDisplay, stripHarnessWrappers } from "../session-harness.js";

/** 可读字符数（去除 … 与空白占位），对齐前端 C 护栏的「超短」判定口径 */
function readableLen(s: string): number {
  return s.replace(/[…\.\s]/g, "").length;
}

describe("sanitizeFirstPromptForDisplay · plan A 路径清洗", () => {
  it("A2：无引号绝对路径后跟中文提问 —— 不再吞掉整段（核心回归）", () => {
    const input =
      "探索 /Users/dandan/Projects/TencentDB-Agent-Memory/MemoryCore/src/store/ 目录下记忆存储与检索的实现细节，thoroughness: very thorough。重点回答：";
    const out = sanitizeFirstPromptForDisplay(input, 80);
    // 不再是「探索 …」
    expect(out).not.toBe("探索 …");
    // 路径被抹掉，真实提问保留
    expect(out).not.toContain("/Users/dandan");
    expect(out).toContain("目录下");
    expect(out).toContain("记忆存储");
    // 可读长度远超护栏阈值（>2），前端不会误触发「未命名会话」
    expect(readableLen(out)).toBeGreaterThan(2);
  });

  it("A0：引号包裹路径（含空格路径）整条抹除，隐私语义不回退", () => {
    const input = '帮我看 "@/Users/dan/My Project/memory-core/src/store.ts" 的改动';
    const out = sanitizeFirstPromptForDisplay(input, 80);
    expect(out).toContain("帮我看");
    expect(out).toContain("的改动");
    // 整条引号路径（含 Projects / store.ts / 空格）都已抹除
    expect(out).not.toContain("Projects");
    expect(out).not.toContain("store.ts");
    expect(out).not.toContain("My Project");
    expect(readableLen(out)).toBeGreaterThan(2);
  });

  it("A2：纯绝对路径（无中文）—— 抹成 …，交前端 C 护栏降级", () => {
    const input = "/Users/dandan/Projects/TencentDB-Agent-Memory/docs/file.html";
    const out = sanitizeFirstPromptForDisplay(input, 80);
    expect(out).toBe("…");
    expect(readableLen(out)).toBe(0);
  });

  it("A2-Windows：无引号 C:\\Users 路径抹除，保留后续中文", () => {
    const input = "分析 C:\\Users\\dandan\\app\\main.go 里的逻辑";
    const out = sanitizeFirstPromptForDisplay(input, 80);
    expect(out).not.toContain("C:\\Users");
    expect(out).toContain("里的逻辑");
    expect(readableLen(out)).toBeGreaterThan(2);
  });

  it("内网 IPv4 + 端口抹除，保留前后文", () => {
    const input = "连 10.12.34.56:8080 的网关服务做健康检查";
    const out = sanitizeFirstPromptForDisplay(input, 80);
    expect(out).not.toContain("10.12.34.56");
    expect(out).toContain("网关服务");
    expect(readableLen(out)).toBeGreaterThan(2);
  });

  it("token 抹除（Bearer/token 后接 := 值，值不外露）", () => {
    const input = "Authorization: token: tk_abcdef1234567890xyz 调用接口";
    const out = sanitizeFirstPromptForDisplay(input, 80);
    expect(out).not.toContain("tk_abcdef1234567890xyz");
    expect(readableLen(out)).toBeGreaterThan(2);
  });

  it("普通提问（无路径 / 无隐私）原样保留", () => {
    const input = "如何优化 PostgreSQL 查询性能？";
    const out = sanitizeFirstPromptForDisplay(input, 80);
    expect(out).toBe("如何优化 PostgreSQL 查询性能？");
    expect(readableLen(out)).toBeGreaterThan(2);
  });
});

describe("stripHarnessWrappers · 注入包裹剥离", () => {
  it("剥离 <user_query> 块并保留块内真实提问", () => {
    const raw = "前缀 <user_query>真实提问内容</user_query> 后缀";
    const out = stripHarnessWrappers(raw);
    expect(out).toContain("真实提问内容");
    expect(out).not.toContain("<user_query>");
  });

  it("剥离 system-reminder 包裹", () => {
    const raw = "问题 <system-reminder>不要泄露</system-reminder> 是什么？";
    const out = stripHarnessWrappers(raw);
    expect(out).toContain("问题");
    expect(out).toContain("是什么？");
    expect(out).not.toContain("不要泄露");
  });
});
