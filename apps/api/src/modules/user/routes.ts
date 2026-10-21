/**
 * 用户只读接口（T1-4 + T3-2）：
 *  GET /api/users/:uid            公开资料（零敏感列：无 email/ip/password）+ online/关注/粉丝计数
 *  GET /api/users/:uid/threads    我的主题（游标翻页 + 版块权限过滤）
 *  GET /api/users/:uid/posts      公开回帖列表（bbs_mypost 倒排，写侧真实维护）
 *  POST /api/users/:uid/follow    关注/取关 toggle（bbs_follow，A 组新增）
 *  GET /api/me/posts              本人回帖（登录态，复用同投影）
 */
import { Hono } from 'hono';
import { Code, PageSize } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { THREAD_LIST_COLS, USER_PUBLIC_COLS, T } from '../../core/db/columns';
import { cursorCond } from '../../core/db/paginate';
import { postListAccessFilter, threadListAccessFilter, type AccessCtx } from '../../core/access';
import { loadForumlist, loadGrouplist, loadViewer, makeAccessCtx } from '../../core/loaders';
import { core, intParam, avatarAutoOf, type ReadEnv } from '../shared';

/** 在线口径：bbs_session.last_date 距今 15 分钟内（与 /api/online 列表同源表） */
const ONLINE_WINDOW = 900;
const now = () => Math.floor(Date.now() / 1000);

interface ReplyRow {
  pid: number;
  tid: number;
  fid: number;
  top: number;
  uid: number;
  subject: string;
  message_fmt: string;
  create_date: number;
}

/** 回帖列表投影：mypost 倒排 JOIN post JOIN thread（单查询，游标按 mp.pid） */
async function fetchReplies(
  db: ReturnType<typeof core>['db'],
  ctx: AccessCtx,
  uid: number,
  beforePid: number | undefined,
): Promise<ReplyRow[]> {
  const size = PageSize.USER_THREAD_LIST;
  const cur = cursorCond({ column: 'mp.pid', size, before: beforePid, desc: true });
  const r = await db
    .prepare<ReplyRow>(
      `SELECT p.pid,p.tid,p.uid,p.create_date,p.message_fmt,t.fid,t.top,t.subject
       FROM bbs_mypost mp JOIN bbs_post p ON p.pid = mp.pid JOIN bbs_thread t ON t.tid = mp.tid
       WHERE mp.uid = ? ${cur.where} ${cur.order} LIMIT ?`,
    )
    .bind(uid, ...cur.params, size)
    .all();
  const rows = r.results.map((x) => ({
    pid: Number(x.pid),
    tid: Number(x.tid),
    fid: Number(x.fid),
    top: Number(x.top),
    uid: Number(x.uid),
    subject: String(x.subject),
    message_fmt: String(x.message_fmt),
    create_date: Number(x.create_date),
  }));
  const threadCtx = new Map<number, { fid: number; top: number }>(rows.map((x) => [x.tid, { fid: x.fid, top: x.top }]));
  return postListAccessFilter(ctx, rows, threadCtx);
}

export function userRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  app.get('/api/users/:uid', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const uid = intParam(c.req.param('uid'));
    const [grouplist, viewer] = await Promise.all([loadGrouplist(cache, db), loadViewer(cache, db, c)]);
    const u = await db
      .prepare<Record<string, number | string>>(`SELECT ${USER_PUBLIC_COLS} FROM bbs_user WHERE uid = ?`)
      .bind(uid)
      .first<Record<string, number | string>>();
    if (!u) throw new AppError(Code.NOT_FOUND, t('common.userNotFound'));
    const group = grouplist[Number(u.gid)];
    const avatarAuto = avatarAutoOf(Number(u.avatar), u.avatar_auto);

    // online + 社交计数并行取（A 组：A6 在线 / A3 关注）
    const ts = now();
    const [sess, followers, following, followed] = await Promise.all([
      db.prepare<{ last_date: number }>('SELECT last_date FROM bbs_session WHERE uid = ? ORDER BY last_date DESC LIMIT 1').bind(uid).first<{ last_date: number }>(),
      db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_follow WHERE followee_uid = ?').bind(uid).first<{ c: number }>(),
      db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_follow WHERE follower_uid = ?').bind(uid).first<{ c: number }>(),
      viewer.uid > 0
        ? db
            .prepare<{ x: number }>('SELECT 1 AS x FROM bbs_follow WHERE follower_uid = ? AND followee_uid = ?')
            .bind(viewer.uid, uid)
            .first<{ x: number }>()
        : Promise.resolve(null),
    ]);
    return ok(c, 'ok', {
      data: {
        uid: Number(u.uid),
        gid: Number(u.gid),
        groupName: String(group?.name ?? ''),
        username: String(u.username),
        avatar: Number(u.avatar),
        /** 预设头像路径（avatar=0 且 avatar_auto 非 '0' 时生效） */
        ...(avatarAuto ? { avatar_auto: avatarAuto } : {}),
        threads: Number(u.threads),
        posts: Number(u.posts),
        credits: Number(u.credits),
        createDate: Number(u.create_date),
        loginDate: Number(u.login_date),
        online: Number(sess?.last_date ?? 0) > ts - ONLINE_WINDOW,
        followers: Number(followers?.c ?? 0),
        following: Number(following?.c ?? 0),
        followed: Boolean(followed),
        /** 认证头衔（'0'=未认证；用户名旁 V 标 title） */
        v: String(u.v ?? '0'),
        /** 主页背景预设编号（'0'=默认 bg-0.png） */
        bgimg: String(u.bgimg ?? '0'),
      },
    });
  });

  /** POST /api/users/:uid/follow：关注/取关 toggle（不能关注自己） */
  app.post('/api/users/:uid/follow', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const viewer = await loadViewer(cache, db, c);
    if (viewer.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
    const uid = intParam(c.req.param('uid'));
    if (uid === viewer.uid) throw new AppError(Code.VALIDATION_ERROR, t('user.cannotFollowSelf'));
    const u = await db.prepare<{ uid: number }>('SELECT uid FROM bbs_user WHERE uid = ?').bind(uid).first<{ uid: number }>();
    if (!u) throw new AppError(Code.NOT_FOUND, t('common.userNotFound'));
    let existing = await db
      .prepare<{ follower_uid: number }>('SELECT follower_uid FROM bbs_follow WHERE follower_uid = ? AND followee_uid = ?')
      .bind(viewer.uid, uid)
      .first<{ follower_uid: number }>();
    if (existing) {
      await db.prepare('DELETE FROM bbs_follow WHERE follower_uid = ? AND followee_uid = ?').bind(viewer.uid, uid).run();
    } else {
      try {
        await db.prepare('INSERT INTO bbs_follow (follower_uid, followee_uid, create_date) VALUES (?, ?, ?)').bind(viewer.uid, uid, now()).run();
      } catch (e) {
        // 并发双击：两请求都查到「未关注」，第二个撞唯一约束 → 按已关注幂等成功（不 500、不误取关）
        const msg = e instanceof Error ? e.message : String(e);
        if (!/UNIQUE constraint failed/i.test(msg)) throw e;
        existing = { follower_uid: viewer.uid };
      }
    }
    const cnt = await db
      .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_follow WHERE followee_uid = ?')
      .bind(uid)
      .first<{ c: number }>();
    return ok(c, existing ? t('user.followCancelled') : t('user.followed'), { data: { followed: !existing, followers: Number(cnt?.c ?? 0) } });
  });

  app.get('/api/users/:uid/threads', async (c) => {
    const { db, cache } = core(c);
    const uid = intParam(c.req.param('uid'));
    const beforeTid = intParam(c.req.query('before_tid')) || undefined;
    const size = PageSize.THREAD_LIST;

    const [forumlist, grouplist, viewer] = await Promise.all([
      loadForumlist(cache, db),
      loadGrouplist(cache, db),
      loadViewer(cache, db, c),
    ]);
    const ctx = makeAccessCtx(viewer, forumlist, grouplist);
    const cur = cursorCond({ column: 'tid', size, before: beforeTid, desc: true });
    const r = await db
      .prepare<Record<string, number | string>>(
        `SELECT ${THREAD_LIST_COLS} FROM ${T} WHERE uid = ? ${cur.where} ${cur.order} LIMIT ?`,
      )
      .bind(uid, ...cur.params, size)
      .all();
    const rows = r.results.map((x) => ({
      tid: Number(x.tid),
      fid: Number(x.fid),
      top: Number(x.top),
      digest: Number(x.digest),
      closed: Number(x.closed),
      uid: Number(x.uid),
      username: String(x.username),
      avatar: Number(x.avatar),
      subject: String(x.subject),
      posts: Number(x.posts),
      views: Number(x.views),
      images: Number(x.images),
      files: Number(x.files),
      lastpid: Number(x.lastpid),
      lastuid: Number(x.lastuid),
      lastusername: String(x.lastusername),
      create_date: Number(x.create_date),
      last_date: Number(x.last_date),
    }));
    const list0 = threadListAccessFilter(ctx, rows);
    // 作者 V 头衔 + 预设头像：本列表全部同一位作者，单查一次随行下发
    const author =
      list0.length && uid > 0
        ? await db
            .prepare<{ v: string; avatar: number; avatar_auto: string }>('SELECT v,avatar,avatar_auto FROM bbs_user WHERE uid = ?')
            .bind(uid)
            .first<{ v: string; avatar: number; avatar_auto: string }>()
        : undefined;
    const authorV = String(author?.v ?? '0');
    const authorAuto = avatarAutoOf(Number(author?.avatar), author?.avatar_auto);
    const list = list0.map((x) => ({
      ...x,
      createDate: x.create_date,
      lastDate: x.last_date,
      ...(authorV !== '0' ? { uv: authorV } : {}),
      ...(authorAuto ? { avatar_auto: authorAuto } : {}),
    }));
    // 游标口径（before_tid + nextCursor）：不返回 totalPage——固定 1 会让前端页码组件误判总页数，
    // 与 /api/my/favorites 等游标端点保持一致（只给 list/size/nextCursor）。
    return ok(c, 'ok', {
      data: { list, size, nextCursor: rows.at(-1)?.tid },
    });
  });

  // 公开回帖列表（T3-2：bbs_mypost 倒排，写侧真实维护）
  app.get('/api/users/:uid/posts', async (c) => {
    const { db, cache } = core(c);
    const uid = intParam(c.req.param('uid'));
    const beforePid = intParam(c.req.query('before_pid')) || undefined;
    const [forumlist, grouplist, viewer] = await Promise.all([
      loadForumlist(cache, db),
      loadGrouplist(cache, db),
      loadViewer(cache, db, c),
    ]);
    const ctx = makeAccessCtx(viewer, forumlist, grouplist);
    const list = await fetchReplies(db, ctx, uid, beforePid);
    return ok(c, 'ok', { data: { list, size: PageSize.USER_THREAD_LIST, nextCursor: list.at(-1)?.pid } });
  });

  // 本人回帖（登录态）
  app.get('/api/me/posts', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const viewer = await loadViewer(cache, db, c);
    if (viewer.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
    const beforePid = intParam(c.req.query('before_pid')) || undefined;
    const [forumlist, grouplist] = await Promise.all([loadForumlist(cache, db), loadGrouplist(cache, db)]);
    const ctx = makeAccessCtx(viewer, forumlist, grouplist);
    const list = await fetchReplies(db, ctx, viewer.uid, beforePid);
    return ok(c, 'ok', { data: { list, size: PageSize.USER_THREAD_LIST, nextCursor: list.at(-1)?.pid } });
  });

  return app;
}
