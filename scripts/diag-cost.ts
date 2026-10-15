#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const root = join(homedir(), '.workbuddy', 'projects');
// 找最大的几个会话文件
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

let shown = 0;
for (const f of files.slice(0, 8)) {
  const lines = readFileSync(f.full, 'utf-8').split('\n').filter((l) => l.trim());
  let recWithUsage = 0;
  let recWithProvider = 0;
  let sampleUsage: any = null;
  let sampleModel: any = null;
  const topKeyCount: Record<string, number> = {};
  for (const l of lines) {
    let o: any;
    try { o = JSON.parse(l); } catch { continue; }
    const s = JSON.stringify(o);
    if (s.includes('"usage"')) recWithUsage++;
    if (s.includes('providerData')) recWithProvider++;
    if (!sampleUsage && s.includes('"usage"')) {
      // 定位 usage 的 key 路径
      const dig = (obj: any, path: string) => {
        if (!obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
          if (k === 'usage' && v && typeof v === 'object') { sampleUsage = { path, val: v }; return; }
          if (k === 'model' && typeof v === 'string' && !sampleModel) sampleModel = { path, val: v };
          if (typeof v === 'object' && v !== null) dig(v, path ? `${path}.${k}` : k);
        }
      };
      dig(o, '');
    }
    for (const k of Object.keys(o)) topKeyCount[k] = (topKeyCount[k] ?? 0) + 1;
  }
  console.log(`\n=== ${f.full.split('/').slice(-3).join('/')}  size=${(f.size/1024).toFixed(0)}KB lines=${lines.length}`);
  console.log(`  含 usage 行: ${recWithUsage}  含 providerData 行: ${recWithProvider}`);
  console.log(`  顶层 key 分布: ${Object.entries(topKeyCount).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([k,v])=>`${k}:${v}`).join(' ')}`);
  if (sampleUsage) console.log(`  usage 路径: ${sampleUsage.path}  样例: ${JSON.stringify(sampleUsage.val).slice(0,200)}`);
  if (sampleModel) console.log(`  model 路径: ${sampleModel.path}  值: ${sampleModel.val}`);
  shown++;
  if (shown >= 5) break;
}
