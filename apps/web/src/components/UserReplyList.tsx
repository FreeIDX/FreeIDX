/**
 * 用户回帖列表（批次 3C）：mypost 倒排游标分页（?before_pid=<pid>），
 * UserPage「他的回帖」与 MePage「我的回帖」共用（base = API 路径）。
 * 行形态仿 FollowStreamRow：动作条「对主题「X」进行了回复」+ message_fmt 预览 + 时间。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { fmtDate, fetchMyReplies, fetchUserReplies, type UserReplyItem } from '../lib/api';
import { useT } from '../lib/i18n';
import { Button } from './ui';

interface Props {
  /** 'me' 走本人接口（登录态），否则按 uid 拉公开回帖 */
  uid?: number;
  active: boolean;
}

export function UserReplyList({ uid, active }: Props) {
  const t = useT();
  const [items, setItems] = useState<UserReplyItem[]>([]);
  const [nextCursor, setNextCursor] = useState<number | undefined>();
  const [canMore, setCanMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const startedRef = useRef('');
  const reqRef = useRef(0);

  const load = useCallback(
    async (before?: number) => {
      const seq = ++reqRef.current;
      setLoading(true);
      setError('');
      try {
        const d = uid === undefined ? await fetchMyReplies(before) : await fetchUserReplies(uid, before);
        if (seq !== reqRef.current) return;
        setItems((prev) => (before ? [...prev, ...d.list] : d.list));
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
    [uid],
  );

  useEffect(() => {
    if (!active) return;
    const base = uid === undefined ? '/api/me/posts' : `/api/users/${uid}/posts`;
    if (startedRef.current !== base) {
      startedRef.current = base;
      reqRef.current += 1;
      setItems([]);
      setNextCursor(undefined);
      setCanMore(false);
      setLoaded(false);
      void load();
    }
  }, [active, uid, load]);

  return (
    <section className="zh-card mb-4 overflow-hidden">
      {error && <p className="px-5 py-3 text-sm text-destructive">{error}</p>}
      <ul>
        {items.map((r) => (
          <li key={r.pid} className="border-b border-zh-line px-5 py-4 last:border-b-0">
            <div className="rounded-[4px] bg-lt-soft px-2 py-1 text-xs text-lt-grey">
              {t('follow_replied_prefix')}
              <Link className="transition-colors hover:text-brand" to={`/thread/${r.tid}`}>
                {r.subject}
              </Link>
              {t('follow_replied_suffix')}
            </div>
            <div className="post-body mt-2 break-words text-sm leading-6" dangerouslySetInnerHTML={{ __html: r.message_fmt }} />
            <div className="mt-1.5 text-xs text-lt-grey">
              {fmtDate(r.create_date)} ·{' '}
              <Link className="text-zh-deep-link transition-colors hover:text-brand" to={`/thread/${r.tid}`}>
                {t('click_view_detail')}
              </Link>
            </div>
          </li>
        ))}
      </ul>
      {loaded && !error && items.length === 0 && <p className="py-6 text-center text-sm text-lt-grey">{t('no_data')}</p>}
      {canMore && (
        <div className="border-t border-zh-line p-3">
          <Button block variant="secondary" loading={loading} onClick={() => void load(nextCursor)}>
            {t('load_more')}
          </Button>
        </div>
      )}
    </section>
  );
}