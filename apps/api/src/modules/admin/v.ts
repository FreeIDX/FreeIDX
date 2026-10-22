/**
 * 加V认证后台接口：
 *   GET  /api/admin/v/applies  ?status=0|1 &page  审核两列表（status=0 待审核 / 1 已通过，create_time 倒序 20/页）
 *   POST /api/admin/v/pass     {uid}              通过：user.v = 申请头衔 + status=1 + 系统通知「恭喜！加V认证成功！」
 *   POST /api/admin/v/reject   {uid, remark?}     拒绝：status=-1 + 系统通知「很抱歉！您的加V认证审核未通过！」
 *   GET  /api/admin/v/user     ?username          按用户名查询当前头衔（op=0，查无此人 NO_SUCH_USER）
 *   PUT  /api/admin/v/user     {username, v}      按用户名直接设置头衔（op=1，手动加V/改V）
 *   GET  /api/admin/v/setting                    收费参数（op=2 读取侧）
 *   PUT  /api/admin/v/setting  {type, count}      保存收费参数（op=2）
 * 全部路由挂在 adminGuard 之后（app.use('/api/admin/*')）。
 */
import { Hono } from 'hono';
import { Code } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { saveExtConfig } from '../../core/ext-store';
import { noticeSend, NoticeType } from '../../core/notice';
import { core, intParam, readJson, totalPageOf, type ReadEnv } from '../shared';
import { loadVFee, V_EXT_ID } from '../v/routes';
import type { Cache } from '../../core/cache';

const PAGE_SIZE = 20;

export function adminVRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  // ---------------- 审核两列表 ----------------
  app.get('/api/admin/v/applies', async (c) => {
    const { db } = core(c);
    const status = intParam(c.req.query('status'), 0);
    const page = Math.max(1, intParam(c.req.query('page'), 1));
    const where = status === 1 ? 'WHERE a.status = 1' : 'WHERE a.status = 0'; // 仅 0/1 两列表
    const cnt = await db.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM bbs_v_apply a ${where}`).first<{ c: number }>();
    const total = Number(cnt?.c ?? 0);
    const rows = await db
      .prepare<{ uid: number; username: string; v: string; v_info: string; v_file: string; status: number; remark: string; create_time: number }>(
        `SELECT a.uid, u.username, a.v, a.v_info, a.v_file, a.status, a.remark, a.create_time
         FROM bbs_v_apply a LEFT JOIN bbs_user u ON u.uid = a.uid
         ${where} ORDER BY a.create_time DESC LIMIT ? OFFSET ?`,
      )
      .bind(PAGE_SIZE, (page - 1) * PAGE_SIZE)
      .all();
    return ok(c, 'ok', {
      data: {
        total,
        page,
        size: PAGE_SIZE,
        totalPage: totalPageOf(total, PAGE_SIZE),
        list: rows.results.map((r) => ({
          uid: Number(r.uid),
          username: String(r.username ?? ''),
          v: String(r.v ?? ''),
          vInfo: String(r.v_info ?? ''),
          vFile: String(r.v_file ?? ''),
          status: Number(r.status),
          remark: String(r.remark ?? ''),
          createTime: Number(r.create_time),
        })),
      },
    });
  });

  // ---------------- 通过 ----------------
  app.post('/api/admin/v/pass', async (c) => {
    const { db } = core(c);
    const t = c.get('t');
    const b = await readJson(c);
    const uid = Number(b.uid);
    if (!Number.isInteger(uid) || uid <= 0) throw new AppError(Code.VALIDATION_ERROR, t('common.paramError'));
    const apply = await db
      .prepare<{ v: string; status: number }>('SELECT v,status FROM bbs_v_apply WHERE uid = ?')
      .bind(uid)
      .first<{ v: string; status: number }>();
    if (!apply) throw new AppError(Code.NOT_FOUND, t('common.applyNotFound'));
    // 仅待审（status=0）可「通过」：已拒绝（-1）的申请不在任何列表可见，误操作会无感翻转拒绝决定且不可追溯
    if (Number(apply.status) !== 0) throw new AppError(Code.VALIDATION_ERROR, t('v.alreadyHandled'));
    await db.prepare('UPDATE bbs_user SET v = ? WHERE uid = ?').bind(String(apply.v ?? '').slice(0, 200), uid).run();
    await db.prepare('UPDATE bbs_v_apply SET status = 1 WHERE uid = ?').bind(uid).run();
    await noticeSend(db, { fromuid: 1, recvuid: uid, message: t('v.passedNotice'), type: NoticeType.SYSTEM });
    return ok(c, t('v.passed'), { data: { uid } });
  });

  // ---------------- 拒绝（remark 为项目可用性增强，前端 prompt 输入） ----------------
  app.post('/api/admin/v/reject', async (c) => {
    const { db } = core(c);
    const t = c.get('t');
    const b = await readJson(c);
    const uid = Number(b.uid);
    if (!Number.isInteger(uid) || uid <= 0) throw new AppError(Code.VALIDATION_ERROR, t('common.paramError'));
    const apply = await db.prepare<{ status: number }>('SELECT status FROM bbs_v_apply WHERE uid = ?').bind(uid).first<{ status: number }>();
    // 先校验申请存在且待审：UPDATE 影响 0 行不报错的话，输错 uid 也会让无辜用户收到「认证未通过」通知
    if (!apply) throw new AppError(Code.NOT_FOUND, t('common.applyNotFound'));
    if (Number(apply.status) !== 0) throw new AppError(Code.VALIDATION_ERROR, t('v.alreadyHandled'));
    const remark = String(b.remark ?? '').trim().slice(0, 255);
    await db.prepare('UPDATE bbs_v_apply SET status = -1, remark = ? WHERE uid = ?').bind(remark, uid).run();
    await noticeSend(db, { fromuid: 1, recvuid: uid, message: t('v.rejectedNotice'), type: NoticeType.SYSTEM });
    return ok(c, t('v.rejected'), { data: { uid } });
  });

  // ---------------- 手动加V：查询（op=0）/ 设置（op=1） ----------------
  app.get('/api/admin/v/user', async (c) => {
    const { db } = core(c);
    const t = c.get('t');
    const username = String(c.req.query('username') ?? '').trim();
    if (!username) throw new AppError(Code.VALIDATION_ERROR, t('auth.usernameRequired'));
    const u = await db
      .prepare<{ uid: number; username: string; v: string }>('SELECT uid,username,v FROM bbs_user WHERE username = ?')
      .bind(username)
      .first<{ uid: number; username: string; v: string }>();
    if (!u) throw new AppError(Code.NOT_FOUND, 'NO_SUCH_USER'); // 错误码原文 NO_SUCH_USER
    return ok(c, 'ok', { data: { uid: Number(u.uid), username: String(u.username), v: String(u.v ?? '0') } });
  });

  app.put('/api/admin/v/user', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const b = await readJson(c);
    const username = String(b.username ?? '').trim();
    const v = String(b.v ?? '').trim().slice(0, 200) || '0';
    if (!username) throw new AppError(Code.VALIDATION_ERROR, t('auth.usernameRequired'));
    const u = await db.prepare<{ uid: number }>('SELECT uid FROM bbs_user WHERE username = ?').bind(username).first<{ uid: number }>();
    if (!u) throw new AppError(Code.NOT_FOUND, 'NO_SUCH_USER');
    await db.prepare('UPDATE bbs_user SET v = ? WHERE uid = ?').bind(v, Number(u.uid)).run();
    await cache.del(`user:${u.uid}`);
    return ok(c, t('common.setDone'), { data: { uid: Number(u.uid), v } });
  });

  // ---------------- 收费参数（op=2） ----------------
  app.get('/api/admin/v/setting', async (c) => {
    const { db, cache } = core(c);
    return ok(c, 'ok', { data: await loadVFee(db, cache as Cache) });
  });

  app.put('/api/admin/v/setting', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const b = await readJson(c);
    const type = String(b.type ?? 'golds');
    if (type !== 'credits' && type !== 'golds' && type !== 'rmbs') throw new AppError(Code.VALIDATION_ERROR, t('admin.currencyInvalid'));
    const count = Number(b.count);
    if (!Number.isInteger(count) || count < 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.feeInvalid'));
    await saveExtConfig(db, cache, V_EXT_ID, { type, count });
    return ok(c, t('common.setDone'), { data: { type, count } });
  });

  return app;
}
