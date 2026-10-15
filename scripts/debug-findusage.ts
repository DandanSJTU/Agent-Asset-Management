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

// 复制 facts.ts 的 findUsage 逻辑
function findUsage(rec: Record<string, unknown>): Record<string, unknown> | null {
  const cands = [
    rec.usage,
    rec.providerData && (rec.providerData as Record<string, unknown>).usage,
    rec.providerData && (rec.providerData as Record<string, unknown>).response && ((rec.providerData as Record<string, unknown>).response as Record<string, unknown>).usage,
    rec.providerData && (rec.providerData as Record<string, unknown>).response && ((rec.providerData as Record<string, unknown>).response as Record<string, unknown>).body && (((rec.providerData as Record<string, unknown>).response as Record<string, unknown>).body as Record<string, unknown>).usage,
    rec.message && (rec.message as Record<string, unknown>).usage,
    rec.payload && (rec.payload as Record<string, unknown>).providerData && ((rec.payload as Record<string, unknown>).providerData as Record<string, unknown>).usage,
  ];
  for (const c of cands) if (c && typeof c === 'object') return c;
  return null;
}

let total = 0;
let foundTop = 0;
let foundMessage = 0;
let foundPayload = 0;
let recWithProvider = 0;
let recWithPayload = 0;
let sampleTopStructure: any = null;
let sampleRec: any = null;

for (const f of files.slice(0, 40)) {
  const raw = readRawRecords(f.full);
  for (const r of raw.records) {
    const rec = r as Record<string, unknown>;
    total++;
    if (rec.providerData && typeof rec.providerData === 'object') recWithProvider++;
    if (rec.payload && typeof rec.payload === 'object') recWithPayload++;
    if (!sampleRec) sampleRec = rec;
    const u = findUsage(rec);
    if (u) {
      if (rec.providerData && (rec.providerData as any).usage) foundTop++;
      if (rec.message && (rec.message as any).usage) foundMessage++;
      if (rec.payload) foundPayload++;
    }
  }
}

console.log(`事件总数: ${total}`);
console.log(`含 providerData 顶层: ${recWithProvider}`);
console.log(`含 payload 顶层: ${recWithPayload}`);
console.log(`findUsage 命中(顶层providerData.usage): ${foundTop}`);
console.log(`findUsage 命中(message.usage): ${foundMessage}`);
console.log(`findUsage 命中(payload.*): ${foundPayload}`);
console.log(`\n样例记录顶层 keys: ${Object.keys(sampleRec).join(', ')}`);
console.log(`样例 providerData: ${JSON.stringify(sampleRec.providerData).slice(0, 300)}`);
console.log(`样例 message 顶层: ${JSON.stringify(sampleRec.message)?.slice(0, 200)}`);
console.log(`样例 payload 顶层 keys: ${sampleRec.payload ? Object.keys(sampleRec.payload).join(', ') : '(无)'}`);
