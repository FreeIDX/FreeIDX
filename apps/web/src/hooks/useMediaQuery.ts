/**
 * 媒体查询订阅（响应式「要不要发请求」的判据）。
 *
 * 动机：不少区块只靠 CSS 隐藏（`hidden lg:block`），窄屏**不渲染但数据照拉**。
 * 移动端是论坛的主要流量，按视口能力关掉这些请求，省的是一个 RTT + 一次 D1 读。
 * 与之配套的写法：`enabled: <区块真的会渲染> && useMediaQuery(...)`。
 *
 * 首值是同步算出来的（不是 false 再 effect 里改），避免首帧多渲染一次、也避免
 * 「桌面端首帧误判为窄屏导致请求被推迟」。SSR/无 matchMedia 的环境返回 false。
 */
import { useEffect, useState } from 'react';

/** 主题 lg 断点（与 globals.css 的 `--breakpoint-lg: 992px` 同源，勿各写各的） */
export const LG_UP = '(min-width: 992px)';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? false
      : window.matchMedia(query).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    /* query 变化或首次挂载时对齐一次：首值算在渲染期，这里只兜「挂载前窗口已变化」的极端情况 */
    const onChange = (): void => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
