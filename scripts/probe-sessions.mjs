#!/usr/bin/env node
/**
 * 本机会话数据体检探针（阶段 -1 · 只读 · 零侵入）
 *
 * 目的：在写任何 SessionFactsExtractor / readRawRecords 之前，
 *       先用真实数据验证方案里的每一条假设，避免在错误的口径上写业务代码。
 *
 * 约束（对齐 P3 零破坏）：
 *   - 只读，不写任何文件（含缓存）
 *   - 不 import agents/asset-import.ts，不跑 tsx，零依赖，避免触发任何现有管线
 *   - 不做 LLM 调用
 *
 * 用法：
 *   node scripts/probe-sessions.mjs            # 体检（分类 + 体量）
 *   node scripts/probe-sessions.mjs --deep     # 追加内容结构抽样（较慢）
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const VENDOR_ROOTS = [
  { vendor: 'workbuddy', root: join(homedir(), '.workbuddy', 'projects') },
  { vendor: 'claude-code', root: join(homedir(), '.claude', 'projects') },
  { vendor: 'codebuddy', root: join(homedir(), '.codebuddy', 'projects') },
];

const DEEP = process.argv.includes('--deep');
const KB = (n) => (n / 1024).toFixed(1) + 'KB';

/** 递归收集 jsonl，并按相对深度区分 顶层会话 / 子代理会话 */
function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.name.endsWith('.jsonl')) {
        const rel = full.slice(root.length + 1);
        // <slug>/<uuid>.jsonl  → 1 层；含更深的层级 → 子代理 / 嵌套
        const depth = rel.split('/').length - 1;
        out.push({ full, rel, depth, kind: depth === 1 ? 'top-level' : 'nested' });
      }
    }
  }
  return out;
}

/** 流式读一个 jsonl，统计行型分布（不保留内容，内存恒定）
 *  注意：WorkBuddy 用的是 OpenAI Responses 风格（function_call / output_text），
 *  不是 Anthropic 风格（tool_use / tool_result）。字段名实测于 2026-10-12。 */
async function profileLines(path, maxLines = Infinity) {
  const rl = createInterface({ input: createReadStream(path, 'utf-8'), crlfDelay: Infinity });
  const typeDist = Object.create(null);
  let lines = 0, user = 0, assistant = 0, fnCall = 0, fnResult = 0, snapshot = 0;
  let withUsage = 0, withProviderData = 0, withParentId = 0, bad = 0;
  let firstPrompt = '', lastTs = null, firstTs = null;
  for await (const line of rl) {
    lines++;
    if (lines > maxLines) break;
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { bad++; continue; }
    if (o.type) typeDist[o.type] = (typeDist[o.type] ?? 0) + 1;
    if (o.role === 'user') {
      user++;
      if (!firstPrompt) {
        const c = Array.isArray(o.content)
          ? o.content.map((x) => x?.text ?? '').join(' ')
          : String(o.content ?? '');
        // 剥掉 system-reminder 包裹，拿到用户真实的那句话
        const stripped = c.replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '')
          .replace(/<[a-z-]+_context>[\s\S]*?<\/[a-z-]+_context>/g, '')
          .replace(/\s+/g, ' ').trim();
        firstPrompt = (stripped || c.replace(/\s+/g, ' ').trim()).slice(0, 70);
      }
    } else if (o.role === 'assistant') assistant++;
    if (o.type === 'function_call') fnCall++;
    if (o.type === 'function_call_result') fnResult++;
    if (o.type === 'file-history-snapshot' || line.includes('file-history-snapshot')) snapshot++;
    if (o.providerData) withProviderData++;
    if (o.parentId) withParentId++;
    if (JSON.stringify(o.providerData ?? {}).includes('usage') || line.includes('"usage"')) withUsage++;
    if (o.timestamp) { if (firstTs === null) firstTs = o.timestamp; lastTs = o.timestamp; }
  }
  return { lines, user, assistant, fnCall, fnResult, snapshot, withUsage, withProviderData, withParentId, bad, firstPrompt, firstTs, lastTs, typeDist };
}

const report = [];
let grand = { top: 0, nested: 0, bytes: 0, files: 0 };

for (const { vendor, root } of VENDOR_ROOTS) {
  if (!existsSync(root)) {
    report.push({ vendor, root, missing: true });
    continue;
  }
  const files = walk(root);
  const top = files.filter((f) => f.kind === 'top-level');
  const nested = files.filter((f) => f.kind === 'nested');
  const bytes = files.reduce((a, f) => a + statSync(f.full).size, 0);
  grand.top += top.length; grand.nested += nested.length; grand.bytes += bytes; grand.files += files.length;

  const sizes = files.map((f) => statSync(f.full).size).sort((a, b) => a - b);
  const mtimes = files.map((f) => statSync(f.full).mtimeMs).sort((a, b) => a - b);
  const emptySlugs = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .filter((e) => walk(join(root, e.name)).length === 0).length;

  const entry = {
    vendor, root, missing: false,
    total: files.length,
    topLevel: top.length,
    nested: nested.length,
    nestedRatio: files.length ? ((nested.length / files.length) * 100).toFixed(1) + '%' : '0%',
    totalBytes: (bytes / 1024 / 1024).toFixed(1) + 'MB',
    p50KB: sizes.length ? KB(sizes[Math.floor(sizes.length * 0.5)]) : '-',
    maxKB: sizes.length ? KB(sizes[sizes.length - 1]) : '-',
    emptySlugDirs: emptySlugs,
    oldest: mtimes.length ? new Date(mtimes[0]).toISOString().slice(0, 10) : '-',
    newest: mtimes.length ? new Date(mtimes[mtimes.length - 1]).toISOString().slice(0, 10) : '-',
  };

  if (DEEP && files.length) {
    // 抽 3 个有代表性的文件：最大、中位、最小
    const picks = [sizes.length - 1, Math.floor(sizes.length / 2), 0]
      .map((i) => files.find((f) => statSync(f.full).size === sizes[i]))
      .filter(Boolean)
      .filter((f, i, arr) => arr.findIndex((x) => x.full === f.full) === i);
    entry.samples = [];
    for (const p of picks) {
      const prof = await profileLines(p.full, 20000);
      entry.samples.push({ file: p.rel.split('/').pop().slice(0, 8), size: KB(statSync(p.full).size), ...prof,
        usageRate: prof.lines ? ((prof.withUsage / prof.lines) * 100).toFixed(0) + '%' : '-',
        snapshotRate: prof.lines ? ((prof.snapshot / prof.lines) * 100).toFixed(0) + '%' : '-',
        providerRate: prof.lines ? ((prof.withProviderData / prof.lines) * 100).toFixed(0) + '%' : '-',
        parentRate: prof.lines ? ((prof.withParentId / prof.lines) * 100).toFixed(0) + '%' : '-',
        types: Object.entries(prof.typeDist).sort((a, b) => b[1] - a[1]).slice(0, 6)
          .map(([k, v]) => `${k}:${v}`).join(' '),
      });
    }
  }
  report.push(entry);
}

console.log('='.repeat(72));
console.log('本机会话数据体检 / Local Session Probe');
console.log('='.repeat(72));

for (const r of report) {
  console.log(`\n── ${r.vendor}`);
  if (r.missing) { console.log(`   目录不存在：${r.root}`); continue; }
  console.log(`   路径        ${r.root}`);
  console.log(`   jsonl 总数  ${r.total}`);
  console.log(`   顶层会话    ${r.topLevel}`);
  console.log(`   嵌套/子代理 ${r.nested}   占比 ${r.nestedRatio}`);
  console.log(`   空壳目录    ${r.emptySlugDirs} 个 slug 无任何 jsonl`);
  console.log(`   体量        ${r.totalBytes}   中位 ${r.p50KB} / 最大 ${r.maxKB}`);
  console.log(`   时间跨度    ${r.oldest} → ${r.newest}`);
  if (r.samples) {
    console.log('   内容结构抽样：');
    for (const s of r.samples) {
      console.log(`     [${s.file}] ${s.size} lines=${s.lines} user=${s.user} asst=${s.assistant}`);
      console.log(`        usage=${s.usageRate} providerData=${s.providerRate} parentId=${s.parentRate} fnCall=${s.fnCall} fnResult=${s.fnResult} snapshot=${s.snapshot} badJson=${s.bad}`);
      console.log(`        行型 ${s.types || '(空文件)'}`);
      console.log(`        首条提问「${s.firstPrompt}」`);
    }
  }
}

console.log('\n' + '='.repeat(72));
console.log(`合计 ${grand.files} 个 jsonl（顶层 ${grand.top} / 嵌套 ${grand.nested}），${(grand.bytes / 1024 / 1024).toFixed(1)}MB`);
console.log('='.repeat(72));
console.log(`
实测结构（2026-10-12，WorkBuddy）：
  行型 function_call / function_call_result / message / reasoning /
      file-history-snapshot / session-meta
  ⚠ 不是 Anthropic 的 tool_use / tool_result —— 按后者写解析器会全部落空。

判读要点：
  1. 顶层会话数才是「会话洞察」列表的真实条目数；嵌套项必须分轨，
     并且优先用行内的 parentId 还原父子关系（覆盖率极高），
     不能学 coslash 那样让 ParentIDFromPath 恒返回 ""。
  2. usage 覆盖率决定「Token 成本归因」可行性；providerData 决定能否拿到真实模型名。
  3. file-history-snapshot 覆盖率偏低（约 5%），FileEdits 必须以解析 function_call
     参数为主、snapshot 为辅，不能反过来。
  4. 中位/最大体积决定 mtime+size 增量缓存是否够用（P4 的前提）。
  5. 只有 1 个文件的 vendor（如本机 claude-code / codebuddy）无法用于验证提取器，
     横向扩 vendor 必须以"该 vendor 本机有足够样本"为前提。
`);
