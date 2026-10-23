/**
 * StatCard — 统一统计指标卡（个人空间「我的记忆 / 我的技能」等页面复用）。
 *
 * 设计语言：左侧色条 + 大数字 + 标签 + 可选副文案，圆角与既有卡片一致
 * （沿用 docs 设计稿的金=记忆 / 紫=技能 / 蓝=通用 / 青=原子记忆层 体系）。
 * 纯展示组件，不耦合任何数据请求，便于多 tab 复用同一视觉。
 */
import type { CSSProperties, ReactNode } from 'react';

export interface StatCardProps {
  /** 卡片标签，如「技能总数」 */
  label: string;
  /** 主数值，可为数字或带单位的节点 */
  value: ReactNode;
  /** 副文案（如「近 30 天 12」、占比说明） */
  sub?: ReactNode;
  /** 左侧色条 / 数字主色，默认深蓝 */
  accent?: string;
  /** 点击卡片的行为（如切到对应 tab / 应用筛选），传入即渲染为可点击态 */
  onClick?: () => void;
  /** 选中高亮态（用于与当前激活 tab 联动） */
  active?: boolean;
}

export function StatCard({
  label,
  value,
  sub,
  accent = '#0b3d6b',
  onClick,
  active = false,
}: StatCardProps) {
  const interactive = typeof onClick === 'function';
  const style: CSSProperties = {
    position: 'relative',
    overflow: 'hidden',
    background: active ? '#e8f0f9' : '#ffffff',
    border: `1px solid ${active ? '#0b3d6b' : '#e3e6ed'}`,
    borderRadius: 10,
    padding: '14px 16px 14px 20px',
    cursor: interactive ? 'pointer' : 'default',
    transition: 'box-shadow .15s, transform .15s, background .15s',
    boxShadow: '0 1px 2px rgba(11,61,107,.04)',
    flex: '1 1 200px',
    minWidth: 0,
  };
  return (
    <div
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={onClick}
      onKeyDown={
        interactive
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      style={style}
    >
      <span
        style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: accent }}
      />
      <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.3 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: accent, lineHeight: 1.25, marginTop: 2 }}>
        {value}
      </div>
      {sub ? <div style={{ fontSize: 11.5, color: '#9ca3af', marginTop: 2 }}>{sub}</div> : null}
    </div>
  );
}

export function StatCardRow({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>{children}</div>
  );
}
