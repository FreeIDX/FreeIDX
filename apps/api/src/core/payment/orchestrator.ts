/**
 * payment-core：webhook 事件落账 + 掉单对账 + 退款编排（T5-4，§15.3）。
 * 通道差异已在插件的 verifyWebhook/queryOrder/refund 内收敛；本模块只把 ProviderEvent 翻译成
 * 订单状态机动作（复用 core/order 的 markPaid/fulfillOrder/…，幂等由其保证），全程无通道代码。
 */
import { OrderStatus, type ProviderEvent } from '@freeidx/shared';
import type { Env } from '../../types/env';
import type { Cache } from '../cache';
import type { D1b } from '../db';
import {
  closeOrder,
  fulfillOrder,
  getOrderByProviderRef,
  getOrder,
  listPendingForReconcile,
  listStalePending,
  markPaid,
  refundOrder,
  type OrderRow,
} from '../order';
import { getProvider, providerLifecycle, resolveProviderConfig } from './registry';
import { t0, type ApiT } from '../i18n';

type WebhookOutcome =
  | { handled: true; action: 'paid' | 'refunded' | 'closed' | 'ignored'; orderNo?: string }
  | { handled: false; reason: 'invalid-signature' | 'unknown-order' };

/** checkout 侧回填 provider_ref（外部通道在下单拿到会话/订单号后关联到 pending 单，供 webhook 反查） */
export async function linkProviderRef(db: D1b, orderNo: string, providerRef: string): Promise<void> {
  if (!providerRef) return;
  await db
    .prepare('UPDATE bbs_order SET provider_ref = ? WHERE order_no = ? AND status = ? AND provider_ref = ?')
    .bind(providerRef, orderNo, 'pending', '')
    .run();
}

/**
 * 应用一条已验签事件到状态机。幂等：重复回调经 markPaid/fulfillOrder 的守卫直接短路。
 * 订单反查两级：provider_ref 命中优先；退款/失败类事件对象是 Charge/Refund/PaymentIntent
 * （`ch_/re_/pi_…`）而非下单时存的 ref（`cs_…`），故回落 event.orderNo（通道从
 * metadata/custom_id/client_reference_id 解析）。两级都未命中才视为未知单（ack 不报错，避免 provider 重试风暴）。
 */
export async function applyProviderEvent(
  core: { db: D1b; cache: Cache },
  event: ProviderEvent,
  ts: number,
): Promise<WebhookOutcome> {
  const byRef = event.providerRef ? await getOrderByProviderRef(core.db, event.providerRef) : null;
  const order = byRef ?? (event.orderNo ? await getOrder(core.db, event.orderNo) : null);
  if (!order) return { handled: false, reason: 'unknown-order' };

  switch (event.status) {
    case 'paid': {
      // 金额一致性：事件带上实收金额且与订单应付不一致时拒绝落账（改价/串单/篡改），
      // 抛错会让 provider 无限重试，故 ack + ignored 并由日志暴露给运维。
      if (event.amountCents !== undefined && Number(event.amountCents) !== Number(order.amountCents)) {
        console.error(
          `[payment] ${t0('pay.logAmountMismatch', { orderNo: order.orderNo, provider: order.provider, event: event.amountCents, order: order.amountCents })}`,
        );
        return { handled: true, action: 'ignored', orderNo: order.orderNo };
      }
      // 用订单已存的 provider_ref（下单时的会话标识）落账，避免被事件侧标识（pi_/ch_）覆盖而丢失反查依据
      const after = await markPaid(core.db, order.orderNo, order.providerRef || event.providerRef, ts);
      // 迟到/重复的 paid 事件落在已关单或退款单上：不落账也不抛错（抛错会让 provider 无限重试）。
      // 仅 pending→paid→fulfilled 正常推进；已 fulfilled 由 fulfillOrder 内部幂等短路。
      if (after.status !== OrderStatus.PAID && after.status !== OrderStatus.FULFILLED) {
        return { handled: true, action: 'ignored', orderNo: order.orderNo };
      }
      // 履约失败（如计划被硬删）不回滚已落账的 paid，也不抛错（抛错 = provider 重试风暴）；
      // 订单停在 paid 待人工补单，日志暴露给运维，对账 cron 每小时会重试同一路径。
      try {
        await fulfillOrder(core, order.orderNo, ts);
      } catch (e) {
        console.error(`[payment] ${t0('pay.logFulfillFailed', { orderNo: order.orderNo, err: e instanceof Error ? e.message : String(e) })}`);
      }
      return { handled: true, action: 'paid', orderNo: order.orderNo };
    }
    case 'refunded': {
      // 非法迁移（事件重放/单已被对账关单）不得抛错：抛错会让 provider 重试风暴并丢失 ack 语义
      try {
        await refundOrder(core.db, order.orderNo, ts);
        return { handled: true, action: 'refunded', orderNo: order.orderNo };
      } catch (e) {
        console.warn(`[payment] ${t0('pay.logRefundIgnored', { orderNo: order.orderNo, err: e instanceof Error ? e.message : String(e) })}`);
        return { handled: true, action: 'ignored', orderNo: order.orderNo };
      }
    }
    case 'failed': {
      try {
        await closeOrder(core.db, order.orderNo);
        return { handled: true, action: 'closed', orderNo: order.orderNo };
      } catch (e) {
        console.warn(`[payment] ${t0('pay.logFailIgnored', { orderNo: order.orderNo, err: e instanceof Error ? e.message : String(e) })}`);
        return { handled: true, action: 'ignored', orderNo: order.orderNo };
      }
    }
    default:
      return { handled: true, action: 'ignored', orderNo: order.orderNo };
  }
}

/**
 * webhook 分发核心：生命周期门控 + 验签 + 落账。
 * 返回值区分 HTTP 语义：missing→404、disabled→410、invalid→400（拒绝落账）、其余→200（含幂等 ack）。
 */
export async function dispatchWebhook(
  core: { db: D1b; cache: Cache },
  env: Env | undefined,
  pluginId: string,
  req: Request,
  ts: number,
): Promise<{ status: number; outcome: WebhookOutcome | { handled: false; reason: 'not-installed' | 'disabled' } }> {
  const life = await providerLifecycle(core.cache, core.db, pluginId);
  if (life === 'missing') return { status: 404, outcome: { handled: false, reason: 'not-installed' } };
  if (life === 'disabled') return { status: 410, outcome: { handled: false, reason: 'disabled' } };
  const provider = getProvider(pluginId)!;
  const cfg = await resolveProviderConfig(core.cache, core.db, env, pluginId);
  let event: ProviderEvent | null;
  try {
    event = await provider.verifyWebhook(req, cfg);
  } catch {
    event = null; // 验签异常等同失败，拒绝落账
  }
  if (!event) return { status: 400, outcome: { handled: false, reason: 'invalid-signature' } };
  const outcome = await applyProviderEvent(core, event, ts);
  return { status: 200, outcome };
}

interface ReconcileReport {
  scanned: number;
  recovered: number;
  failed: number;
}

interface StaleSweepReport {
  scanned: number;
  closed: number;
  recovered: number;
  failed: number;
}

/** 超期未付关单阈值：72h（覆盖 PayPal 订单最长有效期；Stripe Checkout 会话 24h） */
const STALE_ORDER_TTL = 72 * 3600;

/**
 * 掉单对账（cron 每小时；§15.3）：拉取近 24h pending 外部单，逐单向 provider queryOrder 复核，
 * 命中已付则补 markPaid+fulfillOrder。卡密无 provider 侧、queryOrder 缺省的通道跳过。
 */
export async function reconcilePending(
  core: { db: D1b; cache: Cache },
  env: Env | undefined,
  now: number,
): Promise<ReconcileReport> {
  const orders = await listPendingForReconcile(core.db, now - 86400);
  const report: ReconcileReport = { scanned: orders.length, recovered: 0, failed: 0 };
  for (const o of orders) {
    const provider = getProvider(o.provider);
    if (!provider?.queryOrder) continue;
    const cfg = await resolveProviderConfig(core.cache, core.db, env, o.provider);
    let state: 'pending' | 'paid' | 'failed';
    try {
      state = await provider.queryOrder(o.providerRef || o.orderNo, cfg);
    } catch {
      report.failed++;
      continue;
    }
    if (state === 'paid') {
      const ref = o.providerRef || `recon:${o.orderNo}`;
      await linkProviderRef(core.db, o.orderNo, ref);
      const after = await markPaid(core.db, o.orderNo, ref, now);
      // 单已被其它路径推进到终态（关闭/退款）：跳过履约、不计 recovered，避免抛错中断整轮对账。
      if (after.status !== OrderStatus.PAID && after.status !== OrderStatus.FULFILLED) continue;
      try {
        await fulfillOrder(core, o.orderNo, now);
        report.recovered++;
      } catch (e) {
        // 履约失败（如计划被硬删）不得中断整轮对账：记失败并保留 paid 待人工补单
        console.error(`[payment] ${t0('pay.logReconFulfillFailed', { orderNo: o.orderNo, err: e instanceof Error ? e.message : String(e) })}`);
        report.failed++;
      }
    } else if (state === 'failed') {
      await closeOrder(core.db, o.orderNo);
      report.failed++;
    }
  }
  return report;
}

/**
 * 超期关单（C5，cron 每小时，listStalePending 供单）：
 * 创建超 72h（覆盖 PayPal 订单最长有效期）且仍 pending 的外部单逐单 queryOrder 复核——
 * 已付则补 markPaid+fulfillOrder（与掉单对账同路径）；确认未付则 closeOrder 终结，
 * 杜绝「中途放弃支付」的订单永久悬挂 pending（对账窗口仅 24h，此前超窗单无人接管）。
 * queryOrder 抛错（通道故障）不关单，保留 pending 下轮重试；卡密单由 SQL 排除。
 * 无 queryOrder 能力的通道：超 72h 仍未落账即关单（迟到 paid 事件落在 closed 终态被
 * 幂等 ignored，不会重试风暴）；当前 stripe/paypal 均实现 queryOrder，此为防御分支。
 */
export async function sweepStaleOrders(
  core: { db: D1b; cache: Cache },
  env: Env | undefined,
  now: number,
): Promise<StaleSweepReport> {
  const orders = await listStalePending(core.db, now - STALE_ORDER_TTL);
  const report: StaleSweepReport = { scanned: orders.length, closed: 0, recovered: 0, failed: 0 };
  for (const o of orders) {
    const provider = getProvider(o.provider);
    let state: 'pending' | 'paid' | 'failed' | null = null;
    if (provider?.queryOrder) {
      const cfg = await resolveProviderConfig(core.cache, core.db, env, o.provider);
      try {
        state = await provider.queryOrder(o.providerRef || o.orderNo, cfg);
      } catch {
        report.failed++; // 通道故障：本轮不动，保留 pending 待下轮复核
        continue;
      }
    }
    if (state === 'paid') {
      const ref = o.providerRef || `recon:${o.orderNo}`;
      await linkProviderRef(core.db, o.orderNo, ref);
      const after = await markPaid(core.db, o.orderNo, ref, now);
      if (after.status !== OrderStatus.PAID && after.status !== OrderStatus.FULFILLED) continue;
      try {
        await fulfillOrder(core, o.orderNo, now);
        report.recovered++;
      } catch (e) {
        // 履约失败（如计划被硬删）保留 paid 待人工补单，与掉单对账口径一致
        console.error(`[payment] ${t0('pay.logReconFulfillFailed', { orderNo: o.orderNo, err: e instanceof Error ? e.message : String(e) })}`);
        report.failed++;
      }
      continue;
    }
    // pending / failed / 无 queryOrder 通道：超期未付 → 关单终结
    try {
      await closeOrder(core.db, o.orderNo);
      report.closed++;
    } catch (e) {
      console.error(`[payment] ${t0('pay.logStaleCloseFailed', { orderNo: o.orderNo, err: e instanceof Error ? e.message : String(e) })}`);
      report.failed++;
    }
  }
  return report;
}

interface RefundFlowResult {
  ok: boolean;
  /** 失败原因：API_MESSAGES 词条键（如 'pay.refundNoCreds'），路由层 t() 按站点语言翻译后返回用户 */
  reason?: string;
  order?: OrderRow;
}

/** 后台退款编排（§15.1）：通道 refund 成功（或无通道退款能力）才回写状态机 refunded。 */
export async function issueRefund(
  core: { db: D1b; cache: Cache },
  env: Env | undefined,
  orderNo: string,
  ts: number,
  t: ApiT = t0,
): Promise<RefundFlowResult> {
  const order = await getOrder(core.db, orderNo);
  if (!order) return { ok: false, reason: 'common.orderNotFound' };
  const provider = getProvider(order.provider);
  const cfg = provider ? await resolveProviderConfig(core.cache, core.db, env, order.provider) : {};
  if (provider?.refund) {
    const r = await provider.refund(order, cfg);
    if (!r.ok) return { ok: false, reason: r.reason ?? 'order.providerRefundFailed' };
  }
  const updated = await refundOrder(core.db, orderNo, ts, t);
  return { ok: true, order: updated };
}
