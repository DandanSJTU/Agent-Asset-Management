/**
 * build-insights-dashboard.ts — 生成「会话洞察」独立可运行 HTML 仪表盘（真实数据）。
 *
 * 为什么存在：MemoryPanel 的 web 工程在本沙箱无法 build/run（无 tsc / 无 dev server），
 * 但 agents/personal-space 派生事实引擎已在真数据上跑通（verify-m1 通过）。本脚本直接复用
 * 同一引擎，把派生事实 + 时间线 + Resume Readiness 渲染成【单文件自包含 HTML】，
 * 双击即可在浏览器打开，验证 P0 会话洞察 UI 的真实效果，无需任何后端。
 *
 * 运行：node24 scripts/build-insights-dashboard.ts
 * 输出：docs/personal-space-insights.html
 */
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// 会话层「注入内容剥离」共用工具（coslash 优化点②）：仪表盘展示预处理复用同一份
// harness 包裹剥离逻辑，避免与 agents / MemoryProxy 三处各维护一份 tag 清单。
import { stripHarnessWrappers } from "../MemoryProxy/src/common/session-harness.ts";

const here = dirname(fileURLToPath(import.meta.url));
const enginePath = resolve(here, '../agents/personal-space/facts.ts');

async function main() {
  const engineUrl = pathToFileURL(enginePath).href;
  const engine = (await import(engineUrl)) as unknown as {
    computeAllSessions: (useCache?: boolean) => {
      facts: Array<Record<string, unknown>>;
      cached: number;
      rebuilt: number;
      coldMs: number;
    };
  };

  // 时间线需要全量原始记录（批量构建工具，全量读是固有成本，与索引化不冲突）；
  // facts 走 computeAllSessions 索引化缓存（M1 DoD②：命中零读盘）。
  const scanner = (await import(pathToFileURL(resolve(here, '../agents/personal-space/session-facts.ts')).href)) as unknown as {
    scanSessions: (vendor?: string) => Array<{ session: Record<string, unknown>; raw: { records: Record<string, unknown>[] } }>;
  };
  const scanned = scanner.scanSessions('workbuddy');
  const { facts, cached, rebuilt, coldMs } = engine.computeAllSessions(true);

  const sessions = facts
    .map((f) => {
      const sc = scanned.find((s) => (s.session as Record<string, unknown>).sessionId === f.sessionId);
      const records = (sc?.raw?.records ?? []) as Record<string, unknown>[];
      const digest = (f.digest ?? {}) as Record<string, unknown>;
      const tokens = (f.tokens ?? {}) as Record<string, unknown>;
      const git = (f.git ?? null) as Record<string, unknown> | null;

      // ── coslash 对标维度（Debrief / Resume），构建器层派生，引擎零改 ──
      const recText = (r: Record<string, unknown>): string => {
        const c = r.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' ? String((x as Record<string, unknown>).text ?? '') : '')).join(' ');
        return '';
      };
      const stripWrap = (s: string): string => stripHarnessWrappers(s).trim();
      const findUsage = (r: Record<string, unknown>): Record<string, unknown> | null => {
        const pd = r.providerData as Record<string, unknown> | undefined;
        const msg = r.message as Record<string, unknown> | undefined;
        const resp = pd?.response as Record<string, unknown> | undefined;
        const cands = [r.usage, msg?.usage, pd?.usage, resp?.usage, (resp?.body as Record<string, unknown> | undefined)?.usage];
        for (const c of cands) if (c && typeof c === 'object') return c as Record<string, unknown>;
        return null;
      };
      const numOf = (v: unknown): number =>
        typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : 0;

      // ── coslash 对标：语义化 digest 事件流（TIMELINE 数据源，仿 collector DigestLog.Push）──
      // first_prompt=第1条用户提问；user=后续提问；recap=助手回复；question=AskUserQuestion；
      // todos=TaskCreate/TaskUpdate；每条带 turn（第几个 prompt）与 ts（epoch ms）
      const tsOf = (r: Record<string, unknown>): number => {
        const v = (r.timestamp ?? r.ts) as unknown;
        if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
        if (typeof v === 'string') { const d = Date.parse(v); return Number.isNaN(d) ? 0 : d; }
        return 0;
      };
      const parseArgs = (r: Record<string, unknown>): Record<string, unknown> | null => {
        let p = r.parameters ?? r.args ?? r.input ?? r.arguments;
        if (typeof p === 'string') { try { p = JSON.parse(p); } catch { return null; } }
        return p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
      };
      const recs = records.slice().sort((a, b) => tsOf(a) - tsOf(b));
      const digestEvents: Array<{ cat: string; text: string; turn: number; ts: number }> = [];
      let prompts = 0;
      let firstUserTs: number | null = null;
      let firstAiTs: number | null = null;
      const MAX_EVENTS = 400;
      for (const r of recs) {
        if (digestEvents.length >= MAX_EVENTS) break;
        const ts = tsOf(r);
        const turn = Math.max(prompts, 1);
        const role = r.role;
        if (role === 'user') {
          const t = stripWrap(recText(r)).replace(/\s+/g, ' ').trim();
          if (!t) continue;
          prompts++;
          digestEvents.push({ cat: prompts === 1 ? 'first_prompt' : 'user', text: t.slice(0, 1200), turn: prompts, ts });
          if (firstUserTs === null) firstUserTs = ts;
        } else if (role === 'assistant') {
          const t = stripWrap(recText(r)).replace(/\s+/g, ' ').trim();
          if (!t) continue;
          digestEvents.push({ cat: 'recap', text: t.slice(0, 800), turn, ts });
          if (firstAiTs === null) firstAiTs = ts;
        } else if (r.type === 'function_call') {
          const name = String(r.name ?? '');
          const args = parseArgs(r);
          if (!args) continue;
          if (/askuserquestion/i.test(name)) {
            const qs = Array.isArray(args.questions) ? (args.questions as Record<string, unknown>[]) : [];
            for (const q of qs) {
              const qt = String(q.question ?? q.header ?? '').trim();
              if (qt) digestEvents.push({ cat: 'question', text: qt.slice(0, 500), turn, ts });
            }
          } else if (/taskcreate|taskupdate|todo/i.test(name)) {
            const s = String(args.subject ?? args.taskId ?? args.content ?? '').trim();
            if (s) {
              const prefix = /taskupdate/i.test(name) ? 'updated — ' : '';
              digestEvents.push({ cat: 'todos', text: (prefix + s).slice(0, 300), turn, ts });
            }
          }
        }
      }

      // GOAL=首条 user 真实提问（全文）；OUTCOME=末条 assistant 文本（降级，coslash 用 LLM synthesis）
      let goalFull = '';
      let outcome = '';
      let lastEditAt: number | null = null;
      let contextUsed: number | null = null;
      for (const r of records) {
        if (r.role === 'user' && !goalFull) {
          const t = stripWrap(recText(r));
          if (t) goalFull = t.slice(0, 4000);
        }
        if (r.role === 'assistant') {
          const t = stripWrap(recText(r));
          if (t) outcome = t.slice(0, 4000);
        }
        if (r.type === 'function_call' && /edit|write|replace|multiedit|notebook/i.test(String(r.name ?? ''))) {
          const ts = Number((r.timestamp ?? r.ts) || 0);
          if (ts > 0 && (lastEditAt === null || ts > lastEditAt)) lastEditAt = ts;
        }
        const u = findUsage(r);
        if (u) {
          const input = numOf(u.inputTokens) || numOf(u.input_tokens);
          let cacheRead = numOf(u.cache_read_input_tokens);
          const det = u.inputTokensDetails ?? u.prompt_tokens_details;
          if (Array.isArray(det)) {
            for (const d of det as Record<string, unknown>[]) cacheRead += numOf(d?.cached_tokens);
          } else if (det && typeof det === 'object') {
            cacheRead += numOf((det as Record<string, unknown>).cached_tokens);
          }
          const cacheCreate = numOf(u.cache_creation_input_tokens);
          const used = input + cacheRead + cacheCreate;
          if (used > 0) contextUsed = used;
        }
      }
      // 内部模型别名无公开窗口口径，按 256k 估算，仅作相对水位参考
      const CONTEXT_WINDOW_EST = 262144;

      const readiness = {
        context: { status: (Number(digest.compaction) > 0 ? 'warn' : 'ok'), note: `compaction ${digest.compaction ?? 0}` },
        compression: { status: 'ok', note: `${Number(tokens.total ?? 0).toLocaleString()} tokens` },
        branch: { status: git?.behind ? 'warn' : 'ok', note: git ? `behind ${git.behind ?? 0}` : '无 git' },
        workspace: { status: 'ok', note: f.firstPrompt ? '有首问' : '无首问' },
        cache: { status: 'ok', note: `cacheRead ${(Number(tokens.cacheRead ?? 0)).toLocaleString()}` },
      };

      return {
        sessionId: f.sessionId,
        kind: f.kind,
        parentId: f.parentId ?? null,
        vendor: f.vendor,
        state: f.state,
        startedAt: f.startedAt ?? null,
        endedAt: f.endedAt ?? null,
        recordCount: f.recordCount,
        size: f.size,
        mtime: f.mtime,
        firstPrompt: f.firstPrompt,
        userTurns: f.userTurns,
        assistantTurns: f.assistantTurns,
        tokens: f.tokens,
        costUsd: f.costUsd,
        costEstimated: !!f.costEstimated,
        models: (f.models || []).map((m: Record<string, unknown>) => ({
          model: m.model,
          costUsd: m.costUsd,
          estimated: !!m.estimated,
        })),
        git: f.git ?? null,
        edits: f.edits,
        digest: f.digest,
        goalFull,
        outcome,
        lastEditAt,
        context: { used: contextUsed, window: CONTEXT_WINDOW_EST },
        readiness,
        digestEvents,
        firstUserTs,
        firstAiTs,
      };
    })
    .sort((a, b) => Number(b.mtime) - Number(a.mtime));

  const totalTokens = sessions.reduce((a, s) => a + Number((s.tokens as Record<string, unknown>).total ?? 0), 0);
  const totalCost = sessions.reduce((a, s) => a + Number(s.costUsd), 0);
  const estimatedCount = sessions.filter((s) => s.costEstimated).length;

  const data = {
    generatedAt: new Date().toISOString(),
    stats: { total: sessions.length, cached, rebuilt, coldMs, totalTokens, totalCost, estimatedCount },
    sessions,
  };

  const html = renderHtml(data);
  const outPath = resolve(here, '../docs/personal-space-insights.html');
  writeFileSync(outPath, html, 'utf-8');
  // eslint-disable-next-line no-console
  console.log(`✓ 仪表盘已生成：${outPath}`);
  // eslint-disable-next-line no-console
  console.log(`  会话 ${sessions.length} · token ${totalTokens.toLocaleString()} · 成本 $${totalCost.toFixed(2)} · 估算 ${estimatedCount}`);
}

function renderHtml(data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>会话洞察 · Session Insights</title>
<style>
  :root{
    --bg:#0b1f3a; --bg2:#0e2a52; --panel:#102a4c; --panel2:#0d2342;
    --line:#1d3b63; --text:#e8eef7; --muted:#9fb3d1; --gold:#e6b450; --gold2:#f0c75e;
    --green:#3ec98a; --amber:#ffb547; --red:#ff6b6b; --cyan:#5fd0e0; --pink:#e668b8;
  }
  *{box-sizing:border-box}
  body{margin:0;background:linear-gradient(180deg,var(--bg),var(--bg2));color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;}
  header{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
  header h1{margin:0;font-size:20px;color:var(--gold2);letter-spacing:.5px}
  header .sub{font-size:12px;color:var(--muted)}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;padding:16px 22px}
  .tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  .tile .k{font-size:12px;color:var(--muted)}
  .tile .v{font-size:22px;font-weight:700;margin-top:4px;color:var(--gold2)}
  .tile .s{font-size:11px;color:var(--muted);margin-top:2px}
  .toolbar{display:flex;gap:10px;align-items:center;padding:0 22px 12px;flex-wrap:wrap}
  .toolbar input,.toolbar select{background:var(--panel2);border:1px solid var(--line);color:var(--text);
    border-radius:8px;padding:7px 10px;font-size:13px;outline:none}
  .toolbar input{flex:1;min-width:200px}
  .layout{display:flex;gap:14px;padding:0 22px 28px;align-items:flex-start}
  .list{flex:1 1 58%;min-width:0;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  .list .row{display:grid;grid-template-columns:1fr 90px 110px 120px 80px 90px 130px;gap:6px;
    padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;font-size:12px;align-items:center}
  .list .row.head{background:var(--panel2);color:var(--muted);cursor:default;position:sticky;top:0;z-index:2}
  .list .row:hover{background:#13315a}
  .list .row.sel{background:#16335e;box-shadow:inset 3px 0 0 var(--gold)}
  .list .fp{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .list .num{text-align:right;font-variant-numeric:tabular-nums;color:var(--muted)}
  .tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:6px;background:#1c3a63;color:var(--muted)}
  .est{color:var(--amber);font-size:10px;margin-left:3px}
  .insp{flex:1 1 42%;min-width:320px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
  .insp h3{margin:0 0 10px;color:var(--gold2);font-size:15px}
  .kv{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;font-size:12px;margin-bottom:14px}
  .kv .k{color:var(--muted)} .kv .vs{font-weight:600}
  .sec-t{font-size:12px;color:var(--muted);margin:14px 0 6px}
  .dig{display:flex;flex-wrap:wrap;gap:6px}
  .readiness{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-top:6px}
  .rc{border-radius:8px;padding:8px 4px;text-align:center;border:1px solid var(--line)}
  .rc .n{font-size:10px;color:var(--muted)}
  .rc .d{font-size:9px;line-height:1.2;margin-top:2px}
  .dot{width:9px;height:9px;border-radius:50%;margin:5px auto}
  .dwrap{max-height:420px;overflow:auto;margin-top:4px;border:1px solid var(--line);border-radius:8px;padding:2px 12px 8px}
  .dday{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;color:var(--muted);font-size:11px;font-weight:700;padding:10px 0 4px;letter-spacing:.5px}
  .dday span{height:1px;background:var(--line)}
  .drow{display:flex;gap:10px;padding:6px 0;border-bottom:1px solid var(--line);align-items:baseline}
  .drow:last-child{border-bottom:0}
  .dlab{flex:0 0 96px;font-size:11px;font-weight:700;letter-spacing:.4px}
  .dbody{flex:1;min-width:0;font-size:12px;line-height:1.55}
  .dtext{white-space:pre-wrap;word-break:break-word}
  .dtext.clamp{display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;white-space:normal}
  .dans{border-left:2px solid var(--line);color:var(--muted);padding-left:8px;margin-top:4px;font-size:11px;word-break:break-word}
  .dtoggle{color:var(--cyan);cursor:pointer;font-size:11px;display:inline-block;margin-top:2px;user-select:none}
  .dturn{flex:0 0 auto;text-align:right;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:var(--muted);white-space:nowrap;line-height:1.5}
  .empty{color:var(--muted);font-size:13px;padding:24px;text-align:center}
  .foot{padding:10px 22px 24px;color:var(--muted);font-size:11px}
  .statusbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:12px}
  .badge{font-size:11px;padding:2px 8px;border-radius:7px;border:1px solid var(--line);background:var(--panel2);white-space:nowrap}
  .badge.cost{color:var(--gold2);border-color:rgba(240,199,94,.4)}
  .badge.model{color:var(--cyan);border-color:rgba(95,208,224,.4)}
  .badge.dir{color:var(--muted);max-width:300px;overflow:hidden;text-overflow:ellipsis}
  .tokblocks{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:6px}
  .tok{border-radius:8px;padding:9px 6px;text-align:center;border:1px solid var(--line)}
  .tok .tk{font-size:10px;color:var(--muted)}
  .tok .tv{font-size:14px;font-weight:700;margin-top:3px;font-variant-numeric:tabular-nums}
  .tok.in{background:rgba(95,208,224,.12)} .tok.in .tv{color:var(--cyan)}
  .tok.out{background:rgba(240,199,94,.12)} .tok.out .tv{color:var(--gold2)}
  .tok.cache{background:rgba(62,201,138,.12)} .tok.cache .tv{color:var(--green)}
  .tok.cc{background:rgba(159,179,209,.1)} .tok.cc .tv{color:var(--muted)}
  .cachebar-wrap{display:flex;align-items:center;gap:10px;margin-top:10px;font-size:11px;color:var(--muted)}
  .cachebar{flex:1;height:8px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;overflow:hidden}
  .cachebar-fill{height:100%;background:linear-gradient(90deg,var(--green),var(--cyan))}
  .cb-pct{font-weight:700;color:var(--green);min-width:42px;text-align:right}
  .resume-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:6px}
  .rcell{background:var(--panel2);padding:10px 12px}
  .rcell .k{font-size:11px;color:var(--muted)}
  .rcell .v{font-size:14px;font-weight:700;margin-top:3px;color:var(--text)}
  .rcell .v.green{color:var(--green)} .rcell .v.amber{color:var(--amber)} .rcell .v.red{color:var(--red)}
  .rcell .sub{font-size:10px;color:var(--muted);margin-top:2px}
  .handoff-actions{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap}
  .handoff-actions button{background:var(--panel2);border:1px solid var(--gold);color:var(--gold2);border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer}
  .handoff-actions button:hover{background:rgba(240,199,94,.12)}
  .handoff-actions .hint{font-size:10px;color:var(--muted)}
  .db-block{border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px;background:rgba(13,35,66,.6)}
  .db-label{font-size:11px;color:var(--muted);letter-spacing:.5px}
  .db-label .db-src{background:#1c3a63;border-radius:6px;padding:1px 6px;margin-left:6px;color:var(--text);letter-spacing:0}
  .db-text{margin:8px 0 0;border-left:3px solid var(--gold);padding:2px 10px;font-size:12px;line-height:1.6;color:var(--text);white-space:pre-wrap;word-break:break-word}
  .db-empty{color:var(--muted);font-size:12px;margin-top:6px}
  .db-toggle{font-size:11px;color:var(--cyan);cursor:pointer;user-select:none;margin-top:6px;display:inline-block}
  .tl-head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;margin:14px 0 6px}
  .tl-title{font-size:12px;color:var(--muted)}
  .tl-title .tl-sub{font-size:10px}
  .tl-chips{display:flex;gap:6px;flex-wrap:wrap}
  .tl-chip{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;padding:3px 8px;border-radius:8px;background:var(--panel2);border:1px solid var(--line);letter-spacing:.4px;color:var(--text);cursor:pointer;user-select:none}
  .tl-chip:hover{background:#13315a}
  .tl-chip.off{opacity:.55;border-style:dashed}
  .tl-chip.off i{background:var(--muted)}
  .tl-chip i{width:7px;height:7px;border-radius:50%;display:inline-block}
  .c-fp i{background:var(--green)} .c-td i{background:var(--muted)} .c-rc i{background:var(--pink)} .c-ut i{background:var(--cyan)}
  .range{display:flex;gap:2px;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:3px;margin-left:auto}
  .rchip{font-size:12px;padding:5px 12px;border-radius:7px;color:var(--muted);cursor:pointer;user-select:none;white-space:nowrap}
  .rchip:hover{color:var(--text)}
  .rchip.on{background:#1c3a63;color:var(--gold2);font-weight:600}
  .scopebar{padding:0 22px 10px;font-size:12px;color:var(--muted);display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .scopebar strong{color:var(--text);font-weight:650}
  .scopebar .rglabel{color:var(--gold2);background:rgba(240,199,94,.1);border:1px solid rgba(240,199,94,.3);border-radius:6px;padding:1px 8px;font-size:11px}
  .vtabs{display:flex;gap:4px;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:3px}
  .vtab{font-size:12px;padding:5px 14px;border-radius:7px;color:var(--muted);cursor:pointer;user-select:none}
  .vtab:hover{color:var(--text)}
  .vtab.on{background:#1c3a63;color:var(--gold2);font-weight:600}
  #view-board{padding:0 22px 28px}
  .board-bar{display:flex;gap:8px;align-items:center;font-size:12px;color:var(--muted);margin-bottom:10px;flex-wrap:wrap}
  .board-bar select{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:8px;padding:5px 8px;font-size:12px;outline:none}
  .board{display:grid;gap:10px;overflow-x:auto;padding-bottom:8px}
  .bcol-h{font-size:12px;font-weight:700;color:var(--text);background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;display:flex;justify-content:space-between;gap:8px;min-width:0}
  .bcol-h .n{color:var(--muted);font-weight:400;white-space:nowrap}
  .brow-l{font-size:12px;font-weight:700;color:var(--gold2);background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;display:flex;justify-content:space-between;gap:6px;position:sticky;left:0;min-width:0}
  .brow-l .n{color:var(--muted);font-weight:400;white-space:nowrap}
  .bcell{display:flex;flex-direction:column;gap:8px;min-width:0}
  .bcard{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 12px;cursor:pointer}
  .bcard:hover{background:#13315a}
  .bcard.sel{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold)}
  .bc-top{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--muted);gap:6px}
  .bc-src{background:#1c3a63;border-radius:6px;padding:1px 7px;white-space:nowrap}
  .bc-cost{color:var(--gold2);font-variant-numeric:tabular-nums;white-space:nowrap}
  .bc-title{font-size:12px;font-weight:600;margin-top:6px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
  .bc-sub{font-size:10px;color:var(--muted);margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bc-meta{font-size:10px;color:var(--green);margin-top:3px}
  #view-insights{padding:0 22px 28px}
  .ins-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px}
  .ins-head h2{margin:0;font-size:16px;color:var(--gold2)}
  .ins-head .sub{font-size:11px;color:var(--muted)}
  .monthnav{display:flex;align-items:center;gap:10px;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:4px 10px}
  .monthnav b{font-size:13px;color:var(--text);min-width:90px;text-align:center}
  .monthnav span{cursor:pointer;color:var(--muted);font-size:16px;user-select:none;padding:0 4px}
  .monthnav span:hover{color:var(--gold2)}
  .ins-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .ins-card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0}
  .ins-card.wide{grid-column:1/-1}
  .ic-t{font-size:12px;font-weight:700;color:var(--text)}
  .ic-sub{font-size:10px;color:var(--muted);margin-top:8px}
  .pie-row{display:flex;align-items:center;gap:18px;margin-top:10px;flex-wrap:wrap}
  .lg{display:flex;flex-direction:column;gap:6px;font-size:12px}
  .lg span{display:flex;align-items:center;gap:7px;color:var(--text)}
  .lg i{width:9px;height:9px;border-radius:2px;display:inline-block}
  .lg .pct{color:var(--muted)}
  .bar-row{display:flex;align-items:center;gap:10px;font-size:12px;margin-top:8px}
  .bar-row .bl{flex:0 0 220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)}
  .bar-row .btrack{flex:1;height:10px;background:var(--panel2);border-radius:5px;overflow:hidden}
  .bar-row .bfill{height:100%;background:var(--cyan);border-radius:5px}
  .bar-row .bn{flex:0 0 30px;text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
  .big-cost{font-size:30px;font-weight:800;color:var(--gold2);margin-top:10px}
  .daybars{display:flex;align-items:flex-end;gap:4px;margin-top:12px;height:110px}
  .daybars .dcol{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0}
  .daybars .dbar{width:100%;max-width:26px;background:var(--cyan);border-radius:3px 3px 0 0}
  .daybars .dn{font-size:9px;color:var(--muted)}
  .daybars .dl{font-size:9px;color:var(--muted)}
  .ins-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:12px}
</style>
</head>
<body>
<header>
  <div><h1>会话洞察 · Session Insights</h1>
  <div class="sub">派生事实引擎实时生成 · P0 观测面（单机自用）</div></div>
  <div style="display:flex;align-items:center;gap:14px">
    <div class="vtabs" id="vtabs">
      <span class="vtab on" data-view="table">Table</span>
      <span class="vtab" data-view="board">Board</span>
      <span class="vtab" data-view="insights">Insights</span>
    </div>
    <div class="sub" id="genat"></div>
  </div>
</header>
<div class="toolbar" id="toolbar">
  <input id="search" placeholder="搜索会话 / 首问 / 来源…" />
  <select id="sort">
    <option value="recent">排序：最近修改</option>
    <option value="cost">排序：成本</option>
    <option value="tokens">排序：Token</option>
  </select>
  <div class="range" id="range"></div>
</div>
<div class="scopebar" id="scope"></div>
<div class="layout" id="view-table">
  <div class="list" id="list"></div>
  <div class="insp" id="insp"><div class="empty">点击左侧会话查看派生事实 / 时间线 / 续会话就绪度</div></div>
</div>
<div id="view-board" style="display:none">
  <div class="board-bar">
    <span>Columns</span>
    <select id="colDim">
      <option value="state" selected>状态</option>
      <option value="repo">仓库 / 目录</option>
      <option value="agent">Agent</option>
    </select>
    <span>Rows</span>
    <select id="rowDim">
      <option value="repo" selected>仓库 / 目录</option>
      <option value="state">状态</option>
      <option value="agent">Agent</option>
      <option value="none">无</option>
    </select>
  </div>
  <div class="board" id="board"></div>
</div>
<div id="view-insights" style="display:none">
  <div class="ins-head">
    <div><h2>Insights</h2><div class="sub">按会话最后活跃自然月统计 · 用于复盘与成本回顾</div></div>
    <div class="monthnav"><span id="m-prev" title="上一月">‹</span><b id="m-label"></b><span id="m-next" title="下一月">›</span></div>
  </div>
  <div class="ins-stats" id="ins-stats"></div>
  <div class="ins-grid" id="insights-body"></div>
</div>
<div class="foot">数据来源：agents/personal-space 派生事实引擎（computeAllSessions，真实 WorkBuddy 会话）。成本含估算模型（hy3/hy3-x/hy4-preview）按公开混元定价区间折算，仅供相对排名。<span id="engine-info"></span></div>

<script id="data" type="application/json">${json}</script>
<script>
const DATA = JSON.parse(document.getElementById('data').textContent);
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const fmt = (n)=> (n??0).toLocaleString('en-US');
const fmtCost = (u,e)=> '$'+(u??0).toFixed(e?4:2);
const fmtSize = (b)=> b<1048576 ? Math.round(b/1024)+' KB' : (b/1048576).toFixed(1)+' MB';
const fmtTime = (ts)=> { if(!ts) return '—'; const d=new Date(ts); const p=n=>String(n).padStart(2,'0'); return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); };
const fmtTs = (ts)=> { if(!ts) return ''; const d=new Date(ts); const p=n=>String(n).padStart(2,'0'); return p(d.getMonth()+1)+'-'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds()); };

document.getElementById('genat').textContent = '生成于 ' + fmtTime(Date.parse(DATA.generatedAt));

const fmtDur = (ms)=> { if(ms==null||isNaN(ms)||ms<0) return '—'; const s=Math.round(ms/1000); if(s<60) return s+' 秒'; const m=Math.floor(s/60); if(m<60) return m+' 分'; const h=Math.floor(m/60); const mm=m%60; if(h<24) return h+' 时'+(mm?(' '+mm+' 分'):''); const d=Math.floor(h/24); return d+' 天 '+(h%24)+' 时'; };
const isUser = (t)=> { const r=String(t.role||'').toLowerCase(); const ty=String(t.type||'').toLowerCase(); return r==='user'||r==='question'||ty==='user'||ty==='question'; };
const isAi = (t)=> { const r=String(t.role||'').toLowerCase(); const ty=String(t.type||'').toLowerCase(); return r==='assistant'||r==='ai'||r==='bot'||ty==='assistant'||ty==='ai'; };
const firstResponseMs = (tl)=> { if(!tl||!tl.length) return null; const u=tl.find(isUser); const a=tl.find(isAi); if(!u||!a||!u.ts||!a.ts) return null; return Math.max(0, Number(a.ts)-Number(u.ts)); };
const fmtSpan = (a,b)=> { if(!a) return '—'; const p=n=>String(n).padStart(2,'0'); const f=d=>d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); const d1=new Date(a); const s=f(d1); if(!b||b<=a) return s; const d2=new Date(b); if(d1.toDateString()===d2.toDateString()) return s; if(d1.getFullYear()===d2.getFullYear()) return p(d1.getMonth()+1)+'-'+p(d1.getDate())+' ~ '+p(d2.getMonth()+1)+'-'+p(d2.getDate()); return s+' ~ '+f(d2); };
const dirOf = (id)=> { if(!id) return '—'; const i=String(id); const k=i.lastIndexOf('/'); return k>0? i.slice(0,k): '—'; };
const relTime = (ms)=> { if(ms==null||isNaN(ms)||ms<0) return '—'; const s=Math.round(ms/1000); if(s<60) return '刚刚'; const m=Math.round(s/60); if(m<60) return m+' 分钟前'; const h=Math.round(m/60); if(h<48) return h+' 小时前'; return Math.round(h/24)+' 天前'; };

// ── coslash 对标：Debrief 区块（show full/collapse 折叠）──
let dbSeq = 0;
let hiddenCats = new Set();
function debriefBlock(label, src, text){
  const t = String(text==null?'':text).trim();
  if(!t) return '<div class="db-block"><div class="db-label">'+label+' <span class="db-src">'+esc(src)+'</span></div><div class="db-empty">—</div></div>';
  const id = 'db'+(dbSeq++);
  if(t.length<=160) return '<div class="db-block"><div class="db-label">'+label+' <span class="db-src">'+esc(src)+'</span></div><blockquote class="db-text">'+esc(t)+'</blockquote></div>';
  const short = t.slice(0,159).trimEnd()+'…';
  return '<div class="db-block"><div class="db-label">'+label+' <span class="db-src">'+esc(src)+'</span></div>'
    +'<blockquote class="db-text" id="'+id+'-s">'+esc(short)+'</blockquote>'
    +'<blockquote class="db-text" id="'+id+'-f" style="display:none">'+esc(t)+'</blockquote>'
    +'<a class="db-toggle" data-db="'+id+'">show full</a></div>';
}
// 事件委托：折叠切换（避免内联 onclick 的引号转义问题）
document.addEventListener('click', function(e){
  var t = e.target;
  var el = t && t.closest ? t.closest('.db-toggle') : null;
  if(!el) return;
  toggleDebrief(el.getAttribute('data-db') || '');
  return;
});
// 事件委托：TIMELINE 长文本 expand/collapse
document.addEventListener('click', function(e){
  var t = e.target;
  var el = t && t.closest ? t.closest('.dtoggle') : null;
  if(!el) return;
  var d = document.getElementById(el.getAttribute('data-dg') || '');
  if(!d) return;
  var show = d.classList.contains('clamp');
  d.classList.toggle('clamp', !show);
  el.textContent = show ? 'collapse' : 'expand full ' + (d.getAttribute('data-cat') || 'recap');
});
// 事件委托：TIMELINE chips 分类过滤
document.addEventListener('click', function(e){
  var t = e.target;
  var el = t && t.closest ? t.closest('.tl-chip[data-cat]') : null;
  if(!el) return;
  var c = el.getAttribute('data-cat') || '';
  if(hiddenCats.has(c)) hiddenCats.delete(c); else hiddenCats.add(c);
  renderInspector();
});
function toggleDebrief(id){
  const s=document.getElementById(id+'-s'), f=document.getElementById(id+'-f');
  const t=document.querySelector('.db-toggle[data-db="'+id+'"]');
  if(!s||!f||!t) return;
  const show=f.style.display==='none';
  f.style.display=show?'':'none'; s.style.display=show?'none':'';
  t.textContent=show?'collapse':'show full';
}
function buildHandoff(x){
  const d=x.digest||{};
  const L=['# Handoff — '+x.sessionId];
  L.push('','## Objective (first prompt)');
  L.push((x.goalFull||'—').trim());
  L.push('','## Current state');
  L.push((x.outcome||'—').trim());
  const dig=[['user',d.user],['question',d.question],['todos',d.todos],['plan',d.plan],['compaction',d.compaction],['recap',d.recap]].filter((p)=>Number(p[1])>0);
  L.push('','## Digest');
  L.push(dig.length? dig.map((p)=>'- '+p[0]+': '+p[1]).join('\\n') : '- —');
  L.push('','## Environment');
  L.push('- Vendor: '+x.vendor);
  L.push('- Directory: '+dirOf(x.sessionId));
  L.push('- Branch: '+((x.git&&x.git.branch)||'—'));
  L.push('- Turns: user '+x.userTurns+' / assistant '+x.assistantTurns);
  L.push('- Tokens: '+fmt(x.tokens.total)+' (in '+fmt(x.tokens.input)+' / out '+fmt(x.tokens.output)+' / cacheRead '+fmt(x.tokens.cacheRead)+')');
  L.push('- Cost: $'+Number(x.costUsd).toFixed(4)+(x.costEstimated?' (estimated)':''));
  L.push('- Edits: '+x.edits.operations+' ops, '+((x.edits.files||[]).length)+' files');
  L.push('- Duration: '+fmtDur(x.startedAt&&x.endedAt? x.endedAt-x.startedAt : null));
  return L.join('\\n');
}
function copyText(txt,btn){
  const done=()=>{ const o=btn.textContent; btn.textContent='✓ 已复制'; setTimeout(()=>{btn.textContent=o;},1500); };
  const fallback=()=>{ const ta=document.createElement('textarea'); ta.value=txt; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); try{ document.execCommand('copy'); done(); }catch(e){} document.body.removeChild(ta); };
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(done).catch(fallback); } else fallback();
}

// 顶部全局统计已并入 Insights 视图（按所选月份统计）；引擎构建信息放页脚
const s = DATA.stats;
document.getElementById('engine-info').textContent = ' · 引擎缓存 ' + fmt(s.cached) + '/' + fmt(s.total) + ' 会话 · 冷启动 ' + s.coldMs + 'ms · 重建 ' + fmt(s.rebuilt);

// ── coslash 对标：时间范围筛选（Today / 本周 / 7 天 / 30 天 / 全部）──
var DAY_MS = 86400000;
var RANGES = [['today','今天'],['week','本周'],['7d','7 天'],['30d','30 天'],['all','全部']];
var RANGE_LABEL = { today:'今天', week:'本周', '7d':'7 天', '30d':'30 天', all:'全部时间' };
var curRange = 'all';
function rangeStart(r){
  if(r==='all') return null;
  var now = new Date();
  if(r==='today'){ now.setHours(0,0,0,0); return now.getTime(); }
  if(r==='week'){ now.setHours(0,0,0,0); now.setDate(now.getDate()-((now.getDay()+6)%7)); return now.getTime(); } // 周一零点
  if(r==='7d') return Date.now()-7*DAY_MS;
  if(r==='30d') return Date.now()-30*DAY_MS;
  return null;
}
function renderRange(){
  document.getElementById('range').innerHTML = RANGES.map(function(p){
    return '<span class="rchip'+(curRange===p[0]?' on':'')+'" data-range="'+p[0]+'">'+p[1]+'</span>';
  }).join('');
}
// 事件委托：时间范围切换
document.addEventListener('click', function(e){
  var el = e.target && e.target.closest ? e.target.closest('.rchip') : null;
  if(!el) return;
  curRange = el.getAttribute('data-range')||'all';
  renderRange();
  renderList(currentRows());
});
renderRange();

let selected = null;
function renderList(rows){
  renderScope(rows);
  const head = '<div class="row head"><div>会话 / 首问</div><div>状态</div><div>Token</div><div>成本</div><div>事件</div><div>体积</div><div>修改</div></div>';
  const body = rows.map(x=>{
    const sel = x.sessionId===selected ? ' sel':'';
    return '<div class="row'+sel+'" data-id="'+encodeURIComponent(x.sessionId)+'">'
      +'<div class="fp" title="'+esc(x.firstPrompt||x.sessionId)+'">'+ esc(x.firstPrompt||x.sessionId) +'</div>'
      +'<div><span class="tag">'+x.state+'</span></div>'
      +'<div class="num">'+fmt(x.tokens.total)+'</div>'
      +'<div class="num">'+fmtCost(x.costUsd,x.costEstimated)+(x.costEstimated?'<span class="est">~</span>':'')+'</div>'
      +'<div class="num">'+fmt(x.recordCount)+'</div>'
      +'<div class="num">'+fmtSize(x.size)+'</div>'
      +'<div class="num">'+fmtTime(x.mtime)+'</div>'
      +'</div>';
  }).join('');
  document.getElementById('list').innerHTML = head + body;
  document.querySelectorAll('#list .row[data-id]').forEach(el=>{
    el.addEventListener('click',()=>{ selected = decodeURIComponent(el.getAttribute('data-id')); hiddenCats.clear(); renderInspector(); renderList(currentRows()); });
  });
}
function currentRows(){
  const kw = (document.getElementById('search').value||'').trim().toLowerCase();
  let list = DATA.sessions.slice();
  const st = rangeStart(curRange);
  if(st!=null) list = list.filter((x)=>Number(x.mtime)>=st);
  if(kw) list = list.filter(x=> (x.sessionId+' '+(x.firstPrompt||'')+' '+(x.vendor||'')).toLowerCase().includes(kw));
  const sort = document.getElementById('sort').value;
  if(sort==='cost') list.sort((a,b)=>b.costUsd-a.costUsd);
  else if(sort==='tokens') list.sort((a,b)=>b.tokens.total-a.tokens.total);
  else list.sort((a,b)=>b.mtime-a.mtime);
  return list;
}
const fmtCompact = (n)=> n>=1e9 ? (n/1e9).toFixed(1)+'B' : n>=1e6 ? Math.round(n/1e6)+'M' : n>=1e3 ? (n/1e3).toFixed(0)+'K' : fmt(n);
function renderScope(rows){
  const tk = rows.reduce((a,x)=>a+Number(x.tokens.total||0),0);
  const cost = rows.reduce((a,x)=>a+Number(x.costUsd||0),0);
  document.getElementById('scope').innerHTML =
    '<strong>'+fmt(rows.length)+'</strong> 个会话在此范围内'
    +' · '+fmtCompact(tk)+' tokens'
    +' · $'+cost.toFixed(2)+' 成本'
    +(curRange!=='all' ? ' · <span class="rglabel">筛选：'+esc(RANGE_LABEL[curRange]||curRange)+'</span>' : '');
}
function renderInspector(){
  const x = DATA.sessions.find(s=>s.sessionId===selected);
  if(!x){ document.getElementById('insp').innerHTML='<div class="empty">点击左侧会话查看派生事实 / 时间线 / 续会话就绪度</div>'; return; }
  const f = x;
  const toks = x.tokens||{};
  const durMs = (x.startedAt && x.endedAt) ? Math.max(0, x.endedAt - x.startedAt) : null;
  const spanEnd = x.endedAt || x.mtime;
  const fr = (x.firstUserTs && x.firstAiTs) ? Math.max(0, Number(x.firstAiTs) - Number(x.firstUserTs)) : null;
  const cacheDenom = (Number(toks.input)||0) + (Number(toks.cacheRead)||0);
  const hitRate = cacheDenom>0 ? (Number(toks.cacheRead)||0)/cacheDenom : 0;
  const kv = [
    ['来源', x.vendor],['类型', x.kind],
    ['用户轮次', fmt(x.userTurns)],['助手轮次', fmt(x.assistantTurns)],
    ['编辑操作', fmt(x.edits.operations)],['Git', x.git? (x.git.branch||'—')+' (±'+(x.git.ahead||0)+'/'+(x.git.behind||0)+')':'无'],
    ['耗时', fmtDur(durMs)],['首响', fmtDur(fr)],['跨度', fmtSpan(x.startedAt, spanEnd)],
  ];
  const r = x.readiness;
  const R = [['上下文',r.context],['压缩',r.compression],['分支',r.branch],['工作区',r.workspace],['缓存',r.cache]];
  const col = (st)=> st==='ok'?'var(--green)':st==='warn'?'var(--amber)':'var(--red)';
  const modelBadges = (x.models||[]).map(m=>'<span class="badge model">'+esc(m.model)+(m.estimated?' ~':'')+'</span>').join('');
  const costBadge = '<span class="badge cost">'+fmtCost(x.costUsd,x.costEstimated)+(x.costEstimated?' ~':'')+'</span>';
  const dirBadge = '<span class="badge dir" title="'+esc(dirOf(x.sessionId))+'">目录 '+esc(dirOf(x.sessionId))+'</span>';
  // ── RESUME OR HAND OFF（coslash 对标）──
  const now = Date.now();
  const used = x.context && x.context.used != null ? Number(x.context.used) : null;
  const win = (x.context && Number(x.context.window)) || 262144;
  const pct = used!=null ? Math.min(100, Math.round(used/win*100)) : null;
  const pctCls = pct==null?'':(pct<60?'green':pct<85?'amber':'red');
  const dtM = now - Number(x.mtime||0);
  const warm = dtM < 3600_000;
  const d = x.digest||{};
  const rcell = (k,v,sub,vcls)=>'<div class="rcell"><div class="k">'+k+'</div><div class="v'+(vcls?' '+vcls:'')+'">'+v+'</div>'+(sub?'<div class="sub">'+sub+'</div>':'')+'</div>';
  const resumeGrid =
    rcell('Context used', pct==null?'—':pct+'% of '+fmt(win), used!=null? fmt(used)+' tokens · 按最后一条 usage 估算 · 窗口为 256k 估算':'无 usage 数据', pctCls)
    + rcell('Compactions', fmt(d.compaction||0), Number(d.compaction)>0? '发生过上下文压缩':'无压缩记录')
    + rcell('Branch', esc((x.git&&x.git.branch)||'—'), x.git? ('ahead '+(x.git.ahead||0)+' / behind '+(x.git.behind||0)) : '无 git 信息')
    + rcell('Working tree', x.lastEditAt? esc(relTime(now-Number(x.lastEditAt))) : '—', x.lastEditAt? '最后编辑 · '+fmt(x.edits.operations)+' 次编辑操作' : '未检测到文件编辑')
    + rcell('Prompt cache', warm? 'warm '+esc(relTime(dtM)) : 'cold', (dtM<300_000?'✓':'✗')+' 5 min&nbsp;&nbsp;'+(warm?'✓':'✗')+' 1 hr', warm?'green':'');
  // ── TIMELINE（coslash DigestSection 对标）：chips 可点击过滤 + 日期分组 + turn/时间 ──
  const DIGEST_META = {
    first_prompt: { label:'FIRST PROMPT', c:'var(--green)' },
    user:  { label:'USER TURN', c:'var(--cyan)' },
    question: { label:'QUESTION', c:'var(--gold)' },
    todos: { label:'TODOS', c:'var(--muted)' },
    recap: { label:'RECAP', c:'var(--pink)' },
    plan:  { label:'PLAN', c:'var(--amber)' },
    compaction: { label:'COMPACTION', c:'var(--red)' },
  };
  const evts = x.digestEvents||[];
  const counts = {};
  evts.forEach(e=>{ counts[e.cat]=(counts[e.cat]||0)+1; });
  const chips = Object.keys(DIGEST_META).filter(c=>counts[c]).map(c=>{
    const m=DIGEST_META[c];
    const off = hiddenCats.has(c);
    return '<span class="tl-chip'+(off?' off':'')+'" data-cat="'+c+'"><i'+(off?'':' style="background:'+m.c+'"')+'></i>'+m.label+' '+counts[c]+'</span>';
  }).join('');
  const pad2 = (n)=>String(n).padStart(2,'0');
  const dTime = (ts)=>{ const dt=new Date(ts); return pad2(dt.getHours())+':'+pad2(dt.getMinutes()); };
  const dDayKey = (ts)=>{ const dt=new Date(ts); return dt.getFullYear()+'-'+pad2(dt.getMonth()+1)+'-'+pad2(dt.getDate()); };
  const dDayLabel = (ts)=>{ const dt=new Date(ts); const wd=['周日','周一','周二','周三','周四','周五','周六'][dt.getDay()]; return (dt.getMonth()+1)+'月'+dt.getDate()+'日'+wd; };
  let dHtml=''; let lastDay='';
  for(const e of evts){
    if(hiddenCats.has(e.cat)) continue;
    const day = e.ts? dDayKey(Number(e.ts)):'';
    if(day && day!==lastDay){ dHtml+='<div class="dday"><span></span><b>'+esc(dDayLabel(Number(e.ts)))+'</b><span></span></div>'; lastDay=day; }
    const m = DIGEST_META[e.cat]||{label:e.cat,c:'var(--muted)'};
    const collapsible = (e.cat==='recap'||e.cat==='plan'||e.cat==='user'||e.cat==='first_prompt') && e.text.length>120;
    const id='dg'+(dbSeq++);
    dHtml+='<div class="drow">'
      +'<span class="dlab" style="color:'+m.c+'">'+m.label+'</span>'
      +'<div class="dbody">'
      +'<div class="dtext'+(collapsible?' clamp':'')+'" id="'+id+'" data-cat="'+e.cat+'">'+esc(e.text)+'</div>'
      +(collapsible?'<a class="dtoggle" data-dg="'+id+'">expand full '+e.cat+'</a>':'')
      +'</div>'
      +'<span class="dturn">turn '+e.turn+(e.ts?'<br>'+dTime(Number(e.ts)):'')+'</span>'
      +'</div>';
  }
  if(!dHtml) dHtml='<div class="empty">无事件</div>';
  const evTss = evts.map(e=>Number(e.ts)).filter(t=>t>0);
  let dRange='';
  if(evTss.length){
    const a=new Date(Math.min.apply(null,evTss)), b=new Date(Math.max.apply(null,evTss));
    const f=(dt)=>(dt.getMonth()+1)+'月'+dt.getDate()+'日';
    dRange = a.toDateString()===b.toDateString()
      ? a.getFullYear()+'年'+f(a)+' · local time'
      : f(a)+' – '+a.getFullYear()+'年'+f(b)+' · local time';
  }
  document.getElementById('insp').innerHTML =
    '<h3>'+ esc(x.firstPrompt||x.sessionId) +'</h3>'
    +'<div style="font-size:11px;color:var(--muted);margin-bottom:10px">'+esc(x.sessionId)+'</div>'
    +'<div class="statusbar">'+costBadge+modelBadges+dirBadge+'</div>'
    +'<div class="sec-t" style="margin-top:2px">RESUME OR HAND OFF · 续会话与交接</div>'
    +'<div class="resume-grid">'+resumeGrid+'</div>'
    +'<div class="handoff-actions"><button id="copy-handoff">⧉ Copy handoff（复制交接稿）</button><span class="hint">Start fresh / Resume 需面板后端启动会话，规划在 P2·C3</span></div>'
    +'<div class="sec-t">DEBRIEF · 复盘</div>'
    + debriefBlock('GOAL','first prompt',x.goalFull)
    + debriefBlock('OUTCOME','last reply',x.outcome)
    +'<div class="db-block"><div class="db-label">KEY DECISIONS</div><div class="db-empty">—（关键决策依赖 LLM synthesis，规划在后续里程碑）</div></div>'
    +'<div class="kv">'+kv.map(([k,v])=>'<div><div class="k">'+k+'</div><div class="vs">'+v+'</div></div>').join('')+'</div>'
    +'<div class="sec-t">Token 拆解（in / out / cache）</div>'
    +'<div class="tokblocks">'
      +'<div class="tok in"><div class="tk">输入</div><div class="tv">'+fmt(toks.input)+'</div></div>'
      +'<div class="tok out"><div class="tk">输出</div><div class="tv">'+fmt(toks.output)+'</div></div>'
      +'<div class="tok cache"><div class="tk">缓存读</div><div class="tv">'+fmt(toks.cacheRead)+'</div></div>'
      +'<div class="tok cc"><div class="tk">缓存写</div><div class="tv">'+fmt(toks.cacheCreate)+'</div></div>'
    +'</div>'
    +'<div class="cachebar-wrap"><span>缓存命中率</span><div class="cachebar"><div class="cachebar-fill" style="width:'+(hitRate*100).toFixed(1)+'%"></div></div><span class="cb-pct">'+ (hitRate*100).toFixed(1) +'%</span></div>'
    +'<div class="sec-t">续会话就绪度（Resume Readiness）</div><div class="readiness">'+R.map(([n,c])=>'<div class="rc"><div class="n">'+n+'</div><div class="dot" style="background:'+col(c.status)+'"></div><div class="d">'+c.note+'</div></div>').join('')+'</div>'
    +'<div class="tl-head"><span class="tl-title">TIMELINE <span class="tl-sub">key events from this session · 最多 400 条 · 点击 chips 过滤</span></span><span class="tl-sub">'+dRange+'</span></div>'
    +'<div class="tl-chips" style="margin-bottom:6px">'+chips+'</div>'
    +'<div class="dwrap">'+dHtml+'</div>';
  const copyBtn = document.getElementById('copy-handoff');
  if(copyBtn) copyBtn.addEventListener('click',()=>copyText(buildHandoff(x), copyBtn));
}
document.getElementById('search').addEventListener('input',()=>renderList(currentRows()));
document.getElementById('sort').addEventListener('change',()=>renderList(currentRows()));

// ── coslash 对标：Table / Board / Insights 三视图 ──
var curView = 'table';
function setView(v){
  curView = v;
  document.querySelectorAll('.vtab').forEach((el)=>{ el.classList.toggle('on', el.getAttribute('data-view')===v); });
  document.getElementById('view-table').style.display = v==='table' ? '' : 'none';
  document.getElementById('view-board').style.display = v==='board' ? '' : 'none';
  document.getElementById('view-insights').style.display = v==='insights' ? '' : 'none';
  document.getElementById('toolbar').style.display = v==='insights' ? 'none' : '';
  document.getElementById('scope').style.display = v==='insights' ? 'none' : '';
  if(v==='board') renderBoard();
  if(v==='insights') renderInsights();
  if(v==='table') renderList(currentRows());
}
document.addEventListener('click', function(e){
  var el = e.target && e.target.closest ? e.target.closest('.vtab') : null;
  if(!el) return;
  setView(el.getAttribute('data-view')||'table');
});

// ── Board：Columns × Rows 二维分组卡片 ──
function groupKeyOf(x,dim){
  if(dim==='state') return String(x.state||'—');
  if(dim==='repo') return dirOf(x.sessionId);
  if(dim==='agent') return String(x.vendor||'—');
  return '';
}
function boardCard(x){
  const used = x.context && x.context.used!=null ? Number(x.context.used) : null;
  const win = (x.context && Number(x.context.window)) || 262144;
  const pct = used!=null ? Math.min(100, Math.round(used/win*100))+'% context' : '— context';
  const rel = relTime(Date.now()-Number(x.mtime||0));
  return '<div class="bcard'+(x.sessionId===selected?' sel':'')+'" data-id="'+encodeURIComponent(x.sessionId)+'">'
    +'<div class="bc-top"><span class="bc-src">'+esc(x.vendor||'—')+'</span><span class="bc-cost">'+fmtCost(x.costUsd,x.costEstimated)+(x.costEstimated?'~':'')+'</span></div>'
    +'<div class="bc-title" title="'+esc(x.firstPrompt||x.sessionId)+'">'+esc(x.firstPrompt||x.sessionId)+'</div>'
    +'<div class="bc-sub">'+esc(dirOf(x.sessionId))+' · '+esc(rel)+'</div>'
    +'<div class="bc-meta">'+pct+' · '+fmt(x.tokens.total)+' tokens</div></div>';
}
function renderBoard(){
  const rows0 = currentRows();
  const colDim = document.getElementById('colDim').value;
  const rowDim = document.getElementById('rowDim').value;
  const colKeys = Array.from(new Set(rows0.map((x)=>groupKeyOf(x,colDim)))).sort((a,b)=>a.localeCompare(b));
  let rowKeys = Array.from(new Set(rows0.map((x)=>groupKeyOf(x,rowDim))));
  if(rowDim==='none') rowKeys=['']; else rowKeys.sort((a,b)=>a.localeCompare(b));
  const cell = {};
  rows0.forEach((x)=>{ const rk=groupKeyOf(x,rowDim), ck=groupKeyOf(x,colDim); (cell[rk]=cell[rk]||{})[ck]=(cell[rk][ck]||[]).concat(x); });
  const gridCols = 'minmax(130px,170px) repeat('+colKeys.length+', minmax(200px,1fr))';
  let h = '<div class="bcol-h" style="border-color:transparent;background:transparent"></div>'
    + colKeys.map((ck)=>'<div class="bcol-h"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(ck)+'">'+esc(ck||'—')+'</span><span class="n">'+rows0.filter((x)=>groupKeyOf(x,colDim)===ck).length+'</span></div>').join('');
  for(const rk of rowKeys){
    h += '<div class="brow-l"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+esc(rk)+'">'+esc(rk===''?'全部':rk)+'</span><span class="n">'+rows0.filter((x)=>groupKeyOf(x,rowDim)===rk).length+'</span></div>';
    for(const ck of colKeys){
      const items = (cell[rk]&&cell[rk][ck])||[];
      h += '<div class="bcell">'+items.map(boardCard).join('')+'</div>';
    }
  }
  const b = document.getElementById('board');
  b.style.gridTemplateColumns = gridCols;
  b.innerHTML = colKeys.length ? h : '<div class="empty">该筛选范围内无会话</div>';
}
document.getElementById('colDim').addEventListener('change',()=>renderBoard());
document.getElementById('rowDim').addEventListener('change',()=>renderBoard());
// Board 卡片点击 → 跳回 Table 视图选中该会话
document.addEventListener('click', function(e){
  var el = e.target && e.target.closest ? e.target.closest('.bcard') : null;
  if(!el) return;
  selected = decodeURIComponent(el.getAttribute('data-id')||'');
  hiddenCats.clear();
  renderInspector();
  setView('table');
});

// ── Insights：按自然月统计（Agents/Models 饼图、Top repos、成本、每日活跃）──
var PALETTE = ['#5470c6','#3ec98a','#e6b450','#5fd0e0','#e668b8','#ff6b6b','#9a60b4','#8d98aa'];
var curMonth = null;
var insMonths = [];
const pad2g = (n)=>String(n).padStart(2,'0');
const monthKeyOf = (ts)=>{ const d=new Date(ts); return d.getFullYear()+'-'+pad2g(d.getMonth()+1); };
const monthLabel = (k)=>{ const p=String(k).split('-'); return p[0]+'年'+Number(p[1])+'月'; };
function pieSvg(items){ // items: [{label,value,color}]
  const total = items.reduce((a,b)=>a+b.value,0);
  if(!total) return '';
  let a0 = -Math.PI/2, segs = '';
  const R=58, CX=68, CY=68;
  for(const it of items){
    const frac = it.value/total, a1 = a0 + frac*2*Math.PI;
    if(frac>=0.999){
      segs += '<circle cx="'+CX+'" cy="'+CY+'" r="'+R+'" fill="'+it.color+'"/>';
    } else {
      const x0=(CX+R*Math.cos(a0)).toFixed(2), y0=(CY+R*Math.sin(a0)).toFixed(2);
      const x1=(CX+R*Math.cos(a1)).toFixed(2), y1=(CY+R*Math.sin(a1)).toFixed(2);
      const large = frac>0.5 ? 1 : 0;
      segs += '<path d="M'+CX+','+CY+' L'+x0+','+y0+' A'+R+','+R+' 0 '+large+' 1 '+x1+','+y1+' Z" fill="'+it.color+'" stroke="#0b1f3a" stroke-width="1"/>';
    }
    a0 = a1;
  }
  return '<svg width="136" height="136" viewBox="0 0 136 136">'+segs+'</svg>';
}
function legendHtml(items,total){
  return '<div class="lg">'+items.map((it)=>'<span><i style="background:'+it.color+'"></i>'+esc(it.label)+' <span class="pct">'+(total? Math.round(it.value/total*100):0)+'% · '+fmt(it.value)+'</span></span>').join('')+'</div>';
}
function topItems(map,max){ // map: {k:count} → [{label,value}]，超出合并为 Other
  const arr = Object.keys(map).map((k)=>({label:k,value:map[k]})).sort((a,b)=>b.value-a.value);
  if(arr.length<=max) return arr;
  const top = arr.slice(0,max);
  top.push({label:'Other', value:arr.slice(max).reduce((a,b)=>a+b.value,0)});
  return top;
}
function renderInsights(){
  const all = DATA.sessions.slice();
  insMonths = Array.from(new Set(all.map((x)=>monthKeyOf(Number(x.mtime))))).sort();
  if(!curMonth || insMonths.indexOf(curMonth)<0) curMonth = insMonths[insMonths.length-1] || monthKeyOf(Date.now());
  const mi = insMonths.indexOf(curMonth);
  document.getElementById('m-label').textContent = monthLabel(curMonth);
  document.getElementById('m-prev').style.visibility = mi>0 ? 'visible' : 'hidden';
  document.getElementById('m-next').style.visibility = mi<insMonths.length-1 ? 'visible' : 'hidden';
  const ms = all.filter((x)=>monthKeyOf(Number(x.mtime))===curMonth);
  // Agents used（按会话数）
  const agentMap = {}; ms.forEach((x)=>{ const k=String(x.vendor||'unknown'); agentMap[k]=(agentMap[k]||0)+1; });
  const agents = topItems(agentMap,6).map((it,i)=>Object.assign(it,{color:PALETTE[i%PALETTE.length]}));
  // Models used（每个会话内模型去重后计数）
  const modelMap = {}; ms.forEach((x)=>{ new Set((x.models||[]).map((m)=>String(m.model||'unknown'))).forEach((m)=>{ modelMap[m]=(modelMap[m]||0)+1; }); });
  const models = topItems(modelMap,6).map((it,i)=>Object.assign(it,{color:PALETTE[i%PALETTE.length]}));
  // Top repositories
  const repoMap = {}; ms.forEach((x)=>{ const k=dirOf(x.sessionId); repoMap[k]=(repoMap[k]||0)+1; });
  const repos = Object.keys(repoMap).map((k)=>({label:k,value:repoMap[k]})).sort((a,b)=>b.value-a.value).slice(0,5);
  const maxRepo = repos.length ? repos[0].value : 1;
  // 成本
  const cost = ms.reduce((a,x)=>a+Number(x.costUsd||0),0);
  const estN = ms.filter((x)=>x.costEstimated).length;
  const freeN = ms.filter((x)=>Number(x.costUsd||0)===0).length;
  // 每日活跃
  const dim = Number(String(curMonth).split('-')[1]);
  const y = Number(String(curMonth).split('-')[0]);
  const daysInMonth = new Date(y, dim, 0).getDate();
  const dayMap = {}; ms.forEach((x)=>{ const d=new Date(Number(x.mtime)); if(d.getFullYear()===y && d.getMonth()+1===dim){ const dd=d.getDate(); dayMap[dd]=(dayMap[dd]||0)+1; } });
  const maxDay = Math.max.apply(null, [1].concat(Object.keys(dayMap).map((k)=>dayMap[k])));
  let dayHtml='';
  for(let dd=1; dd<=daysInMonth; dd++){
    const n = dayMap[dd]||0;
    const hgt = n? Math.max(6, Math.round(n/maxDay*80)) : 0;
    dayHtml += '<div class="dcol"><div class="dn">'+(n||'')+'</div>'+(n? '<div class="dbar" style="height:'+hgt+'px" title="'+curMonth+'-'+pad2g(dd)+'：'+n+' 个会话"></div>':'<div style="height:1px"></div>')+'<div class="dl">'+dd+'</div></div>';
  }
  // ── 顶部统计 tiles（自全局并入，跟随月份导航按时间统计）──
  const mt = ms.reduce((a,x)=>a+Number((x.tokens||{}).total||0),0);
  const mIn = ms.reduce((a,x)=>a+Number((x.tokens||{}).input||0),0);
  const mCr = ms.reduce((a,x)=>a+Number((x.tokens||{}).cacheRead||0),0);
  const mDenom = mIn + mCr;
  const mHit = mDenom>0 ? (mCr/mDenom*100) : 0;
  document.getElementById('ins-stats').innerHTML =
    '<div class="tile"><div class="k">会话数</div><div class="v">'+fmt(ms.length)+'</div><div class="s">最后活跃 · '+esc(monthLabel(curMonth))+'</div></div>'
    +'<div class="tile"><div class="k">总 Token</div><div class="v" title="'+fmt(mt)+'">'+fmtCompact(mt)+'</div><div class="s">'+fmt(mt)+' tokens</div></div>'
    +'<div class="tile"><div class="k">总成本</div><div class="v">$'+cost.toFixed(2)+'</div><div class="s">'+(estN? '其中 '+estN+' 个为估算':'精确成本')+(freeN? ' · '+freeN+' 个无成本数据':'')+'</div></div>'
    +'<div class="tile"><div class="k">缓存命中率</div><div class="v">'+(mDenom>0? mHit.toFixed(1)+'%':'—')+'</div><div class="s">cacheRead '+fmtCompact(mCr)+' / input '+fmtCompact(mIn)+'</div></div>';
  document.getElementById('insights-body').innerHTML =
    '<div class="ins-card"><div class="ic-t">Agents used</div><div class="pie-row">'+(pieSvg(agents)||'<div class="empty">无数据</div>')+legendHtml(agents,ms.length)+'</div><div class="ic-sub">按会话数占比（agent 来源）</div></div>'
    +'<div class="ins-card"><div class="ic-t">Models used</div><div class="pie-row">'+(pieSvg(models)||'<div class="empty">无数据</div>')+legendHtml(models,ms.length)+'</div><div class="ic-sub">每个会话内模型去重后计数</div></div>'
    +'<div class="ins-card"><div class="ic-t">Top repositories</div>'+(repos.length? repos.map((r)=>'<div class="bar-row"><span class="bl" title="'+esc(r.label)+'">'+esc(r.label)+'</span><div class="btrack"><div class="bfill" style="width:'+Math.round(r.value/maxRepo*100)+'%"></div></div><span class="bn">'+r.value+'</span></div>').join('') : '<div class="empty">无数据</div>')+'<div class="ic-sub">按会话数排行的仓库 / 目录</div></div>'
    +'<div class="ins-card"><div class="ic-t">Lifetime estimated cost</div><div class="big-cost">≈ $'+cost.toFixed(2)+'</div><div class="ic-sub">'+monthLabel(curMonth)+' · '+fmt(ms.length)+' 个会话'+(estN? '，其中 '+estN+' 个为估算':'')+(freeN? ' · '+freeN+' 个无成本数据':'')+'</div></div>'
    +'<div class="ins-card wide"><div class="ic-t">Sessions last active per day</div><div class="daybars">'+dayHtml+'</div><div class="ic-sub">'+monthLabel(curMonth)+' 每日最后活跃会话数</div></div>';
}
// 月份导航（事件委托）
document.addEventListener('click', function(e){
  var el = e.target && e.target.closest ? e.target.closest('#m-prev,#m-next') : null;
  if(!el || curView!=='insights') return;
  var mi = insMonths.indexOf(curMonth);
  if(el.id==='m-prev' && mi>0){ curMonth = insMonths[mi-1]; renderInsights(); }
  if(el.id==='m-next' && mi<insMonths.length-1){ curMonth = insMonths[mi+1]; renderInsights(); }
});

renderList(currentRows());
</script>
</body>
</html>`;
}

main().catch((e) => {
  console.error('构建失败:', e);
  process.exit(1);
});
