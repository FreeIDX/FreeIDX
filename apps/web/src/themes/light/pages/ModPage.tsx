/**
 * 版务页（mod-{fid}，版块操作台）：
 *  列出该版块主题（可多选）+ 批量操作台（置顶 / 全站置顶 / 取消置顶 / 关闭 / 打开 / 精华 / 取消精华 / 移动 / 删除）。
 *  权限由服务端 GET /api/mod/forums/:fid 计算（perms.allowmod/allowdelete/allowmove），前端不做权限推断；
 *  操作复用 POST /api/mod/threads（写 modlog + 版务通知 + 缓存失效），与帖子页版务按钮同一后端。
 */
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ModForumData } from '@freeidx/shared';
import { apiGet, modThreads } from '../../../lib/api';
import { apiErrorMessage } from '../../../lib/errors';
import { nonNegInt, posInt } from '../../../lib/params';
import { useAuth } from '../../../store/auth';
import { Button, Card, cx } from '../../../components/ui';
import { Icon } from '../../../components/icons';
import { ThreadList, type ThreadPageData } from '../../../components/ThreadList';
import { Pagination } from '../../../components/Pagination';
import { useT } from '../../../lib/i18n';

/** 工具栏按钮（小尺寸：38px 高、4px 圆角、描边） */
const toolCls =
  'inline-flex h-[32px] items-center gap-1 rounded-[4px] border border-zh-line bg-card px-2.5 text-xs text-foreground transition-colors hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-50';

export function ModPage() {
  const t = useT();
  const qc = useQueryClient();
  const params = useParams();
  const [search] = useSearchParams();
  const fid = nonNegInt(params.fid);
  const forumlist = useAuth((s) => s.forumlist);
  const forum = forumlist.find((f) => f.fid === fid);
  const page = posInt(search.get('page'));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [moveTo, setMoveTo] = useState(0);
  const [notice, setNotice] = useState('');
  const [err, setErr] = useState('');

  const perm = useQuery({
    queryKey: ['mod-forum', fid],
    queryFn: () => apiGet<ModForumData>(`/api/mod/forums/${fid}`),
    enabled: fid > 0,
    retry: false,
  });
  const perms = perm.data?.perms;

  const list = useQuery({
    queryKey: ['mod-threads', fid, page],
    queryFn: () => apiGet<ThreadPageData>(`/api/forums/${fid}/threads?page=${page}`),
    enabled: fid > 0 && Boolean(perms),
    placeholderData: (prev) => prev,
  });

  const tids = [...selected];
  const act = useMutation({
    mutationFn: (v: { action: 'top' | 'untop' | 'close' | 'digest' | 'move' | 'delete'; value?: number }) =>
      modThreads({ tids, action: v.action, value: v.value ?? 0 }),
    onSuccess: () => {
      setNotice(t('mod_action_done'));
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: ['mod-threads', fid] });
      void qc.invalidateQueries({ queryKey: ['threads'] });
    },
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  const run = (action: 'top' | 'untop' | 'close' | 'digest' | 'move' | 'delete', value = 0) => {
    setNotice('');
    setErr('');
    if (!tids.length) {
      setErr(t('mod_select_threads'));
      return;
    }
    if (action === 'move' && !moveTo) {
      setErr(t('mod_move_to'));
      return;
    }
    if (action === 'delete' && !window.confirm(t('confirm_delete_q'))) return;
    act.mutate({ action, value: action === 'move' ? moveTo : value });
  };

  const onToggle = (tid: number, checked: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (checked) next.add(tid);
      else next.delete(tid);
      return next;
    });

  if (perm.isError) {
    return (
      <Card>
        <p className="py-8 text-center text-sm text-destructive">{apiErrorMessage(perm.error)}</p>
      </Card>
    );
  }

  const data: ThreadPageData = list.data ?? { list: [], page: 1, size: 20, totalPage: 1 };

  return (
    <div className="flex flex-col gap-4">
      <Card
        header={
          <span className="flex items-center gap-2 text-sm font-medium">
            <Icon name="wrench" className="size-4 text-brand" />
            {t('mod_manage')}
            {forum && <span className="text-lt-grey">· {forum.name}</span>}
          </span>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-lt-grey">
            <input
              type="checkbox"
              className="size-4 cursor-pointer accent-brand"
              checked={data.list.length > 0 && selected.size === data.list.length}
              onChange={(e) => setSelected(e.target.checked ? new Set(data.list.map((x) => x.tid)) : new Set())}
            />
            {t('select_all')}
          </label>
          <span className="text-xs text-lt-grey">{t('mod_selected', { count: selected.size })}</span>
          <span className="mx-1 hidden h-4 w-px bg-zh-line sm:block" />
          {perms?.allowmod && (
            <>
              <button className={toolCls} disabled={act.isPending} onClick={() => run('top', 1)}>
                <Icon name="top" className="size-3.5" />
                {t('top_label')}
              </button>
              <button className={toolCls} disabled={act.isPending} onClick={() => run('top', 3)}>
                <Icon name="top" className="size-3.5" />
                {t('mod_top_all')}
              </button>
              <button className={toolCls} disabled={act.isPending} onClick={() => run('untop')}>
                {t('mod_untop')}
              </button>
              <button className={toolCls} disabled={act.isPending} onClick={() => run('close', 1)}>
                <Icon name="lock" className="size-3.5" />
                {t('mod_close')}
              </button>
              <button className={toolCls} disabled={act.isPending} onClick={() => run('close', 0)}>
                <Icon name="unlock" className="size-3.5" />
                {t('mod_open')}
              </button>
              <button className={toolCls} disabled={act.isPending} onClick={() => run('digest', 1)}>
                <Icon name="gem" className="size-3.5" />
                {t('digest_label')}
              </button>
              <button className={toolCls} disabled={act.isPending} onClick={() => run('digest', 0)}>
                {t('mod_undigest')}
              </button>
            </>
          )}
          {perms?.allowmove && (
            <>
              <select
                className={cx(toolCls, 'cursor-pointer appearance-none pr-6')}
                value={moveTo || ''}
                onChange={(e) => setMoveTo(Number(e.target.value))}
                aria-label={t('mod_move_to')}
              >
                <option value="">{t('mod_move_to')}</option>
                {forumlist
                  .filter((f) => f.fid !== fid)
                  .map((f) => (
                    <option key={f.fid} value={f.fid}>
                      {f.name}
                    </option>
                  ))}
              </select>
              <button className={toolCls} disabled={act.isPending} onClick={() => run('move')}>
                {t('mod_move')}
              </button>
            </>
          )}
          {perms?.allowdelete && (
            <button className={cx(toolCls, 'hover:border-destructive hover:text-destructive')} disabled={act.isPending} onClick={() => run('delete')}>
              <Icon name="trash" className="size-3.5" />
              {t('delete')}
            </button>
          )}
        </div>
        {notice && <p className="mt-2 text-xs text-success">{notice}</p>}
        {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
      </Card>

      <Card bodyClass="p-0">
        <ThreadList data={data} baseHref={(p) => `/mod/${fid}?page=${p}`} selectable selected={selected} onToggle={onToggle} />
      </Card>

      <Pagination page={data.page} totalPage={data.totalPage} href={(p) => `/mod/${fid}?page=${p}`} />

      <div className="mx-auto lg:w-1/2">
        <Link to={forum ? `/forum/${fid}` : '/'}>
          <Button variant="secondary" block>
            {t('back')}
          </Button>
        </Link>
      </div>
    </div>
  );
}
