/**
 * AssetSplitLayout — 资产管理页通用分栏布局。
 *
 * 统一 Skills / Memory 等资产页的「左侧列表 + 右侧详情」分栏结构：
 * - 左右宽度可拖拽调节，比例记忆到 localStorage（同一浏览器下次保留）
 * - 右侧详情设最大高度，内容超出时在详情区内部滚动，不撑开外层页面高度
 *   （外层容器不出现滚动条）
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import './asset-split-layout.css';

interface AssetSplitLayoutProps {
  sidebar: ReactNode;
  detail: ReactNode;
  /** 拖拽宽度的持久化 key（不同页面互不干扰）；不传则不持久化 */
  storageKey?: string;
  /**
   * 左栏初始宽度（px）。仅在无本地记忆值时生效，仍受 [MIN_SIDEBAR, MAX_SIDEBAR] 约束。
   * 用途：列表项字段较多（如技能列表的名称/描述/最近修改/本地位置四列）时，
   * 默认 280px 会把字段挤成多行；传入更宽的值让首屏就有舒适的排版。
   * 不传 = 沿用 DEFAULT_SIDEBAR，其他资产页行为不变。
   */
  defaultWidth?: number;
}

const MIN_SIDEBAR = 220;
const MAX_SIDEBAR = 480;
const DEFAULT_SIDEBAR = 280;

function clampWidth(w: number): number {
  return Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, w));
}

function readStoredWidth(storageKey?: string, defaultWidth?: number): number {
  const fallback = clampWidth(defaultWidth ?? DEFAULT_SIDEBAR);
  if (!storageKey) return fallback;
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? clampWidth(parsed) : fallback;
  } catch {
    return fallback;
  }
}

export function AssetSplitLayout({ sidebar, detail, storageKey, defaultWidth }: AssetSplitLayoutProps) {
  const { t } = useTranslation();
  const [sidebarWidth, setSidebarWidth] = useState<number>(() =>
    readStoredWidth(storageKey, defaultWidth),
  );
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 拖拽过程：以容器左边界为基准计算左栏宽度，限制在 [MIN, MAX] 内
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setSidebarWidth(clampWidth(e.clientX - rect.left));
    };
    const onUp = () => setDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    // 拖拽时禁用文本选中，避免选到列表内容
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevUserSelect;
    };
  }, [dragging]);

  // 拖拽结束后持久化最终宽度
  useEffect(() => {
    if (dragging || !storageKey) return;
    try {
      window.localStorage.setItem(storageKey, String(sidebarWidth));
    } catch {
      /* localStorage 不可用时静默忽略，仅影响记忆能力 */
    }
  }, [dragging, sidebarWidth, storageKey]);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  return (
    <div
      ref={containerRef}
      className={`_asset-split${dragging ? ' _asset-split--dragging' : ''}`}
      style={{ gridTemplateColumns: `${sidebarWidth}px 6px minmax(0, 1fr)` }}
    >
      <section className="_asset-split-sidebar">{sidebar}</section>
      <button
        type="button"
        className="_asset-split-resizer"
        aria-label={t('assetSplit.resizer.label')}
        onMouseDown={onHandleMouseDown}
        onKeyDown={(e) => {
          // 键盘可达：左右箭头以 16px 步进调整左栏宽度
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            setSidebarWidth((w) => clampWidth(w - 16));
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            setSidebarWidth((w) => clampWidth(w + 16));
          }
        }}
      >
        <span className="_asset-split-resizer-bar" />
      </button>
      <section className="_asset-split-detail">{detail}</section>
    </div>
  );
}
