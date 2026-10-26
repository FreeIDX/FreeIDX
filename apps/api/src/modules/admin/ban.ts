/**
 * 小黑屋后台接口（0025）：
 *   GET    /api/admin/users/banned          生效中的封禁列表（keyword 模糊匹配用户名/邮箱）
 *   GET    /api/admin/users/:uid/bans       某用户封禁历史（bbs_user_ban）
 *   POST   /api/admin/users/:uid/ban        {scope,until|duration,reason} 单用户封禁
 *   POST   /api/admin/users/:uid/unban      解封
 *   POST   /api/admin/users/bans            {uids[],scope,until|duration,reason} 批量封禁（≤50）
 *
 * 语义（能力模型见 @freeidx/shared 的 BanScope）：
 *   scope 位掩码 1 禁言 / 2 禁访 / 4 禁登，可组合；until=0 永久，duration 为「从现在起 N 秒」。
 *   只有命中 LOGIN 位才吊销会话（token_version+1 + 删 bbs_session + 清 user:{uid}）；
 *   禁言/禁访保留登录态（用户仍可登录查看原因），仅清 user:{uid} 让闸门立即生效。
 *
 * 防误伤：不允许封禁 gid=1、不允许封自己；批量里命中的非法目标进 skipped 而非整批失败。
 * 全部路由挂在 adminGuard（app.use('/api/admin/*')）之后。
 */
import { Hono } from 'hono';
import { BAN_REASON_MAX, BAN_SCOPE_MAX, BanScope, Code, GroupId } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { D1b, Stmt } from '../../core/db';
import type { ApiT } from '../../core/i18n';
import { banMessage } from '../../core/ban';
import { NoticeType, escapeHtml } from '../../core/notice';
import { adminUidOf, core, intParam, readJson, totalPageOf, type ReadEnv } from '../shared';

const now = () => Math.floor(Date.now() / 1000);
const BATCH_MAX = 50;

interface BanInput {
  scope: number;
  until: number;
  reason: string;
}

interface TargetRow {
  uid: number;
  gid: number;
  username: string;
}

/** 请求体 → 归一化封禁参数（scope 必须 1..7；until 与 duration 二选一，0=永久） */
function parseBanInput(b: Record<string, unknown>, t: ApiT, ts: number): BanInput {
  const scope = Math.trunc(Number(b.scope));
  if (!Number.isInteger(scope) || scope < 1 || scope > BAN_SCOPE_MAX) {
    throw new AppError(Code.VALIDATION_ERROR, t('ban.scopeInvalid'));
  }
  let until = 0;
  if ('until' in b && b.until != null && b.until !== '') {
    until = Math.trunc(Number(b.until));
  } else if ('duration' in b && b.duration != null && b.duration !== '') {
    const d = Math.trunc(Number(b.duration));
    until = d > 0 ? ts + d : 0;
  }
  if (!Number.isFinite(until) || until < 0) throw new AppError(Code.VALIDATION_ERROR, t('ban.untilInvalid'));
  if (until > 0 && until <= ts) throw new AppError(Code.VALIDATION_ERROR, t('ban.untilInvalid'));

  const reason = String(b.reason ?? '').trim();
  if ([...reason].length > BAN_REASON_MAX) throw new AppError(Code.VALIDATION_ERROR, t('ban.reasonTooLong', { n: BAN_REASON_MAX }));
  return { scope, until, reason };
}

async function loadTarget(db: D1b, uid: number, t: ApiT): Promise<TargetRow> {
  const row = await db
    .prepare<TargetRow>('SELECT uid,gid,username FROM bbs_user WHERE uid = ?')
    .bind(uid)
    .first<TargetRow>();
  if (!row) throw new AppError(Code.NOT_FOUND, t('common.userNotFound'));
  if (Number(row.gid) === GroupId.ADMIN) throw new AppError(Code.NO_PERMISSION, t('ban.targetIsAdmin'));
  return row;
}

/** 单条封禁的语句组（批量复用）：只有 LOGIN 位才吊销会话 */
function banStmts(core: { db: D1b }, args: {
  uid: number;
  scope: number;
  until: number;
  reason: string;
  operator: number;
  username: string;
  ts: number;
  t: ApiT;
}): Stmt[] {
  const { db } = core;
  const { uid, scope, until, reason, operator, ts, t } = args;
  const kick = (scope & BanScope.LOGIN) !== 0;
  const stmts: Stmt[] = [
    db
      .prepare(
        `UPDATE bbs_user SET ban_scope = ?, ban_until = ?, ban_reason = ?, ban_at = ?, ban_by = ?${kick ? ', token_version = token_version + 1' : ''} WHERE uid = ?`,
      )
      .bind(scope, until, reason, ts, operator, uid),
    db
      .prepare('INSERT INTO bbs_user_ban (uid, scope, reason, operator_uid, create_date, expire_date) VALUES (?,?,?,?,?,?)')
      .bind(uid, scope, reason, operator, ts, until),
    // 站内通知（bbs_notice type=3 系统）：正文为服务端受限 HTML，用户输入一律转义
    db
      .prepare('INSERT INTO bbs_notice (fromuid,recvuid,create_date,isread,type,message) VALUES (?,?,?,0,?,?)')
      .bind(operator, uid, ts, NoticeType.SYSTEM, escapeHtml(banMessage(scope, until, reason, t))),
  ];
  if (kick) stmts.push(db.prepare('DELETE FROM bbs_session WHERE uid = ?').bind(uid));
  return stmts;
}

export function adminBanRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  // ---------------- 生效中的封禁列表（小黑屋） ----------------
  app.get('/api/admin/users/banned', async (c) => {
    const { db } = core(c);
    const keyword = String(c.req.query('keyword') ?? '').trim();
    const page = Math.max(1, intParam(c.req.query('page'), 1));
    const size = Math.min(100, Math.max(1, intParam(c.req.query('size'), 20)));
    const ts = now();

    /** 生效口径与 effectiveBanScope 一致：ban_scope>0 且（永久 或 未到期） */
    const where = ['ban_scope > 0', '(ban_until = 0 OR ban_until > ?)'];
    const binds: (string | number)[] = [ts];
    if (keyword) {
      // 与 /api/admin/users 的精确匹配不同：小黑屋列表按模糊搜（运营排查场景）
      where.push('(username LIKE ? OR email LIKE ?)');
      binds.push(`%${keyword}%`, `%${keyword}%`);
    }
    const whereSql = where.join(' AND ');

    const total = await db
      .prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM bbs_user WHERE ${whereSql}`)
      .bind(...binds)
      .first<{ c: number }>();
    const rows = await db
      .prepare<Record<string, number | string>>(
        `SELECT uid,gid,username,email,ban_scope,ban_until,ban_reason,ban_at,ban_by
         FROM bbs_user WHERE ${whereSql} ORDER BY ban_at DESC, uid DESC LIMIT ? OFFSET ?`,
      )
      .bind(...binds, size, (page - 1) * size)
      .all();

    // 操作人用户名批量补（避免逐行 JOIN 或 N 次查询）
    const opUids = [...new Set(rows.results.map((r) => Number(r.ban_by)).filter((n) => n > 0))];
    const opMap = new Map<number, string>();
    if (opUids.length) {
      const ops = await db
        .prepare<{ uid: number; username: string }>(`SELECT uid,username FROM bbs_user WHERE uid IN (${opUids.map(() => '?').join(',')})`)
        .bind(...opUids)
        .all();
      for (const o of ops.results) opMap.set(Number(o.uid), String(o.username));
    }

    const list = rows.results.map((r) => ({
      uid: Number(r.uid),
      gid: Number(r.gid),
      username: String(r.username),
      email: String(r.email ?? ''),
      ban_scope: Number(r.ban_scope),
      ban_until: Number(r.ban_until),
      ban_reason: String(r.ban_reason ?? ''),
      ban_at: Number(r.ban_at),
      ban_by: Number(r.ban_by),
      ban_by_name: opMap.get(Number(r.ban_by)) ?? '',
    }));
    const totalN = Number(total?.c ?? 0);
    return ok(c, 'ok', { data: { total: totalN, page, size, totalPage: totalPageOf(totalN, size), list } });
  });

  // ---------------- 某用户封禁历史 ----------------
  app.get('/api/admin/users/:uid/bans', async (c) => {
    const { db } = core(c);
    const t = c.get('t');
    const uid = intParam(c.req.param('uid'));
    if (!uid) throw new AppError(Code.VALIDATION_ERROR, t('common.uidInvalid'));
    const rows = await db
      .prepare<Record<string, number | string | null>>(
        `SELECT b.bid,b.scope,b.reason,b.operator_uid,b.create_date,b.expire_date,b.lifted_at,b.lifted_by,u.username AS operator_name
         FROM bbs_user_ban b LEFT JOIN bbs_user u ON u.uid = b.operator_uid
         WHERE b.uid = ? ORDER BY b.bid DESC LIMIT 50`,
      )
      .bind(uid)
      .all();
    const list = rows.results.map((r) => ({
      bid: Number(r.bid),
      scope: Number(r.scope),
      reason: String(r.reason ?? ''),
      operator_uid: Number(r.operator_uid),
      operator_name: String(r.operator_name ?? ''),
      create_date: Number(r.create_date),
      expire_date: Number(r.expire_date),
      lifted_at: Number(r.lifted_at),
      lifted_by: Number(r.lifted_by),
    }));
    return ok(c, 'ok', { data: { uid, list } });
  });

  // ---------------- 单用户封禁 ----------------
  app.post('/api/admin/users/:uid/ban', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const uid = intParam(c.req.param('uid'));
    if (!uid) throw new AppError(Code.VALIDATION_ERROR, t('common.uidInvalid'));

    const operator = await adminUidOf(c);
    if (uid === operator) throw new AppError(Code.NO_PERMISSION, t('ban.targetSelf'));
    const target = await loadTarget(db, uid, t);
    const ts = now();
    const input = parseBanInput(await readJson(c), t, ts);

    await db.batch(banStmts({ db }, { uid, ...input, operator, username: target.username, ts, t }));
    await cache.del(`user:${uid}`);
    return ok(c, t('ban.banned'), { data: { uid, ...input } });
  });

  // ---------------- 解封 ----------------
  app.post('/api/admin/users/:uid/unban', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const uid = intParam(c.req.param('uid'));
    if (!uid) throw new AppError(Code.VALIDATION_ERROR, t('common.uidInvalid'));

    const operator = await adminUidOf(c);
    const ts = now();
    const target = await loadTarget(db, uid, t);
    await db.batch([
      db
        .prepare("UPDATE bbs_user SET ban_scope = 0, ban_until = 0, ban_reason = '', ban_at = 0, ban_by = 0 WHERE uid = ?")
        .bind(uid),
      db.prepare('UPDATE bbs_user_ban SET lifted_at = ?, lifted_by = ? WHERE uid = ? AND lifted_at = 0').bind(ts, operator, uid),
    ]);
    await cache.del(`user:${uid}`);
    return ok(c, t('ban.unbanned'), { data: { uid, username: target.username } });
  });

  // ---------------- 批量封禁 ----------------
  app.post('/api/admin/users/bans', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const b = await readJson(c);
    const raw = Array.isArray(b.uids) ? (b.uids as unknown[]) : [];
    const uids = [...new Set(raw.map((v) => Math.trunc(Number(v))).filter((n) => Number.isInteger(n) && n > 0))];
    if (!uids.length) throw new AppError(Code.VALIDATION_ERROR, t('ban.uidsRequired'));
    if (uids.length > BATCH_MAX) throw new AppError(Code.VALIDATION_ERROR, t('ban.batchTooLarge', { n: BATCH_MAX }));

    const operator = await adminUidOf(c);
    const ts = now();
    const input = parseBanInput(b, t, ts);

    const targets = await db
      .prepare<TargetRow>(`SELECT uid,gid,username FROM bbs_user WHERE uid IN (${uids.map(() => '?').join(',')})`)
      .bind(...uids)
      .all();
    const byUid = new Map(targets.results.map((r) => [Number(r.uid), r]));

    const affected: number[] = [];
    const skipped: number[] = [];
    const stmts: Stmt[] = [];
    for (const uid of uids) {
      const target = byUid.get(uid);
      if (!target || Number(target.gid) === GroupId.ADMIN || uid === operator) {
        skipped.push(uid);
        continue;
      }
      stmts.push(...banStmts({ db }, { uid, ...input, operator, username: target.username, ts, t }));
      affected.push(uid);
    }
    if (!stmts.length) throw new AppError(Code.NO_PERMISSION, t('ban.targetIsAdmin'));

    await db.batch(stmts);
    for (const uid of affected) await cache.del(`user:${uid}`);
    return ok(c, t('ban.banned'), { data: { uids: affected, skipped, ...input } });
  });

  return app;
}
