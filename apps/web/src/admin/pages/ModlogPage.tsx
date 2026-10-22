/**
 * 版务日志（modlog 面板）：?uid 过滤 + logid 倒序分页。
 * action 是版务动作枚举（top/close/digest/delete/move，见 modules/mod/routes.ts），
 * tid/pid 直链前台，管理员可从日志回溯到被操作的主题。
 */
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { getModlogs } from '../api';
import { useAdminT } from '../t';
import { fmtDate } from '../../lib/api';
import { posInt } from '../../lib/params';
import { Icon } from '../../components/icons';
import { OTHER_TABS } from '../tabs';
import { AdminPagination, Button, Card, ErrorState, Input, PageTitle, TabBar, Table } from '../ui';

export function ModlogPage() {
  const t = useAdminT();
  const ACTION_TEXT: Record<string, string> = {
    top: t('admin_modlog_action_top', '置顶/取消'),
    close: t('admin_modlog_action_close', '关闭/开放'),
    digest: t('admin_modlog_action_digest', '加精/取消'),
    delete: t('delete', '删除'),
    move: t('admin_modlog_action_move', '移动版块'),
    update: t('admin_modlog_action_update', '编辑主题'),
  };
  const [sp, setSp] = useSearchParams();
  const uid = sp.get('uid') ?? '';
  const page = posInt(sp.get('page'));
  const [formUid, setFormUid] = useState(uid);
  useEffect(() => setFormUid(uid), [uid]);

  const q = useQuery({
    queryKey: ['admin', 'modlogs', { uid, page }],
    queryFn: () => getModlogs({ uid: uid ? Number(uid) : undefined, page }),
    placeholderData: keepPreviousData,
  });

  const href = (p: number): string => {
    const params = new URLSearchParams();
    if (uid) params.set('uid', uid);
    if (p > 1) params.set('page', String(p));
    const s = params.toString();
    return s ? `/admin/modlogs?${s}` : '/admin/modlogs';
  };

  const rows = q.data?.list ?? [];

  return (
    <div className="space-y-3">
      <PageTitle>{t('admin_mod_logs', '版务日志')}</PageTitle>
      <TabBar active="modlog" items={OTHER_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {q.isError && <ErrorState error={q.error} />}

      <Card>
        <form
          className="mb-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const k = formUid.trim();
            setSp(k ? new URLSearchParams({ uid: k }) : new URLSearchParams());
          }}
        >
          <div className="w-40">
            <label className="mb-1 block text-xs text-muted" htmlFor="modlog-uid">
              {t('admin_filter_by_uid', '按操作者 UID 过滤')}
            </label>
            <Input id="modlog-uid" type="number" min={1} value={formUid} onChange={(e) => setFormUid(e.target.value)} />
          </div>
          <Button type="submit" loading={q.isFetching}>
            <Icon name="search" />
            {t('search', '搜索')}
          </Button>
          {uid && (
            <button type="button" className="text-sm text-muted hover:underline" onClick={() => setSp(new URLSearchParams())}>
              {t('admin_clear_filter', '清除过滤')}
            </button>
          )}
        </form>
        <Table
          head={[t('admin_log_id', '日志 ID'), t('admin_operator', '操作者'), t('thread', '主题'), t('post', '帖子'), t('admin_modlog_action_col', '动作'), t('admin_subject_comment', '标题 / 备注'), t('time_label', '时间')]}
          minWidth="min-w-[860px]"
        >
          {rows.map((r) => (
            <tr key={r.logid} className="border-b border-line-soft">
              <td className="py-2 text-center tabular-nums">{r.logid}</td>
              <td className="py-2 text-center">
                <Link className="text-brand hover:underline" to={`/user/${r.uid}`}>
                  uid {r.uid}
                </Link>
              </td>
              <td className="py-2 text-center tabular-nums">
                {r.tid ? (
                  <Link className="text-brand hover:underline" to={`/thread/${r.tid}`}>
                    {r.tid}
                  </Link>
                ) : (
                  '-'
                )}
              </td>
              <td className="py-2 text-center tabular-nums">{r.pid || '-'}</td>
              <td className="py-2 text-center">
                <span className="rounded bg-line px-1.5 py-0.5 text-xs">{ACTION_TEXT[r.action] ?? r.action}</span>
              </td>
              <td className="py-2">
                <div className="line-clamp-1">{r.subject || '-'}</div>
                {r.comment && <div className="mt-0.5 text-xs text-muted-2">{r.comment}</div>}
              </td>
              <td className="py-2 text-center text-xs text-muted">{fmtDate(r.create_date)}</td>
            </tr>
          ))}
        </Table>
        {rows.length === 0 && !q.isFetching && <p className="py-6 text-center text-sm text-muted">{t('admin_no_modlog_records', '暂无版务操作记录。')}</p>}
        {q.data && <AdminPagination page={q.data.page} totalPage={q.data.totalPage} href={href} />}
      </Card>
    </div>
  );
}
