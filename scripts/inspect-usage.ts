#!/usr/bin/env node
import { readRawRecords } from '../agents/asset-import.ts';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync, statSync } from 'node:fs';

const root = join(homedir(), '.workbuddy', 'projects');
const files: { full: string; size: number }[] = [];
function walk(d: string) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const full = join(d, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.jsonl')) files.push({ full, size: statSync(full).size });
  }
}
walk(root);
files.sort((a, b) => b.size - a.size);

const usagePaths = new Map<string, number>();
const modelPaths = new Map<string, number>();
const costPaths = new Map<string, number>();
let recsWithMessage = 0;
let recsTotal = 0;
let sampleMessageUsage: any = null;
let sampleTopUsage: any = null;

for (const f of files.slice(0, 40)) {
  const raw = readRawRecords(f.full);
  for (const r of raw.records) {
    recsTotal++;
    const dig = (obj: any, path: string, depth: number) => {
      if (!obj || typeof obj !== 'object' || depth > 6) return;
      for (const [k, v] of Object.entries(obj)) {
        const here = path ? `${path}.${k}` : k;
        if (k === 'usage' && v && typeof v === 'object') {
          usagePaths.set(here, (usagePaths.get(here) ?? 0) + 1);
          if (!sampleTopUsage && here === 'usage') sampleTopUsage = v;
        }
        if (k === 'model' && typeof v === 'string') {
          modelPaths.set(here, (modelPaths.get(here) ?? 0) + 1);
        }
        if (/(cost|price)/i.test(k) && typeof v === 'number') {
          costPaths.set(here, (costPaths.get(here) ?? 0) + 1);
        }
        if (typeof v === 'object' && v !== null) dig(v, here, depth + 1);
      }
    };
    dig(r, '', 0);
    if ((r as any).message && typeof (r as any).message === 'object') {
      recsWithMessage++;
      const m = (r as any).message;
      if (m.usage && typeof m.usage === 'object' && !sampleMessageUsage) sampleMessageUsage = m.usage;
    }
  }
}

console.log(`扫描会话文件(前40大): ${files.length}  事件总数: ${recsTotal}  含 message 对象: ${recsWithMessage}`);
console.log('\n--- usage 键的精确路径分布 ---');
for (const [k, v] of [...usagePaths.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log('\n--- model 键的精确路径分布 ---');
for (const [k, v] of [...modelPaths.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log('\n--- cost/price 数值键路径分布 ---');
for (const [k, v] of [...costPaths.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
console.log('\n--- 样例 message.usage ---');
console.log(JSON.stringify(sampleMessageUsage, null, 2));
console.log('\n--- 样例 顶层 usage ---');
console.log(JSON.stringify(sampleTopUsage, null, 2));
