/**
 * 积分管理后台接口（本项目新增菜单；覆盖积分规则/余额/消费记录/排行等后台页）：
 *   GET  /api/admin/points/users    ?type=uid|username &keyword &page &size  台账（复用后台用户投影，uid 倒序）
 *   POST /api/admin/points/adjust   {uid, change, note?}                     手工 ±（change 非零整数）
 *   GET  /api/admin/points/logs     ?uid &reason &page &size                 流水（id 倒序，join username）
 *   —— 以下为积分后台管理页 ——
 *   GET  /api/admin/points/rules                积分规则/兑换比例（读取侧）
 *   PUT  /api/admin/points/rules                保存规则矩阵 3×6 + limit/min/兑换比例
 *   GET  /api/admin/points/balance ?username    查询用户三币余额
 *   PUT  /api/admin/points/balance              三门绝对值改（credits 补差额流水）
 *   GET  /api/admin/points/paylog               消费（购买主题）记录 paylist type=1
 *   GET  /api/admin/points/groups               用户组 allowsell 列表
 *   PUT  /api/admin/points/groups               设置可发收费帖组（先全清后逐组置 1）
 *   POST /api/admin/points/simulate             模拟用户购买主题（paylist num=0 type=1）
 *   POST /api/admin/points/upgrade              按用户名强制重算用户组
 *   GET  /api/admin/points/rank ?type&page&size 积分排行（credits|golds|rmbs 全表倒序）
 *   GET/PUT /api/admin/points/register-credits  注册默认积分——存 kv 'd_credit'/'d_gold'/'d_rmb'
 *     （D1 无列默认回写 → 改存 kv，注册时由 auth 显式发放）。
 * 铁律（§15.1）：credits 变动必须经 applyPointChange（余额+流水同批事务），reason 固定 'admin'；
 * biz_key 加随机尾缀，同秒连续调整不撞幂等键（手工调整本就允许逐次生效，幂等键仅防同一条记录重复写入）。
 * 全部路由挂在 adminGuard 之后（app.use('/api/admin/*')）。
 */
import { Hono, type Context } from 'hono';
import { Code } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { Stmt } from '../../core/db';
import {
  applyPointChange,
  creditDeltaStmts,
  CREDIT_RULE_DEFAULTS,
  CREDIT_RULE_KEYS,
  loadCreditsRules,
  upgradeGroupByCredits,
  type CreditsRules,
} from '../../core/points';
import { USER_ADMIN_LIST_COLS } from '../../core/db/columns';
import { core, intParam, totalPageOf, type ReadEnv } from '../shared';

type Ctx = Context<ReadEnv>;
const now = () => Math.floor(Date.now() / 1000);
const nonceOf = (): string => Math.random().toString(36).slice(2, 10);

/** 流水的 reason → 前端展示映射的合法值（过滤用）。
 *  与实际写入点对齐（§20.3 批次 3E 枚举漂移修正）：
 *  - 'v_apply'（v/routes.ts 申请扣费）与 'checkin'（extensions/checkin.ts 签到）补进筛选；
 *  - 'exchange' 移除——兑换只动 golds/rmbs 不写 point_log，属幽灵枚举（三处声明零写入点）。 */
const REASONS = new Set([
  'thread', 'reply', 'daily_first', 'attach_purchase', 'attach_income', 'order', 'admin', 'register',
  'thread_purchase', 'thread_income', 'transfer_out', 'transfer_in', 'digest', 'checkin', 'v_apply',
]);

/** 后台写库的普通语句（D1b.prepare 链式类型见 §D1b） */
const stmt = (v: unknown): Stmt => v as unknown as Stmt;

export function adminPointRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  // ---------------- 用户积分台账 ----------------
  app.get('/api/admin/points/users', async (c: Ctx) => {
    const { db } = core(c);
    const keyword = String(c.req.query('keyword') ?? '').trim();
    const type = String(c.req.query('type') ?? 'username');
    const page = Math.max(1, intParam(c.req.query('page'), 1));
    const size = Math.min(100, Math.max(1, intParam(c.req.query('size'), 20)));
    const col = type === 'uid' ? 'uid' : 'username';
    const where: string[] = [];
    const params: (number | string)[] = [];
    if (keyword) {
      where.push(`${col} = ?`); // 与后台用户列表一致，精确等值
      params.push(col === 'uid' ? Number(keyword) || 0 : keyword);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const cnt = await db.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM bbs_user${whereSql}`).bind(...params).first<{ c: number }>();
    const total = Number(cnt?.c ?? 0);
    const rows = await db
      .prepare<Record<string, unknown>>(`SELECT ${USER_ADMIN_LIST_COLS} FROM bbs_user${whereSql} ORDER BY uid DESC LIMIT ? OFFSET ?`)
      .bind(...params, size, (page - 1) * size)
      .all();
    return ok(c, 'ok', { data: { total, page, size, totalPage: totalPageOf(total, size), list: rows.results } });
  });

  // ---------------- 手工调整（±） ----------------
  app.post('/api/admin/points/adjust', async (c: Ctx) => {
    const { db } = core(c);
    const t = c.get('t');
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b) throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
    const uid = Number(b.uid);
    const change = Number(b.change);
    if (!Number.isInteger(uid) || uid <= 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.uidInvalid'));
    if (!Number.isInteger(change) || change === 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.changeInvalid'));
    const user = await db.prepare<{ uid: number }>('SELECT uid FROM bbs_user WHERE uid = ?').bind(uid).first<{ uid: number }>();
    if (!user) throw new AppError(Code.VALIDATION_ERROR, t('common.userNotFound'));
    const ts = now();
    const granted = await applyPointChange(core(c), {
      uid,
      change,
      reason: 'admin',
      bizKey: `admin:${uid}:${ts}:${Math.random().toString(36).slice(2, 8)}`,
      ts,
    });
    const row = await db.prepare<{ credits: number }>('SELECT credits FROM bbs_user WHERE uid = ?').bind(uid).first<{ credits: number }>();
    return ok(c, granted ? t('admin.adjusted') : t('admin.adjustSkipped'), { data: { granted, credits: Number(row?.credits ?? 0) } });
  });

  // ---------------- 积分流水 ----------------
  app.get('/api/admin/points/logs', async (c: Ctx) => {
    const { db } = core(c);
    const page = Math.max(1, intParam(c.req.query('page'), 1));
    const size = Math.min(100, Math.max(1, intParam(c.req.query('size'), 20)));
    const uid = intParam(c.req.query('uid'), 0);
    const reason = String(c.req.query('reason') ?? '').trim();
    const where: string[] = [];
    const params: (number | string)[] = [];
    if (uid > 0) {
      where.push('l.uid = ?');
      params.push(uid);
    }
    if (reason && REASONS.has(reason)) {
      where.push('l.reason = ?');
      params.push(reason);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const cnt = await db.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM bbs_point_log l${whereSql}`).bind(...params).first<{ c: number }>();
    const total = Number(cnt?.c ?? 0);
    const rows = await db
      .prepare<Record<string, unknown>>(
        `SELECT l.id AS logid, l.uid, u.username, l.change, l.balance, l.reason, l.biz_key, l.create_date
         FROM bbs_point_log l LEFT JOIN bbs_user u ON u.uid = l.uid${whereSql}
         ORDER BY l.id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...params, size, (page - 1) * size)
      .all();
    return ok(c, 'ok', { data: { total, page, size, totalPage: totalPageOf(total, size), list: rows.results } });
  });

  // ---------------- 积分规则 / 兑换比例（op=3 读取侧 + 写入侧） ----------------
  app.get('/api/admin/points/rules', async (c: Ctx) => {
    const { db, cache } = core(c);
    const rules = await loadCreditsRules(cache, db);
    return ok(c, 'ok', { data: { ...rules, defaults: CREDIT_RULE_DEFAULTS } });
  });

  app.put('/api/admin/points/rules', async (c: Ctx) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b) throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
    const out: CreditsRules = {};
    // 3×6 规则矩阵：逐键取整并限幅（±99999999，防注入与溢出）
    for (const k of CREDIT_RULE_KEYS) {
      const n = Math.trunc(Number(b[k] ?? 0));
      if (!Number.isFinite(n) || Math.abs(n) > 99_999_999) throw new AppError(Code.VALIDATION_ERROR, t('admin.ruleInvalid', { k }));
      out[k] = n;
    }
    const limit = Math.trunc(Number(b.limit ?? 0));
    const min = Math.trunc(Number(b.min ?? 0));
    const exchangeN = Math.trunc(Number(b.exchange_n ?? b.exchangeN ?? 1));
    const exchangeC = Math.trunc(Number(b.exchange_c ?? b.exchangeC ?? 1));
    if (limit < 0 || min < 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.limitInvalid'));
    if (exchangeN < 1 || exchangeC < 1) throw new AppError(Code.VALIDATION_ERROR, t('admin.ratioInvalid'));
    out.limit = limit;
    out.min = min;
    out.exchange_n = exchangeN;
    out.exchange_c = exchangeC;
    out.convert_exchange = Number(b.convert_exchange ?? b.convertExchange ?? 0) === 1 ? 1 : 0;
    await db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind('tt_credits', JSON.stringify(out)).run();
    await cache.del('tt_credits'); // L1 失效：前台读路径下次即生效
    return ok(c, t('common.setDone'));
  });

  // ---------------- 注册默认积分（op=5；kv 三键，auth 注册时消费） ----------------
  const registerDefaults = async (c: Ctx): Promise<{ credits: number; golds: number; rmbs: number }> => {
    const { db } = core(c);
    const rows = await db
      .prepare<{ k: string; v: string }>('SELECT k,v FROM bbs_kv WHERE k IN (?,?,?)')
      .bind('d_credit', 'd_gold', 'd_rmb')
      .all();
    const get = (k: string): number => {
      const n = Math.trunc(Number(rows.results.find((r) => String(r.k) === k)?.v ?? 0));
      return Number.isFinite(n) ? n : 0;
    };
    return { credits: get('d_credit'), golds: get('d_gold'), rmbs: get('d_rmb') };
  };

  app.get('/api/admin/points/register-credits', async (c: Ctx) => {
    return ok(c, 'ok', { data: await registerDefaults(c) });
  });

  app.put('/api/admin/points/register-credits', async (c: Ctx) => {
    const { db } = core(c);
    const t = c.get('t');
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b) throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
    const vals: [string, number][] = [
      ['d_credit', Math.trunc(Number(b.credits ?? 0))],
      ['d_gold', Math.trunc(Number(b.golds ?? 0))],
      ['d_rmb', Math.trunc(Number(b.rmbs ?? 0))],
    ];
    if (!vals.every(([, n]) => Number.isFinite(n) && Math.abs(n) <= 2_147_483_647)) {
      throw new AppError(Code.VALIDATION_ERROR, t('admin.valueInvalid'));
    }
    await db.batch(vals.map(([k, v]) => stmt(db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind(k, String(v)))));
    return ok(c, t('common.setDone'), { data: Object.fromEntries(vals) });
  });

  // ---------------- 查询/修改用户积分（op=4 / op=0） ----------------
  app.get('/api/admin/points/balance', async (c: Ctx) => {
    const { db } = core(c);
    const t = c.get('t');
    const username = String(c.req.query('username') ?? '').trim();
    if (!username) throw new AppError(Code.VALIDATION_ERROR, t('auth.usernameRequired'));
    const u = await db
      .prepare<{ uid: number; username: string; credits: number; golds: number; rmbs: number }>(
        'SELECT uid,username,credits,golds,rmbs FROM bbs_user WHERE username = ?',
      )
      .bind(username)
      .first<{ uid: number; username: string; credits: number; golds: number; rmbs: number }>();
    if (!u) throw new AppError(Code.NOT_FOUND, t('common.userNotFound'));
    return ok(c, 'ok', { data: { uid: Number(u.uid), username: String(u.username), exp: Number(u.credits), golds: Number(u.golds), rmbs: Number(u.rmbs) } });
  });

  app.put('/api/admin/points/balance', async (c: Ctx) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b) throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
    const username = String(b.username ?? '').trim();
    if (!username) throw new AppError(Code.VALIDATION_ERROR, t('auth.usernameRequired'));
    const u = await db
      .prepare<{ uid: number; credits: number; golds: number; rmbs: number }>('SELECT uid,credits,golds,rmbs FROM bbs_user WHERE username = ?')
      .bind(username)
      .first<{ uid: number; credits: number; golds: number; rmbs: number }>();
    if (!u) throw new AppError(Code.NOT_FOUND, t('common.userNotFound'));
    const exp = Math.trunc(Number(b.exp ?? u.credits));
    const golds = Math.trunc(Number(b.golds ?? u.golds));
    const rmbs = Math.trunc(Number(b.rmbs ?? u.rmbs));
    if (![exp, golds, rmbs].every((n) => Number.isFinite(n) && Math.abs(n) <= 2_147_483_647)) {
      throw new AppError(Code.VALIDATION_ERROR, t('admin.valueInvalid'));
    }
    const ts = now();
    // 绝对覆盖口径：credits 以差额补 point_log（reason=admin），
    // golds/rmbs 仍按绝对覆盖（无账本表）
    const stmts: Stmt[] = [
      stmt(db.prepare('UPDATE bbs_user SET golds = ?, rmbs = ? WHERE uid = ?').bind(golds, rmbs, Number(u.uid))),
      ...creditDeltaStmts(core(c), {
        uid: Number(u.uid),
        creditType: 1,
        change: exp - Number(u.credits),
        reason: 'admin',
        bizKey: `admin-set:${u.uid}:${ts}:${nonceOf()}`,
        ts,
      }),
    ];
    if (stmts.length) await db.batch(stmts);
    await cache.del(`user:${u.uid}`);
    return ok(c, t('admin.execDone'), { data: { exp, golds, rmbs } });
  });

  // ---------------- 消费（购买主题）记录 ----------------
  app.get('/api/admin/points/paylog', async (c: Ctx) => {
    const { db } = core(c);
    const page = Math.max(1, intParam(c.req.query('page'), 1));
    const size = Math.min(100, Math.max(1, intParam(c.req.query('size'), 20)));
    const cnt = await db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_paylist WHERE type = 1').first<{ c: number }>();
    const total = Number(cnt?.c ?? 0);
    const rows = await db
      .prepare<Record<string, unknown>>(
        `SELECT p.plid, p.tid, t.subject, p.uid, u.username, p.num, p.credit_type, p.paytime
         FROM bbs_paylist p LEFT JOIN bbs_thread t ON t.tid = p.tid LEFT JOIN bbs_user u ON u.uid = p.uid
         WHERE p.type = 1 ORDER BY p.paytime DESC, p.plid DESC LIMIT ? OFFSET ?`,
      )
      .bind(size, (page - 1) * size)
      .all();
    return ok(c, 'ok', { data: { total, page, size, totalPage: totalPageOf(total, size), list: rows.results } });
  });

  // ---------------- 收费组设置 ----------------
  app.get('/api/admin/points/groups', async (c: Ctx) => {
    const { db } = core(c);
    const rows = await db.prepare<Record<string, unknown>>('SELECT gid,name,allowsell FROM bbs_group ORDER BY gid ASC').all();
    return ok(c, 'ok', { data: { list: rows.results } });
  });

  app.put('/api/admin/points/groups', async (c: Ctx) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const b = (await c.req.json().catch(() => null)) as { gids?: unknown } | null;
    if (!b) throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
    const gids = (Array.isArray(b.gids) ? b.gids : []).map(Number).filter((x) => Number.isInteger(x) && x > 0);
    // 口径：先全清再逐组置 1（提交空数组=全部关闭）
    const stmts: Stmt[] = [stmt(db.prepare('UPDATE bbs_group SET allowsell = 0'))];
    for (const gid of gids) stmts.push(stmt(db.prepare('UPDATE bbs_group SET allowsell = 1 WHERE gid = ?').bind(gid)));
    await db.batch(stmts);
    await cache.del('grouplist'); // group_list_cache_delete
    return ok(c, t('common.setDone'));
  });

  // ---------------- 模拟用户购买 ----------------
  app.post('/api/admin/points/simulate', async (c: Ctx) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b) throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
    const uid = Math.trunc(Number(b.uid ?? 0));
    const tid = Math.trunc(Number(b.tid ?? 0));
    if (uid <= 0 || tid <= 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.uidTidInvalid'));
    const [user, thread] = await Promise.all([
      db.prepare<{ uid: number }>('SELECT uid FROM bbs_user WHERE uid = ?').bind(uid).first<{ uid: number }>(),
      db.prepare<{ tid: number }>('SELECT tid FROM bbs_thread WHERE tid = ?').bind(tid).first<{ tid: number }>(),
    ]);
    if (!user) throw new AppError(Code.NOT_FOUND, t('common.userNotFound'));
    if (!thread) throw new AppError(Code.NOT_FOUND, t('common.threadNotFound'));
    // 写入 num=0 credit_type=1 type=1；paylist 有 (tid,uid) WHERE type=1 唯一键 → OR IGNORE 幂等（已购则不重复）
    const r = await db
      .prepare('INSERT OR IGNORE INTO bbs_paylist (tid,uid,num,credit_type,type,paytime,nonce) VALUES (?,?,0,1,1,?,?)')
      .bind(tid, uid, now(), nonceOf())
      .run();
    await cache.del(`user:${uid}`);
    return ok(c, Number(r.meta?.changes ?? 0) > 0 ? t('admin.opDone') : t('admin.purchasedAlready'));
  });

  // ---------------- 强制升级用户组 ----------------
  app.post('/api/admin/points/upgrade', async (c: Ctx) => {
    const { db } = core(c);
    const t = c.get('t');
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b) throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
    const username = String(b.username ?? '').trim();
    if (!username) throw new AppError(Code.VALIDATION_ERROR, t('auth.usernameRequired'));
    const u = await db.prepare<{ uid: number }>('SELECT uid FROM bbs_user WHERE username = ?').bind(username).first<{ uid: number }>();
    if (!u) throw new AppError(Code.NOT_FOUND, t('common.userNotFound'));
    const up = await upgradeGroupByCredits(core(c), Number(u.uid));
    return ok(c, up ? t('admin.groupUpdated', { old: up.oldGid, new: up.newGid }) : t('common.setDone'), { data: up ?? undefined });
  });

  // ---------------- 积分排行（credits|golds|rmbs 全表倒序 20/页） ----------------
  app.get('/api/admin/points/rank', async (c: Ctx) => {
    const { db } = core(c);
    const sortMap = { credits: 'credits', golds: 'golds', rmbs: 'rmbs' } as const;
    const type = (Object.keys(sortMap) as (keyof typeof sortMap)[]).includes(c.req.query('type') as never)
      ? (c.req.query('type') as keyof typeof sortMap)
      : 'rmbs';
    const page = Math.max(1, intParam(c.req.query('page'), 1));
    const size = Math.min(100, Math.max(1, intParam(c.req.query('size'), 20)));
    const cnt = await db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_user').first<{ c: number }>();
    const total = Number(cnt?.c ?? 0);
    const rows = await db
      .prepare<Record<string, unknown>>(
        `SELECT uid,username,credits,golds,rmbs FROM bbs_user ORDER BY ${sortMap[type]} DESC, uid ASC LIMIT ? OFFSET ?`,
      )
      .bind(size, (page - 1) * size)
      .all();
    return ok(c, 'ok', { data: { type, total, page, size, totalPage: totalPageOf(total, size), list: rows.results } });
  });

  return app;
}
