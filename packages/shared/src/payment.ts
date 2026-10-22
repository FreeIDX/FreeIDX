/**
 * PaymentProvider 契约（§15.5，类型在 shared，payment-core 装配）。
 * 每通道一个独立插件；差异收敛在 createCheckout/verifyWebhook 两个函数内。
 */

export const OrderStatus = {
  PENDING: 'pending',
  PAID: 'paid',
  FULFILLED: 'fulfilled',
  REFUNDED: 'refunded',
  CLOSED: 'closed',
} as const;
export type OrderStatusValue = (typeof OrderStatus)[keyof typeof OrderStatus];

/** 状态机合法迁移（pending→paid→fulfilled/refunded；单测全覆盖 T5-3） */
export const ORDER_TRANSITIONS: Record<OrderStatusValue, OrderStatusValue[]> = {
  pending: ['paid', 'closed'],
  paid: ['fulfilled', 'refunded'],
  fulfilled: ['refunded'],
  refunded: [],
  closed: [],
};

export interface PayOrder {
  orderNo: string;
  uid: number;
  planId: number;
  amountCents: number;
  currency: string;
  status: OrderStatusValue;
}

export interface ProviderEvent {
  providerRef: string;
  /** ignored：验签通过但当前无需落账（如异步支付 completed 尚未到账），核心 ack 200 不触发重试 */
  status: 'paid' | 'refunded' | 'failed' | 'ignored';
  amountCents?: number;
  /**
   * 站内订单号（可选）：通道侧从 metadata / custom_id / client_reference_id 等可靠字段解析。
   * providerRef 只保证在同一订单生命周期内稳定（如 Stripe 下单存 checkout session id `cs_…`），
   * 而退款/失败类事件的对象是 Charge/Refund/PaymentIntent（`ch_/re_/pi_…`），无法反查该 ref；
   * 核心据此做二级反查，避免「钱退了但订单状态不动」。
   */
  orderNo?: string;
  raw?: unknown;
}

export interface PaymentCapabilities {
  currencies: string[];
  modes: ('redirect' | 'qrcode' | 'redeem')[];
  refund: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PaymentConfig {}

export interface PaymentProvider<Cfg extends PaymentConfig = PaymentConfig> {
  id: string;
  capabilities: PaymentCapabilities;
  createCheckout(order: PayOrder, cfg: Cfg): Promise<
    | { mode: 'redirect'; url: string }
    | { mode: 'qrcode'; content: string }
    | { mode: 'redeem' }
  >;
  /** 验签失败返回 null，核心拒绝落账 */
  verifyWebhook(req: Request, cfg: Cfg): Promise<ProviderEvent | null>;
  /** 掉单对账用 */
  queryOrder?(ref: string, cfg: Cfg): Promise<'pending' | 'paid' | 'failed'>;
  refund?(order: PayOrder, cfg: Cfg): Promise<{ ok: boolean; reason?: string }>;
}
