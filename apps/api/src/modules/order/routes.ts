/**
 * 会员订单只读/下单接口（T5-3，§15.4）：
 *  GET  /api/vip/plans     已启用计划（公开）
 *  POST /api/orders        下单（登录）：按 plan 定价落 pending 订单
 *  GET  /api/orders/:no    查单（登录 + 本人）：前端轮询兜底 webhook 延迟
 * 支付通道 checkout/兑换/webhook 属 payment-core（T5-4）与各通道插件（T5-5/T5-6），此处仅订单与状态。
 */
import { Hono, type Context } from 'hono';
import { Code, type PayOrder } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { loadViewer } from '../../core/loaders';
import type { D1b } from '../../core/db';
import { createOrder, findPlan, getOrder, listEnabledPlans, type VipPlanRow } from '../../core/order';
import { listReadyProviders } from '../../core/payment/registry';
import { intParam, type ReadEnv } from '../shared';

type Ctx = Context<ReadEnv>;
const now = () => Math.floor(Date.now() / 1000);

function planDto(p: VipPlanRow): Record<string, unknown> {
  let perks: unknown = {};
  try {
    perks = JSON.parse(p.perks || '{}');
  } catch {
    perks = {};
  }
  return {
    id: Number(p.id),
    name: String(p.name),
    duration_days: Number(p.duration_days),
    price_cents: Number(p.price_cents),
    currency: String(p.currency),
    perks,
    gid: Number(p.gid ?? 0),
  };
}

function orderDto(o: PayOrder): Record<string, unknown> {
  return {
    order_no: o.orderNo,
    plan_id: o.planId,
    amount_cents: o.amountCents,
    currency: o.currency,
    status: o.status,
  };
}

/** GET /api/vip/plans */
async function vipPlans(c: Ctx): Promise<Response> {
  const db: D1b = c.get('db');
  const plans = await listEnabledPlans(db);
  return ok(c, 'ok', { data: { list: plans.map(planDto) } });
}

/** POST /api/orders */
async function placeOrder(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core = { db: c.get('db'), cache: c.get('cache') };
  const v = await loadViewer(core.cache, core.db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  let b: Record<string, unknown>;
  try {
    b = await c.req.json<Record<string, unknown>>();
  } catch {
    throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
  }
  const planId = intParam(String(b.planId ?? b.plan_id ?? ''));
  const provider = String(b.provider ?? '').trim();
  if (planId <= 0) throw new AppError(Code.VALIDATION_ERROR, t('order.planRequired'));
  const plan = await findPlan(core.db, planId);
  if (!plan || Number(plan.enabled) !== 1) throw new AppError(Code.NOT_FOUND, t('common.planNotFoundOrOff'));

  // 通道有效性：必须是当前 ready 的收银台通道。否则会落出永不成立的 pending 单
  // （checkout 恒降级、webhook 恒 404），只能靠对账兜底。
  if (!provider) throw new AppError(Code.VALIDATION_ERROR, t('pay.providerRequired'));
  const ready = await listReadyProviders(core.cache, core.db);
  if (!ready.some((p) => p.id === provider)) throw new AppError(Code.VALIDATION_ERROR, t('pay.providerUnavailable'));

  const order = await createOrder(core, { uid: v.uid, plan, provider, ts: now() });
  // checkout（redirect/qrcode/redeem）由 payment-core 依 provider 插件装配（T5-4）；未启用通道返回 pending 态由前端轮询。
  return ok(c, t('order.created'), { data: { ...orderDto(order), provider } });
}

/** GET /api/orders/:no —— 仅本人可查（前端轮询兜底） */
async function queryOrder(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core = { db: c.get('db'), cache: c.get('cache') };
  const v = await loadViewer(core.cache, core.db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const orderNo = c.req.param('no') ?? '';
  if (!orderNo) throw new AppError(Code.VALIDATION_ERROR, t('pay.orderNoRequired'));
  const order = await getOrder(core.db, orderNo);
  if (!order) throw new AppError(Code.NOT_FOUND, t('common.orderNotFound'));
  if (order.uid !== v.uid) throw new AppError(Code.NO_PERMISSION, t('pay.orderNotOwnerView'));
  return ok(c, 'ok', {
    data: {
      ...orderDto(order),
      created_date: order.createdDate,
      paid_date: order.paidDate,
      fulfilled_date: order.fulfilledDate,
    },
  });
}

export function orderRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();
  app.get('/api/vip/plans', vipPlans);
  app.post('/api/orders', placeOrder);
  app.get('/api/orders/:no', queryOrder);
  return app;
}
