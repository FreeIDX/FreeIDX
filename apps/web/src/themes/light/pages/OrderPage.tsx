/**
 * 订单收银台（/order/:no，§15 前台接线）：
 *  - 轮询 GET /api/orders/:no（3s，pending 时；服务端设计内行为「前端轮询兜底 webhook 延迟」）；
 *  - pending 操作区按 checkout 的 mode 四态分流：redirect 跳三方 / qrcode 展内容+复制 / redeem 卡密输入 / pending 降级等待；
 *  - paid/fulfilled → 成功提示（fulfilled 时挂组/续期已在服务端完成，刷新 bootstrap 让组徽章/权益即时可见）；
 *  - closed/refunded → 终态提示。未登录/非本单 → 服务端 403/401 错误透出。
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { checkoutOrder, fetchOrder, redeemOrder, type CheckoutData } from '../../../lib/api';
import { apiErrorMessage } from '../../../lib/errors';
import { fmtDate } from '../../../lib/api';
import { useAuth } from '../../../store/auth';
import { useAuthModal } from '../../../store/authModal';
import { useT } from '../../../lib/i18n';
import { Alert, Breadcrumb, Button, Card, inputCls } from '../../../components/ui';

/** 分 → 元（2 位小数）+ 币种 ISO 代码 */
function priceOf(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export function OrderPage() {
  const t = useT();
  const { no = '' } = useParams();

  const me = useAuth((s) => s.me);
  const refreshAuth = useAuth((s) => s.refresh);
  const openAuth = useAuthModal((s) => s.openAuth);
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ['order', no],
    queryFn: () => fetchOrder(no),
    refetchInterval: (query) => (query.state.data?.status === 'pending' ? 3000 : false),
    enabled: Boolean(no),
  });

  const [checkout, setCheckout] = useState<CheckoutData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);

  const order = q.data;
  const status = order?.status;

  /* fulfilled 即权益生效（挂组/VIP 续期/积分在服务端同事务完成）：刷新登录态让组徽章/权益可见 */
  useEffect(() => {
    if (status === 'fulfilled') {
      void refreshAuth();
      void qc.invalidateQueries({ queryKey: ['order', no] });
    }
  }, [status, refreshAuth, qc, no]);

  const goCheckout = async () => {
    if (!me) {
      openAuth('login');
      return;
    }
    setBusy(true);
    setErr('');
    setCopied(false);
    try {
      const data = await checkoutOrder(no);
      if (data.mode === 'redirect' && data.url) {
        window.location.href = data.url;
        return;
      }
      setCheckout(data);
    } catch (e) {
      setErr(apiErrorMessage(e, t('operation_failed')));
    } finally {
      setBusy(false);
    }
  };

  const doRedeem = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setErr('');
    try {
      await redeemOrder(no, code.trim());
      setCode('');
      await q.refetch();
    } catch (e) {
      setErr(apiErrorMessage(e, t('operation_failed')));
    } finally {
      setBusy(false);
    }
  };

  const copyContent = async () => {
    if (!checkout?.content) return;
    try {
      await navigator.clipboard.writeText(checkout.content);
      setCopied(true);
    } catch {
      /* 剪贴板权限拒绝：保持未复制态，用户可手动选择文本 */
    }
  };

  const statusLabel = (s: string | undefined): string => {
    switch (s) {
      case 'pending':
        return t('order_status_pending');
      case 'paid':
        return t('order_status_paid');
      case 'fulfilled':
        return t('order_status_fulfilled');
      case 'refunded':
        return t('order_status_refunded');
      case 'closed':
        return t('order_status_closed');
      default:
        return String(s ?? '');
    }
  };

  return (
    <div>
      <Breadcrumb items={[{ text: t('home'), to: '/' }, { text: t('vip_plans_title'), to: '/vip' }, { text: t('order_title') }]} />
      <Card header={<span className="font-bold">{t('order_title')}</span>}>
        {q.isError && (
          <p className="py-6 text-center text-sm text-destructive">{apiErrorMessage(q.error, t('order_not_found'))}</p>
        )}
        {q.isLoading && <p className="py-6 text-center text-sm text-muted-foreground">{t('order_loading')}</p>}
        {order && (
          <>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <div className="flex justify-between gap-4 border-b border-border/60 pb-2">
                <dt className="text-muted-foreground">{t('order_no_label')}</dt>
                <dd className="font-medium tabular-nums">{order.order_no}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-border/60 pb-2">
                <dt className="text-muted-foreground">{t('order_amount_label')}</dt>
                <dd className="font-bold tabular-nums">{priceOf(order.amount_cents, order.currency)}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-border/60 pb-2">
                <dt className="text-muted-foreground">{t('order_status_label')}</dt>
                <dd className="font-medium">{statusLabel(order.status)}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-border/60 pb-2">
                <dt className="text-muted-foreground">{t('order_created_at')}</dt>
                <dd className="tabular-nums">{fmtDate(order.created_date) || '-'}</dd>
              </div>
              {order.paid_date > 0 && (
                <div className="flex justify-between gap-4 border-b border-border/60 pb-2">
                  <dt className="text-muted-foreground">{t('order_paid_at')}</dt>
                  <dd className="tabular-nums">{fmtDate(order.paid_date)}</dd>
                </div>
              )}
            </dl>

            {err && <p className="mt-3 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}

            {status === 'pending' && (
              <div className="mt-4">
                {!checkout && (
                  <div className="flex flex-col items-start gap-2">
                    <p className="text-sm text-muted-foreground">{t('order_pending_hint')}</p>
                    <Button variant="primary" loading={busy} onClick={() => void goCheckout()}>
                      {t('order_go_pay')}
                    </Button>
                  </div>
                )}
                {checkout?.mode === 'redeem' && (
                  <div className="max-w-sm">
                    <p className="mb-2 text-sm font-medium">{t('order_redeem_label')}</p>
                    <div className="flex gap-2">
                      <input
                        className={inputCls}
                        placeholder={t('order_redeem_placeholder')}
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void doRedeem();
                        }}
                      />
                      <Button variant="primary" loading={busy} onClick={() => void doRedeem()}>
                        {t('order_redeem_submit')}
                      </Button>
                    </div>
                  </div>
                )}
                {checkout?.mode === 'qrcode' && checkout.content && (
                  <div>
                    <p className="mb-2 text-sm text-muted-foreground">{t('order_qr_hint')}</p>
                    <p className="mb-2 text-xs font-medium text-muted-foreground">{t('order_qr_content_label')}</p>
                    <div className="flex items-center gap-2">
                      <code className="max-w-full flex-1 truncate rounded border border-border bg-lt-soft px-3 py-2 text-xs">
                        {checkout.content}
                      </code>
                      <Button variant="outline" size="sm" onClick={() => void copyContent()}>
                        {copied ? t('order_copied') : t('order_copy')}
                      </Button>
                    </div>
                  </div>
                )}
                {checkout?.mode === 'pending' && <p className="text-sm text-muted-foreground">{t('order_pending_hint')}</p>}
              </div>
            )}

            {(status === 'paid' || status === 'fulfilled') && (
              <Alert tone="success" icon="shield" className="mt-4">
                {t('order_success')}
              </Alert>
            )}
            {status === 'closed' && (
              <Alert tone="warning" icon="warning_circle" className="mt-4">
                {t('order_closed_hint')}
              </Alert>
            )}
            {status === 'refunded' && (
              <Alert tone="secondary" icon="warning_circle" className="mt-4">
                {t('order_refunded_hint')}
              </Alert>
            )}

            <div className="mt-4">
              <Link to="/vip" className="text-sm text-brand underline underline-offset-2">
                {t('order_back_plans')}
              </Link>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

