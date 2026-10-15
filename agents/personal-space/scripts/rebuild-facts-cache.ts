/**
 * rebuild-facts-cache.ts — 强制全量重建「会话洞察」facts 缓存。
 *
 * 适用场景：引擎新增/变更字段（如本仓库新增 spawnTask）后，旧缓存条目缺字段，
 * 面板 API（computeAllSessions(true)）会复用陈旧条目导致新字段为空。本脚本以
 * useCache=false 全量重算并落盘，使缓存携带最新字段。
 *
 * 运行（node24 原生类型擦除）：
 *   node agents/personal-space/scripts/rebuild-facts-cache.ts
 */
import { computeAllSessions } from '../facts.ts';

const r = computeAllSessions(false);
console.log(
  `[rebuild] total=${r.facts.length} rebuilt=${r.rebuilt} cached=${r.cached} coldMs=${r.coldMs}`,
);
