/**
 * 购买记录页（/thread/:tid/paylist）：
 * Breadcrumb（首页/主题/购买记录）+ 主题信息卡（卡头 = 主题标题链接 + 购买人数/单价徽章；
 * 卡体 = 时间|用户 用户表 + 分页）。未登录由接口 401 拦。
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { getThreadPaylist } from '../../../lib/api';
import { posInt } from '../../../lib/params';
import { Avatar } from '../../../components/Avatar';
import { Pagination } from '../../../components/Pagination';
import { Breadcrumb, Card, Pill, cx } from '../../../components/ui';
import { useAuth } from '../../../store/auth';
import { useT } from '../../../lib/i18n';

export function PaylistPage() {
  const t = useT();
  const params = useParams();
  const me = useAuth((s) => s.me);
  const tid = posInt(params.tid);
  const page = posInt(params.page);
  const q = useQuery({ queryKey: ['thread-paylist', tid, page], queryFn: () => getThreadPaylist(tid, page) });
  const d = q.data;
  const isRmb = d?.contentBuyType === 3;
  const amount = d
    ? `${isRmb ? d.contentBuy / 100 : d.contentBuy} ${d.contentBuyType === 1 ? t('credits_experience') : d.contentBuyType === 2 ? t('credits_gold') : t('credits_rmb')}`
    : '';

  return (
    <div className="mx-auto w-full lg:w-[83.333%]">
      <Breadcrumb
        items={[{ text: t('home'), to: '/' }, { text: t('thread'), to: `/thread/${tid}` }, { text: t('buy_record') }]}
      />

      <Card
        header={
          <>
            <Link to={`/thread/${tid}`} className="min-w-0 truncate transition-colors hover:text-brand">
              {d?.thread.subject ?? '…'}
            </Link>
            {d && (
              <span className="ml-auto flex shrink-0 items-center gap-2">
                <Pill jb="jb-blue" title={t('quantity')}>
                  {t('quantity')} {d.count}
                </Pill>
                <Pill jb="jb-gold" title={t('amount_label')}>
                  {amount}
                </Pill>
              </span>
            )}
          </>
        }
        bodyClass="p-0"
      >
        {q.isError && <p className="px-5 py-6 text-sm text-destructive">{(q.error as Error).message}</p>}
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-lt-soft text-xs text-lt-grey">
              <th className="w-[30%] px-5 py-2.5 text-left font-medium">{t('time_label')}</th>
              <th className="w-[70%] px-5 py-2.5 text-left font-medium">{t('user_label')}</th>
            </tr>
          </thead>
          <tbody>
            {(d?.list ?? []).map((r) => (
              <tr key={r.uid} className={cx('border-b border-zh-line last:border-b-0', me?.uid === r.uid && 'font-bold')}>
                <td className="whitespace-nowrap px-5 py-3">{fmtTime(r.paytime)}</td>
                <td className="px-5 py-3">
                  <Link to={`/user/${r.uid}`} className="inline-flex items-center gap-1.5" aria-label={r.username}>
                    <Avatar uid={r.uid} avatar={r.avatar} username={r.username} size={1} />
                    <span className="transition-colors hover:text-brand">{r.username}</span>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {q.isSuccess && d && d.list.length === 0 && (
          <p className="py-10 text-center text-sm text-lt-grey">{t('no_purchase_records')}</p>
        )}
        {d && (
          <Pagination
            className="my-4"
            page={page}
            totalPage={d.totalPage}
            href={(p) => (p === 1 ? `/thread/${tid}/paylist` : `/thread/${tid}/paylist/p/${p}`)}
          />
        )}
      </Card>
    </div>
  );
}

/** 日期时间格式 YYYY-MM-DD HH:mm:ss（fmtDate 为 / 分隔，此处为 - 分隔） */
function fmtTime(ts: number): string {
  if (!ts) return '';
  const dt = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}