/**
 * 小黑屋名单（/admin/banned）：**生效中**的封禁 + 解封入口。
 * 口径与后端一致：ban_scope > 0 且（永久 或 未到期）；已到期未清理的行不出现（读路径惰性判定）。
 * 检索为模糊匹配用户名/邮箱（/api/admin/users 的精确匹配口径不适用于运营排查场景）。
 */
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { getBannedUsers, unbanUser } from '../api';
import type { BannedUserRow } from '../types';
import { useAdminT } from '../t';
import { useBatchAction } from '../use-action';
import { USER_TABS } from '../tabs';
import { fmtDate } from '../../lib/api';
import { posInt } from '../../lib/params';
import { scopeText } from '../ban';
import {
  AdminPagination,
  Alert,
  Button,
  ConfirmModal,
  ErrorState,
  Input,
  PageTitle,
  TabBar,
  Table,
  cardCls,
  cardFooterCls,
  cardHeaderCls,
  cx,
} from '../ui';

export function BannedPage() {
  const t = useAdminT();
  const [sp, setSp] = useSearchParams();
  const keyword = sp.get('keyword') ?? '';
  const page = posInt(sp.get('page'));
  const [formKey, setFormKey] = useState(keyword);
  useEffect(() => setFormKey(keyword), [keyword]);

  const q = useQuery({
    queryKey: ['admin', 'banned', { keyword, page }],
    queryFn: () => getBannedUsers({ keyword, page }),
    placeholderData: keepPreviousData,
  });

  const batch = useBatchAction([['admin', 'banned'], ['admin', 'users'], ['admin', 'runtime']]);
  const [confirmUid, setConfirmUid] = useState(0);
  const rows = q.data?.list ?? [];

  const buildHref = (p: number): string => {
    const params = new URLSearchParams();
    if (keyword) params.set('keyword', keyword);
    if (p > 1) params.set('page', String(p));
    const s = params.toString();
    return s ? `/admin/banned?${s}` : '/admin/banned';
  };

  const submit = () => {
    const params = new URLSearchParams();
    const k = formKey.trim();
    if (k) params.set('keyword', k);
    setSp(new URLSearchParams(params.toString()));
  };

  const confirmUnban = async () => {
    const ok = await batch.run([() => unbanUser(confirmUid)], t('ban_unban', '解封'));
    if (ok) setConfirmUid(0);
  };

  return (
    <div className="space-y-3">
      <PageTitle>{t('ban_manage', '小黑屋')}</PageTitle>
      <TabBar active="banned" items={USER_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />

      <div className="grid grid-cols-1 items-start gap-x-[30px] md:grid-cols-12">
        <div className="min-w-0 md:col-span-5">
          <Input
            aria-label={t('keyword', '关键字')}
            placeholder={t('keyword', '关键字')}
            value={formKey}
            onChange={(e) => setFormKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>
        <div className="min-w-0 md:col-span-2">
          <Button loading={q.isFetching} onClick={submit} className="w-full">
            {t('search', '搜索')}
          </Button>
        </div>
      </div>

      {q.isError && <ErrorState error={q.error} />}
      {batch.flash && <Alert tone={batch.flash.tone}>{batch.flash.text}</Alert>}

      <section className={cx(cardCls, 'flex flex-col')}>
        <div className={cardHeaderCls}>
          <span className="text-[1.1rem] font-normal leading-[1.5]">{t('ban_list', '小黑屋名单')}</span>
          <span className="ml-auto text-sm text-muted">{q.data ? `${q.data.total}` : '—'}</span>
        </div>
        <div className="min-h-px flex-1">
          <Table
            flush
            minWidth="min-w-[960px]"
            head={[
              t('uid', 'UID'),
              t('username', '用户名'),
              t('ban_scope', '封禁范围'),
              t('ban_reason_label', '原因'),
              t('ban_expire', '到期'),
              t('ban_operator', '操作人'),
              t('operation', '操作'),
            ]}
          >
            {rows.map((r) => (
              <BannedRow key={r.uid} row={r} onUnban={() => setConfirmUid(r.uid)} />
            ))}
          </Table>
          {rows.length === 0 && !q.isFetching && <p className="m-0 py-[.75rem] text-center text-sm text-muted">{t('none', '无')}</p>}
        </div>
        <div className={cx(cardFooterCls, 'text-[80%] text-muted')}>
          {t('ban_scope', '封禁范围')}：{t('ban_scope_mute', '禁言')} / {t('ban_scope_read', '禁访')} / {t('ban_scope_login', '禁止登录')}
        </div>
      </section>

      {q.data && <AdminPagination page={q.data.page} totalPage={q.data.totalPage} href={buildHref} />}

      <ConfirmModal
        open={confirmUid > 0}
        loading={batch.pending}
        danger={false}
        text={t('ban_unban_confirm', '确定解除该用户的封禁？')}
        onConfirm={() => void confirmUnban()}
        onCancel={() => setConfirmUid(0)}
      />
    </div>
  );
}

function BannedRow({ row, onUnban }: { row: BannedUserRow; onUnban: () => void }) {
  const t = useAdminT();
  return (
    <tr>
      <td className="tabular-nums">{row.uid}</td>
      <td>
        <Link to={`/admin/users/${row.uid}/edit`} className="text-brand no-underline hover:underline">
          {row.username}
        </Link>
        <span className="ml-2 text-xs text-muted-2">{row.email}</span>
      </td>
      <td>{scopeText(row.ban_scope, t)}</td>
      <td className="max-w-[240px] break-all">{row.ban_reason || '—'}</td>
      <td className="whitespace-nowrap tabular-nums">
        {row.ban_until > 0 ? fmtDate(row.ban_until) : t('ban_permanent', '永久')}
      </td>
      <td className="whitespace-nowrap">{row.ban_by_name || `#${row.ban_by}`}</td>
      <td className="pr-0">
        <Button size="sm" variant="danger" onClick={onUnban}>
          {t('ban_unban', '解封')}
        </Button>
      </td>
    </tr>
  );
}
