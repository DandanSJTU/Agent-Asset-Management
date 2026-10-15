import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * 可拖拽分割线 hook
 * @param initial  初始宽度 (px)
 * @param min      最小宽度 (px)
 * @param max      最大宽度 (px)
 * @param side     拖拽边：'left' 表示左侧面板宽度可调，'right' 表示右侧面板宽度可调
 * @param persistKey 可选。传入后把宽度持久化到 localStorage（约束在 [min,max]），跨会话保留
 */
export function useResizable(
  initial: number,
  min: number,
  max: number,
  side: 'left' | 'right' = 'left',
  persistKey?: string,
) {
  const [width, setWidth] = useState(() => {
    if (persistKey) {
      const saved = Number(localStorage.getItem(persistKey));
      if (Number.isFinite(saved) && saved >= min && saved <= max) return saved;
    }
    return initial;
  });
  const dragging = useRef(false);
  const startX = useRef(0);
  const startW = useRef(0);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      startX.current = e.clientX;
      startW.current = width;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - startX.current;
      const newW =
        side === 'left' ? Math.max(min, Math.min(max, startW.current + delta)) : Math.max(min, Math.min(max, startW.current - delta));
      setWidth(newW);
    };
    const onMouseUp = () => {
      if (dragging.current) {
        dragging.current = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        if (persistKey) localStorage.setItem(persistKey, String(width));
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [min, max, side, persistKey, width]);

  /** 重置为初始宽度（拖拽条双击等场景使用） */
  const reset = useCallback(() => setWidth(initial), [initial]);

  return { width, onMouseDown, reset };
}
