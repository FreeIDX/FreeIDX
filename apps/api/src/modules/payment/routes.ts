/**
 * payment-core 对外路由（T5-4，§15.4/§15.5）：
 *   POST /api/payments/webhook/:pluginId  公网通道回调分发（CSRF 豁免）
 *     · 生命周期门控：未装/无代码→404、装而停用→410、验签失败→400（拒绝落账）、其余→200
 *     · 幂等：重复回调经订单状态机守卫直接短路，始终 200 ack 以止住 provider 重试
 *   POST /api/orders/:no/checkout         对已下单（pending）订单装配跳转/二维码/卡密态（收银台用）
 * 收银台聚合 GET /api/payment-providers、掉单对账 cron、后台退款/配置属 T5-7。
 */
import { Hono, type Context } from 'hono';
import { Code } from '@freeidx/shared';
import type { ApiKey } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { loadViewer } from '../../core/loaders';
import type { D1b } from '../../core/db';
import type { Cache } from '../../core/cache';
import { claimPendingOrder, getOrder, markPaid, fulfillOrder, releaseOrderClaim } from '../../core/order';
import { dispatchWebhook, linkProviderRef } from '../../core/payment/orchestrator';
import { asRedeemable, getProvider, listReadyProviders, providerLifecycle, resolveProviderConfig, runCheckout, type ProviderView, type RedeemResult } from '../../core/payment/registry';
import type { ReadEnv } from '../shared';

type Ctx = Context<ReadEnv>;
const now = () => Math.floor(Date.now() / 1000);

/** 收银台币种过滤：capabilities.currencies 为空（卡密/通道无关币种）视为接受任意币种 */
function acceptCurrency(v: ProviderView, currency: string | undefined): boolean {
  if (!currency) return true;
  const list = v.capabilities.currencies ?? [];
  return list.length === 0 || list.some((c) => c.toUpperCase() === currency.toUpperCase());
}

/** GET /api/payment-providers —— 收银台可用通道（仅 ready，按币种过滤；卡密等 redeem 通道置前作兜底） */
async function providers(c: Ctx): Promise<Response> {
  const core = { db: c.get('db') as D1b, cache: c.get('cache') as Cache };
  const currency = c.req.query('currency');
  const list = await listReadyProviders(core.cache, core.db);
  const filtered = list
    .filter((v) => acceptCurrency(v, currency))
    .sort((a, b) => {
      const ar = a.capabilities.modes?.includes('redeem') ? 0 : 1;
      const br = b.capabilities.modes?.includes('redeem') ? 0 : 1;
      return ar - br || a.id.localeCompare(b.id);
    });
  return ok(c, 'ok', {
    data: {
      list: filtered.map((v) => ({
        id: v.id,
        capabilities: { currencies: v.capabilities.currencies ?? [], modes: v.capabilities.modes ?? [], refund: !!v.capabilities.refund },
      })),
    },
  });
}

/** POST /api/payments/webhook/:pluginId */
async function webhook(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core = { db: c.get('db'), cache: c.get('cache') };
  const pluginId = c.req.param('pluginId') ?? '';
  if (!pluginId) return c.json({ code: Code.NOT_FOUND, message: t('pay.providerRequired') }, 404);
  const { status, outcome } = await dispatchWebhook(core, c.env, pluginId, c.req.raw, now());
  if (status === 404) return c.json({ code: Code.NOT_FOUND, message: t('pay.providerNotInstalled'), outcome }, 404);
  if (status === 410) return c.json({ code: Code.SYSTEM_ERROR, message: t('pay.providerDisabled'), outcome }, 410);
  if (status === 400) return c.json({ code: Code.CAPTCHA_FAILED, message: t('pay.signFailed'), outcome }, 400);
  return c.json({ code: Code.OK, message: 'ok', outcome }, 200);
}

/** POST /api/orders/:no/checkout —— 本人订单，按 provider 装配 checkout（未 ready 通道优雅降级 pending 轮询） */
async function checkout(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core = { db: c.get('db') as D1b, cache: c.get('cache') as Cache };
  const v = await loadViewer(core.cache, core.db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const orderNo = c.req.param('no') ?? '';
  if (!orderNo) throw new AppError(Code.VALIDATION_ERROR, t('pay.orderNoRequired'));
  const order = await getOrder(core.db, orderNo);
  if (!order) throw new AppError(Code.NOT_FOUND, t('common.orderNotFound'));
  if (order.uid !== v.uid) throw new AppError(Code.NO_PERMISSION, t('pay.orderNotOwner'));

  // 已终结订单不再创建会话：已付/已退/已关单若再拉起一笔外部支付，
  // webhook 落到终态只会被幂等 ignored —— 用户实际扣款但不发货。
  if (order.status !== 'pending') {
    return ok(c, t('pay.orderProcessed'), { data: { order_no: orderNo, status: order.status, mode: 'pending' } });
  }
  // 同一 pending 单复用已创建的会话（24h 内）：重复点击/刷新不得另开会话，
  // 否则两笔外部支付只有一笔能与订单关联，另一笔被静默忽略。
  const ckKey = `checkout:${orderNo}`;
  const cached = await core.cache.get<{ mode: string; url?: string; content?: string }>(ckKey);
  if (cached) {
    return ok(c, 'ok', {
      data: {
        order_no: orderNo,
        status: order.status,
        mode: cached.mode,
        ...(cached.mode === 'redirect' ? { url: cached.url } : {}),
        ...(cached.mode === 'qrcode' ? { content: cached.content } : {}),
      },
    });
  }
  // 已有外部会话引用但结果缓存缺失（旧单/缓存被清）：返回 pending 轮询，不另开会话。
  // `claim:` 是兑换/回调的短时占位，不属于外部会话，可正常重开。
  if (order.providerRef && !order.providerRef.startsWith('claim:')) {
    return ok(c, t('pay.pending'), { data: { order_no: orderNo, status: order.status, mode: 'pending' } });
  }

  const result = await runCheckout(core.cache, core.db, c.env, order.provider, order);
  if (!result) {
    // 通道未启用/无 checkout：回落 pending，由前端轮询 /api/orders/:no 兜底（§15.4）
    return ok(c, t('pay.pending'), { data: { order_no: orderNo, status: order.status, mode: 'pending' } });
  }
  // 外部通道可回填 provider_ref（幂等 webhook 反查用）；卡密 redeem 无 ref
  const ref = (result as { providerRef?: string }).providerRef;
  if (ref) await linkProviderRef(core.db, orderNo, ref);
  // 24h 内复用同一会话（Stripe Checkout 会话有效期上限）；卡密态同缓存，避免重复渲染查询
  await core.cache.set(ckKey, result, 86400);
  return ok(c, 'ok', {
    data: {
      order_no: orderNo,
      status: order.status,
      mode: result.mode,
      ...(result.mode === 'redirect' ? { url: result.url } : {}),
      ...(result.mode === 'qrcode' ? { content: result.content } : {}),
    },
  });
}

/** POST /api/orders/:no/redeem —— 卡密兑换闭环（下单→兑换→开通）；通道无关编排，redeem 能力由插件提供 */
async function redeem(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core = { db: c.get('db') as D1b, cache: c.get('cache') as Cache };
  const v = await loadViewer(core.cache, core.db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const orderNo = c.req.param('no') ?? '';
  if (!orderNo) throw new AppError(Code.VALIDATION_ERROR, t('pay.orderNoRequired'));
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
  }
  const code = String(body.code ?? '');

  const order = await getOrder(core.db, orderNo);
  if (!order) throw new AppError(Code.NOT_FOUND, t('common.orderNotFound'));
  if (order.uid !== v.uid) throw new AppError(Code.NO_PERMISSION, t('pay.orderNotOwner'));
  if (order.status !== 'pending') {
    // 幂等：已支付/已开通的重复兑换直接返回当前态，不再消费新卡
    return ok(c, t('pay.orderProcessed'), { data: { order_no: orderNo, status: order.status } });
  }

  if ((await providerLifecycle(core.cache, core.db, order.provider)) !== 'ready') {
    throw new AppError(Code.VALIDATION_ERROR, t('pay.providerUnavailable'));
  }
  const provider = asRedeemable(getProvider(order.provider));
  if (!provider) throw new AppError(Code.VALIDATION_ERROR, t('pay.redeemUnsupported'));

  // 订单级互斥占位：并发提交两张不同有效卡时，只有抢到占位的那次能消费卡密。
  // 否则「状态检查」与「认领卡密」之间无锁，两张卡各被认领一次，仅第一张推进订单 → 有效卡凭空损失。
  const claim = await claimPendingOrder(core.db, orderNo);
  if (!claim) {
    const cur = await getOrder(core.db, orderNo);
    return ok(c, t('pay.orderProcessed'), { data: { order_no: orderNo, status: cur?.status ?? order.status } });
  }

  const config = await resolveProviderConfig(core.cache, core.db, c.env, order.provider);
  let result: RedeemResult;
  try {
    result = await provider.redeem(order, code, { db: core.db, cache: core.cache, env: c.env, config, ts: now() });
  } catch (e) {
    await releaseOrderClaim(core.db, orderNo, claim); // 尚未消耗卡密：释放占位，允许换码重试
    throw e;
  }
  // 插件 reason 约定为 API_MESSAGES 词条键（如 card.codeInvalid），路由层统一按站点语言翻译
  if (!result.ok) {
    await releaseOrderClaim(core.db, orderNo, claim);
    throw new AppError(Code.VALIDATION_ERROR, result.reason ? t(result.reason as ApiKey) : t('pay.redeemFailed'));
  }

  // 卡密已被认领：此后不再释放占位（落账失败也不允许再消费第二张卡）
  const ts = now();
  await markPaid(core.db, orderNo, result.providerRef ?? `card:${code}`, ts, t);
  const fulfilled = await fulfillOrder(core, orderNo, ts, t);
  return ok(c, t('pay.redeemDone'), { data: { order_no: orderNo, status: fulfilled.status } });
}

export function paymentRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();
  app.get('/api/payment-providers', providers);
  app.post('/api/payments/webhook/:pluginId', webhook);
  app.post('/api/orders/:no/checkout', checkout);
  app.post('/api/orders/:no/redeem', redeem);
  return app;
}
