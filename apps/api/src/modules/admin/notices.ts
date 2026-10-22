/**
 * 消息管理后台接口（huux_notice 后台）：
 *   GET    /api/admin/notices        ?page&size            全部消息（nid 倒序，含收发双方名/头像 + 关联公告状态）
 *   POST   /api/admin/notices        {recvuid,message,announcement?}  发送系统通知（type=3，fromuid=管理员；announcement=1 同步发首页公告）
 *   DELETE /api/admin/notices/:nid                         删除单条（级联删关联公告）
 *   PUT    /api/admin/notices/:nid/announcement {isshow}   切换关联公告显示开关（0 隐藏 / 1 显示）
 * 全部路由挂在 adminGuard 之后（app.use('/api/admin/*')）；发送者 uid 取 admin_at token（操作者真实身份）。
 */
import { Hono, type Context } from 'hono';
import { Code } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { NoticeType, noticeSend, escapeHtml } from '../../core/notice';
import type { Stmt } from '../../core/db';
import { adminUidOf, core, intParam, totalPageOf, type ReadEnv } from '../shared';

type Ctx = Context<ReadEnv>;

export function adminNoticeRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  // ---------------- 全部消息列表 ----------------
  app.get('/api/admin/notices', async (c: Ctx) => {
    const { db } = core(c);
    const page = Math.max(1, intParam(c.req.query('page'), 1));
    const size = Math.min(100, Math.max(1, intParam(c.req.query('size'), 20)));
    const cnt = await db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_notice').first<{ c: number }>();
    const total = Number(cnt?.c ?? 0);
    const rows = await db
      .prepare<Record<string, unknown>>(
        `SELECT n.nid, n.fromuid, n.recvuid, n.create_date, n.isread, n.type, n.message,
                fu.username AS from_username, fu.avatar AS from_avatar,
                ru.username AS recv_username, ru.avatar AS recv_avatar,
                a.aid AS ann_aid, a.isshow AS ann_isshow
         FROM bbs_notice n
         LEFT JOIN bbs_user fu ON fu.uid = n.fromuid
         LEFT JOIN bbs_user ru ON ru.uid = n.recvuid
         LEFT JOIN bbs_announcement a ON a.nid = n.nid
         ORDER BY n.nid DESC LIMIT ? OFFSET ?`,
      )
      .bind(size, (page - 1) * size)
      .all();
    return ok(c, 'ok', { data: { total, page, size, totalPage: totalPageOf(total, size), list: rows.results } });
  });

  // ---------------- 发送系统通知 ----------------
  app.post('/api/admin/notices', async (c: Ctx) => {
    const { db } = core(c);
    const t = c.get('t');
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!b) throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
    const recvuid = Number(b.recvuid);
    // 发送入口为纯文本语义，但前台 MePage / 后台列表均以 innerHTML 渲染 notice message：
    // 与 sendPm 同口径先转义，杜绝经系统通知注入任意 HTML/脚本（存储型 XSS）。
    const message = escapeHtml(String(b.message ?? '').trim());
    if (!message) throw new AppError(Code.VALIDATION_ERROR, t('admin.contentRequired'));
    if (!Number.isInteger(recvuid) || recvuid <= 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.recvRequired'));
    const target = await db.prepare<{ uid: number }>('SELECT uid FROM bbs_user WHERE uid = ?').bind(recvuid).first<{ uid: number }>();
    if (!target) throw new AppError(Code.VALIDATION_ERROR, t('common.userNotFound'));
    const fromUid = await adminUidOf(c);
    const nid = await noticeSend(db, { fromuid: fromUid, recvuid, message, type: NoticeType.SYSTEM });
    if (!nid) throw new AppError(Code.SYSTEM_ERROR, t('admin.sendFailed'));
    /* 公告开关（本项目新增）：勾选时同步落首页公告（bbs_announcement），isshow=1 立即显示 */
    let aid = 0;
    if (Number(b.announcement) === 1 || b.announcement === true) {
      const r = await db
        .prepare<{ aid: number }>('INSERT INTO bbs_announcement (nid,message,isshow,create_date) VALUES (?,?,1,?) RETURNING aid')
        .bind(nid, message, Math.floor(Date.now() / 1000))
        .first<{ aid: number }>();
      aid = Number(r?.aid ?? 0);
    }
    return ok(c, t('admin.sendDone'), { data: { nid, aid } });
  });

  // ---------------- 公告显示开关 ----------------
  app.put('/api/admin/notices/:nid/announcement', async (c: Ctx) => {
    const { db } = core(c);
    const t = c.get('t');
    const nid = intParam(c.req.param('nid'));
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const isshow = Number(b?.isshow) === 1 ? 1 : 0;
    const ann = await db
      .prepare<{ aid: number }>('SELECT aid FROM bbs_announcement WHERE nid = ?')
      .bind(nid)
      .first<{ aid: number }>();
    if (!ann) throw new AppError(Code.NOT_FOUND, t('admin.noAnnouncement'));
    await db.prepare('UPDATE bbs_announcement SET isshow = ? WHERE aid = ?').bind(isshow, ann.aid).run();
    return ok(c, isshow ? t('admin.showOn') : t('admin.showOff'), { data: { nid, isshow } });
  });

  // ---------------- 删除单条 ----------------
  app.delete('/api/admin/notices/:nid', async (c: Ctx) => {
    const { db } = core(c);
    const t = c.get('t');
    const nid = intParam(c.req.param('nid'));
    const n = await db.prepare<{ nid: number }>('SELECT nid FROM bbs_notice WHERE nid = ?').bind(nid).first<{ nid: number }>();
    if (!n) throw new AppError(Code.NOT_FOUND, t('common.noticeNotFound'));
    /* 级联删关联公告（0011：nid 关联源消息） */
    await db.batch([
      db.prepare('DELETE FROM bbs_notice WHERE nid = ?').bind(nid) as unknown as Stmt,
      db.prepare('DELETE FROM bbs_announcement WHERE nid = ?').bind(nid) as unknown as Stmt,
    ]);
    return ok(c, t('notice.deleted'), { data: { nid } });
  });

  return app;
}