/**
 * 后台支付管理（T5-7，§15.4）：VIP 计划 CRUD、订单查询/退款/补单、卡密批量生成与列表。
 * 挂载于 adminGuard 之后（已强制 gid=1）。通道启停/密钥配置不在此，统一走 §15.4 通用 /api/admin/extensions/{id}。
 * 私钥永不回显；退款编排复用 payment-core issueRefund（通道退款 + 状态机回写），补单复用状态机 markPaid/fulfillOrder（幂等）。
 */
import { Hono } from 'hono';
import { Code, LEVEL_GROUP_MIN, type ApiKey, type OrderStatusValue } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { D1b } from '../../core/db';
import type { Cache } from '../../core/cache';
import {
  createPlan,
  deletePlan,
  findPlan,
  fulfillOrder,
  listAllPlans,
  listOrdersForAdmin,
  markPaid,
  updatePlan,
  type OrderRow,
  type PlanInput,
  type VipPlanRow,
} from '../../core/order';
import { issueRefund } from '../../core/payment/orchestrator';
import { deleteCards, generateCards, listCards, voidCards } from '../../extensions/card';
import type { ApiT } from '../../core/i18n';
import { intParam, readJsonObject, type ReadEnv } from '../shared';

const nowSec = (): number => Math.floor(Date.now() / 1000);

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
    enabled: Number(p.enabled),
    sort: Number(p.sort),
    gid: Number(p.gid ?? 0),
  };
}

function orderDto(o: OrderRow): Record<string, unknown> {
  return {
    order_no: o.orderNo,
    uid: o.uid,
    plan_id: o.planId,
    amount_cents: o.amountCents,
    currency: o.currency,
    status: o.status,
    provider: o.provider,
    provider_ref: o.providerRef,
    created_date: o.createdDate,
    paid_date: o.paidDate,
    fulfilled_date: o.fulfilledDate,
  };
}

/** 规范化计划入参（新建/更新共用）：金额/天数为非负整数，币种大写，perks 序列化 JSON；
 *  gid（0004/0005）**必填**：须为 bbs_group 里 gid>=100 的等级/会员组——管理组（<100）禁选，防购买提权；
 *  会员体系与用户组合一：开通=挂组、到期=cron 回落，故不允许「不关联」的计划。 */
async function normalizePlan(db: D1b, body: Record<string, unknown>, t: ApiT): Promise<PlanInput> {
  const name = String(body.name ?? '').trim();
  if (!name) throw new AppError(Code.VALIDATION_ERROR, t('admin.planNameRequired'));
  const duration_days = Math.trunc(Number(body.duration_days ?? 0));
  const price_cents = Math.trunc(Number(body.price_cents ?? 0));
  if (!Number.isFinite(duration_days) || duration_days < 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.planDurationInvalid'));
  if (!Number.isFinite(price_cents) || price_cents < 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.planPriceInvalid'));
  const currency = String(body.currency ?? 'CNY').trim().toUpperCase() || 'CNY';
  let perks = '{}';
  if (body.perks !== undefined) {
    if (typeof body.perks === 'string') perks = body.perks;
    else if (body.perks && typeof body.perks === 'object') perks = JSON.stringify(body.perks);
  }
  const enabled = body.enabled === 0 || body.enabled === '0' || body.enabled === false ? 0 : 1;
  const sort = Math.trunc(Number(body.sort ?? 0)) || 0;
  const gid = Math.trunc(Number(body.gid ?? 0)) || 0;
  if (gid < LEVEL_GROUP_MIN) throw new AppError(Code.VALIDATION_ERROR, t('admin.planGidInvalid'));
  const g = await db.prepare<{ gid: number }>('SELECT gid FROM bbs_group WHERE gid = ?').bind(gid).first<{ gid: number }>();
  if (!g) throw new AppError(Code.VALIDATION_ERROR, t('admin.planGroupNotFound'));
  return { name, duration_days, price_cents, currency, perks, enabled: enabled as 0 | 1, sort, gid };
}

const STATUSES = new Set<OrderStatusValue>(['pending', 'paid', 'fulfilled', 'refunded', 'closed']);

export function adminPaymentRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  // —— VIP 计划 CRUD（§15.4 /api/admin/vip/*）——
  app.get('/api/admin/vip/plans', async (c) => {
    const { db } = { db: c.get('db') as D1b };
    const plans = await listAllPlans(db);
    return ok(c, 'ok', { data: { list: plans.map(planDto) } });
  });

  app.post('/api/admin/vip/plans', async (c) => {
    const db = c.get('db') as D1b;
    const t = c.get('t');
    const body = await readJsonObject(c);
    const input = await normalizePlan(db, body, t);
    const row = await createPlan(db, input, nowSec());
    return ok(c, t('common.created'), { data: row ? planDto(row) : null });
  });

  app.put('/api/admin/vip/plans/:id', async (c) => {
    const db = c.get('db') as D1b;
    const t = c.get('t');
    const id = intParam(c.req.param('id'));
    if (id <= 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.idInvalid'));
    const body = await readJsonObject(c);
    const input = await normalizePlan(db, body, t);
    const row = await updatePlan(db, id, input);
    if (!row) throw new AppError(Code.NOT_FOUND, t('common.planNotFound'));
    return ok(c, t('common.updated'), { data: planDto(row) });
  });

  app.delete('/api/admin/vip/plans/:id', async (c) => {
    const db = c.get('db') as D1b;
    const t = c.get('t');
    const id = intParam(c.req.param('id'));
    if (id <= 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.idInvalid'));
    const removed = await deletePlan(db, id);
    if (!removed) throw new AppError(Code.NOT_FOUND, t('common.planNotFound'));
    return ok(c, t('common.deleted'), { data: { id } });
  });

  // —— 订单查询 + 退款/补单（§15.4 /api/admin/orders）——
  app.get('/api/admin/orders', async (c) => {
    const db = c.get('db') as D1b;
    const t = c.get('t');
    const status = c.req.query('status');
    if (status && !STATUSES.has(status as OrderStatusValue)) throw new AppError(Code.VALIDATION_ERROR, t('admin.statusInvalid'));
    const size = Math.min(100, Math.max(1, intParam(c.req.query('size'), 20)));
    const page = Math.max(1, intParam(c.req.query('page'), 1));
    const list = await listOrdersForAdmin(db, {
      status: status as OrderStatusValue | undefined,
      limit: size,
      offset: (page - 1) * size,
    });
    return ok(c, 'ok', { data: { list: list.map(orderDto), page, size } });
  });

  // 退款：编排通道退款（如 Stripe refund）成功后回写 refunded；通道无退款能力则仅回写状态机
  app.post('/api/admin/orders/:no/refund', async (c) => {
    const core = { db: c.get('db') as D1b, cache: c.get('cache') as Cache };
    const t = c.get('t');
    const orderNo = c.req.param('no') ?? '';
    if (!orderNo) throw new AppError(Code.VALIDATION_ERROR, t('pay.orderNoRequired'));
    const r = await issueRefund(core, c.env, orderNo, nowSec(), t);
    if (!r.ok) throw new AppError(Code.VALIDATION_ERROR, t((r.reason ?? 'order.refundDenied') as ApiKey));
    return ok(c, t('admin.refundDone'), { data: orderDto(r.order!) });
  });

  // 人工补单：管理员确认收款后，pending→paid→fulfilled（幂等，复用状态机；provider_ref 记 manual 前缀避免与通道冲突）
  app.post('/api/admin/orders/:no/settle', async (c) => {
    const core = { db: c.get('db') as D1b, cache: c.get('cache') as Cache };
    const t = c.get('t');
    const orderNo = c.req.param('no') ?? '';
    if (!orderNo) throw new AppError(Code.VALIDATION_ERROR, t('pay.orderNoRequired'));
    const ts = nowSec();
    await markPaid(core.db, orderNo, `manual:${orderNo}`, ts, t);
    const fulfilled = await fulfillOrder(core, orderNo, ts, t);
    return ok(c, t('admin.replenishDone'), { data: orderDto(fulfilled) });
  });

  // —— 卡密批量生成/列表/作废/删除（§15.4 /api/admin/cards）——
  app.get('/api/admin/cards', async (c) => {
    const db = c.get('db') as D1b;
    const batchNo = c.req.query('batch');
    const statusQ = c.req.query('status');
    let status: 0 | 1 | 2 | undefined;
    if (statusQ === '0' || statusQ === '1' || statusQ === '2') status = Number(statusQ) as 0 | 1 | 2;
    const size = Math.min(200, Math.max(1, intParam(c.req.query('size'), 50)));
    const page = Math.max(1, intParam(c.req.query('page'), 1));
    const list = await listCards(db, { batchNo, status, limit: size, offset: (page - 1) * size });
    return ok(c, 'ok', { data: { list, page, size } });
  });

  app.post('/api/admin/cards', async (c) => {
    const db = c.get('db') as D1b;
    const t = c.get('t');
    const body = await readJsonObject(c);
    const planId = intParam(String(body.planId ?? body.plan_id ?? ''));
    if (planId <= 0) throw new AppError(Code.VALIDATION_ERROR, t('order.planRequired'));
    const plan = await findPlan(db, planId);
    if (!plan) throw new AppError(Code.NOT_FOUND, t('common.planNotFound'));
    const count = Math.trunc(Number(body.count ?? 1));
    if (!Number.isFinite(count) || count < 1 || count > 200) throw new AppError(Code.VALIDATION_ERROR, t('admin.countInvalid'));
    const expireDate = Math.trunc(Number(body.expire_date ?? 0)) || 0;
    const batchNo = String(body.batch_no ?? '').trim() || `B${nowSec().toString(36).toUpperCase()}`;
    const cards = await generateCards(db, { planId, count, batchNo, expireDate }, nowSec());
    return ok(c, t('admin.cardGenDone'), { data: { batch_no: batchNo, count: cards.length, cards } });
  });

  /** 批量操作公共入参：ids 需为非空数字数组（上限 200，与单次生成对齐） */
  const parseCardIds = (body: Record<string, unknown>, t: ApiT): number[] => {
    const raw = Array.isArray(body.ids) ? body.ids : [];
    const ids = [...new Set(raw.map((x) => Math.trunc(Number(x))).filter((x) => Number.isInteger(x) && x > 0))];
    if (!ids.length || ids.length > 200) throw new AppError(Code.VALIDATION_ERROR, t('admin.idsInvalid'));
    return ids;
  };

  // 作废：仅未使用卡可作废（status 0→2），已使用卡返回中会被跳过并回告实际张数
  app.post('/api/admin/cards/void', async (c) => {
    const db = c.get('db') as D1b;
    const t = c.get('t');
    const body = await readJsonObject(c);
    const ids = parseCardIds(body, t);
    const voided = await voidCards(db, ids, nowSec());
    return ok(c, t('admin.cardVoidDone'), { data: { voided } });
  });

  // 删除：仅未使用/已作废卡可删，已使用卡保留账目（SQL 条件跳过），回告实际张数
  app.post('/api/admin/cards/delete', async (c) => {
    const db = c.get('db') as D1b;
    const t = c.get('t');
    const body = await readJsonObject(c);
    const ids = parseCardIds(body, t);
    const deleted = await deleteCards(db, ids);
    return ok(c, t('admin.cardDeleteDone'), { data: { deleted } });
  });

  return app;
}
