/** 已读标记（§10.3）：localStorage 记 tid→已读时间，纯前端 */
import { useCallback, useState } from 'react';

const KEY = 'idx_read_unread';

function readStore(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}

export function useReadUnread() {
  const [store, setStore] = useState<Record<string, number>>(readStore);

  const markRead = useCallback((tid: number) => {
    const s = { ...readStore(), [String(tid)]: Math.floor(Date.now() / 1000) };
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* 隐私模式静默降级 */
    }
    setStore(s);
  }, []);

  const isRead = useCallback((tid: number, lastDate: number) => (store[String(tid)] ?? 0) > lastDate, [store]);

  return { markRead, isRead };
}
