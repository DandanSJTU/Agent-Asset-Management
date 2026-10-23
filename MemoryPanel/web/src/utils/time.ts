/**
 * 资产列表的时间展示工具。
 *
 * 背景：资产管理页左栏默认只有 280px 宽（AssetSplitLayout 可拖拽调整），
 * 列表项要在一行里同时容纳「本地位置」与「最近修改」两个字段。
 * `toLocaleString()` 输出的 `2026/10/15 17:18:43` 有 19 个字符，
 * 会把位置挤到下一行、并让两行都显得松散，因此列表统一走紧凑格式：
 *
 *   - 今天   → `今天 17:18`
 *   - 今年   → `10-15 17:18`
 *   - 往年   → `2025-10-15`
 *
 * 秒级精度在列表里没有决策价值，完整时间通过 title 悬浮查看
 * （见 formatAssetTimeFull）。
 */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 列表紧凑时间（见文件头注释）。 */
export function formatAssetTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const sameDay =
    sameYear && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (sameDay) return `今天 ${hhmm}`;
  if (sameYear) return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmm}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 完整本地时间，用于 title 悬浮提示（保留秒与年份）。 */
export function formatAssetTimeFull(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}
