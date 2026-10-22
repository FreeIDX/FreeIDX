/**
 * 积分交易接口（tt_credits）：
 *  POST /api/threads/:tid/pay       付费主题购买（已购/作者幂等返回「付费成功」）
 *  GET  /api/threads/:tid/paylist   购买记录页：主题信息 + 逐笔买家清单
 *  GET  /api/me/credits             积分面板：头像/组徽章/升级进度 + 三币卡片 + 兑换参数
 *  POST /api/me/credits/exchange    人民币↔金币兑换，10 分钟频控
 *  POST /api/me/credits/transfer    三币种转账
 *  GET  /api/me/credits/record      user_pay 积分变动记录 20/页
 *  GET  /api/me/credits/purchased   已购主题列表，套主题列表卡
 *
 * 原子性口径（项目增强）：D1 batch 单事务 + 随机 nonce 锚定列——「清单/流水行已由本请求插入」
 * 由后续余额语句用 EXISTS(... nonce=?) 守卫，余额不足时锚行不产生（SELECT ... WHERE 余额条件），
 * 整批 changes=0 即整体不生效（等价先查后写），且并发下不产生凭空入账。
 * credits(经验) 变动一律同批补 bbs_point_log（铁律 §15.1）；golds/rmbs 无账本表。
 */
import { Hono, type Context } from 'hono';
import { Code, type ApiKey } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { D1b, Stmt } from '../../core/db';
import type { Cache } from '../../core/cache';
import { creditTypeCol, creditTypeLabel, loadCreditsRules, upgradeGroupByCredits } from '../../core/points';
import { API_MESSAGES, type ApiT } from '../../core/i18n';
import { loadForumlist, loadGrouplist, loadViewer, makeAccessCtx } from '../../core/loaders';
import { forumAccessMod } from '../../core/access';
import { hasSeeCheck } from '../../core/check';
import { getExtensions } from '../../core/extensions';
import { THREAD_LIST_COLS_T } from '../../core/db/columns';
import { core, intParam, readJson, totalPageOf, type ReadEnv } from '../shared';

type Ctx = Context<ReadEnv>;
const now = () => Math.floor(Date.now() / 1000);
const PAGE_SIZE = 20;

/** 积分变动类型/状态文案走词条库（pay.type.N / pay.status.N），按站点语言取词 */
const payTypeName = (t: ApiT, n: number): string => { const k = `pay.type.${Number(n)}`; return k in API_MESSAGES ? t(k as ApiKey) : ''; };
const payStatusName = (t: ApiT, s: number): string => { const k = `pay.status.${Number(s) + 1}`; return k in API_MESSAGES ? t(k as ApiKey) : ''; };

const nonceOf = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

interface Core {
  db: D1b;
  cache: Cache;
}

/** 组变更事件（与 write 模块同口径） */
async function emitGroupChanged(core: Core, uid: number, oldGid: number, newGid: number): Promise<void> {
  const rt = await getExtensions(core.cache, core.db, undefined, { preloadConfigs: false });
  await rt.bus.emit('user:group-changed', { uid, oldGid, newGid });
}

/* ------------------------------------------------------------------ *
 * POST /api/threads/:tid/pay —— 付费主题购买
 * ------------------------------------------------------------------ */
async function payThread(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core0 = core(c);
  const { db, cache } = core0;
  const tid = intParam(c.req.param('tid'));
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLoginEx'));

  const thread = await db
    .prepare<{ tid: number; uid: number; subject: string; content_buy: number; content_buy_type: number }>(
      'SELECT tid,uid,subject,content_buy,content_buy_type FROM bbs_thread WHERE tid = ?',
    )
    .bind(tid)
    .first<{ tid: number; uid: number; subject: string; content_buy: number; content_buy_type: number }>();
  if (!thread) throw new AppError(Code.NOT_FOUND, t('common.threadNotFound'));

  const purchased = await db
    .prepare<{ plid: number }>('SELECT plid FROM bbs_paylist WHERE tid = ? AND uid = ? AND type = 1')
    .bind(tid, v.uid)
    .first<{ plid: number }>();
  if (purchased) return ok(c, t('credits.paidSuccess')); // 已购直接返回成功

  const creditType = creditTypeCol(Number(thread.content_buy_type)) ? Number(thread.content_buy_type) : 1;
  const col = creditTypeCol(creditType)!;
  const price = Math.max(0, Number(thread.content_buy ?? 0));
  // 免费/未标价主题不存在可购买内容：不落 paylist / 流水（原实现 price=0 时 SQL 恒成立，
  // 会给免费主题写入「已购/付费成功」记录，污染购买清单与后台消费统计）。
  if (price <= 0) throw new AppError(Code.VALIDATION_ERROR, t('credits.threadNotPaid'));
  const authorUid = Number(thread.uid);
  const ts = now();
  const nonce = nonceOf();
  const anchor = 'EXISTS (SELECT 1 FROM bbs_paylist WHERE uid = ? AND nonce = ?)';

  const stmts: Stmt[] = [
    // ① 购买清单：余额不足（或买家不存在）时 SELECT 不产出行 → changes=0；UNIQUE(tid,uid) WHERE type=1 防并发双买
    db
      .prepare(
        `INSERT INTO bbs_paylist (tid,uid,num,credit_type,type,paytime,nonce)
         SELECT ?,?,?,?,1,?,? FROM bbs_user WHERE uid = ? AND ${col} >= ?`,
      )
      .bind(tid, v.uid, price, creditType, ts, nonce, v.uid, price) as unknown as Stmt,
    // ② 买家扣款（nonce 锚定本请求的购买行）
    db
      .prepare(`UPDATE bbs_user SET ${col} = ${col} - ? WHERE uid = ? AND ${anchor}`)
      .bind(price, v.uid, v.uid, nonce) as unknown as Stmt,
  ];
  if (col === 'credits' && price > 0) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO bbs_point_log (uid,change,balance,reason,biz_key,create_date)
           SELECT uid,?,credits,'thread_purchase',?,? FROM bbs_user WHERE uid = ? AND ${anchor}`,
        )
        .bind(-price, `pay:${tid}:${v.uid}`, ts, v.uid, v.uid, nonce) as unknown as Stmt,
    );
  }
  stmts.push(
    // ③ 作者入账（同伴锚定：购买成交才入账）
    db
      .prepare(`UPDATE bbs_user SET ${col} = ${col} + ? WHERE uid = ? AND ${anchor}`)
      .bind(price, authorUid, v.uid, nonce) as unknown as Stmt,
  );
  if (col === 'credits' && price > 0 && authorUid > 0 && authorUid !== v.uid) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO bbs_point_log (uid,change,balance,reason,biz_key,create_date)
           SELECT uid,?,credits,'thread_income',?,? FROM bbs_user WHERE uid = ? AND ${anchor}`,
        )
        .bind(price, `pay:${tid}:${v.uid}:income`, ts, authorUid, v.uid, nonce) as unknown as Stmt,
    );
  }
  stmts.push(
    // ④ 买家购买记录（user_pay type=4，code=tid,subject）
    db
      .prepare(
        `INSERT INTO bbs_user_pay (uid,status,num,type,credit_type,code,time,nonce)
         SELECT ?,1,?,4,?,?,?,? WHERE EXISTS (SELECT 1 FROM bbs_paylist WHERE uid = ? AND nonce = ?)`,
      )
      .bind(v.uid, price, creditType, `${tid},${thread.subject}`, ts, nonce, v.uid, nonce) as unknown as Stmt,
  );

  let results: { meta?: { changes?: number } }[];
  try {
    results = (await db.batch(stmts)) as unknown as { meta?: { changes?: number } }[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed/i.test(msg) && /paylist/i.test(msg)) return ok(c, t('credits.paidSuccess')); // 并发/重复提交
    throw e;
  }
  if (Number(results[0]?.meta?.changes ?? 0) <= 0) {
    throw new AppError(Code.FORM_INSUFFICIENT_CREDITS, t('credits.insufficientWithType', { credit: creditTypeLabel(t, creditType) }), {
      price,
      creditType,
    });
  }

  // 买家 gid>=100 升组
  if (v.gid >= 100) {
    const up = await upgradeGroupByCredits(core0, v.uid);
    if (up) await emitGroupChanged(core0, v.uid, up.oldGid, up.newGid);
  }
  return ok(c, t('credits.paidSuccess'), { data: { tid, purchased: true, price, creditType } });
}

/* ------------------------------------------------------------------ *
 * GET /api/threads/:tid/paylist —— 购买记录
 * ------------------------------------------------------------------ */
async function threadPaylist(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const { db, cache } = core(c);
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('credits.loginForPaylist'));
  const tid = intParam(c.req.param('tid'));
  const thread = await db
    .prepare<{ tid: number; fid: number; uid: number; subject: string; username: string; avatar: number; content_buy: number; content_buy_type: number }>(
      'SELECT tid,fid,uid,subject,username,avatar,content_buy,content_buy_type FROM bbs_thread WHERE tid = ?',
    )
    .bind(tid)
    .first<{ tid: number; fid: number; uid: number; subject: string; username: string; avatar: number; content_buy: number; content_buy_type: number }>();
  if (!thread) throw new AppError(Code.NOT_FOUND, t('common.threadNotFound'));

  // 买家清单含逐笔 uid/昵称/时间：与前端入口一致——仅作者、已购者、审核（see_check）与版务可见。
  // 原实现只校验登录，任意登录用户即可枚举他人交易/社交关系。
  const [grouplist, forumlist] = await Promise.all([loadGrouplist(cache, db), loadForumlist(cache, db)]);
  const ctx = makeAccessCtx(v, forumlist, grouplist);
  const canWatch =
    Number(thread.uid) === v.uid ||
    hasSeeCheck(grouplist[v.gid]) ||
    forumAccessMod(ctx, Number(thread.fid), 'allowdelete');
  if (!canWatch) {
    const mine = await db
      .prepare<{ plid: number }>('SELECT plid FROM bbs_paylist WHERE tid = ? AND uid = ? AND type = 1')
      .bind(tid, v.uid)
      .first<{ plid: number }>();
    if (!mine) throw new AppError(Code.NO_PERMISSION, t('common.permDenied'));
  }

  const page = Math.max(1, intParam(c.req.query('page'), 1));
  const cnt = await db
    .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_paylist WHERE tid = ?')
    .bind(tid)
    .first<{ c: number }>();
  const total = Number(cnt?.c ?? 0);
  const rows = await db
    .prepare<{ uid: number; paytime: number; username: string; avatar: number }>(
      `SELECT p.uid, p.paytime, u.username, u.avatar FROM bbs_paylist p LEFT JOIN bbs_user u ON u.uid = p.uid
       WHERE p.tid = ? ORDER BY p.paytime ASC, p.plid ASC LIMIT ? OFFSET ?`,
    )
    .bind(tid, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    .all();

  const creditType = creditTypeCol(Number(thread.content_buy_type)) ? Number(thread.content_buy_type) : 1;
  return ok(c, 'ok', {
    data: {
      thread: {
        tid: thread.tid,
        subject: thread.subject,
        uid: thread.uid,
        username: thread.username,
        avatar: thread.avatar,
      },
      count: total,
      contentBuy: Number(thread.content_buy ?? 0),
      contentBuyType: creditType,
      page,
      size: PAGE_SIZE,
      totalPage: totalPageOf(total, PAGE_SIZE),
      list: rows.results.map((r) => ({
        uid: Number(r.uid),
        username: String(r.username ?? ''),
        avatar: Number(r.avatar ?? 0),
        paytime: Number(r.paytime),
      })),
    },
  });
}

/* ------------------------------------------------------------------ *
 * GET /api/me/credits —— 积分面板 + 兑换参数
 * ------------------------------------------------------------------ */
async function myCredits(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core0 = core(c);
  const { db, cache } = core0;
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const u = await db
    .prepare<{ uid: number; username: string; avatar: number; gid: number; credits: number; golds: number; rmbs: number }>(
      'SELECT uid,username,avatar,gid,credits,golds,rmbs FROM bbs_user WHERE uid = ?',
    )
    .bind(v.uid)
    .first<{ uid: number; username: string; avatar: number; gid: number; credits: number; golds: number; rmbs: number }>();
  if (!u) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));

  const grouplist = await loadGrouplist(cache, db);
  let progress = 100;
  // gid>100 时按「creditsfrom < n <= creditsto」找当前档位，progress = n/creditsto*100
  if (Number(u.gid) > 100) {
    let max = 1;
    for (const g of Object.values(grouplist)) {
      if (Number(g.gid) < 100) continue;
      const from = Number(g.creditsfrom ?? 0);
      const to = Number(g.creditsto ?? 0);
      if (Number(u.credits) > from && Number(u.credits) <= to) {
        max = to;
        break;
      }
    }
    progress = Math.min(100, Math.floor((Number(u.credits) / Math.max(1, max)) * 100));
  }
  // 面板内联的「组名不符即重算组」（仅 gid>=100 参与）
  const up = await upgradeGroupByCredits(core0, v.uid, grouplist);
  if (up) await emitGroupChanged(core0, v.uid, up.oldGid, up.newGid);
  const gid = up ? up.newGid : Number(u.gid);

  const rules = await loadCreditsRules(cache, db);
  return ok(c, 'ok', {
    data: {
      uid: Number(u.uid),
      username: String(u.username),
      avatar: Number(u.avatar),
      gid,
      groupName: String(grouplist[gid]?.name ?? ''),
      credits: Number(u.credits),
      golds: Number(u.golds),
      rmbs: Number(u.rmbs),
      progress,
      trade: {
        convertExchange: Number(rules.convert_exchange) === 1,
        exchangeN: Number(rules.exchange_n),
        exchangeC: Number(rules.exchange_c),
        min: Number(rules.min),
      },
    },
  });
}

/* ------------------------------------------------------------------ *
 * POST /api/me/credits/exchange —— 人民币↔金币兑换
 * ------------------------------------------------------------------ */
async function exchange(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core0 = core(c);
  const { db, cache } = core0;
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const b = await readJson<{ op?: string; e_rmb?: number | string; e_golds_c?: number | string }>(c);
  const op = String(b.op ?? '');
  const rules = await loadCreditsRules(cache, db);
  const min = Number(rules.min);
  const tn = now();

  /** 10 分钟频控（最近 type=6 流水 time 距今 <=600s 拒绝） */
  const recent = await db
    .prepare<{ time: number }>('SELECT time FROM bbs_user_pay WHERE uid = ? AND type = 6 ORDER BY time DESC LIMIT 1')
    .bind(v.uid)
    .first<{ time: number }>();
  if (recent && tn - Number(recent.time) <= 600) {
    throw new AppError(Code.RATE_LIMITED, t('credits.exchangeRateLimited'));
  }

  const nonce = nonceOf();
  const anchor = 'EXISTS (SELECT 1 FROM bbs_user_pay WHERE uid = ? AND nonce = ?)';
  let cost = 0; // 扣减额（op=n 扣 rmbs 分；op=c 扣 golds）
  let gain = 0; // 入账额（op=n 得 golds；op=c 得 rmbs 分）
  let payNum = 0; // 流水 num
  let payCreditType = 3; // 流水 credit_type（op=n=3 人民币；op=c=2 金币）
  let debitCol: 'golds' | 'rmbs' = 'rmbs';
  let creditCol: 'golds' | 'rmbs' = 'golds';

  if (op === 'n') {
    // 人民币兑换金币：输入 N（金币）→ 成本 = N*exchange_n（分）；验额与最低额先于写库
    const raw = Math.floor(Number(b.e_rmb ?? 0));
    if (!Number.isFinite(raw) || raw <= 0) throw new AppError(Code.VALIDATION_ERROR, t('common.invalidPositive'));
    cost = raw * Number(rules.exchange_n);
    if (cost < min) throw new AppError(Code.VALIDATION_ERROR, t('credits.minRmb', { amount: min / 100 }));
    gain = raw;
    payNum = cost;
    payCreditType = 3;
    debitCol = 'rmbs';
    creditCol = 'golds';
  } else if (op === 'c') {
    // 反向兑换（convert_exchange=1 才开放）：输入 e_golds_c = X*100（分）→ 成本 = X*100*exchange_c（金币）
    if (Number(rules.convert_exchange) !== 1) throw new AppError(Code.NO_PERMISSION, t('credits.exchangeDisabled'));
    const raw = Math.floor(Number(b.e_golds_c ?? 0));
    if (!Number.isFinite(raw) || raw <= 0) throw new AppError(Code.VALIDATION_ERROR, t('common.invalidPositive'));
    cost = raw * Number(rules.exchange_c);
    if (cost < min * Number(rules.exchange_c)) {
      throw new AppError(Code.VALIDATION_ERROR, t('credits.minGold', { amount: min * Number(rules.exchange_c) }));
    }
    gain = raw;
    payNum = cost;
    payCreditType = 2;
    debitCol = 'golds';
    creditCol = 'rmbs';
  } else {
    throw new AppError(Code.VALIDATION_ERROR, t('common.paramError'));
  }

  const before = await db
    .prepare<{ golds: number; rmbs: number }>('SELECT golds,rmbs FROM bbs_user WHERE uid = ?')
    .bind(v.uid)
    .first<{ golds: number; rmbs: number }>();
  if (before && Number(before[debitCol]) < cost) throw new AppError(Code.FORM_INSUFFICIENT_CREDITS, t('credits.insufficient'));

  const stmts: Stmt[] = [
    // ① 流水锚行（type=6；余额不足/近 10 分钟已兑换时 SELECT 不产出行 → changes=0）
    db
      .prepare(
        `INSERT INTO bbs_user_pay (uid,status,num,type,credit_type,code,time,nonce)
         SELECT ?,1,?,6,?,'',?,? FROM bbs_user WHERE uid = ? AND ${debitCol} >= ?
           AND NOT EXISTS (SELECT 1 FROM bbs_user_pay WHERE uid = ? AND type = 6 AND time >= ?)`,
      )
      .bind(v.uid, payNum, payCreditType, tn, nonce, v.uid, cost, v.uid, tn - 600) as unknown as Stmt,
    db
      .prepare(`UPDATE bbs_user SET ${debitCol} = ${debitCol} - ? WHERE uid = ? AND ${debitCol} >= ? AND ${anchor}`)
      .bind(cost, v.uid, cost, v.uid, nonce) as unknown as Stmt,
    db
      .prepare(`UPDATE bbs_user SET ${creditCol} = ${creditCol} + ? WHERE uid = ? AND ${anchor}`)
      .bind(gain, v.uid, v.uid, nonce) as unknown as Stmt,
  ];

  let results: { meta?: { changes?: number } }[];
  try {
    results = (await db.batch(stmts)) as unknown as { meta?: { changes?: number } }[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed/i.test(msg)) throw new AppError(Code.RATE_LIMITED, t('credits.exchangeRateLimited'));
    throw e;
  }
  const changed = Number(results[1]?.meta?.changes ?? 0) + Number(results[2]?.meta?.changes ?? 0);
  if (Number(results[0]?.meta?.changes ?? 0) <= 0 || changed <= 0) {
    // 并发兜底：锚行未落或余额变动失败 —— 复核频控以给出准确文案
    const again = await db
      .prepare<{ time: number }>('SELECT time FROM bbs_user_pay WHERE uid = ? AND type = 6 ORDER BY time DESC LIMIT 1')
      .bind(v.uid)
      .first<{ time: number }>();
    if (again && tn - Number(again.time) <= 600) {
      throw new AppError(Code.RATE_LIMITED, t('credits.exchangeRateLimited'));
    }
    throw new AppError(Code.FORM_INSUFFICIENT_CREDITS, t('credits.insufficient'));
  }

  // 按经验升组（gid<100 由内部保护）
  const up = await upgradeGroupByCredits(core0, v.uid);
  if (up) await emitGroupChanged(core0, v.uid, up.oldGid, up.newGid);
  // 回传兑换后实读余额（原实现恒返回 0，前端直接展示会误导）
  const after = await db
    .prepare<{ golds: number; rmbs: number }>('SELECT golds,rmbs FROM bbs_user WHERE uid = ?')
    .bind(v.uid)
    .first<{ golds: number; rmbs: number }>();
  return ok(c, t('credits.updateDone'), { data: { golds: Number(after?.golds ?? 0), rmbs: Number(after?.rmbs ?? 0) } });
}

/* ------------------------------------------------------------------ *
 * POST /api/me/credits/transfer —— 三币种转账
 * ------------------------------------------------------------------ */
async function transfer(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core0 = core(c);
  const { db, cache } = core0;
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const b = await readJson<{ username?: string; num?: number | string; creditType?: number | string }>(c);
  const num = Math.floor(Number(b.num ?? 0));
  if (!Number.isFinite(num) || num <= 0) throw new AppError(Code.VALIDATION_ERROR, t('common.invalidPositive'));
  const toUsername = String(b.username ?? '').trim();
  if (!toUsername) throw new AppError(Code.VALIDATION_ERROR, t('credits.usernameRequired'));
  const creditTypeRaw = Number(b.creditType ?? 0);
  if (!creditTypeCol(creditTypeRaw)) throw new AppError(Code.VALIDATION_ERROR, t('credits.segmentEmpty'));

  const to = await db
    .prepare<{ uid: number }>('SELECT uid FROM bbs_user WHERE username = ?')
    .bind(toUsername)
    .first<{ uid: number }>();
  if (!to) throw new AppError(Code.NOT_FOUND, t('common.userNotFoundEx'));
  const toUid = Number(to.uid);
  if (toUid === v.uid) throw new AppError(Code.VALIDATION_ERROR, t('credits.selfTransfer'));

  const col = creditTypeCol(creditTypeRaw)!;
  const before = await db
    .prepare<{ balance: number }>(`SELECT ${col} AS balance FROM bbs_user WHERE uid = ?`)
    .bind(v.uid)
    .first<{ balance: number }>();
  if (!before || Number(before.balance) < num) throw new AppError(Code.FORM_INSUFFICIENT_CREDITS, t('credits.balanceInsufficient'));

  const ts = now();
  const nonce = nonceOf();
  const anchor = 'EXISTS (SELECT 1 FROM bbs_user_pay WHERE uid = ? AND nonce = ?)';
  const stmts: Stmt[] = [
    // ① 发起方流水锚行（type=12；余额不足时 SELECT 不产出行 → changes=0）
    db
      .prepare(
        `INSERT INTO bbs_user_pay (uid,status,num,type,credit_type,code,time,nonce)
         SELECT ?,1,?,12,?,'',?,? FROM bbs_user WHERE uid = ? AND ${col} >= ?`,
      )
      .bind(v.uid, num, creditTypeRaw, ts, nonce, v.uid, num) as unknown as Stmt,
    // ② 发起方扣减
    db
      .prepare(`UPDATE bbs_user SET ${col} = ${col} - ? WHERE uid = ? AND ${col} >= ? AND ${anchor}`)
      .bind(num, v.uid, num, v.uid, nonce) as unknown as Stmt,
    // ③ 接收方入账
    db
      .prepare(`UPDATE bbs_user SET ${col} = ${col} + ? WHERE uid = ? AND ${anchor}`)
      .bind(num, toUid, v.uid, nonce) as unknown as Stmt,
    // ④ 接收方流水（type=13）
    db
      .prepare(
        `INSERT INTO bbs_user_pay (uid,status,num,type,credit_type,code,time,nonce)
         SELECT ?,1,?,13,?,'',?,? WHERE EXISTS (SELECT 1 FROM bbs_user_pay WHERE uid = ? AND nonce = ?)`,
      )
      .bind(toUid, num, creditTypeRaw, ts, `${nonce}:in`, v.uid, nonce) as unknown as Stmt,
  ];
  if (col === 'credits') {
    // 经验转账补账本（铁律：credits 变动必留 point_log）
    stmts.push(
      db
        .prepare(
          `INSERT INTO bbs_point_log (uid,change,balance,reason,biz_key,create_date)
           SELECT uid,?,credits,'transfer_out',?,? FROM bbs_user WHERE uid = ? AND ${anchor}`,
        )
        .bind(-num, `transfer:${nonce}`, ts, v.uid, v.uid, nonce) as unknown as Stmt,
      db
        .prepare(
          `INSERT INTO bbs_point_log (uid,change,balance,reason,biz_key,create_date)
           SELECT uid,?,credits,'transfer_in',?,? FROM bbs_user WHERE uid = ? AND ${anchor}`,
        )
        .bind(num, `transfer:${nonce}:in`, ts, toUid, v.uid, nonce) as unknown as Stmt,
    );
  }

  let results: { meta?: { changes?: number } }[];
  try {
    results = (await db.batch(stmts)) as unknown as { meta?: { changes?: number } }[];
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed/i.test(msg)) throw new AppError(Code.VALIDATION_ERROR, t('credits.transferDuplicate'));
    throw e;
  }
  if (Number(results[0]?.meta?.changes ?? 0) <= 0 || Number(results[1]?.meta?.changes ?? 0) <= 0) {
    throw new AppError(Code.FORM_INSUFFICIENT_CREDITS, t('credits.balanceInsufficient'));
  }

  await cache.del(`user:${toUid}`);
  return ok(c, t('credits.transferDone'), { data: { toUid, num, creditType: creditTypeRaw } });
}

/* ------------------------------------------------------------------ *
 * GET /api/me/credits/record —— 积分变动记录
 * ------------------------------------------------------------------ */
async function myRecord(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const { db, cache } = core(c);
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const page = Math.max(1, intParam(c.req.query('page'), 1));
  const cnt = await db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_user_pay WHERE uid = ?').bind(v.uid).first<{ c: number }>();
  const total = Number(cnt?.c ?? 0);
  const rows = await db
    .prepare<{ cid: number; status: number; num: number; type: number; credit_type: number; code: string; time: number }>(
      'SELECT cid,status,num,type,credit_type,code,time FROM bbs_user_pay WHERE uid = ? ORDER BY time DESC, cid DESC LIMIT ? OFFSET ?',
    )
    .bind(v.uid, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    .all();
  return ok(c, 'ok', {
    data: {
      total,
      page,
      size: PAGE_SIZE,
      totalPage: totalPageOf(total, PAGE_SIZE),
      list: rows.results.map((r) => {
        const ct = Number(r.credit_type);
        const num = Number(r.num);
        const display = ct === 3 ? num / 100 : num;
        return {
          cid: Number(r.cid),
          time: Number(r.time),
          type: Number(r.type),
          typeName: payTypeName(t, Number(r.type)),
          status: Number(r.status),
          statusName: payStatusName(t, Number(r.status)),
          num,
          displayNum: display, // 人民币（分）已折算为元
          creditType: ct,
          creditName: ct === 1 || ct === 2 || ct === 3 ? creditTypeLabel(t, ct) : '',
          code: String(r.code ?? ''),
        };
      }),
    },
  });
}

/* ------------------------------------------------------------------ *
 * GET /api/me/credits/purchased —— 已购主题列表（套主题列表卡）
 * ------------------------------------------------------------------ */
async function myPurchased(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const { db, cache } = core(c);
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const page = Math.max(1, intParam(c.req.query('page'), 1));
  const cnt = await db
    .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_paylist p JOIN bbs_thread t ON t.tid = p.tid WHERE p.uid = ? AND p.type = 1')
    .bind(v.uid)
    .first<{ c: number }>();
  const total = Number(cnt?.c ?? 0);
  const rows = await db
    .prepare<Record<string, unknown>>(
      `SELECT ${THREAD_LIST_COLS_T} FROM bbs_paylist p JOIN bbs_thread t ON t.tid = p.tid
       WHERE p.uid = ? AND p.type = 1 ORDER BY p.paytime DESC, p.plid DESC LIMIT ? OFFSET ?`,
    )
    .bind(v.uid, PAGE_SIZE, (page - 1) * PAGE_SIZE)
    .all();
  // 行投影由前端 ThreadList 卡片消费（与 /api/threads 同一列集口径）
  return ok(c, 'ok', {
    data: { total, page, size: PAGE_SIZE, totalPage: totalPageOf(total, PAGE_SIZE), list: rows.results },
  });
}

export function creditsRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();
  app.post('/api/threads/:tid/pay', payThread);
  app.get('/api/threads/:tid/paylist', threadPaylist);
  app.get('/api/me/credits', myCredits);
  app.post('/api/me/credits/exchange', exchange);
  app.post('/api/me/credits/transfer', transfer);
  app.get('/api/me/credits/record', myRecord);
  app.get('/api/me/credits/purchased', myPurchased);
  return app;
}