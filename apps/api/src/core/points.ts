/**
 * 积分账本原语（T5-1，§15.1/§15.3）+ 多币种扩展（tt_credits）：
 *  - credits(经验)/golds(金币)/rmbs(人民币·分) 三币种列白名单；credits 必须经本模块写 point_log 流水，
 *    禁止裸改 user.credits；golds/rmbs 无账本表，只记 bbs_user_pay 业务流水（由业务模块同批写入）。
 *  - 余额更新 + 流水同批 DB.batch() 事务（相对值 `credits = credits + ?`，并发写不丢账）。
 *  - biz_key 唯一索引（uid,biz_key）保证幂等：重复发放整批回滚，grant 至多生效一次。
 *  - 规则数值存 kv 'tt_credits'（后台「积分」页可配），未配置时经验两项镜像旧三键、其余 0=关闭。
 *  - 发放入口挂在 post:created 生命周期点（与自动升组同钩子链，见 modules/write）。
 */
import type { SiteSetting } from '@freeidx/shared';
import type { D1b, Stmt } from './db';
import type { Cache } from './cache';
import { remember } from './cache';
import { loadGrouplist, loadSetting } from './loaders';
import { resolveCreditsUpgrade, type GroupForAccess } from './access';
import { t0, type ApiT } from './i18n';

interface Core {
  db: D1b;
  cache: Cache;
}

type PointReason =
  | 'thread'
  | 'reply'
  | 'daily_first'
  | 'attach_purchase'
  | 'attach_income'
  | 'order'
  | 'admin'
  | 'register'
  /* tt_credits 业务 */
  | 'thread_purchase'
  | 'thread_income'
  | 'transfer_out'
  | 'transfer_in'
  | 'digest'
  | 'checkin'
  /* v 认证申请扣费（v/routes.ts 直写 point_log，reason='v_apply'） */
  | 'v_apply';

/** UTC 日序号（每日首帖/每日加分上限幂等键用） */
export function dayNo(ts: number): number {
  return Math.floor(ts / 86400);
}

/** 三币种（tt_credits credit_type → 用户表列名）：白名单映射，杜绝列名拼接注入 */
const CREDIT_TYPE_COL: Record<number, 'credits' | 'golds' | 'rmbs'> = {
  1: 'credits',
  2: 'golds',
  3: 'rmbs',
};
/** 三币种展示名（按站点语言取词；type 非法回落 t('credit.credits')） */
export function creditTypeLabel(t: ApiT, type: number): string {
  const n = Number(type);
  if (n === 1) return t('credit.exp');
  if (n === 2) return t('credit.gold');
  if (n === 3) return t('credit.rmb');
  return t('credit.credits');
}

export function creditTypeCol(t: number): 'credits' | 'golds' | 'rmbs' | null {
  return CREDIT_TYPE_COL[Number(t)] ?? null;
}

export interface PointChange {
  uid: number;
  change: number; // 正=入账，负=扣减
  reason: PointReason;
  bizKey: string; // 幂等键；重复提交同键则整批跳过
  ts: number;
}

/** 多币种相对变动的公共参数（tt_credits 三币种共用；golds/rmbs 忽略 reason/bizKey） */
interface CreditDelta {
  uid: number;
  creditType: number;
  change: number;
  reason: PointReason;
  bizKey: string;
  ts: number;
}

/**
 * 生成「余额相对变动」语句组（供调用方合入业务批次，保证余额与业务流水同事务）：
 *  - credits：UPDATE 余额 + INSERT point_log（balance 取更新后值，同批同事务）；
 *  - golds/rmbs：仅 UPDATE 余额（这两列无账本表）。
 */
export function creditDeltaStmts(core: { db: D1b }, p: CreditDelta): Stmt[] {
  const col = creditTypeCol(p.creditType);
  if (!col) throw new Error(t0('credit.unsupportedType', { type: p.creditType }));
  if (p.change === 0) return [];
  if (col !== 'credits') {
    return [
      core.db.prepare(`UPDATE bbs_user SET ${col} = ${col} + ? WHERE uid = ?`).bind(p.change, p.uid) as unknown as Stmt,
    ];
  }
  return [
    core.db.prepare('UPDATE bbs_user SET credits = credits + ? WHERE uid = ?').bind(p.change, p.uid) as unknown as Stmt,
    core.db
      .prepare(
        `INSERT INTO bbs_point_log (uid, change, balance, reason, biz_key, create_date)
         SELECT uid, ?, credits, ?, ?, ? FROM bbs_user WHERE uid = ?`,
      )
      .bind(p.change, p.reason, p.bizKey, p.ts, p.uid) as unknown as Stmt,
  ];
}

/**
 * 余额更新 + 流水同批事务（credits）。流水 balance 取 UPDATE 之后的 user.credits（batch 内顺序执行、同一事务）。
 * biz_key 冲突（重复发放）时 D1 batch 原子回滚 UPDATE，捕获唯一约束错误 → granted:false（幂等跳过），
 * 不影响业务写事务（发放发生在内容已提交之后）。
 */
export async function applyPointChange(core: Core, p: PointChange): Promise<boolean> {
  return applyCreditDelta(core, { ...p, creditType: 1 });
}

/** 多币种版 applyPointChange（credits 幂等同 applyPointChange；golds/rmbs 无幂等键，业务侧自守卫） */
async function applyCreditDelta(core: Core, p: CreditDelta): Promise<boolean> {
  const stmts = creditDeltaStmts(core, p);
  if (!stmts.length) return false;
  try {
    await core.db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed: bbs_point_log/i.test(msg)) return false;
    throw e;
  }
  return true;
}

type ChargeResult = 'charged' | 'already' | 'insufficient' | 'free';

interface ChargeArgs {
  uid: number;
  price: number;
  reason: PointReason;
  bizKey: string;
  ts: number;
  /** 币种（tt_credits：默认 1=经验；2=金币 3=人民币 走余额直扣，无 point_log 账本） */
  creditType?: number;
  /** 入账对象（如付费附件的上传者/主题作者）；与买家不同则等额充值 */
  incomeTo?: number;
  /** 入账流水 reason（默认 attach_income；主题购买用 thread_income） */
  incomeReason?: PointReason;
  /**
   * 附加守卫（同事务跨语句条件，如购买主题要求 paylist 行已插入——D1 batch 内前序语句对本语句可见）：
   * SQL 片段（不含前导 AND）+ 绑定参数，追加到扣减语句的 WHERE 尾部。
   */
  guardSql?: string;
  guardParams?: (number | string)[];
}

/**
 * 扣减入账（付费消费）——单批语句，同时具备幂等锁与透支锁：
 *  ① credits：INSERT...SELECT 仅在 credits >= price（且附加守卫成立）时写流水（balance=扣减后余额），
 *     biz_key 唯一 → 重复购买整批回滚；② UPDATE 带 `credits >= price`（+守卫）扣减，余额不足则 0 行变更。
 *  golds/rmbs：仅 ② 同款守卫 UPDATE（这两列无账本，幂等由业务侧唯一键/前置查重保证）。
 * 要点：二者同处一个 DB.batch() 事务——要么「扣减+流水」全部生效，要么全部不生效，杜绝丢账与重复扣款。
 */
export async function chargePoints(core: Core, p: ChargeArgs): Promise<ChargeResult> {
  if (p.price <= 0) return 'free';
  const col = creditTypeCol(p.creditType ?? 1);
  if (!col) throw new Error(t0('credit.unsupportedType', { type: String(p.creditType) }));
  const guard = p.guardSql ? ` AND ${p.guardSql}` : '';
  const gparams = p.guardParams ?? [];
  // 入账对象：与买家不同才需要转账；入账方在扣款同一事务内二次校验存在性，
  // 杜绝「买家已扣、卖家已注销 → 入账 0 行」的丢款。
  const incomeTo = p.incomeTo && p.incomeTo > 0 && p.incomeTo !== p.uid ? p.incomeTo : 0;
  const incomeGuard = incomeTo ? ' AND EXISTS (SELECT 1 FROM bbs_user WHERE uid = ?)' : '';
  const payParams = [...gparams, ...(incomeTo ? [incomeTo] : [])];
  const stmts: Stmt[] = [];
  if (col === 'credits') {
    stmts.push(
      core.db
        .prepare(
          `INSERT INTO bbs_point_log (uid, change, balance, reason, biz_key, create_date)
           SELECT uid, ?, credits - ?, ?, ?, ? FROM bbs_user WHERE uid = ? AND credits >= ?${guard}${incomeGuard}`,
        )
        .bind(-p.price, p.price, p.reason, p.bizKey, p.ts, p.uid, p.price, ...payParams) as unknown as Stmt,
      core.db
        .prepare(`UPDATE bbs_user SET credits = credits - ? WHERE uid = ? AND credits >= ?${guard}${incomeGuard}`)
        .bind(p.price, p.uid, p.price, ...payParams) as unknown as Stmt,
    );
  } else {
    stmts.push(
      core.db
        .prepare(`UPDATE bbs_user SET ${col} = ${col} - ? WHERE uid = ? AND ${col} >= ?${guard}${incomeGuard}`)
        .bind(p.price, p.uid, p.price, ...payParams) as unknown as Stmt,
    );
  }
  // 入账方余额更新/流水与扣款同批提交：要么「扣款+入账」全部生效，要么整批回滚。
  if (incomeTo) {
    if (col === 'credits') {
      stmts.push(
        ...creditDeltaStmts(core, {
          uid: incomeTo,
          creditType: p.creditType ?? 1,
          change: p.price,
          reason: p.incomeReason ?? 'attach_income',
          bizKey: `${p.bizKey}:income`,
          ts: p.ts,
        }),
      );
    } else {
      stmts.push(
        core.db
          .prepare(`UPDATE bbs_user SET ${col} = ${col} + ? WHERE uid = ?`)
          .bind(p.price, incomeTo) as unknown as Stmt,
      );
    }
  }
  let results: { meta?: { changes?: number } }[];
  try {
    results = (await core.db.batch(stmts)) as unknown as { meta?: { changes?: number } }[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed: bbs_point_log/i.test(msg)) return 'already';
    throw e;
  }
  const changed = Number(results[col === 'credits' ? 1 : 0]?.meta?.changes ?? 0);
  if (changed <= 0) return 'insufficient';
  return 'charged';
}

/* ------------------------------------------------------------------ *
 * tt_credits 规则（kv 'tt_credits'，后台「积分」页可配）
 * ------------------------------------------------------------------ */

/** 规则矩阵 18 键（3 币种 × 6 场景） */
export const CREDIT_RULE_KEYS = [
  'digest1_exp', 'digest2_exp', 'digest3_exp', 'thread_exp', 'post_exp', 'down_exp',
  'digest1_gold', 'digest2_gold', 'digest3_gold', 'thread_gold', 'post_gold', 'down_gold',
  'digest1_rmb', 'digest2_rmb', 'digest3_rmb', 'thread_rmb', 'post_rmb', 'down_rmb',
] as const;

export interface CreditsRules {
  [k: string]: number;
}

/**
 * 默认值取舍：正向规则出厂全 0（未配置=关闭），经验两项镜像既有「积分设置」三键
 * （credit_thread/credit_reply），保证升级后现站发放行为零突变。limit/min/exchange_* 沿用默认档。
 */
export const CREDIT_RULE_DEFAULTS: CreditsRules = {
  digest1_exp: 0, digest2_exp: 0, digest3_exp: 0, thread_exp: 0, post_exp: 0, down_exp: 0,
  digest1_gold: 0, digest2_gold: 0, digest3_gold: 0, thread_gold: 0, post_gold: 0, down_gold: 0,
  digest1_rmb: 0, digest2_rmb: 0, digest3_rmb: 0, thread_rmb: 0, post_rmb: 0, down_rmb: 0,
  limit: 3, min: 1000, convert_exchange: 0, exchange_n: 1, exchange_c: 1,
};

const intOr = (v: unknown, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
};
const posInt = (v: unknown, d: number): number => {
  const n = intOr(v, d);
  return n > 0 ? n : d;
};

/** 读取 tt_credits 规则（L1 缓存，键表见 core/cache KEY_POLICIES） */
export async function loadCreditsRules(cache: Cache, db: D1b): Promise<CreditsRules> {
  return remember(cache, 'tt_credits', async () => {
    const row = await db.prepare<{ v: string }>('SELECT v FROM bbs_kv WHERE k = ?').bind('tt_credits').first<{ v: string }>();
    let raw: Record<string, unknown> | null = null;
    if (row?.v) {
      try {
        raw = JSON.parse(row.v) as Record<string, unknown>;
      } catch {
        raw = null;
      }
    }
    const out: CreditsRules = { ...CREDIT_RULE_DEFAULTS };
    if (!raw) {
      const s: SiteSetting = await loadSetting(cache, db);
      out.thread_exp = intOr(s.creditThread, 0);
      out.post_exp = intOr(s.creditReply, 0);
      return out;
    }
    for (const k of CREDIT_RULE_KEYS) out[k] = intOr(raw[k], 0);
    out.limit = intOr(raw.limit, 3);
    out.min = intOr(raw.min, 1000);
    out.convert_exchange = Number(raw.convert_exchange) === 1 ? 1 : 0;
    out.exchange_n = posInt(raw.exchange_n, 1);
    out.exchange_c = posInt(raw.exchange_c, 1);
    return out;
  });
}

/** 每日加分上限（limit，0=不限）：按当日同类帖数判定；插入后统计含当前帖（pid<=） */
async function withinDailyBonusLimit(
  db: D1b,
  o: { uid: number; isfirst: 0 | 1; pid: number; ts: number },
  limit: number,
): Promise<boolean> {
  const dayStart = dayNo(o.ts) * 86400;
  const r = await db
    .prepare<{ c: number }>(
      'SELECT COUNT(*) AS c FROM bbs_post WHERE uid = ? AND isfirst = ? AND create_date >= ? AND pid <= ?',
    )
    .bind(o.uid, o.isfirst, dayStart, o.pid)
    .first<{ c: number }>();
  return Number(r?.c ?? 0) <= limit;
}

/**
 * 发帖/回帖前置余额闸门（tt_credits）：
 * 任一负向规则会把余额扣成负数 → 拒绝发帖；
 * 全规则非负（含全 0）时零余额查询跳过。返回 null=放行，否则错误文案。
 */
export async function postCreditGate(core: Core, uid: number, isfirst: 0 | 1, t: ApiT = t0): Promise<string | null> {
  const rules = await loadCreditsRules(core.cache, core.db);
  const key = isfirst === 1 ? 'thread' : 'post';
  const exp = Number(rules[`${key}_exp`] ?? 0);
  const gold = Number(rules[`${key}_gold`] ?? 0);
  const rmb = Number(rules[`${key}_rmb`] ?? 0);
  if (exp >= 0 && gold >= 0 && rmb >= 0) return null;
  const u = await core.db
    .prepare<{ credits: number; golds: number; rmbs: number }>('SELECT credits,golds,rmbs FROM bbs_user WHERE uid = ?')
    .bind(uid)
    .first<{ credits: number; golds: number; rmbs: number }>();
  if (!u) return null;
  if (
    (exp < 0 && Number(u.credits) + exp < 0) ||
    (gold < 0 && Number(u.golds) + gold < 0) ||
    (rmb < 0 && Number(u.rmbs) + rmb < 0)
  ) {
    return t('credits.insufficient');
  }
  return null;
}

/**
 * 发帖/回帖的三币种发放（tt_credits）：
 * 正向变动受「每日加分上限」（limit）约束，负向变动不受限；
 * credits 走 point_log（reason thread/reply），golds/rmbs 直接余额。
 * 另保留本项目既有「积分设置」每日首帖奖励（creditDailyFirst）。
 * 返回值 = 成功提示后缀（`经验+5 金币-2 人民币+100`；无变动为空串，发帖两路由拼进 ok 文案）。
 */
export async function grantForPost(
  core: Core,
  opts: { uid: number; isfirst: 0 | 1; pid: number; ts: number },
  t: ApiT = t0,
): Promise<string> {
  const rules = await loadCreditsRules(core.cache, core.db);
  const key = opts.isfirst === 1 ? 'thread' : 'post';
  const exp = Number(rules[`${key}_exp`] ?? 0);
  const gold = Number(rules[`${key}_gold`] ?? 0);
  const rmb = Number(rules[`${key}_rmb`] ?? 0);
  let allowPositive = true;
  if ((exp > 0 || gold > 0 || rmb > 0) && Number(rules.limit) > 0) {
    allowPositive = await withinDailyBonusLimit(core.db, opts, Number(rules.limit));
  }
  const take = (v: number): boolean => v !== 0 && (v < 0 || allowPositive);
  const reason: PointReason = opts.isfirst === 1 ? 'thread' : 'reply';
  const applied: [string, number][] = [];
  if (take(exp)) {
    await applyCreditDelta(core, { uid: opts.uid, creditType: 1, change: exp, reason, bizKey: `post:${opts.pid}`, ts: opts.ts });
    applied.push([t('credit.exp'), exp]);
  }
  if (take(gold)) {
    await applyCreditDelta(core, { uid: opts.uid, creditType: 2, change: gold, reason, bizKey: `post:${opts.pid}:gold`, ts: opts.ts });
    applied.push([t('credit.gold'), gold]);
  }
  if (take(rmb)) {
    await applyCreditDelta(core, { uid: opts.uid, creditType: 3, change: rmb, reason, bizKey: `post:${opts.pid}:rmb`, ts: opts.ts });
    applied.push([t('credit.rmb'), rmb]);
  }
  const s: SiteSetting = await loadSetting(core.cache, core.db);
  const daily = Number(s.creditDailyFirst ?? 0);
  if (daily > 0) {
    await applyPointChange(core, {
      uid: opts.uid,
      change: daily,
      reason: 'daily_first',
      bizKey: `daily:${opts.uid}:${dayNo(opts.ts)}`,
      ts: opts.ts,
    });
  }
  return applied.map(([label, v]) => `${label}${v > 0 ? '+' : ''}${v}`).join(' ');
}

/** 删除回扣条目（isfirst=1 走主题作者 thread_*；isfirst=0 走楼层作者 post_*） */
export interface RevokeEntry {
  uid: number;
  isfirst: 0 | 1;
  pid?: number;
  tid?: number;
}

/**
 * 主题删除回扣条目构造：
 * 主题作者扣 thread_*，级联删的每个回帖作者各扣一次 post_*；
 * 必须在删除语句执行前调用（读楼层列表——删后无可读行）。
 */
export async function threadRevokeEntries(db: D1b, tid: number, authorUid: number): Promise<RevokeEntry[]> {
  const floors = await db
    .prepare<{ pid: number; uid: number }>('SELECT pid,uid FROM bbs_post WHERE tid = ? AND isfirst = 0')
    .bind(tid)
    .all();
  return [
    { uid: Number(authorUid), isfirst: 1, tid },
    ...floors.results.map((f) => ({ uid: Number(f.uid), isfirst: 0 as const, pid: Number(f.pid) })),
  ];
}

/** 回扣受影响 uid 去重（调用方按此逐个重算等级组） */
export function revokeAffectedUids(entries: RevokeEntry[]): number[] {
  return [...new Set(entries.map((e) => Number(e.uid)))].filter((u) => u > 0);
}

/**
 * 发帖/回帖删除的积分回扣（tt_credits）：
 * 主题删除 → 作者扣 thread_*；回帖删除（非首帖）→ 楼层作者扣 post_*；级联删主题时逐楼层回扣。
 * 回扣无上限判断、允许扣成负数。本项目铁律 §15.1：credits 变动必须留 point_log 流水，故经
 * creditDeltaStmts 写负向流水（reason 沿用 thread/reply，biz_key 加 ':del' 尾缀与发放键区分）。
 * 多目标合并为单个 DB.batch()：一次事务完成全部回扣，避免逐帖往返。
 * 幂等：同一目标重复删除（流水键已存在）整批回滚；此时其余目标也一并跳过（删除本身已不可重复，等价）。
 */
export async function revokeForPostDelete(core: Core, entries: RevokeEntry[]): Promise<void> {
  const rules = await loadCreditsRules(core.cache, core.db);
  const ts = Math.floor(Date.now() / 1000);
  const stmts: Stmt[] = [];
  for (const e of entries) {
    if (e.uid <= 0) continue;
    const key = e.isfirst === 1 ? 'thread' : 'post';
    const biz = e.isfirst === 1 ? `thread:${e.tid}:del` : `post:${e.pid}:del`;
    const reason: PointReason = e.isfirst === 1 ? 'thread' : 'reply';
    const deltas: [number, number, string][] = [
      [1, Number(rules[`${key}_exp`] ?? 0), ''],
      [2, Number(rules[`${key}_gold`] ?? 0), ':gold'],
      [3, Number(rules[`${key}_rmb`] ?? 0), ':rmb'],
    ];
    for (const [type, v, suffix] of deltas) {
      if (v === 0) continue;
      stmts.push(...creditDeltaStmts(core, { uid: e.uid, creditType: type, change: -v, reason, bizKey: biz + suffix, ts }));
    }
  }
  if (!stmts.length) return;
  try {
    await core.db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/UNIQUE constraint failed: bbs_point_log/i.test(msg)) throw e;
  }
}

/**
 * 精华变更差额结算（tt_credits）：
 * 结算额 = 新级别奖励 − 旧级别奖励（三币种各算，可为负；级别 0 视为全 0）。
 * biz_key 带随机尾缀：精华可反复升降，同一 (tid, 级别) 组合会重复出现，不能使用固定幂等键。
 * N 条合并为一次 DB.batch —— N 个子请求降为 1（§7）。
 * 随机幂等尾缀逐条生成，保持「精华可反复升降」的既有行为。
 */
export async function settleDigestChanges(
  core: Core,
  items: { uid: number; tid: number; before: number; after: number }[],
): Promise<void> {
  const rules = await loadCreditsRules(core.cache, core.db);
  const val = (digest: number, kind: 'exp' | 'gold' | 'rmb'): number =>
    digest >= 1 && digest <= 3 ? Number(rules[`digest${digest}_${kind}`] ?? 0) : 0;
  const ts = Math.floor(Date.now() / 1000);
  const stmts: Stmt[] = [];
  for (const o of items) {
    const bizKey = `digest:${o.tid}:${ts}:${Math.random().toString(36).slice(2, 6)}`;
    const deltas: [number, number][] = [
      [1, val(o.after, 'exp') - val(o.before, 'exp')],
      [2, val(o.after, 'gold') - val(o.before, 'gold')],
      [3, val(o.after, 'rmb') - val(o.before, 'rmb')],
    ];
    for (const [creditType, change] of deltas) {
      if (change === 0) continue;
      stmts.push(...creditDeltaStmts(core, { uid: o.uid, creditType, change, reason: 'digest', bizKey, ts }));
    }
  }
  if (!stmts.length) return;
  try {
    await core.db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/UNIQUE constraint failed: bbs_point_log/i.test(msg)) throw e;
  }
}

/**
 * 用户组升级（门槛值取用户经验值 credits）：
 * gid>=100 的等级/会员组按经验值落入 (creditsfrom, creditsto] 区间换组；管理组（gid<100）不动。
 * 会员挂组保护（0005）沿用条件 UPDATE（有效期内 changes=0 跳过）。返回变化供调用方发射事件。
 * grouplist 可由调用方注入（写路径已有缓存上下文，省一次装载）。
 */
export async function upgradeGroupByCredits(
  core: Core,
  uid: number,
  grouplist?: Record<number, GroupForAccess>,
): Promise<{ oldGid: number; newGid: number } | null> {
  const u = await core.db
    .prepare<{ gid: number; credits: number }>('SELECT gid,credits FROM bbs_user WHERE uid = ?')
    .bind(uid)
    .first<{ gid: number; credits: number }>();
  if (!u || Number(u.gid) < 100) return null;
  const gl = grouplist ?? (await loadGrouplist(core.cache, core.db));
  const target = resolveCreditsUpgrade(gl, Number(u.gid), Number(u.credits));
  if (target === null || target === Number(u.gid)) return null;
  const r = await core.db
    .prepare('UPDATE bbs_user SET gid = ? WHERE uid = ? AND (vip_expire_at IS NULL OR vip_expire_at = 0 OR vip_expire_at < ?)')
    .bind(target, uid, Math.floor(Date.now() / 1000))
    .run();
  if ((r.meta?.changes ?? 0) !== 1) return null;
  await core.cache.del(`user:${uid}`);
  return { oldGid: Number(u.gid), newGid: target };
}

/**
 * 用户组升级（批量）：逐条语义与 upgradeGroupByCredits 完全一致（同 SQL、同会员挂组条件、
 * 同 user:{uid} 缓存失效），但把 N 组「读 + 条件更新」合并为 1 次 SELECT + 1 次 DB.batch：
 * 2N 个子请求降为 2（§7）。批量版务/删帖回扣后重算等级组走此路径。
 * 返回实际发生变化的 uid 与其新旧组（供调用方发射 user:group-changed）。
 */
export async function upgradeGroupsByCredits(
  core: Core,
  uids: number[],
  grouplist?: Record<number, GroupForAccess>,
): Promise<{ uid: number; oldGid: number; newGid: number }[]> {
  const ids = [...new Set(uids)].filter((u) => u > 0);
  if (!ids.length) return [];
  const inList = ids.map(() => '?').join(',');
  const rows = await core.db
    .prepare<{ uid: number; gid: number; credits: number }>(
      `SELECT uid,gid,credits FROM bbs_user WHERE uid IN (${inList})`,
    )
    .bind(...ids)
    .all();
  const gl = grouplist ?? (await loadGrouplist(core.cache, core.db));
  const now = Math.floor(Date.now() / 1000);
  const stmts: Stmt[] = [];
  const pending: { uid: number; oldGid: number; newGid: number }[] = [];
  for (const row of rows.results) {
    const oldGid = Number(row.gid);
    if (oldGid < 100) continue; // 管理组不动
    const target = resolveCreditsUpgrade(gl, oldGid, Number(row.credits));
    if (target === null || target === oldGid) continue;
    stmts.push(
      core.db
        .prepare('UPDATE bbs_user SET gid = ? WHERE uid = ? AND (vip_expire_at IS NULL OR vip_expire_at = 0 OR vip_expire_at < ?)')
        .bind(target, Number(row.uid), now),
    );
    pending.push({ uid: Number(row.uid), oldGid, newGid: target });
  }
  if (!stmts.length) return [];
  const results = await core.db.batch(stmts);
  const changed: { uid: number; oldGid: number; newGid: number }[] = [];
  for (let i = 0; i < pending.length; i++) {
    if ((results[i]?.meta?.changes ?? 0) !== 1) continue; // 会员挂组保护：changes=0 视为未升级
    const p = pending[i];
    if (!p) continue;
    await core.cache.del(`user:${p.uid}`);
    changed.push(p);
  }
  return changed;
}