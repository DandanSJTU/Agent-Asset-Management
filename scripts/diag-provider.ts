#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
const f = files[0];
const lines = readFileSync(f.full, 'utf-8').split('\n').filter((l) => l.trim());
for (const l of lines) {
  let o: any; try { o = JSON.parse(l); } catch { continue; }
  if (o.providerData && typeof o.providerData === 'object') {
    // 打印 providerData 的顶层 key + 深度查找 model / price / cost 字样
    const pd = o.providerData;
    const keys = Object.keys(pd);
    const dig = (obj: any, path: string, depth: number) => {
      if (!obj || typeof obj !== 'object' || depth > 4) return;
      for (const [k, v] of Object.entries(obj)) {
        const kk = k.toLowerCase();
        if (/(model|price|cost|token)/.test(kk) && typeof v !== 'object') {
          console.log(`   ${path?path+'.':''}${k} = ${JSON.stringify(v).slice(0,80)}`);
        }
        if (typeof v === 'object' && v !== null) dig(v, path?path+'.'+k:k, depth+1);
      }
    };
    console.log(`\nproviderData 顶层 keys: ${keys.join(', ')}`);
    dig(pd, 'providerData', 0);
    console.log(`  完整 providerData(截断2000): ${JSON.stringify(pd).slice(0,2000)}`);
    break;
  }
}
