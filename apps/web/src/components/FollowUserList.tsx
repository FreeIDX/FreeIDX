/**
 * 关注用户列表（头像 + 昵称（双向关注图标）+ 粉丝数 + 关注/已关注按钮）：
 *  - 我的页「我关注的 / 关注我的」（GET /api/my/following|followers，需登录）
 *  - 他人主页「Ta关注的 / 关注Ta的」（GET /api/users/:uid/following|followers，游客可读）
 * 游标 before_rowid 翻页；关注/取关后就地失效所有 follow-users 查询（多列表联动）。
 */
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { fetchFollowUserPage, saveFollowDynamic, saveFollowRemark, toggleFollow, type FollowUserItem } from '../lib/api';
import { Avatar } from './Avatar';
import { Icon } from './icons';
import { Button } from './ui';
import { useT } from '../lib/i18n';

/** 单行：左 头像+昵称（备注优先）+粉丝数、右 备注/动态/关注按钮 */
function FollowUserRow({
  u,
  busy,
  editable,
  onToggle,
  onRemark,
  onDynamic,
}: {
  u: FollowUserItem;
  busy: boolean;
  /** 「我关注的」行才有备注与动态开关 */
  editable: boolean;
  onToggle: () => void;
  onRemark: () => void;
  onDynamic: () => void;
}) {
  const t = useT();
  return (
    <li className="flex items-center justify-between gap-3 border-b border-zh-line px-5 py-3 last:border-b-0">
      <span className="flex min-w-0 items-center gap-2.5">
        <Link to={`/user/${u.uid}`} className="shrink-0" aria-label={u.username}>
          <Avatar uid={u.uid} avatar={u.avatar} username={u.username} size={3} />
        </Link>
        <span className="min-w-0">
          <Link to={`/user/${u.uid}`} className="flex min-w-0 items-center gap-1 text-sm text-zh-deep-link transition-colors hover:text-brand">
            <span className="truncate">{u.remark ?? u.username}</span>
            {u.remark && <span className="shrink-0 text-xs text-lt-grey">{`(${u.username})`}</span>}
            {u.mutual && <Icon name="users" className="size-3.5 shrink-0 text-lt-grey" title={t('mutual_follow')} />}
          </Link>
          <span className="mt-0.5 block text-xs text-lt-grey">{t('fans_count', { count: u.fans })}</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {editable && (
          <>
            <button
              type="button"
              className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs text-lt-grey transition-colors hover:text-brand"
              title={t('remark_label')}
              onClick={onRemark}
            >
              <Icon name="edit" className="size-3.5" />
            </button>
            <button
              type="button"
              className={cxRow('inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs transition-colors', u.dynamic ? 'text-[#00b96b]' : 'text-lt-grey hover:text-brand')}
              title={t('dynamic_label')}
              aria-pressed={u.dynamic}
              onClick={onDynamic}
            >
              <Icon name={u.dynamic ? 'check' : 'close'} className="size-3.5" />
            </button>
          </>
        )}
        <Button size="sm" variant={u.followed ? 'secondary' : 'outline'} loading={busy} onClick={onToggle}>
          {u.followed ? t('followed_label') : t('following_label')}
        </Button>
      </span>
    </li>
  );
}

/** 行内多类拼接（本组件内联样式用，避免额外依赖 cx 名冲突） */
function cxRow(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function FollowUserList({
  url,
  emptyText,
  editable = false,
  onChanged,
}: {
  url: string;
  emptyText: string;
  /** 是否显示备注与动态开关（仅「我关注的」） */
  editable?: boolean;
  onChanged?: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [busyUid, setBusyUid] = useState(0);
  const [err, setErr] = useState('');

  const q = useInfiniteQuery({
    queryKey: ['follow-users', url],
    queryFn: ({ pageParam }) => fetchFollowUserPage(url, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = q.data?.pages.flatMap((pg) => pg.list) ?? [];

  const run = async (uid: number, fn: () => Promise<unknown>) => {
    setBusyUid(uid);
    setErr('');
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['follow-users'] });
      /* 关注关系/动态开关变化同时影响关注动态流（我的关注页 tab 切换即读，须即时失效） */
      await qc.invalidateQueries({ queryKey: ['my-follow-stream'] });
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('operation_failed'));
    } finally {
      setBusyUid(0);
    }
  };

  /** 备注编辑（清空=删除备注） */
  const editRemark = (u: FollowUserItem) => {
    const next = window.prompt(t('remark_prompt'), u.remark ?? '');
    if (next === null) return; // 取消
    void run(u.uid, () => saveFollowRemark(u.uid, next.trim().slice(0, 50)));
  };

  return (
    <div>
      {err && <p className="px-5 py-3 text-sm text-destructive">{err}</p>}
      {q.isError && <p className="px-5 py-3 text-sm text-destructive">{(q.error as Error).message}</p>}
      {items.length > 0 && (
        <ul className="m-0 list-none">
          {items.map((u) => (
            <FollowUserRow
              key={u.uid}
              u={u}
              busy={busyUid === u.uid}
              editable={editable}
              onToggle={() => void run(u.uid, () => toggleFollow(u.uid))}
              onRemark={() => editRemark(u)}
              onDynamic={() => void run(u.uid, () => saveFollowDynamic(u.uid, u.dynamic ? 0 : 1))}
            />
          ))}
        </ul>
      )}
      {q.isSuccess && items.length === 0 && <p className="px-5 py-10 text-center text-sm text-lt-grey">{emptyText}</p>}
      {q.hasNextPage && (
        <div className="px-5 py-3 text-center">
          <Button variant="secondary" size="sm" loading={q.isFetchingNextPage} loadingText={t('loading')} onClick={() => void q.fetchNextPage()}>
            {t('load_more')}
          </Button>
        </div>
      )}
    </div>
  );
}