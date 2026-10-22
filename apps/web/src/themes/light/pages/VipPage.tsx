/**
 * VIP 套餐页（收银台入口，§15 前台接线）：
 *  - 套餐列表（GET /api/vip/plans，公开可浏览）+ 页面级支付方式选择（GET /api/payment-providers）；
 *  - 已登录 → 选择通道后「立即购买」POST /api/orders → 跳 /order/:no 进入收银台；
 *  - 未登录点购买 → 登录弹窗（下单/收银台接口均需登录）。
 * 通道显示名按 id 映射词条（pay_provider_{id}），未知通道透出原始 id。
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useState } from 'react';
import { fetchPaymentProviders, fetchVipPlans, placeOrder, type PaymentProviderView, type VipPlan } from '../../../lib/api';
import { apiErrorMessage } from '../../../lib/errors';
import { useAuth } from '../../../store/auth';
import { useAuthModal } from '../../../store/authModal';
import { useT } from '../../../lib/i18n';
import { Breadcrumb, Button, Card, cx } from '../../../components/ui';
import { Icon } from '../../../components/icons';

/** 分 → 元（2 位小数），币种以 ISO 代码展示（与后台订单口径一致） */
function priceOf(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

/** 通道显示名：已知 id 走词条（静态映射，i18n 门禁可见），未知 id 透出原始标识 */
function providerName(t: ReturnType<typeof useT>, id: string): string {
  switch (id) {
    case 'card':
      return t('pay_provider_card');
    case 'stripe':
      return t('pay_provider_stripe');
    case 'paypal':
      return t('pay_provider_paypal');
    case 'alipay':
      return t('pay_provider_alipay');
    default:
      return id;
  }
}

/** 按套餐币种过滤通道：currencies 为空 = 通道不限币种 */
function supportsCurrency(p: PaymentProviderView, currency: string): boolean {
  return p.capabilities.currencies.length === 0 || p.capabilities.currencies.some((c) => c.toUpperCase() === currency.toUpperCase());
}

export function VipPage() {
  const t = useT();
  const navigate = useNavigate();
  const me = useAuth((s) => s.me);
  const openAuth = useAuthModal((s) => s.openAuth);
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [busyPlanId, setBusyPlanId] = useState(0);
  const [err, setErr] = useState('');

  const plansQ = useQuery({ queryKey: ['vip-plans'], queryFn: fetchVipPlans });
  const providersQ = useQuery({ queryKey: ['payment-providers'], queryFn: () => fetchPaymentProviders() });

  const plans = plansQ.data?.list ?? [];
  const providers = providersQ.data?.list ?? [];
  const effectiveProvider = selectedProvider || providers[0]?.id || '';

  const buy = async (plan: VipPlan) => {
    if (!me) {
      openAuth('login');
      return;
    }
    if (!effectiveProvider) {
      setErr(t('order_choose_provider'));
      return;
    }
    setBusyPlanId(plan.id);
    setErr('');
    try {
      const order = await placeOrder(plan.id, effectiveProvider);
      navigate(`/order/${order.order_no}`);
    } catch (e) {
      setErr(apiErrorMessage(e, t('operation_failed')));
    } finally {
      setBusyPlanId(0);
    }
  };

  return (
    <div>
      <Breadcrumb items={[{ text: t('home'), to: '/' }, { text: t('vip_plans_title') }]} />
      <Card header={<span className="font-bold">{t('vip_plans_title')}</span>}>
        {err && <p className="mb-3 rounded border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
        {plansQ.isError && (
          <p className="py-6 text-center text-sm text-destructive">{(plansQ.error as Error).message}</p>
        )}
        {plansQ.isLoading && <p className="py-6 text-center text-sm text-muted-foreground">{t('order_loading')}</p>}
        {!plansQ.isLoading && !plans.length && !plansQ.isError && (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('vip_plans_none')}</p>
        )}
        {providers.length > 1 && (
          <div className="mb-4">
            <p className="mb-2 text-sm font-medium">{t('order_choose_provider')}</p>
            <div className="flex flex-wrap gap-2">
              {providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedProvider(p.id)}
                  className={cx(
                    'rounded border px-3 py-1.5 text-sm transition-colors',
                    effectiveProvider === p.id
                      ? 'border-brand bg-brand/10 font-medium text-brand'
                      : 'border-border text-muted-foreground hover:border-brand/50',
                  )}
                >
                  {providerName(t, p.id)}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plans.map((plan) => {
            const credits = Number(plan.perks?.credits ?? 0);
            const usable = providers.filter((p) => supportsCurrency(p, plan.currency));
            return (
              <div key={plan.id} className="rounded border border-border p-5">
                <div className="flex items-center gap-2">
                  <Icon name="gem" className="size-5 text-brand" />
                  <p className="font-bold">{plan.name}</p>
                </div>
                <p className="mt-3 text-2xl font-bold tabular-nums">{priceOf(plan.price_cents, plan.currency)}</p>
                <p className="mt-1 text-sm text-muted-foreground">{t('vip_plan_days', { days: plan.duration_days })}</p>
                {credits > 0 && (
                  <p className="mt-1 text-sm text-muted-foreground">{t('vip_plan_credits_perk', { n: credits })}</p>
                )}
                <Button
                  className="mt-4"
                  block
                  variant="primary"
                  loading={busyPlanId === plan.id}
                  disabled={!usable.length && !!providers.length}
                  onClick={() => void buy(plan)}
                >
                  {me ? t('vip_buy') : t('vip_login_to_buy')}
                </Button>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}