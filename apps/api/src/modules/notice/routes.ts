/**
 * 我的消息（huux_notice）：
 *  GET    /api/my/notices?type=&before_nid=  消息列表（nid 倒序游标；type 0=全部，2=评论，3=系统，99=其他）
 *  POST   /api/my/notices/read-all           全部标记已读
 *  POST   /api/my/notices/:nid/read          单条标记已读
 *  DELETE /api/my/notices/:nid               单条删除（校验归属）
 *  POST   /api/my/notices/delete-batch       删除本页消息（nid 属本人）
 * 未读数为实时 COUNT（bbs_notice 计数口径见 0006 迁移），写操作回传最新值同步导航铃铛。
 */
import { Hono, type Context } from 'hono';
import { Code, PageSize } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { loadViewer } from '../../core/loaders';
import { cursorCond } from '../../core/db/paginate';
import { escapeHtml, noticeSend, noticeTypeName, NoticeType } from '../../core/notice';
import type { Stmt } from '../../core/db';
import type { ReadEnv } from '../shared';
import { intParam } from '../shared';

type Ctx = Context<ReadEnv>;

async function unreadCount(c: Ctx, uid: number): Promise<number> {
  const r = await c
    .get('db')
    .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_notice WHERE recvuid = ? AND isread = 0')
    .bind(uid)
    .first<{ c: number }>();
  return Number(r?.c ?? 0);
}

async function requireUid(c: Ctx): Promise<number> {
  const t = c.get('t');
  const v = await loadViewer(c.get('cache'), c.get('db'), c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  return v.uid;
}

/** 列表（notice_find_by_recvuid）：JOIN 取发送者名/头像；type=0 不带类型条件 */
async function listNotices(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const uid = await requireUid(c);
  let type = intParam(c.req.query('type'));
  if (![NoticeType.ALL, NoticeType.COMMENT, NoticeType.SYSTEM, NoticeType.OTHER].includes(type as 0 | 2 | 3 | 99)) {
    type = NoticeType.ALL;
  }
  const size = PageSize.NOTICE_LIST;
  const before = intParam(c.req.query('before_nid')) || undefined;
  const cur = cursorCond({ column: 'n.nid', size, before, desc: true });
  const typeCond = type === NoticeType.ALL ? '' : 'AND n.type = ?';
  const binds: (number | string)[] = type === NoticeType.ALL ? [uid] : [uid, type];
  binds.push(...cur.params, size);
  const r = await db
    .prepare<Record<string, number | string>>(
      `SELECT n.nid, n.fromuid, n.recvuid, n.create_date, n.isread, n.type, n.message,
              u.username AS from_username, u.avatar AS from_avatar
       FROM bbs_notice n LEFT JOIN bbs_user u ON u.uid = n.fromuid
       WHERE n.recvuid = ? ${typeCond} ${cur.where} ${cur.order} LIMIT ?`,
    )
    .bind(...binds)
    .all();
  const list = r.results.map((x) => ({
    nid: Number(x.nid),
    fromUid: Number(x.fromuid),
    fromUsername: String(x.from_username ?? ''),
    fromAvatar: Number(x.from_avatar ?? 0),
    type: Number(x.type),
    name: noticeTypeName(t, Number(x.type)),
    isRead: Number(x.isread) === 1,
    createDate: Number(x.create_date),
    message: String(x.message),
  }));
  const last = list.at(-1);
  return ok(c, 'ok', {
    data: { list, size, nextCursor: last?.nid, unread: await unreadCount(c, uid) },
  });
}

async function readAll(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const uid = await requireUid(c);
  await db.prepare('UPDATE bbs_notice SET isread = 1 WHERE recvuid = ? AND isread = 0').bind(uid).run();
  return ok(c, t('notice.readAll'), { data: { unread: 0 } });
}

async function readOne(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const uid = await requireUid(c);
  const nid = intParam(c.req.param('nid'));
  const n = await db
    .prepare<{ recvuid: number }>('SELECT recvuid FROM bbs_notice WHERE nid = ?')
    .bind(nid)
    .first<{ recvuid: number }>();
  if (!n) throw new AppError(Code.NOT_FOUND, t('common.noticeNotFound'));
  if (Number(n.recvuid) !== uid) throw new AppError(Code.NO_PERMISSION, t('notice.permDenied'));
  await db.prepare('UPDATE bbs_notice SET isread = 1 WHERE nid = ?').bind(nid).run();
  return ok(c, t('notice.read'), { data: { nid, unread: await unreadCount(c, uid) } });
}

async function deleteOne(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const uid = await requireUid(c);
  const nid = intParam(c.req.param('nid'));
  const n = await db
    .prepare<{ recvuid: number }>('SELECT recvuid FROM bbs_notice WHERE nid = ?')
    .bind(nid)
    .first<{ recvuid: number }>();
  if (!n) throw new AppError(Code.NOT_FOUND, t('common.noticeNotFound'));
  if (Number(n.recvuid) !== uid) throw new AppError(Code.NO_PERMISSION, t('notice.permDenied'));
  await db.prepare('DELETE FROM bbs_notice WHERE nid = ?').bind(nid).run();
  return ok(c, t('notice.deleted'), { data: { nid, unread: await unreadCount(c, uid) } });
}

/** 删除本页消息（deletearr）：只删归属本人的 nid 集合 */
async function deleteBatch(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const uid = await requireUid(c);
  let b: { nids?: number[] };
  try {
    b = await c.req.json<{ nids?: number[] }>();
  } catch {
    throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
  }
  const nids = (Array.isArray(b.nids) ? b.nids : []).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  if (!nids.length) throw new AppError(Code.VALIDATION_ERROR, t('notice.selectToDelete'));
  const inList = nids.map(() => '?').join(',');
  const stmts: Stmt[] = [
    db.prepare(`DELETE FROM bbs_notice WHERE recvuid = ? AND nid IN (${inList})`).bind(uid, ...nids) as unknown as Stmt,
  ];
  const results = (await db.batch(stmts)) as unknown as { meta?: { changes?: number } }[];
  // 实际删除数（SQL 带 recvuid 过滤：他人的/不存在的 nid 不计入），原实现回的是提交数
  const deleted = Number(results[0]?.meta?.changes ?? nids.length);
  return ok(c, t('notice.deleted'), { data: { deleted, unread: await unreadCount(c, uid) } });
}

/**
 * 发送私信（type=7，正文结构：
 * comment-info 动作行 + single-comment 正文）；不能发给自己；用户输入一律转义后拼受限 HTML。
 */
async function sendPm(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const uid = await requireUid(c);
  let b: { uid?: number; message?: string };
  try {
    b = await c.req.json<{ uid?: number; message?: string }>();
  } catch {
    throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
  }
  const toUid = Math.max(0, Math.trunc(Number(b.uid ?? 0)));
  if (toUid === uid) throw new AppError(Code.VALIDATION_ERROR, t('notice.pmSelf'));
  const message = String(b.message ?? '').trim();
  if (!message) throw new AppError(Code.VALIDATION_ERROR, t('notice.pmEmpty'));
  if ([...message].length > 1000) throw new AppError(Code.VALIDATION_ERROR, t('notice.pmTooLong'));
  const target = await db.prepare<{ uid: number }>('SELECT uid FROM bbs_user WHERE uid = ?').bind(toUid).first<{ uid: number }>();
  if (!target) throw new AppError(Code.NOT_FOUND, t('common.userNotFound'));
  const html = `<div class="comment-info">${t('notice.pmReceived')}</div><div class="single-comment">${escapeHtml(message).replace(/\n/g, '<br/>')}</div>`;
  const nid = await noticeSend(db, { fromuid: uid, recvuid: toUid, type: NoticeType.PM, message: html });
  if (!nid) throw new AppError(Code.SYSTEM_ERROR, t('common.serverError'));
  return ok(c, t('notice.pmSent'), { data: { nid, uid: toUid } });
}

export function noticeRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();
  app.get('/api/my/notices', listNotices);
  app.post('/api/my/notices/read-all', readAll);
  app.post('/api/my/notices/delete-batch', deleteBatch);
  app.post('/api/my/notices/pm', sendPm);
  app.post('/api/my/notices/:nid/read', readOne);
  app.delete('/api/my/notices/:nid', deleteOne);

  /* 首页系统公告（本项目新增，0011）：游客可读，isshow=1，aid 倒序，最多 10 条供前台轮播 */
  app.get('/api/announcements', (c) => {
    return listAnnouncements(c);
  });
  return app;
}

/** 公告列表（bbs_announcement isshow=1，最多 10 条） */
async function listAnnouncements(c: Ctx): Promise<Response> {
  const rows = await c
    .get('db')
    .prepare<Record<string, unknown>>(
      'SELECT aid, message, create_date FROM bbs_announcement WHERE isshow = 1 ORDER BY aid DESC LIMIT 10',
    )
    .all();
  const list = rows.results.map((x) => ({
    aid: Number(x.aid),
    message: String(x.message ?? ''),
    createDate: Number(x.create_date ?? 0),
  }));
  return ok(c, 'ok', { data: { list } });
}