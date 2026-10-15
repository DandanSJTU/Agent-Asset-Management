/**
 * verify-session-title-fix.ts — 验证「探索 …」标题塌缩修复（plan A + B）。
 *
 * 两类验证：
 *   1) 集成：scanSessions() 真实跑全量，断言——
 *      - 不再有任何嵌套会话的 firstPrompt 恰好等于 "探索 …"（旧 bug 态）；
 *      - 已知 3 个 Explore 子会话的 spawnTask 命中父会话 Agent 任务名，且 firstPrompt 可读（>2）。
 *   2) 单元：用合成父会话原始记录喂 extractParentSpawnTask，验证精确匹配 / 前缀匹配 /
 *      关联失败（子 prompt 与父不匹配）/ 短公共前缀不误关联 四种分支。
 *
 * 运行（node24 原生类型擦除）：
 *   node agents/personal-space/scripts/verify-session-title-fix.ts
 */
import { scanSessions, extractParentSpawnTask } from '../session-facts.ts';
import type { RawRecordFile } from '../../asset-import.ts';

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  \u2713 ${msg}`);
  } else {
    console.error(`  \u2717 ${msg}`);
    failures++;
  }
}

// ── Part 2 · 单元测试 extractParentSpawnTask ──
console.log('[unit] extractParentSpawnTask');
{
  const childPrompt = '探索 /Users/dan/x/store/ 目录下记忆存储与检索的实现细节';
  const parentRaw: RawRecordFile = {
    records: [
      {
        type: 'function_call',
        name: 'Agent',
        arguments: JSON.stringify({ description: '探索存储层检索实现', prompt: childPrompt }),
      },
    ],
    badJson: 0,
    mtime: 0,
    size: 0,
  };
  assert(
    extractParentSpawnTask(childPrompt, parentRaw) === '探索存储层检索实现',
    '精确匹配：返回父 Agent description',
  );

  // 前缀匹配（父 prompt 更长，子被截断）：score 取公共前缀长度，≥30 命中
  const longerParent: RawRecordFile = {
    records: [
      {
        type: 'tool_use',
        name: 'Task',
        input: JSON.stringify({
          description: '探索插件与SDK搜索入口',
          prompt: childPrompt + '，thoroughness: very thorough。重点回答：',
        }),
      },
    ],
    badJson: 0,
    mtime: 0,
    size: 0,
  };
  assert(
    extractParentSpawnTask(childPrompt, longerParent) === '探索插件与SDK搜索入口',
    '前缀匹配（父更长）：返回父 Task description',
  );

  // 关联失败：子 prompt 与父不匹配
  assert(
    extractParentSpawnTask('完全无关的首问内容', parentRaw) === '',
    '无匹配：返回空串（调用方回退 firstPrompt）',
  );

  // 公共前缀过短（<30）：不误关联
  const shortParent: RawRecordFile = {
    records: [
      {
        type: 'function_call',
        name: 'Agent',
        arguments: JSON.stringify({ description: '错配任务', prompt: '探索 /Users' }),
      },
    ],
    badJson: 0,
    mtime: 0,
    size: 0,
  };
  assert(
    extractParentSpawnTask('探索 /Users 下的其它内容完全不同', shortParent) === '',
    '公共前缀 <30：不误关联，返回空串',
  );
}

// ── Part 1 · 集成：真实 scanSessions ──
console.log('[integration] scanSessions');
const scanned = scanSessions('workbuddy');
const nested = scanned.filter((s) => s.session.kind === 'nested');
assert(nested.length > 0, `检出嵌套会话 ${nested.length} 个`);

// 不变量：无会话 firstPrompt 恰好等于旧 bug 态 "探索 …"
const collapsed = nested.filter((s) => s.session.firstPrompt === '探索 …');
assert(collapsed.length === 0, '不变量：无任何 nested 会话 firstPrompt === "探索 …"（旧 bug 态已消除）');

// 已知 3 个 Explore 子会话：spawnTask 命中父任务名 + firstPrompt 可读
const knownSubagents = [
  'Users-dandan-Projects-TencentDB-Agent-Memory/a438267a-fdc9-46c2-a3b0-37c39cc170a6/subagents/agent-3f769b1ef5344b34',
  'Users-dandan-Projects-TencentDB-Agent-Memory/a438267a-fdc9-46c2-a3b0-37c39cc170a6/subagents/agent-8bb0e8cb19694ffa',
  'Users-dandan-Projects-TencentDB-Agent-Memory/a438267a-fdc9-46c2-a3b0-37c39cc170a6/subagents/agent-c987fd345d1f446f',
];
const expectedDescs = new Set(['探索存储层检索实现', '探索插件与SDK搜索入口', '探索Gateway搜索API层']);
for (const id of knownSubagents) {
  const s = scanned.find((x) => x.session.sessionId === id)?.session;
  assert(!!s, `找到已知子会话 ${id.split('/').pop()}`);
  if (!s) continue;
  assert(!!s.spawnTask && expectedDescs.has(s.spawnTask), `spawnTask 命中父任务名："${s.spawnTask}"`);
  const readable = s.firstPrompt.replace(/[…\.\s]/g, '').length;
  assert(readable > 2, `firstPrompt 可读（${readable} 字符）："${s.firstPrompt.slice(0, 30)}…"`);
}

// 所有 spawnTask 以 "探索" 开头的嵌套会话，firstPrompt 都应可读（防回归）
const exploreSessions = nested.filter((s) => s.session.spawnTask.startsWith('探索'));
assert(exploreSessions.length >= 3, `共 ${exploreSessions.length} 个 spawnTask 以"探索"开头的嵌套会话`);
for (const s of exploreSessions) {
  const readable = s.session.firstPrompt.replace(/[…\.\s]/g, '').length;
  assert(readable > 2, `探索类会话 firstPrompt 可读："${s.session.firstPrompt.slice(0, 24)}…"`);
}

console.log('');
if (failures === 0) {
  console.log('✅ 全部通过：plan A + B 修复已验证');
  process.exit(0);
} else {
  console.error(`❌ ${failures} 项失败`);
  process.exit(1);
}
