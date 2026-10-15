/**
 * Highlight — 搜索命中片段高亮。
 *
 * 对齐 coslash 的 Highlight.tsx：对查询的每个词找出**全部**命中区间（非仅第一个），
 * 按起点排序并合并重叠区间，再用 <mark> 包裹重组文本。
 * 结构化前缀（repo:/agent:/status: 等）只做过滤，不参与高亮。
 */
import { Fragment, type ReactNode } from 'react';
import { highlightRanges } from '@/lib/session-search';

export function Highlight({
  text,
  terms,
  className = 'sim-mark',
}: {
  text: string;
  terms: string[];
  className?: string;
}) {
  const value = text ?? '';
  const ranges = highlightRanges(value, terms);
  if (!ranges.length) return <>{value}</>;

  const out: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(([start, end], i) => {
    if (start > cursor) out.push(<Fragment key={`t${i}`}>{value.slice(cursor, start)}</Fragment>);
    out.push(
      <mark className={className} key={`m${i}`}>
        {value.slice(start, end)}
      </mark>,
    );
    cursor = end;
  });
  if (cursor < value.length) out.push(<Fragment key="tail">{value.slice(cursor)}</Fragment>);
  return <>{out}</>;
}

export default Highlight;
