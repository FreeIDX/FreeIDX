/**
 * 订单状态机 + VIP 履约（T5-3，§15.1/§15.3；复用 shared 冻结契约 OrderStatus/ORDER_TRANSITIONS）。
 * 合法迁移：pending→paid→fulfilled/refunded，pending→closed，fulfilled→refunded（其余一律拒绝）。
 *  - markPaid：写入 paid_date/provider_ref；provider_ref 唯一约束 + 状态守卫 → webhook 重复回调幂等。
 *  - fulfillOrder：延长 user.vip_expire_at（从 max(now,现值) 起算 duration_days），可选发放 perks.credits，
 *    并把买家挂入计划关联组（vip_from_gid 记原组）；到期回落见 demoteExpiredVip（cron 每小时）。
 * 金额一律 INTEGER 最小货币单位；订单读写走显式投影（§7）。
 */
import { Code, LEVEL_GROUP_MIN, ORDER_TRANSITIONS, OrderStatus, type OrderStatusValue, type PayOrder } from '@freeidx/shared';
import { AppError } from '../middleware/envelope';
import { t0, type ApiT } from './i18n';
import type { D1b, Stmt } from './db';
import { creditDeltaStmts } from './points';

interface Core {
  db: D1b;
  cache: import('./cache').Cache;
}

export interface VipPlanRow {
  id: number;
  name: string;
  duration_days: number;
  price_cents: number;
  currency: string;
  perks: string;
  enabled: number;
  sort: number;
  /** 0004：履约时把买家挂入的用户组（0 = 不关联；<100 管理组禁止，见 fulfillOrder） */
  gid: number;
}

export interface OrderRow extends PayOrder {
  provider: string;
  providerRef: string;
  createdDate: number;
  paidDate: number;
  fulfilledDate: number;
}

const ORDER_COLS = 'order_no,uid,plan_id,amount_cents,currency,status,provider,provider_ref,created_date,paid_date,fulfilled_date';

/** 纯状态机：是否允许 from→to（单测全覆盖） */
export function canTransit(from: OrderStatusValue, to: OrderStatusValue): boolean {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

function assertTransit(from: OrderStatusValue, to: OrderStatusValue, t: ApiT = t0): void {
  if (!canTransit(from, to)) {
    throw new AppError(Code.VALIDATION_ERROR, t('order.badTransition', { from, to }));
  }
}

/** 订单号：FI + base36(时间ms) + 随机段（crypto 优先，回落 Math.random）；唯一索引兜底 */
export function newOrderNo(ts: number): string {
  const t = ts.toString(36);
  let rnd = '';
  try {
    const a = new Uint8Array(4);
    crypto.getRandomValues(a);
    rnd = Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('');
  } catch {
    rnd = Math.random().toString(36).slice(2, 10);
  }
  return `FI${t}${rnd}`.toUpperCase();
}

/** 订单级互斥占位 token：唯一性仅需与并发方不同（crypto 优先，回落 Math.random） */
function claimToken(): string {
  try {
    const a = new Uint8Array(8);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * 抢占 pending 单（兑换/回调编排互斥，§15.3 幂等）：
 * 以条件更新把 provider_ref 从 ''（未认领）原子置为本请求 token，changes=1 才算抢到。
 * 抢不到说明单已被处理（或已被并发请求认领）→ 返回 null，调用方据此幂等短路。
 * 抢到时返回 token；调用方在 markPaid 成功后 token 被 provider_ref 覆盖，
 * 失败（尚未消费外部资源）时用 releaseOrderClaim 释放以便用户重试。
 */
export async function claimPendingOrder(db: D1b, orderNo: string): Promise<string | null> {
  const token = `claim:${claimToken()}`;
  const r = await db
    .prepare('UPDATE bbs_order SET provider_ref = ? WHERE order_no = ? AND status = ? AND provider_ref = ?')
    .bind(token, orderNo, OrderStatus.PENDING, '')
    .run();
  return Number((r as { meta?: { changes?: number } }).meta?.changes ?? 0) > 0 ? token : null;
}

/** 释放占位（仅在尚未消费外部资源时调用，避免「卡已用掉但订单未推进」） */
export async function releaseOrderClaim(db: D1b, orderNo: string, token: string): Promise<void> {
  await db
    .prepare('UPDATE bbs_order SET provider_ref = ? WHERE order_no = ? AND status = ? AND provider_ref = ?')
    .bind('', orderNo, OrderStatus.PENDING, token)
    .run();
}

function mapOrder(r: Record<string, unknown>): OrderRow {
  return {
    orderNo: String(r.order_no),
    uid: Number(r.uid),
    planId: Number(r.plan_id),
    amountCents: Number(r.amount_cents),
    currency: String(r.currency),
    status: String(r.status) as OrderStatusValue,
    provider: String(r.provider),
    providerRef: String(r.provider_ref),
    createdDate: Number(r.created_date),
    paidDate: Number(r.paid_date),
    fulfilledDate: Number(r.fulfilled_date),
  };
}

export async function findPlan(db: D1b, planId: number): Promise<VipPlanRow | null> {
  return db
    .prepare<VipPlanRow>('SELECT id,name,duration_days,price_cents,currency,perks,enabled,sort,gid FROM bbs_vip_plan WHERE id = ?')
    .bind(planId)
    .first<VipPlanRow>();
}

export async function listEnabledPlans(db: D1b): Promise<VipPlanRow[]> {
  const r = await db
    .prepare<VipPlanRow>('SELECT id,name,duration_days,price_cents,currency,perks,enabled,sort,gid FROM bbs_vip_plan WHERE enabled = 1 ORDER BY sort ASC, id ASC')
    .all();
  return r.results;
}

/** 后台计划列表：含下架位，按 sort/id 排序（§15.4 GET /api/admin/vip/plans） */
export async function listAllPlans(db: D1b): Promise<VipPlanRow[]> {
  const r = await db
    .prepare<VipPlanRow>('SELECT id,name,duration_days,price_cents,currency,perks,enabled,sort,gid FROM bbs_vip_plan ORDER BY sort ASC, id ASC')
    .all();
  return r.results;
}

export interface PlanInput {
  name: string;
  duration_days: number;
  price_cents: number;
  currency: string;
  perks: string;
  enabled: 0 | 1;
  sort: number;
  /** 必填：bbs_group 里 gid>=100 的等级/会员组（校验在 admin 层 normalizePlan；履约挂组用） */
  gid: number;
}

/** 后台新建计划（§15.4 admin CRUD） */
export async function createPlan(db: D1b, p: PlanInput, ts: number): Promise<VipPlanRow | null> {
  await db
    .prepare(
      'INSERT INTO bbs_vip_plan (name,duration_days,price_cents,currency,perks,enabled,sort,gid,create_date) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .bind(p.name, p.duration_days, p.price_cents, p.currency, p.perks, p.enabled, p.sort, p.gid, ts)
    .run();
  const r = await db
    .prepare<VipPlanRow>('SELECT id,name,duration_days,price_cents,currency,perks,enabled,sort,gid FROM bbs_vip_plan ORDER BY id DESC LIMIT 1')
    .first<VipPlanRow>();
  return r ?? null;
}

/** 后台更新计划（整量覆盖核心字段，id 不存在返回 null） */
export async function updatePlan(db: D1b, id: number, p: PlanInput): Promise<VipPlanRow | null> {
  const exists = await db.prepare<{ id: number }>('SELECT id FROM bbs_vip_plan WHERE id = ?').bind(id).first<{ id: number }>();
  if (!exists) return null;
  await db
    .prepare('UPDATE bbs_vip_plan SET name=?,duration_days=?,price_cents=?,currency=?,perks=?,enabled=?,sort=?,gid=? WHERE id = ?')
    .bind(p.name, p.duration_days, p.price_cents, p.currency, p.perks, p.enabled, p.sort, p.gid, id)
    .run();
  return findPlan(db, id);
}

/** 后台删除计划（硬删；订单历史保留 plan_id 引用不受影响） */
export async function deletePlan(db: D1b, id: number): Promise<boolean> {
  const exists = await db.prepare<{ id: number }>('SELECT id FROM bbs_vip_plan WHERE id = ?').bind(id).first<{ id: number }>();
  if (!exists) return false;
  await db.prepare('DELETE FROM bbs_vip_plan WHERE id = ?').bind(id).run();
  return true;
}

/** 后台订单列表：可选状态过滤 + 分页（§15.4 GET /api/admin/orders，有界 LIMIT 守预算） */
export async function listOrdersForAdmin(
  db: D1b,
  opts: { status?: OrderStatusValue; limit: number; offset: number },
): Promise<OrderRow[]> {
  const params: (string | number)[] = [];
  let where = '';
  if (opts.status) {
    where = ' WHERE status = ?';
    params.push(opts.status);
  }
  const r = await db
    .prepare<Record<string, unknown>>(`SELECT ${ORDER_COLS} FROM bbs_order${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .bind(...params, opts.limit, opts.offset)
    .all();
  return r.results.map(mapOrder);
}

export async function getOrder(db: D1b, orderNo: string): Promise<OrderRow | null> {
  const r = await db.prepare<Record<string, unknown>>(`SELECT ${ORDER_COLS} FROM bbs_order WHERE order_no = ?`).bind(orderNo).first<Record<string, unknown>>();
  return r ? mapOrder(r) : null;
}

/** webhook 落账定位：按 provider_ref 反查订单（provider_ref 唯一索引，一 ref 至多一单） */
export async function getOrderByProviderRef(db: D1b, providerRef: string): Promise<OrderRow | null> {
  if (!providerRef) return null;
  const r = await db
    .prepare<Record<string, unknown>>(`SELECT ${ORDER_COLS} FROM bbs_order WHERE provider_ref = ?`)
    .bind(providerRef)
    .first<Record<string, unknown>>();
  return r ? mapOrder(r) : null;
}

/** 掉单对账候选：近 sinceTs 内、已指定通道且非卡密、仍 pending 的订单（§15.3 cron 每小时拉取） */
export async function listPendingForReconcile(db: D1b, sinceTs: number, limit = 100): Promise<OrderRow[]> {
  const r = await db
    .prepare<Record<string, unknown>>(
      `SELECT ${ORDER_COLS} FROM bbs_order WHERE status = ? AND provider <> '' AND provider <> 'card' AND created_date >= ? ORDER BY id ASC LIMIT ?`,
    )
    .bind(OrderStatus.PENDING, sinceTs, limit)
    .all();
  return r.results.map(mapOrder);
}

/**
 * 超期 pending 外部订单：创建早于 beforeTs 且仍 pending 的非卡密单（C5 超时关单候选）。
 * 支付渠道会话有效期远短于此（Stripe Checkout 24h、PayPal order 数天），超期仍未支付即不可再付；
 * 由对账 cron 逐单复核（付费则补单，否则关单），避免中途放弃支付的订单永久停留 pending。
 * ORDER BY id ASC + LIMIT：老单优先处理，余量下轮继续。
 */
export async function listStalePending(db: D1b, beforeTs: number, limit = 100): Promise<OrderRow[]> {
  const r = await db
    .prepare<Record<string, unknown>>(
      `SELECT ${ORDER_COLS} FROM bbs_order WHERE status = ? AND provider <> '' AND provider <> 'card' AND created_date < ? ORDER BY id ASC LIMIT ?`,
    )
    .bind(OrderStatus.PENDING, beforeTs, limit)
    .all();
  return r.results.map(mapOrder);
}

/** 下单：读取计划价、落 pending 订单（provider 由上层支付装配补充） */
export async function createOrder(
  core: Core,
  args: { uid: number; plan: VipPlanRow; provider: string; ts: number },
): Promise<OrderRow> {
  const orderNo = newOrderNo(args.ts);
  await core.db
    .prepare(
      'INSERT INTO bbs_order (order_no,uid,plan_id,amount_cents,currency,status,provider,created_date) VALUES (?,?,?,?,?,?,?,?)',
    )
    .bind(orderNo, args.uid, args.plan.id, args.plan.price_cents, args.plan.currency, OrderStatus.PENDING, args.provider, args.ts)
    .run();
  return {
    orderNo,
    uid: args.uid,
    planId: args.plan.id,
    amountCents: args.plan.price_cents,
    currency: args.plan.currency,
    status: OrderStatus.PENDING,
    provider: args.provider,
    providerRef: '',
    createdDate: args.ts,
    paidDate: 0,
    fulfilledDate: 0,
  };
}

/**
 * 置为已付：pending→paid。幂等：
 *  - 已是 paid/fulfilled → 直接返回（重复回调）；
 *  - provider_ref 命中唯一约束 → 视为重复回调，返回当前订单（不落错账）。
 */
export async function markPaid(db: D1b, orderNo: string, providerRef: string, ts: number, t: ApiT = t0): Promise<OrderRow> {
  const order = await getOrder(db, orderNo);
  if (!order) throw new AppError(Code.NOT_FOUND, t('common.orderNotFound'));
  if (order.status !== OrderStatus.PENDING) return order; // 已处理，幂等
  assertTransit(order.status, OrderStatus.PAID, t);
  try {
    await db
      .prepare('UPDATE bbs_order SET status = ?, paid_date = ?, provider_ref = ? WHERE order_no = ? AND status = ?')
      .bind(OrderStatus.PAID, ts, providerRef, orderNo, OrderStatus.PENDING)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed: bbs_order.provider_ref/i.test(msg)) {
      // provider_ref 撞唯一约束有两种可能：同一单重复回调（status 守卫已在上面早退，走不到这里），
      // 或两个订单共享同一外部引用（串单/通道重复建单）——后者是异常，必须日志暴露，
      // 否则本订单静默停留 pending（编排层见 status!==paid 即 ignored），运维无从发现。
      console.warn(`[order] ${t('pay.logMarkPaidDup', { orderNo, providerRef })}`);
      const again = await getOrder(db, orderNo);
      if (again) return again;
    }
    throw e;
  }
  const updated = await getOrder(db, orderNo);
  if (!updated) throw new AppError(Code.SYSTEM_ERROR, t('order.statusUpdateFailed'));
  return updated;
}

/** 履约：paid→fulfilled。延长 vip_expire_at，发放可选 perks.credits，回写 fulfilled_date。 */
export async function fulfillOrder(core: Core, orderNo: string, ts: number, t: ApiT = t0): Promise<OrderRow> {
  const order = await getOrder(core.db, orderNo);
  if (!order) throw new AppError(Code.NOT_FOUND, t('common.orderNotFound'));
  if (order.status === OrderStatus.FULFILLED) return order; // 幂等
  assertTransit(order.status, OrderStatus.FULFILLED, t);
  const plan = await findPlan(core.db, order.planId);
  // 计划被硬删（deletePlan）后仍可能收到 paid 事件/对账：此时若继续翻转状态，
  // 会得到「已履约但 VIP 时长=0、perks=0、未挂组」的不可逆空履约（refunded 是终态迁移）。
  // 故阻断履约，保持 paid 待人工补单（调用方记录日志，对账下一轮会重试同一路径）。
  if (!plan) throw new AppError(Code.SYSTEM_ERROR, t('order.planMissing'));
  const durationDays = Number(plan.duration_days ?? 0);
  const credits = perksCredits(plan.perks);

  // 先以「paid→fulfilled」条件更新占位：只有真正把行从 paid 翻成 fulfilled 的那一次（meta.changes>0）才发放权益。
  // 并发/重复的 paid 事件（webhook 重试、Stripe across isolates）翻不动 → 幂等返回，绝不二次延长 VIP。
  const flip = await core.db
    .prepare('UPDATE bbs_order SET status = ?, fulfilled_date = ? WHERE order_no = ? AND status = ?')
    .bind(OrderStatus.FULFILLED, ts, orderNo, OrderStatus.PAID)
    .run();
  if (Number(flip.meta?.changes ?? 0) === 0) {
    const cur = await getOrder(core.db, orderNo);
    if (cur) return cur; // 已被他方履约/关单/退款：交由状态机兜底，不重复发放
    throw new AppError(Code.SYSTEM_ERROR, t('order.fulfillFailed'));
  }
  // 发放语句（VIP 续期 + 挂组 + perks 积分）合入单一 DB.batch() 事务：
  //  - 要么全部生效、要么全部回滚，杜绝「VIP 延长了但积分没到账」的半履约；
  //  - 发放整批失败时下方回滚状态翻转，订单留在 paid——webhook 重试/对账/后台 /settle 可重新履约，
  //    杜绝「已 fulfilled 但权益永久缺失」（FULFILLED 幂等早退会挡死一切补发路径）。
  try {
    const stmts: Stmt[] = [];
    if (durationDays > 0) {
      // 续期基于 max(现值, now)，未过期用户叠加、过期用户从当下起算
      stmts.push(
        core.db
          .prepare('UPDATE bbs_user SET vip_expire_at = MAX(vip_expire_at, ?) + ? WHERE uid = ?')
          .bind(ts, durationDays * 86400, order.uid),
      );
    }
    // 挂组（0004/0005）：会员体系与用户组合一——履约即把买家挂入计划关联组（gid>=100）；
    // 首次挂组用 CASE 记下原组到 vip_from_gid（续费/换组不覆盖），到期由 cron demoteExpiredVip 回落；
    // `gid >= ? AND gid < ?` 守卫：① 管理组（<100）不受购买影响，防误配提权；② 禁止把更高等级用户降级到低等级组。
    const targetGid = Math.trunc(Number(plan.gid ?? 0));
    if (targetGid >= LEVEL_GROUP_MIN) {
      stmts.push(
        core.db
          .prepare(
            'UPDATE bbs_user SET gid = ?, vip_from_gid = CASE WHEN vip_from_gid > 0 THEN vip_from_gid ELSE gid END WHERE uid = ? AND gid >= ? AND gid < ?',
          )
          .bind(targetGid, order.uid, LEVEL_GROUP_MIN, targetGid),
      );
    }
    if (credits > 0) {
      // perks.credits 发放与挂组同批（bizKey 唯一：重复发放整批回滚，幂等由本函数入口守卫）
      stmts.push(
        ...creditDeltaStmts(core, { uid: order.uid, creditType: 1, change: credits, reason: 'order', bizKey: `order:${orderNo}`, ts }),
      );
    }
    if (stmts.length) await core.db.batch(stmts);
  } catch (e) {
    // 回滚翻转（fulfilled→paid）：条件守卫 status=FULFILLED，不误伤并发退款（refunded 终态）。
    // 回滚自身失败（D1 持续故障）只记错误不掩盖原始异常——订单停留 fulfilled 与旧行为一致，不更糟。
    try {
      await core.db
        .prepare('UPDATE bbs_order SET status = ?, fulfilled_date = 0 WHERE order_no = ? AND status = ?')
        .bind(OrderStatus.PAID, orderNo, OrderStatus.FULFILLED)
        .run();
    } catch (rb) {
      console.error('[order] fulfill rollback failed:', rb instanceof Error ? rb.message : rb);
    }
    throw e;
  }
  // 履约改了 vip_expire_at / gid：user:{uid} 缓存（loadViewer，L0+L2/30s）必须立即失效，
  // 否则买家在缓存窗口内仍是旧组（会员组权限/下载等权益不一致）。
  await core.cache.del(`user:${order.uid}`);
  const updated = await getOrder(core.db, orderNo);
  if (!updated) throw new AppError(Code.SYSTEM_ERROR, t('order.fulfillFailed'));
  return updated;
}

/**
 * 会员到期回落（0005）：把 vip_from_gid>0 且会员已过期的挂组用户降回原组并清标记（闭环「到期=出组」）。
 * `gid >= ?` 守卫：期间被管理员调去管理组（<100）的用户跳过，不覆盖人工配置。
 * 返回被处理的行（cron 侧按 uid 清 user:{uid} 缓存）；单轮 limit 防爆量，余量下轮 cron 继续。
 */
export async function demoteExpiredVip(
  db: D1b,
  ts: number,
  limit = 200,
): Promise<{ uid: number; fromGid: number }[]> {
  const res = await db
    .prepare<{ uid: number; vip_from_gid: number }>(
      'SELECT uid, vip_from_gid FROM bbs_user WHERE vip_from_gid > 0 AND vip_expire_at > 0 AND vip_expire_at < ? AND gid >= ? LIMIT ?',
    )
    .bind(ts, LEVEL_GROUP_MIN, limit)
    .all();
  const rows = res.results ?? [];
  for (const r of rows) {
    // UPDATE 复查 SELECT 全部条件（TOCTOU 防护）：SELECT 与 UPDATE 之间可能发生续费
    // （vip_expire_at 被顺延到未来）或管理员调组（gid < 100），此时绝不可降级。
    await db
      .prepare(
        'UPDATE bbs_user SET gid = ?, vip_from_gid = 0 WHERE uid = ? AND vip_from_gid > 0 AND vip_expire_at > 0 AND vip_expire_at < ? AND gid >= ?',
      )
      .bind(Number(r.vip_from_gid), Number(r.uid), ts, LEVEL_GROUP_MIN)
      .run();
  }
  return rows.map((r) => ({ uid: Number(r.uid), fromGid: Number(r.vip_from_gid) }));
}

/**
 * 退款：paid/fulfilled→refunded。回滚已发放权益：
 *  - 扣回 perks.credits（写退款流水留痕）；
 *  - 扣回本订单增加的 VIP 时长（按计划 duration_days 回退）；
 *  - 会员因此过期时立即回落到 vip_from_gid 原组（不必等 cron）。
 * 冻结 schema 无 refunded_date 列（G1），故不落退款时刻，仅回写状态。
 */
export async function refundOrder(db: D1b, orderNo: string, ts: number, t: ApiT = t0): Promise<OrderRow> {
  const order = await getOrder(db, orderNo);
  if (!order) throw new AppError(Code.NOT_FOUND, t('common.orderNotFound'));
  if (order.status === OrderStatus.REFUNDED) return order;
  assertTransit(order.status, OrderStatus.REFUNDED, t);

  // 先条件翻转状态抢锁：并发重复退款（后台双击 + webhook 重试）只有一次 changes>0，
  // 后续请求直接返回，不会二次扣回积分/时长。
  const flip = await db
    .prepare('UPDATE bbs_order SET status = ? WHERE order_no = ? AND status IN (?, ?)')
    .bind(OrderStatus.REFUNDED, orderNo, OrderStatus.PAID, OrderStatus.FULFILLED)
    .run();
  if (Number(flip.meta?.changes ?? 0) === 0) {
    const cur = await getOrder(db, orderNo);
    if (cur) return cur;
    throw new AppError(Code.SYSTEM_ERROR, t('order.refundFailed'));
  }

  const plan = await findPlan(db, order.planId);
  const stmts: Stmt[] = [];
  const days = Number(plan?.duration_days ?? 0);
  if (days > 0) {
    // 履约时按 duration_days 延长，退款等额扣回（余额不为负，最多扣到 0）
    stmts.push(
      db.prepare('UPDATE bbs_user SET vip_expire_at = MAX(0, vip_expire_at - ?) WHERE uid = ?').bind(days * 86400, order.uid),
    );
  }
  const credits = perksCredits(plan?.perks ?? '');
  if (credits > 0) {
    stmts.push(
      ...creditDeltaStmts(
        { db },
        { uid: order.uid, creditType: 1, change: -credits, reason: 'order', bizKey: `refund:${orderNo}`, ts },
      ),
    );
  }
  // 退款后会员已过期：立即回落原组（gid>=100 守卫避免覆盖管理员手动调组；vip_from_gid 记的是首购前原组）
  stmts.push(
    db
      .prepare(
        'UPDATE bbs_user SET gid = vip_from_gid, vip_from_gid = 0 WHERE uid = ? AND vip_from_gid > 0 AND vip_expire_at > 0 AND vip_expire_at <= ? AND gid >= ?',
      )
      .bind(order.uid, ts, LEVEL_GROUP_MIN),
  );
  try {
    if (stmts.length) await db.batch(stmts);
  } catch (e) {
    // 权益回收整批失败（原子）：把状态退回退款前，便于后台重试；避免「已退款但权益未回收」
    await db
      .prepare('UPDATE bbs_order SET status = ? WHERE order_no = ? AND status = ?')
      .bind(order.status, orderNo, OrderStatus.REFUNDED)
      .run();
    throw e;
  }

  const updated = await getOrder(db, orderNo);
  if (!updated) throw new AppError(Code.SYSTEM_ERROR, t('order.refundFailed'));
  return updated;
}

/** 关单：pending→closed（超时/取消）。 */
export async function closeOrder(db: D1b, orderNo: string, t: ApiT = t0): Promise<OrderRow> {
  const order = await getOrder(db, orderNo);
  if (!order) throw new AppError(Code.NOT_FOUND, t('common.orderNotFound'));
  if (order.status === OrderStatus.CLOSED) return order;
  assertTransit(order.status, OrderStatus.CLOSED, t);
  await db.prepare('UPDATE bbs_order SET status = ? WHERE order_no = ? AND status = ?').bind(OrderStatus.CLOSED, orderNo, OrderStatus.PENDING).run();
  const updated = await getOrder(db, orderNo);
  if (!updated) throw new AppError(Code.SYSTEM_ERROR, t('order.closeFailed'));
  return updated;
}

export function perksCredits(perks: string | undefined): number {
  if (!perks) return 0;
  try {
    const p = JSON.parse(perks) as { credits?: unknown };
    return Math.max(0, Math.floor(Number(p.credits ?? 0)) || 0);
  } catch {
    return 0;
  }
}
