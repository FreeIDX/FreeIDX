/**
 * 内容审核后台接口（tt_check）：
 *   GET  /api/admin/check/threads   ?ok=0|-1&page&size  主题审核队列（tid 倒序 20/页）
 *   GET  /api/admin/check/posts     ?ok=0|-1&page&size  回帖审核队列（isfirst=0；pid 倒序）
 *   GET  /api/admin/check/users     ?ok=0|-1&page&size  用户审核队列（uid 倒序；投影同后台用户列表）
 *   GET  /api/admin/check/recycle   ?page&size          回收站（ok=-2 主题）
 *   GET  /api/admin/check/setting                       设置页回显（tt_check {user_check,recycle} + 组/板块矩阵）
 *   PUT  /api/admin/check/setting                       保存（先全清后置选中；清 forum/group 缓存）
 *   POST /api/admin/check/truncate                      清空回收站（全部 ok=-2 逐个真删）
 * 审核动作（通过/拒绝/删除）不在此重复实现：后台页面直调前台路由，
 * 后台页面复用 POST /api/check 与 POST /api/recycle（权限同为组 see_check）。
 * 全部路由挂在 adminGuard 之后（app.use('/api/admin/*')）。
 */
import { Hono, type Context } from 'hono';
import { Code } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { Stmt } from '../../core/db';
import { USER_ADMIN_LIST_COLS } from '../../core/db/columns';
import { ipToStr } from '../../core/auth/session';
import { loadGrouplist, loadSetting } from '../../core/loaders';
import { as01, core, intParam, readJson, totalPageOf, type ReadEnv } from '../shared';
import { purgeThread } from '../check/routes';

type Ctx = Context<ReadEnv>;
/** 审核队列 page/size（后台约定，默认 20） */
function pageArgs(c: Ctx): { page: number; size: number; offset: number } {
  const page = Math.max(1, intParam(c.req.query('page'), 1));
  const size = Math.min(100, Math.max(1, intParam(c.req.query('size'), 20)));
  return { page, size, offset: (page - 1) * size };
}

const queueOk = (c: Ctx): number => {
  const okv = intParam(c.req.query('ok'), 0);
  if (okv !== 0 && okv !== -1) throw new AppError(Code.VALIDATION_ERROR, c.get('t')('admin.okInvalid'));
  return okv;
};

export function adminCheckRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  // ---------------- 主题审核队列 ----------------
  app.get('/api/admin/check/threads', async (c) => {
    const { db } = core(c);
    const okv = queueOk(c);
    const { page, size, offset } = pageArgs(c);
    const cnt = await db
      .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_thread WHERE ok = ?')
      .bind(okv)
      .first<{ c: number }>();
    const total = Number(cnt?.c ?? 0);
    // 作者列 LEFT JOIN bbs_user（用户已删显示空）
    const rows = await db
      .prepare<Record<string, unknown>>(
        `SELECT t.tid, t.fid, t.subject, t.uid, u.username, t.create_date
         FROM bbs_thread t LEFT JOIN bbs_user u ON u.uid = t.uid
         WHERE t.ok = ? ORDER BY t.tid DESC LIMIT ? OFFSET ?`,
      )
      .bind(okv, size, offset)
      .all();
    return ok(c, 'ok', { data: { total, page, size, totalPage: totalPageOf(total, size), list: rows.results } });
  });

  // ---------------- 回帖审核队列（isfirst=0） ----------------
  app.get('/api/admin/check/posts', async (c) => {
    const { db } = core(c);
    const okv = queueOk(c);
    const { page, size, offset } = pageArgs(c);
    const cnt = await db
      .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_post WHERE ok = ? AND isfirst = 0')
      .bind(okv)
      .first<{ c: number }>();
    const total = Number(cnt?.c ?? 0);
    // 列：主题 + 作者 + 发表时间 + pid + 内容（原文纯文本，前端默认转义渲染）
    const rows = await db
      .prepare<Record<string, unknown>>(
        `SELECT p.pid, p.tid, p.uid, u.username, p.create_date, p.message, t.subject
         FROM bbs_post p
         LEFT JOIN bbs_thread t ON t.tid = p.tid
         LEFT JOIN bbs_user u ON u.uid = p.uid
         WHERE p.ok = ? AND p.isfirst = 0 ORDER BY p.pid DESC LIMIT ? OFFSET ?`,
      )
      .bind(okv, size, offset)
      .all();
    return ok(c, 'ok', { data: { total, page, size, totalPage: totalPageOf(total, size), list: rows.results } });
  });

  // ---------------- 用户审核队列 ----------------
  app.get('/api/admin/check/users', async (c) => {
    const { db } = core(c);
    const okv = queueOk(c);
    const { page, size, offset } = pageArgs(c);
    const cnt = await db
      .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_user WHERE ok = ?')
      .bind(okv)
      .first<{ c: number }>();
    const total = Number(cnt?.c ?? 0);
    const rows = await db
      .prepare<Record<string, unknown>>(`SELECT ${USER_ADMIN_LIST_COLS} FROM bbs_user WHERE ok = ? ORDER BY uid DESC LIMIT ? OFFSET ?`)
      .bind(okv, size, offset)
      .all();
    const list = rows.results.map((r) => ({ ...r, create_ip_fmt: ipToStr(Number(r.create_ip ?? 0)) }));
    return ok(c, 'ok', { data: { total, page, size, totalPage: totalPageOf(total, size), list } });
  });

  // ---------------- 回收站列表（ok=-2） ----------------
  app.get('/api/admin/check/recycle', async (c) => {
    const { db } = core(c);
    const { page, size, offset } = pageArgs(c);
    const cnt = await db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_thread WHERE ok = -2').first<{ c: number }>();
    const total = Number(cnt?.c ?? 0);
    const rows = await db
      .prepare<Record<string, unknown>>(
        `SELECT t.tid, t.fid, t.subject, t.uid, u.username, t.create_date
         FROM bbs_thread t LEFT JOIN bbs_user u ON u.uid = t.uid
         WHERE t.ok = -2 ORDER BY t.tid DESC LIMIT ? OFFSET ?`,
      )
      .bind(size, offset)
      .all();
    return ok(c, 'ok', { data: { total, page, size, totalPage: totalPageOf(total, size), list: rows.results } });
  });

  // ---------------- 设置回显 ----------------
  app.get('/api/admin/check/setting', async (c) => {
    const { db, cache } = core(c);
    // 开关读归一化后的 setting（kv 原值 0/1/'1' 已收敛为 boolean）
    const setting = await loadSetting(cache, db);
    const groups = await db
      .prepare<Record<string, unknown>>('SELECT gid, name, thread_check, post_check, see_check, edit_check FROM bbs_group ORDER BY gid')
      .all();
    const forums = await db
      .prepare<Record<string, unknown>>('SELECT fid, name, thread_check, post_check, edit_check FROM bbs_forum ORDER BY rank DESC, fid')
      .all();
    return ok(c, 'ok', {
      data: {
        user_check: setting.userCheck ? 1 : 0,
        recycle: setting.recycle ? 1 : 0,
        groups: groups.results,
        forums: forums.results,
      },
    });
  });

  // ---------------- 设置保存 ----------------
  app.put('/api/admin/check/setting', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const b = await readJson(c);
    const userCheck = as01(b.user_check);
    const recycle = as01(b.recycle);

    // 开关合并写回 kv 'setting'（保留其余站点设置键）
    const row = await db.prepare<{ v: string }>('SELECT v FROM bbs_kv WHERE k = ?').bind('setting').first<{ v: string }>();
    let raw: Record<string, unknown> = {};
    try {
      raw = JSON.parse(row?.v ?? '{}') as Record<string, unknown>;
    } catch {
      raw = {};
    }
    raw.user_check = userCheck;
    raw.recycle = recycle;
    await db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind('setting', JSON.stringify(raw)).run();

    // 组/板块矩阵：先全清后置选中（逐列清 0 再对选中 gid/fid 置 1，合并入批次）
    const stmts: Stmt[] = [];
    const groups = Array.isArray(b.groups) ? (b.groups as Record<string, unknown>[]) : [];
    const forums = Array.isArray(b.forums) ? (b.forums as Record<string, unknown>[]) : [];
    if (groups.length) {
      stmts.push(
        db.prepare('UPDATE bbs_group SET thread_check = 0, post_check = 0, see_check = 0, edit_check = 0') as unknown as Stmt,
      );
      for (const g of groups) {
        const gid = Number(g.gid);
        if (!Number.isInteger(gid)) continue;
        stmts.push(
          db
            .prepare('UPDATE bbs_group SET thread_check = ?, post_check = ?, see_check = ?, edit_check = ? WHERE gid = ?')
            .bind(as01(g.thread_check), as01(g.post_check), as01(g.see_check), as01(g.edit_check), gid) as unknown as Stmt,
        );
      }
    }
    if (forums.length) {
      stmts.push(db.prepare('UPDATE bbs_forum SET thread_check = 0, post_check = 0, edit_check = 0') as unknown as Stmt);
      for (const f of forums) {
        const fid = Number(f.fid);
        if (!Number.isInteger(fid)) continue;
        stmts.push(
          db
            .prepare('UPDATE bbs_forum SET thread_check = ?, post_check = ?, edit_check = ? WHERE fid = ?')
            .bind(as01(f.thread_check), as01(f.post_check), as01(f.edit_check), fid) as unknown as Stmt,
        );
      }
    }
    if (stmts.length) await db.batch(stmts);

    // 保存后失效 forumlist + grouplist + setting 缓存
    await cache.del('setting');
    await cache.del('forumlist');
    await cache.del('grouplist');
    return ok(c, t('common.setDone'));
  });

  // ---------------- 清空回收站 ----------------
  app.post('/api/admin/check/truncate', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const grouplist = await loadGrouplist(cache, db);
    // D1 单 invocation 硬上限 50 条语句，而 purgeThread 单条约 15~20 条：
    // 一次最多清 2 条并返回 next，前端循环调用直到清完（否则清 2~3 条后整请求 500 且已部分删除）。
    const CHUNK = 2;
    const rows = await db
      .prepare<{ tid: number }>('SELECT tid FROM bbs_thread WHERE ok = -2 ORDER BY tid DESC LIMIT ?')
      .bind(CHUNK + 1)
      .all();
    let count = 0;
    for (const r of rows.results.slice(0, CHUNK)) {
      // purgeThread：级联真删 + 积分回扣 + 计数 + 缓存/SEO + thread:deleted 事件（与「彻底删除」单条操作同路径）
      if (await purgeThread(db, cache, c, Number(r.tid), grouplist)) count += 1;
    }
    return ok(c, t('admin.truncated'), { data: { count, next: rows.results.length > CHUNK } });
  });

  return app;
}