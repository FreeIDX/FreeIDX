/**
 * 订单管理（§15.4 /api/admin/orders，支付分组第二个 Tab；本项目新增页）。
 * 版式沿用后台「筛选条 + 数据表」范式（ModlogPage/UserListPage 同族），差异记账：
 *  - GET 返回 {list,page,size} 但**没有 total**，故用 AdminCursorPager 的上一页/下一页，
 *    下一页可用性约定为「返回条数 === size」（size 固定 20，服务端默认值即 20）；
 *  - status 是服务端白名单枚举（pending|paid|fulfilled|refunded|closed），空值 = 全部；
 *  - 金额口径是分（amount_cents），UI 用元展示；
 *  - 行内两个动作按状态机禁用：只有 paid/fulfilled 可退款、只有 pending 可补单（服务端也会再校验一次）；
 *    退款是资金动作，补一层 ConfirmModal 二次确认；补单（人工确认收款）幂等，直接执行。
 */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { getAdminOrders, refundOrder, settleOrder } from '../api';
import type { AdminOrderRow } from '../types';
import { useAdminT } from '../t';
import { useBatchAction } from '../use-action';
import { fmtDate } from '../../lib/api';
import { posInt } from '../../lib/params';
import { PAY_TABS } from '../tabs';
import { AdminCursorPager, Alert, Badge, Button, Card, ConfirmModal, ErrorState, PageTitle, Select, TabBar, Table } from '../ui';

const SIZE = 20;


/** 金额单位是分，UI 用元展示 */
const centsToYuan = (cents: number): string => (cents / 100).toFixed(2);

export function OrderAdminPage() {
  const t = useAdminT();
  const STATUS_OPTIONS = [
    { value: '', text: t('admin_order_status_all', '全部状态') },
    { value: 'pending', text: t('admin_order_status_pending', '待支付') },
    { value: 'paid', text: t('admin_order_status_paid', '已支付') },
    { value: 'fulfilled', text: t('admin_order_status_fulfilled', '已履约') },
    { value: 'refunded', text: t('admin_order_status_refunded', '已退款') },
    { value: 'closed', text: t('admin_order_status_closed', '已关闭') },
  ];
  const STATUS_META: Record<string, { text: string; tone: 'secondary' | 'info' | 'success' | 'warning' | 'danger' }> = {
    pending: { text: t('admin_order_status_pending', '待支付'), tone: 'warning' },
    paid: { text: t('admin_order_status_paid', '已支付'), tone: 'info' },
    fulfilled: { text: t('admin_order_status_fulfilled', '已履约'), tone: 'success' },
    refunded: { text: t('admin_order_status_refunded', '已退款'), tone: 'danger' },
    closed: { text: t('admin_order_status_closed', '已关闭'), tone: 'secondary' },
  };
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '';
  const page = posInt(sp.get('page'));

  const q = useQuery({
    queryKey: ['admin', 'orders', { status, page }],
    queryFn: () => getAdminOrders({ status: status || undefined, page, size: SIZE }),
    placeholderData: keepPreviousData,
  });

  const batch = useBatchAction([['admin', 'orders']]);
  const [busyNo, setBusyNo] = useState('');
  const [confirming, setConfirming] = useState<AdminOrderRow | null>(null);

  const rows = q.data?.list ?? [];
  const hasNext = rows.length === SIZE;

  /** 只把非默认值写进 URL：切状态回到第 1 页，翻页保留状态过滤 */
  const goto = (nextStatus: string, nextPage: number) => {
    const params = new URLSearchParams();
    if (nextStatus) params.set('status', nextStatus);
    if (nextPage > 1) params.set('page', String(nextPage));
    setSp(params);
  };

  const run = async (o: AdminOrderRow, kind: 'refund' | 'settle') => {
    setBusyNo(o.order_no);
    const ok = await batch.run(
      [() => (kind === 'refund' ? refundOrder(o.order_no) : settleOrder(o.order_no))],
      kind === 'refund' ? t('admin_order_refunded_msg', '订单 {order_no} 已退款', { order_no: o.order_no }) : t('admin_order_settled_msg', '订单 {order_no} 已补单', { order_no: o.order_no }),
    );
    setBusyNo('');
    if (ok && kind === 'refund') setConfirming(null);
  };

  return (
    <div className="space-y-3">
      <PageTitle>{t('admin_orders', '订单')}</PageTitle>
      <TabBar active="order" items={PAY_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {q.isError && <ErrorState error={q.error} />}
      {batch.flash && <Alert tone={batch.flash.tone}>{batch.flash.text}</Alert>}

      <Card
        title={t('admin_orders', '订单')}
        tools={
          <Select aria-label={t('admin_filter_by_status', '按状态筛选')} className="min-w-[9rem]" value={status} onChange={(e) => goto(e.target.value, 1)}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.text}
              </option>
            ))}
          </Select>
        }
        footer={<AdminCursorPager page={page} hasPrev={page > 1} hasNext={hasNext} onPrev={() => goto(status, page - 1)} onNext={() => goto(status, page + 1)} />}
      >
        <Table head={[t('admin_order_no', '订单号'), 'UID', t('admin_plan_id', '计划 ID'), t('admin_amount_yuan', '金额(元)'), t('admin_currency', '币种'), t('admin_status', '状态'), t('admin_channel', '通道'), t('admin_order_time', '下单时间'), t('admin_pay_time', '支付时间'), t('admin_action', '操作')]} minWidth="min-w-[1040px]">
          {rows.map((o) => {
            const meta = STATUS_META[o.status] ?? { text: o.status, tone: 'secondary' as const };
            const canRefund = o.status === 'paid' || o.status === 'fulfilled';
            const canSettle = o.status === 'pending';
            const busy = busyNo === o.order_no && batch.pending;
            return (
              <tr key={o.order_no}>
                <td className="font-mono text-xs">{o.order_no}</td>
                <td className="tabular-nums">
                  <Link className="text-brand hover:underline" to={`/user/${o.uid}`}>
                    {o.uid}
                  </Link>
                </td>
                <td className="tabular-nums">{o.plan_id}</td>
                <td className="tabular-nums">{centsToYuan(o.amount_cents)}</td>
                <td>{o.currency}</td>
                <td>
                  <Badge tone={meta.tone}>{meta.text}</Badge>
                </td>
                <td>{o.provider || '-'}</td>
                <td className="whitespace-nowrap text-xs text-muted">{fmtDate(o.created_date) || '-'}</td>
                <td className="whitespace-nowrap text-xs text-muted">{o.paid_date ? fmtDate(o.paid_date) : '-'}</td>
                <td className="whitespace-nowrap">
                  <Button size="sm" variant="danger" disabled={!canRefund} loading={busy} onClick={() => setConfirming(o)}>
                    {t('refund', '退款')}
                  </Button>
                  <Button size="sm" variant="default" className="ml-1" disabled={!canSettle} loading={busy} onClick={() => void run(o, 'settle')}>
                    {t('settle', '补单')}
                  </Button>
                </td>
              </tr>
            );
          })}
        </Table>
        {rows.length === 0 && !q.isFetching && <p className="py-6 text-center text-sm text-muted">{t('admin_no_matching_orders', '没有符合条件的订单。')}</p>}
      </Card>

      <ConfirmModal
        open={confirming !== null}
        loading={batch.pending}
        text={t('admin_refund_confirm', '对订单「{order_no}」执行退款：通道退款成功后回写状态为 refunded，该动作不可撤销。确定退款？', { order_no: confirming?.order_no ?? '' })}
        onConfirm={() => void run(confirming!, 'refund')}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
