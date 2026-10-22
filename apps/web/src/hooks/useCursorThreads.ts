/** §4.8/§4.9 游标主题列表：首屏 ?page=1，翻页 ?before_tid=<nextCursor>（纯 page 参数不移动窗口） */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThreadListItem } from '@freeidx/shared';
import { apiGet } from '../lib/api';
import type { ThreadPageData } from '../components/ThreadList';

export function useCursorThreads(base: string, active = true) {
  const [items, setItems] = useState<ThreadListItem[]>([]);
  const [size, setSize] = useState(10);
  const [nextCursor, setNextCursor] = useState<number | undefined>();
  const [canMore, setCanMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const startedRef = useRef('');
  /**
   * 请求序号：晚到的旧响应必须丢弃。
   * 否则从 /user/5?s=threads 快速切到 /user/7?s=threads（或 loadMore 与首屏请求交错）时，
   * 慢的旧响应会在新响应之后 setItems，列表显示他人数据（串页）。
   */
  const reqRef = useRef(0);

  const load = useCallback(
    async (before?: number) => {
      const seq = ++reqRef.current;
      setLoading(true);
      setError('');
      try {
        const d = await apiGet<ThreadPageData>(`${base}${before ? `?before_tid=${before}` : '?page=1'}`);
        if (seq !== reqRef.current) return; // 已被更新的请求取代：不写状态
        setItems((prev) => (before ? [...prev, ...d.list] : d.list));
        setSize(d.size);
        if (d.nextCursor !== undefined) setNextCursor(d.nextCursor);
        setCanMore(d.list.length >= d.size && d.nextCursor !== undefined);
        setLoaded(true);
      } catch (e) {
        if (seq !== reqRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq === reqRef.current) setLoading(false);
      }
    },
    [base],
  );

  useEffect(() => {
    if (!active) return;
    // StrictMode 双跑防重复加载；换用户（base 变化）先清空再首屏加载，避免串页
    if (startedRef.current !== base) {
      startedRef.current = base;
      reqRef.current += 1; // 作废旧 base 的在途请求
      setItems([]);
      setNextCursor(undefined);
      setCanMore(false);
      setLoaded(false);
      void load();
    }
  }, [active, base, load]);

  return {
    items,
    size,
    nextCursor,
    canMore,
    loaded,
    loading,
    error,
    loadMore: () => void load(nextCursor),
  };
}
