/**
 * 首页系统公告条（本项目新增，依托消息管理 0011_announcement）：
 *  - 数据：GET /api/announcements（游客可读，isshow=1，aid 倒序 ≤10 条）；
 *  - 单条静默展示；多条 4s 垂直轮播（hover 暂停），右侧 n/m 指示 + 关闭按钮（本页会话内隐藏）。
 *  - 样式：浅蓝提示条（rgba(41,151,247,.1) 底 + 主蓝「公告」徽标），与站内提示条同族。
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../lib/api';
import { useT } from '../lib/i18n';
import { Icon } from './icons';

interface AnnouncementItem {
  aid: number;
  message: string;
  createDate: number;
}

const ROTATE_MS = 4000;

export function AnnouncementBar() {
  const t = useT();
  const q = useQuery({
    queryKey: ['announcements'],
    queryFn: () => apiGet<{ list: AnnouncementItem[] }>('/api/announcements'),
    staleTime: 60_000,
  });
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [closed, setClosed] = useState(false);

  const list = q.data?.list ?? [];
  const count = list.length;

  useEffect(() => {
    if (count < 2 || paused) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % count), ROTATE_MS);
    return () => clearInterval(t);
  }, [count, paused]);

  useEffect(() => {
    if (idx >= count) setIdx(0);
  }, [idx, count]);

  if (closed || (q.isSuccess && count === 0)) return null;
  /* 未加载完不占位（避免空条闪烁）；失败静默 */
  if (!q.isSuccess) return null;

  return (
    <div
      role="region"
      aria-label={t('system_announcement')}
      className="mb-2 flex items-center gap-2.5 rounded-[6px] bg-[rgba(0,132,255,0.08)] px-4 py-2.5 text-foreground"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span className="flex shrink-0 items-center gap-1.5">
        <span className="inline-flex items-center rounded-[3px] bg-brand px-1.5 py-0.5 text-xs leading-none font-medium text-white">{t('announcement')}</span>
        <Icon name="megaphone" className="size-4 text-brand" />
      </span>
      {/* 轮播视口：固定一行高，轨道整体上移逐条切换 */}
      <div className="relative h-6 min-w-0 flex-1 overflow-hidden">
        <div className="transition-transform duration-500 ease-out" style={{ transform: `translateY(-${idx * 1.5}rem)` }}>
          {list.map((a) => (
            <p key={a.aid} className="h-6 truncate leading-6 text-sm" title={a.message}>
              {a.message}
            </p>
          ))}
        </div>
      </div>
      {count > 1 && (
        <span className="shrink-0 text-xs tabular-nums text-zh-grey">
          {idx + 1}/{count}
        </span>
      )}
      <button
        type="button"
        aria-label={t('close_announcement')}
        className="shrink-0 text-zh-grey transition-colors hover:text-brand"
        onClick={() => setClosed(true)}
      >
        <Icon name="close" className="size-4" />
      </button>
    </div>
  );
}
