/**
 * verify-session-search.ts — 会话洞察搜索引擎回归验证（33 项断言）。
 *
 * 项目未接入测试框架（无 vitest/jest），因此用 node 内置的类型擦除直接跑纯函数模块，
 * 不引入任何新依赖，也不需要构建。
 *
 * 运行：
 *   cd MemoryPanel/web
 *   node --experimental-strip-types scripts/verify-session-search.ts
 *
 * 覆盖：拆词 AND / 中英文子串 / 六种结构化前缀 / 字段权重梯度 / 隐私口径 /
 *       召回退化路径 / 高亮区间合并 / 倒排与全量扫描的结果一致性 + 性能对照。
 * 退出码：0 全通过，1 有失败。
 */
import {
  buildSearchIndex,
  runSessionSearch,
  parseQuery,
  highlightRanges,
  repoOf,
  matchesSearch,
  gramsOf,
  filterByRange,
} from '../src/lib/session-search.ts';

const mk = (id: string, over: Record<string, unknown> = {}) => ({
  sessionId: id,
  kind: 'top-level', parentId: null, vendor: 'claude', state: 'active',
  startedAt: 1, endedAt: null, recordCount: 10, size: 100, mtime: 1,
  firstPrompt: '', title: '', userTurns: 1, assistantTurns: 1,
  tokens: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0, total: 2 },
  costUsd: 0.1, costEstimated: false,
  models: [{ model: 'claude-opus-4', costUsd: 0.1, estimated: false }],
  git: { cwd: '/Users/secret/private', branch: 'main', status: 'ok' },
  edits: { operations: 0, addedLines: 0, removedLines: 0, files: ['/Users/secret/a.ts'] },
  digest: { firstPrompt: 1, user: 0, question: 0, todos: 0, compaction: 0, recap: 0, plan: 0, subagent: 0 },
  ...over,
}) as never;

const sessions = [
  mk('proj/api-gateway/s1', { title: '重构鉴权模块', firstPrompt: 'refactor auth middleware', vendor: 'codex', git: { cwd: '/x', branch: 'feat/auth', status: 'ok' } }),
  mk('proj/api-gateway/s2', { title: 'Authentication 重构', firstPrompt: 'authentication refactor plan', state: 'inactive' }),
  mk('proj/web-console/s3', { title: '优化搜索功能', firstPrompt: '把搜索改成召回加排序', vendor: 'claude' }),
  mk('proj/web-console/s4', { title: '无关的会话', firstPrompt: '写一份周报', kind: 'nested', models: [{ model: 'gpt-5', costUsd: 0, estimated: true }] }),
  // s5：标题不含「重构」，仅首问含 —— 用于验证字段权重梯度
  mk('proj/web-console/s5', { title: '流水线改造', firstPrompt: '重构 pipeline 的执行顺序' }),
];
const index = buildSearchIndex(sessions);
let fails = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (!cond) { fails += 1; console.log(`  FAIL ${name} ${extra}`); } else console.log(`  ok   ${name}`);
};

console.log('— 解析 —');
const pq = parseQuery('repo:api-gateway  refactor   auth ');
check('拆词 AND（去空白）', pq.terms.join('|') === 'refactor|auth', JSON.stringify(pq.terms));
check('前缀抽取', pq.qualifiers.length === 1 && pq.qualifiers[0].key === 'repo' && pq.qualifiers[0].value === 'api-gateway');

console.log('— 子串语义 —');
check('auth 命中 authentication（2 条）', runSessionSearch(index, 'auth').matched.length === 2);
check('authentication 精确到 1 条', runSessionSearch(index, 'authentication').matched.length === 1);

console.log('— 中文 —');
check('中文词命中', runSessionSearch(index, '搜索').matched.length === 1);
check('中文多字子串', runSessionSearch(index, '优化搜索').matched.length === 1);
check('中文空格=AND', runSessionSearch(index, '优化 搜索').matched.length === 1);

console.log('— AND 语义 —');
const r6 = runSessionSearch(index, 'refactor auth');
check('两词都命中 → 2 条（s1/s2 均含）', r6.matched.length === 2, `${r6.matched.length}`);
check('一词不中即淘汰', runSessionSearch(index, 'refactor 周报').matched.length === 0);

console.log('— 结构化前缀 —');
check('repo:', runSessionSearch(index, 'repo:api-gateway').matched.length === 2);
check('agent:', runSessionSearch(index, 'agent:codex').matched.length === 1);
check('status:', runSessionSearch(index, 'status:inactive').matched.length === 1);
check('kind:', runSessionSearch(index, 'kind:nested').matched.length === 1);
check('branch:', runSessionSearch(index, 'branch:feat/auth').matched.length === 1);
check('model:', runSessionSearch(index, 'model:gpt-5').matched.length === 1);
check('前缀 + 文本组合', runSessionSearch(index, 'repo:api-gateway refactor').matched.length === 2);
check('前缀不命中即淘汰', runSessionSearch(index, 'repo:nope refactor').matched.length === 0);

console.log('— 排序（相关度优先）—');
const r15 = runSessionSearch(index, '重构');
const sTitle = r15.scores.get('proj/api-gateway/s1') ?? 0;
const sPrompt = r15.scores.get('proj/web-console/s5') ?? -1;
check('标题命中=100', sTitle === 100, `${sTitle}`);
check('仅首问命中=30', sPrompt === 30, `${sPrompt}`);
check('标题组排在首问组之前', r15.matched.slice(0, 2).every((s) => (r15.scores.get(s.sessionId) ?? 0) === 100)
  && r15.matched[2].sessionId === 'proj/web-console/s5', JSON.stringify(r15.matched.map((s) => s.sessionId)));

console.log('— 隐私口径（对齐 coslash）—');
check('git.cwd 不建索引', matchesSearch(sessions[0], parseQuery('private')) === 0);
check('edits.files 不建索引', matchesSearch(sessions[0], parseQuery('secret')) === 0);
check('sessionId 仍可搜', matchesSearch(sessions[0], parseQuery('api-gateway')) > 0);

console.log('— 召回 / 退化 —');
check('空查询返回全量', runSessionSearch(index, '').matched.length === sessions.length);
check('纯空格等同空查询', runSessionSearch(index, '   ').matched.length === sessions.length);
check('无命中返回空', runSessionSearch(index, 'zzzz-not-exist').matched.length === 0);
check('仅前缀 → 退化全量扫描', runSessionSearch(index, 'repo:api-gateway').degraded === true);
const r20 = runSessionSearch(index, 'auth');
check('文本词 → 走索引且候选更少', r20.degraded === false && r20.scanned < sessions.length, `scanned=${r20.scanned}/${sessions.length}`);

console.log('— 高亮 —');
const hl = highlightRanges('aXbXc', ['x']);
check('全部区间 + 大小写无关', hl.length === 2 && hl[0][0] === 1 && hl[1][0] === 3, JSON.stringify(hl));
const hl2 = highlightRanges('abcdef', ['bcd', 'cde']);
check('重叠合并', hl2.length === 1 && hl2[0][0] === 1 && hl2[0][1] === 5, JSON.stringify(hl2));
check('前缀不高亮', runSessionSearch(index, 'repo:api-gateway').terms.length === 0);

console.log('— 工具函数 —');
check('repoOf', repoOf('proj/api-gateway/s1') === 'proj/api-gateway');
check('gramsOf 中文', [...gramsOf('优化搜索')].join(',') === '优化,化搜,搜索');
check('gramsOf 英文', [...gramsOf('auth')].join(',') === 'au,ut,th');

console.log('— 性能对照（3000 会话 × 20 次查询）—');
const big = Array.from({ length: 3000 }, (_, i) =>
  mk(`proj/repo-${i % 40}/s${i}`, { title: `会话 ${i} 关于 ${i % 7 === 0 ? '鉴权重构' : '日常开发'}`, firstPrompt: `第 ${i} 条 prompt ${i % 11 === 0 ? 'authentication refactor' : 'misc task'}` }),
);
const bigIndex = buildSearchIndex(big);
const t0 = Date.now();
for (let i = 0; i < 20; i += 1) runSessionSearch(bigIndex, i % 2 ? '鉴权重构' : 'authentication');
const idxMs = Date.now() - t0;
const t1 = Date.now();
for (let i = 0; i < 20; i += 1) {
  const p = parseQuery(i % 2 ? '鉴权重构' : 'authentication');
  let n = 0;
  for (const s of big) if (matchesSearch(s, p) > 0) n += 1;
}
const scanMs = Date.now() - t1;
console.log(`  倒排召回: ${idxMs}ms   全量扫描: ${scanMs}ms   提速 ${(scanMs / Math.max(idxMs, 1)).toFixed(1)}×`);
const a = runSessionSearch(bigIndex, '鉴权重构').matched.length;
const b = big.filter((s) => matchesSearch(s, parseQuery('鉴权重构')) > 0).length;
check('倒排召回结果与全量扫描一致', a === b, `${a} vs ${b}`);

console.log('— 时间窗与活跃豁免（对齐 coslash）—');
const DAY = 86_400_000;
const now = Date.now();
const winSessions = [
  // 活跃但 mtime 停在 10 天前：coslash 口径下必须保留（长跑会话不该因切「今天」消失）
  mk('proj/api/s-live-old', { title: '长跑会话', state: 'active', mtime: now - 10 * DAY }),
  mk('proj/api/s-idle-old', { title: '空闲会话', state: 'idle', mtime: now - 10 * DAY }),
  mk('proj/api/s-done-old', { title: '已结束旧会话', state: 'inactive', mtime: now - 10 * DAY }),
  mk('proj/api/s-done-new', { title: '已结束新会话', state: 'inactive', mtime: now - 1 * DAY }),
];
const winStart = now - 3 * DAY;
const inWin = filterByRange(winSessions, winStart);
const winIds = inWin.map((s) => s.sessionId);
check('活跃会话豁免时间窗', winIds.includes('proj/api/s-live-old'), JSON.stringify(winIds));
check('idle 也算活跃', winIds.includes('proj/api/s-idle-old'));
check('已结束 + 窗外 → 剔除', !winIds.includes('proj/api/s-done-old'));
check('已结束 + 窗内 → 保留', winIds.includes('proj/api/s-done-new'));
check('range=all（start=null）全保留', filterByRange(winSessions, null).length === 4);
check('未知 state 不豁免', !filterByRange([mk('x/y', { state: 'weird', mtime: 1 })], now).length);

// 天花板自证：搜索池是 inRange，窗外的命中在窗内确实搜不到 —— 这正是「跨时间窗探测」要补救的
const winIndex = buildSearchIndex(inWin);
check('窗外命中在窗内搜不到（天花板）', runSessionSearch(winIndex, '已结束旧会话').matched.length === 0);
check(
  '同一查询在全量可搜到（探测依据）',
  runSessionSearch(buildSearchIndex(winSessions), '已结束旧会话').matched.length === 1,
);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
