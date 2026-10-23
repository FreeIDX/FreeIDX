/**
 * 版块 / 主题管理后台接口（T3-5，§14.4 / 工单 T3-5）：
 *   GET    /api/admin/forums        版块树 + access 矩阵（每组 5 项 allow*）+ 用户组
 *   POST   /api/admin/forums        新建版块：INSERT forum(RETURNING fid) → access 整表写入 → 清 forumlist
 *   PUT    /api/admin/forums/:fid   更新版块：请求携带的标量才写入（缺省保持原值）+（access 提供则整表替换）→ 清 forumlist
 *   DELETE /api/admin/forums/:fid   删除版块：按 fid 级联删（回帖/倒排/主题/附件/计数）→ 清 forumlist
 *   GET    /api/admin/threads       主题管理列表（?fid/keyword/uid/create_ip/top/closed/digest/since/until/page/size，供批量操作选择）
 *   GET    /api/admin/threads/:tid  主题编辑回显（主题字段 + 首帖原文 message/doctype）
 *   PUT    /api/admin/threads/:tid  编辑主题（subject/message/doctype/fid；fid 变更=移动版块，含计数与 thread_top 迁移）
 * 计数校准已并入每日 cron（cronDaily），不再提供后台端点。
 * DoD：任何 forumlist 写操作都 cache.del('forumlist') → 权限改动立即影响读过滤（下次 GET 重装配 accesslist）。
 * 批量版务操作（top/digest/close/move/delete）复用 POST /api/mod/threads（T3-1），不在本模块重复实现；
 * 单帖编辑（正文级）在本模块直写，权限由 adminGuard（gid=1）保证。
 * 全部路由挂在 adminGuard（app.use('/api/admin/*')）之后。
 */
import { Hono } from 'hono';
import { Code, FORUM_LANG_UNRESTRICTED, GroupId, normalizeForumLang } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { D1b, Stmt } from '../../core/db';
import { forumLangOf, loadForumlist, loadGrouplist } from '../../core/loaders';
import { ipToLong } from '../../core/auth/session';
import { postMessageFmt } from '../../core/fmt';
import { invalidateThreadSeo } from '../seo/generate';
import { filesBucket } from '../attach/core';
import { attachKeysByTids, purgeR2Objects } from '../../core/purge';
import { extractImageUrls, extractSummary } from '../write/routes';
import type { ApiT } from '../../core/i18n';
import { adminUidOf, as01, core, getExecCtx, intParam, patchRuntime, readJson, totalPageOf, type ReadEnv } from '../shared';

const now = () => Math.floor(Date.now() / 1000);
/** 可选整数过滤值：未传参/空串/非数字 → null（= 不参与过滤）；0 是合法值，故不能用 intParam 的默认值语义 */
function intFilter(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
const ALLOW_COLS = ['allowread', 'allowthread', 'allowpost', 'allowattach', 'allowdown'] as const;

/** 版块图标上传：base64 提交 → 落盘 R2 forum/{fid}.{ext} */
const ICON_MAX_BYTES = 1024 * 1024; // 1MB：48px 展示足够，防 base64 大包
const ICON_EXTS: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/** data URL（data:image/png;base64,xxx）→ { bytes, ext }；非白名单格式/解码失败抛错 */
function decodeIcon(raw: string, t: ApiT): { bytes: Uint8Array; ext: string } {
  const m = /^data:image\/(png|jpe?g|gif|webp|bmp);base64,(.+)$/is.exec(raw.trim());
  if (!m) throw new AppError(Code.VALIDATION_ERROR, t('admin.iconFormat'));
  const ext = m[1]!.toLowerCase() === 'jpeg' ? 'jpg' : m[1]!.toLowerCase();
  try {
    const bin = atob(m[2]!);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!bytes.length) throw new Error('empty');
    if (bytes.length > ICON_MAX_BYTES) throw new AppError(Code.FORM_FILE_TOO_LARGE, t('admin.iconTooLarge'), { size: bytes.length });
    return { bytes, ext };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(Code.VALIDATION_ERROR, t('admin.iconDecodeFailed'));
  }
}

interface AccessInput {
  gid: number;
  allowread?: unknown;
  allowthread?: unknown;
  allowpost?: unknown;
  allowattach?: unknown;
  allowdown?: unknown;
}

/** 归一化 access 输入：过滤非法 gid，5 项权限转 0/1 */
function normAccess(raw: unknown): AccessInput[] {
  if (!Array.isArray(raw)) return [];
  const out: AccessInput[] = [];
  for (const it of raw as Record<string, unknown>[]) {
    const gid = Number(it.gid);
    if (!Number.isInteger(gid) || gid <= 0) continue;
    out.push({ gid, ...Object.fromEntries(ALLOW_COLS.map((k) => [k, as01(it[k])])) });
  }
  return out;
}

/** 归一化上级版块输入：非数字/空 → 0（一级版块） */
function normParentFid(v: unknown): number {
  return Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0;
}

/**
 * 归一化绑定内容语言（0024）：
 *   ''      = 未绑定（子版块继承父版块，顶级版块不限制）
 *   'none'  = 显式不限制；只对子版块保留，顶级版块两写法等价 → 归一回空串
 *   其余     = 收敛到 CONTENT_LANGS（非法值同样落 ''）
 */
function normForumLang(v: unknown, parentFid: number): string {
  const lang = normalizeForumLang(v);
  return lang === FORUM_LANG_UNRESTRICTED && parentFid === 0 ? '' : lang;
}

/** 校验上级版块：0=一级（合法）；>0 必须存在且自身为一级版块（仅支持两级） */
async function assertValidParent(db: D1b, t: ApiT, parentFid: number): Promise<void> {
  if (parentFid === 0) return;
  const r = await db
    .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_forum WHERE fid = ? AND parent_fid = 0')
    .bind(parentFid)
    .first<{ c: number }>();
  if (!Number(r?.c)) throw new AppError(Code.VALIDATION_ERROR, t('admin.forumParentInvalid'));
}

/** 该版块是否已有子版块（决定能否被设为子版块 / 能否删除） */
async function childCount(db: D1b, fid: number): Promise<number> {
  const r = await db
    .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_forum WHERE parent_fid = ?')
    .bind(fid)
    .first<{ c: number }>();
  return Number(r?.c ?? 0);
}

export function adminForumRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  app.get('/api/admin/forums', async (c) => {
    const { db, cache } = core(c);
    const [forumlist, grouplist] = await Promise.all([loadForumlist(cache, db), loadGrouplist(cache, db)]);
    return ok(c, 'ok', { data: { forums: Object.values(forumlist), groups: Object.values(grouplist) } });
  });

  app.post('/api/admin/forums', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const b = await readJson(c);
    const name = String(b.name ?? '').trim();
    if (!name) throw new AppError(Code.VALIDATION_ERROR, t('admin.forumNameRequired'));
    const parentFid = normParentFid(b.parent_fid);
    await assertValidParent(db, t, parentFid);
    const lang = normForumLang(b.lang, parentFid);
    const ts = now();
    const r = await db
      .prepare<{ fid: number }>(
        'INSERT INTO bbs_forum (name,rank,brief,announcement,accesson,orderby,icon,moduids,seo_title,seo_keywords,parent_fid,lang,threads,todayposts,todaythreads,create_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,?) RETURNING fid',
      )
      .bind(
        name,
        Number.isFinite(Number(b.rank)) ? Math.trunc(Number(b.rank)) : 0,
        String(b.brief ?? ''),
        String(b.announcement ?? ''),
        as01(b.accesson),
        as01(b.orderby),
        Number.isFinite(Number(b.icon)) ? Math.trunc(Number(b.icon)) : 0,
        String(b.moduids ?? ''),
        String(b.seo_title ?? ''),
        String(b.seo_keywords ?? ''),
        parentFid,
        lang,
        ts,
      )
      .first<{ fid: number }>();
    const fid = Number(r?.fid ?? 0);
    if (!fid) throw new AppError(Code.SYSTEM_ERROR, t('admin.forumCreateFailed'));
    const access = normAccess(b.access);
    if (access.length) await db.batch(access.map((a) => accessStmt(db, fid, a)));
    await cache.del('forumlist');
    return ok(c, t('common.created'), { data: { fid } });
  });

  /**
   * 更新版块：**提供即更新**（merge 语义）——只有请求里显式携带的键才会写入，缺省 = 保持原值；
   * 要清空必须显式传 `''` / `0`（lang 另有 'none' = 显式不限制，见 normalizeForumLang）。
   *
   * 不用 PUT 的「全量标量替换」语义，是因为缺省被当成空会静默毁数据：省略 lang = 悄悄解绑
   * （子版块还会连带回到继承）、省略 parent_fid = 把二级版块悄悄提到顶级、省略 accesson
   * 会悄悄关掉权限矩阵。本接口的 access 本来就是「携带才整表替换」，标量改成同一口径后，
   * 局部更新不会再误伤未提交的字段；完整提交（后台两个入口）的行为与以前完全一致。
   */
  app.put('/api/admin/forums/:fid', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const fid = intParam(c.req.param('fid'));
    if (!fid) throw new AppError(Code.VALIDATION_ERROR, t('admin.fidInvalid'));
    /* 连 parent_fid 一起读：lang 的哨兵判定需要知道变更后（或保持）的父级 */
    const cur = await db
      .prepare<{ fid: number; parent_fid: number }>('SELECT fid,parent_fid FROM bbs_forum WHERE fid = ?')
      .bind(fid)
      .first<{ fid: number; parent_fid: number }>();
    if (!cur) throw new AppError(Code.NOT_FOUND, t('common.forumNotFound'));
    const b = await readJson(c);

    const sets: string[] = [];
    const vals: (string | number)[] = [];
    /** 列名来自本函数内的字面量，不存在注入面 */
    const put = (col: string, v: string | number): void => {
      sets.push(`${col}=?`);
      vals.push(v);
    };

    if ('name' in b) {
      const name = String(b.name ?? '').trim();
      if (!name) throw new AppError(Code.VALIDATION_ERROR, t('admin.forumNameRequired'));
      put('name', name);
    }
    if ('rank' in b) put('rank', Number.isFinite(Number(b.rank)) ? Math.trunc(Number(b.rank)) : 0);
    if ('brief' in b) put('brief', String(b.brief ?? ''));
    if ('announcement' in b) put('announcement', String(b.announcement ?? ''));
    if ('accesson' in b) put('accesson', as01(b.accesson));
    if ('orderby' in b) put('orderby', as01(b.orderby));
    if ('icon' in b) put('icon', Number.isFinite(Number(b.icon)) ? Math.trunc(Number(b.icon)) : 0);
    if ('moduids' in b) put('moduids', String(b.moduids ?? ''));
    if ('seo_title' in b) put('seo_title', String(b.seo_title ?? ''));
    if ('seo_keywords' in b) put('seo_keywords', String(b.seo_keywords ?? ''));

    /* 二级版块约束：不得自引用；仅有子版块的版块不能再被设为子版块（否则成三级）；父必须是一级版块 */
    let parentFid = Number(cur.parent_fid ?? 0);
    if ('parent_fid' in b) {
      parentFid = normParentFid(b.parent_fid);
      if (parentFid === fid) throw new AppError(Code.VALIDATION_ERROR, t('admin.forumParentInvalid'));
      if (parentFid > 0) {
        if ((await childCount(db, fid)) > 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.forumParentLocked'));
        await assertValidParent(db, t, parentFid);
      }
      put('parent_fid', parentFid);
    }
    /* 未提交 parent_fid 时用库中现值判定哨兵（顶级版块的 'none' 会归一回空串） */
    if ('lang' in b) put('lang', normForumLang(b.lang, parentFid));

    if (!sets.length && !('access' in b)) throw new AppError(Code.VALIDATION_ERROR, t('common.noFieldsToUpdate'));
    if (sets.length) {
      await db.prepare(`UPDATE bbs_forum SET ${sets.join(',')} WHERE fid=?`).bind(...vals, fid).run();
    }
    // 仅当请求显式携带 access 时整表替换（编辑表单总是提交当前矩阵）
    if ('access' in b) {
      const access = normAccess(b.access);
      const stmts: Stmt[] = [db.prepare('DELETE FROM bbs_forum_access WHERE fid = ?').bind(fid) as unknown as Stmt];
      for (const a of access) stmts.push(accessStmt(db, fid, a));
      await db.batch(stmts);
    }
    await cache.del('forumlist');
    return ok(c, t('common.saved'), { data: { fid } });
  });

  // PUT /api/admin/forums/:fid/icon —— 版块图标上传（base64 提交）
  app.put('/api/admin/forums/:fid/icon', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const fid = intParam(c.req.param('fid'));
    if (!fid) throw new AppError(Code.VALIDATION_ERROR, t('admin.fidInvalid'));
    const exists = await db.prepare<{ icon_file: string }>('SELECT icon_file FROM bbs_forum WHERE fid = ?').bind(fid).first<{ icon_file: string }>();
    if (!exists) throw new AppError(Code.NOT_FOUND, t('common.forumNotFound'));
    const b = await readJson(c);
    const { bytes, ext } = decodeIcon(String(b.data ?? ''), t);

    const key = `forum/${fid}.${ext}`;
    const bucket = filesBucket(c.env);
    const oldKey = String(exists.icon_file ?? '');
    await bucket.put(key, bytes, { httpMetadata: { contentType: ICON_EXTS[ext] } });
    // 换格式（png→jpg 等）时清掉旧对象，不留孤儿
    if (oldKey && oldKey !== key) await bucket.delete(oldKey).catch(() => undefined);

    const ts = now();
    await db.prepare('UPDATE bbs_forum SET icon_file = ?, icon_time = ? WHERE fid = ?').bind(key, ts, fid).run();
    await cache.del('forumlist');
    return ok(c, t('admin.iconUpdated'), { data: { icon_url: `/files/${key}?v=${ts}` } });
  });

  // DELETE /api/admin/forums/:fid/icon —— 恢复内置默认图（补齐的回退入口）
  app.delete('/api/admin/forums/:fid/icon', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const fid = intParam(c.req.param('fid'));
    if (!fid) throw new AppError(Code.VALIDATION_ERROR, t('admin.fidInvalid'));
    const exists = await db.prepare<{ icon_file: string }>('SELECT icon_file FROM bbs_forum WHERE fid = ?').bind(fid).first<{ icon_file: string }>();
    if (!exists) throw new AppError(Code.NOT_FOUND, t('common.forumNotFound'));
    const oldKey = String(exists.icon_file ?? '');
    if (oldKey) await filesBucket(c.env).delete(oldKey).catch(() => undefined);
    await db.prepare('UPDATE bbs_forum SET icon_file = ?, icon_time = 0 WHERE fid = ?').bind('', fid).run();
    await cache.del('forumlist');
    return ok(c, t('admin.iconReset'), { data: { fid } });
  });

  app.delete('/api/admin/forums/:fid', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const fid = intParam(c.req.param('fid'));
    if (!fid) throw new AppError(Code.VALIDATION_ERROR, t('admin.fidInvalid'));
    const exists = await db
      .prepare<{ fid: number; icon_file: string }>('SELECT fid,icon_file FROM bbs_forum WHERE fid = ?')
      .bind(fid)
      .first<{ fid: number; icon_file: string }>();
    if (!exists) throw new AppError(Code.NOT_FOUND, t('common.forumNotFound'));
    /* 二级版块：仍有子版块时阻止删除（须先删子版块），不级联 */
    if ((await childCount(db, fid)) > 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.forumHasChildren'));

    const threads = await db.prepare<{ tid: number; uid: number }>('SELECT tid,uid FROM bbs_thread WHERE fid = ?').bind(fid).all();
    const tids: number[] = [];
    const threadAuthor = new Map<number, number>();
    for (const row of threads.results) {
      const tid = Number(row.tid);
      const uid = Number(row.uid);
      tids.push(tid);
      if (uid > 0) threadAuthor.set(uid, (threadAuthor.get(uid) ?? 0) + 1);
    }

    const stmts: Stmt[] = [];
    let postCount = 0;
    if (tids.length) {
      const inList = tids.map(() => '?').join(',');
      // 各作者在本版块主题中的回帖数（不含首帖）→ user.posts 回退
      const authorPosts = await db
        .prepare<{ uid: number; c: number }>(`SELECT uid, COUNT(*) AS c FROM bbs_post WHERE tid IN (${inList}) AND isfirst = 0 GROUP BY uid`)
        .bind(...tids)
        .all();
      for (const row of authorPosts.results) {
        const u = Number(row.uid);
        postCount += Number(row.c);
        if (u > 0) stmts.push(db.prepare('UPDATE bbs_user SET posts = posts - ? WHERE uid = ?').bind(Number(row.c), u) as unknown as Stmt);
      }
      // runtime.posts 口径 = isfirst = 0（发主题时只 threads+1、不加 posts；cron 校准亦排除首帖），
      // 故此处只累加回帖数，首帖不计——否则删版块会把 posts 多减「主题数」，被夹到 0 后统计归零。
      for (const [u, n] of threadAuthor) {
        stmts.push(db.prepare('UPDATE bbs_user SET threads = threads - ? WHERE uid = ?').bind(n, u) as unknown as Stmt);
      }
      stmts.push(
        // 楼层点赞按 pid 关联，必须在删 bbs_post 之前清理
        db.prepare(`DELETE FROM bbs_post_like WHERE pid IN (SELECT pid FROM bbs_post WHERE tid IN (${inList}))`).bind(...tids) as unknown as Stmt,
        db.prepare(`DELETE FROM bbs_like WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
        db.prepare(`DELETE FROM bbs_favorite WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
        db.prepare(`DELETE FROM bbs_paylist WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
        db.prepare(`DELETE FROM bbs_post WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
        db.prepare(`DELETE FROM bbs_mypost WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
        db.prepare(`DELETE FROM bbs_mythread WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
        db.prepare(`DELETE FROM bbs_thread_top WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
        db.prepare(`DELETE FROM bbs_attach WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
      );
    }
    stmts.push(
      db.prepare('DELETE FROM bbs_thread WHERE fid = ?').bind(fid) as unknown as Stmt,
      db.prepare('DELETE FROM bbs_forum_access WHERE fid = ?').bind(fid) as unknown as Stmt,
      db.prepare('DELETE FROM bbs_forum WHERE fid = ?').bind(fid) as unknown as Stmt,
    );
    const attachKeys = await attachKeysByTids(db, tids);
    await db.batch(stmts);

    // 附件 R2 对象随版块真删尽力清理（waitUntil 旁路，失败不影响 D1 一致性）
    purgeR2Objects(c.env, await getExecCtx(c), attachKeys);
    // 图标文件随版块删除清掉（不留孤儿对象）
    const oldIcon = String(exists.icon_file ?? '');
    if (oldIcon) await filesBucket(c.env).delete(oldIcon).catch(() => undefined);

    await cache.del('forumlist');
    if (tids.length) {
      await patchRuntime(cache, { threads: -tids.length, posts: -postCount });
      await invalidateThreadSeo({ db, cache }, c, tids);
    }
    return ok(c, t('common.deleted'), { data: { fid, threads: tids.length } });
  });

  app.get('/api/admin/threads', async (c) => {
    const { db } = core(c);
    const keyword = String(c.req.query('keyword') ?? '').trim();
    const fid = intParam(c.req.query('fid'));
    const page = Math.max(1, intParam(c.req.query('page'), 1));
    const size = Math.min(100, Math.max(1, intParam(c.req.query('size'), 20)));

    const where: string[] = [];
    const params: (number | string)[] = [];
    if (fid > 0) {
      where.push('fid = ?');
      params.push(fid);
    }
    if (keyword) {
      where.push('subject LIKE ?');
      params.push(`%${keyword}%`);
    }
    // 以下条件为管理列表过滤组（uid / userip / create_date 区间），
    // 全部并进同一个 where —— count 与列表必须共用，否则分页总数与筛选结果漂移
    const uid = intParam(c.req.query('uid'));
    if (uid > 0) {
      where.push('uid = ?');
      params.push(uid);
    }
    // 主题发帖 IP 库里是整数列 bbs_thread.userip（无 create_ip 列）；
    // ipToLong 对 IPv6/非法串回 0，而 0 正是「未记录 IP」行的存量值 → 只在解出合法 IPv4 时才加条件，防误命中
    const createIp = String(c.req.query('create_ip') ?? '').trim();
    if (createIp) {
      const ipLong = ipToLong(createIp);
      if (ipLong > 0) {
        where.push('userip = ?');
        params.push(ipLong);
      }
    }
    // top/closed/digest 的 0 有业务含义（非置顶/未关闭/非精华），不能用 intParam 的 0 默认值判「未传」；
    // 列名来自下方常量数组（非用户输入），拼接无注入面
    for (const col of ['top', 'closed', 'digest'] as const) {
      const v = intFilter(c.req.query(col));
      if (v !== null) {
        where.push(`${col} = ?`);
        params.push(v);
      }
    }
    // 发帖时间区间（unix 秒，闭区间）：since / until
    const since = intFilter(c.req.query('since'));
    if (since !== null) {
      where.push('create_date >= ?');
      params.push(since);
    }
    const until = intFilter(c.req.query('until'));
    if (until !== null) {
      where.push('create_date <= ?');
      params.push(until);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

    const cnt = await db.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM bbs_thread${whereSql}`).bind(...params).first<{ c: number }>();
    const total = Number(cnt?.c ?? 0);
    const list = await db
      .prepare<Record<string, unknown>>(
        // 投影加宽到前台 ThreadListItem 同集（avatar/images/files/lastpid/lastuid/lastusername 均为 bbs_thread
        // 反规范化列，零 JOIN）——结果列表要按论坛主题列表样式布局渲染（见 admin/types.ts AdminThreadRow）
        `SELECT tid,fid,uid,username,avatar,subject,posts,views,top,digest,closed,images,files,lastpid,lastuid,lastusername,create_date,last_date FROM bbs_thread${whereSql} ORDER BY tid DESC LIMIT ? OFFSET ?`,
      )
      .bind(...params, size, (page - 1) * size)
      .all();
    return ok(c, 'ok', { data: { total, page, size, totalPage: totalPageOf(total, size), list: list.results } });
  });

  // 编辑回显：主题字段 + 首帖原文（message 为库中原样，前端 textarea 直接编辑）
  app.get('/api/admin/threads/:tid', async (c) => {
    const { db } = core(c);
    const t = c.get('t');
    const tid = intParam(c.req.param('tid'));
    const th = await db
      .prepare<{ tid: number; fid: number; subject: string; firstpid: number; closed: number; top: number; digest: number }>(
        'SELECT tid,fid,subject,firstpid,closed,top,digest FROM bbs_thread WHERE tid = ?',
      )
      .bind(tid)
      .first<{ tid: number; fid: number; subject: string; firstpid: number; closed: number; top: number; digest: number }>();
    if (!th) throw new AppError(Code.NOT_FOUND, t('common.threadNotFound'));
    const first = await db
      .prepare<{ message: string; doctype: number }>('SELECT message,doctype FROM bbs_post WHERE tid = ? AND isfirst = 1')
      .bind(tid)
      .first<{ message: string; doctype: number }>();
    return ok(c, 'ok', { data: { ...th, message: first?.message ?? '', doctype: Number(first?.doctype ?? 0) } });
  });

  // 编辑主题：subject/message/doctype 传值即改；fid 变更 = 移动版块（计数双向校准 + thread_top 迁移）。
  // 正文重跑 postMessageFmt（管理员 gid=1，doctype=0 原文放行）并重提取列表图片组/摘要；成功写 modlog（action=update）。
  app.put('/api/admin/threads/:tid', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const tid = intParam(c.req.param('tid'));
    const b = await readJson(c);

    const th = await db
      .prepare<{ tid: number; fid: number; subject: string }>('SELECT tid,fid,subject FROM bbs_thread WHERE tid = ?')
      .bind(tid)
      .first<{ tid: number; fid: number; subject: string }>();
    if (!th) throw new AppError(Code.NOT_FOUND, t('common.threadNotFound'));
    const first = await db
      .prepare<{ pid: number; doctype: number }>('SELECT pid,doctype FROM bbs_post WHERE tid = ? AND isfirst = 1')
      .bind(tid)
      .first<{ pid: number; doctype: number }>();
    if (!first) throw new AppError(Code.NOT_FOUND, t('common.postNotFound'));

    const fid = Number(th.fid);
    let subject = String(th.subject);
    let moved = false;
    const stmts: Stmt[] = [];

    if (b.fid !== undefined) {
      const newFid = Math.trunc(Number(b.fid));
      if (!Number.isInteger(newFid) || newFid <= 0) throw new AppError(Code.VALIDATION_ERROR, t('common.paramError'));
      if (newFid !== fid) {
        const target = await db.prepare<{ fid: number }>('SELECT fid FROM bbs_forum WHERE fid = ?').bind(newFid).first<{ fid: number }>();
        if (!target) throw new AppError(Code.NOT_FOUND, t('common.forumNotFound'));
        stmts.push(
          db.prepare('UPDATE bbs_thread SET fid = ? WHERE tid = ?').bind(newFid, tid) as unknown as Stmt,
          db.prepare('UPDATE bbs_forum SET threads = threads + 1 WHERE fid = ?').bind(newFid) as unknown as Stmt,
          db.prepare('UPDATE bbs_forum SET threads = threads - 1 WHERE fid = ?').bind(fid) as unknown as Stmt,
          db.prepare('UPDATE bbs_thread_top SET fid = ? WHERE tid = ?').bind(newFid, tid) as unknown as Stmt,
        );
        /* 目标版块绑定语言（含父版块继承）：移动即对齐，与发帖强制 / 前台编辑首帖同一口径；
           移出绑定版块保持原值（不反向猜测，避免改掉主题自己的语言标记） */
        const boundLang = forumLangOf(await loadForumlist(cache, db), newFid);
        if (boundLang) {
          stmts.push(db.prepare('UPDATE bbs_thread SET lang = ? WHERE tid = ?').bind(boundLang, tid) as unknown as Stmt);
        }
        moved = true;
      }
    }

    if (b.subject !== undefined) {
      subject = String(b.subject).trim();
      if (!subject) throw new AppError(Code.VALIDATION_ERROR, t('common.paramError'));
      if ([...subject].length > 128) throw new AppError(Code.VALIDATION_ERROR, t('write.subjectTooLong'));
      if (subject !== String(th.subject)) {
        stmts.push(db.prepare('UPDATE bbs_thread SET subject = ? WHERE tid = ?').bind(subject, tid) as unknown as Stmt);
      }
    }

    if (b.message !== undefined) {
      const message = String(b.message);
      if (!message.trim()) throw new AppError(Code.VALIDATION_ERROR, t('write.contentRequired'));
      // 编辑上限 2048000（与前台 PUT /api/posts/:pid 的既有口径一致）
      if ([...message].length > 2_048_000) throw new AppError(Code.FORM_MESSAGE_TOO_LONG, t('write.contentTooLong'));
      const doctype = b.doctype === undefined ? Number(first.doctype) : Number(b.doctype);
      if (!Number.isInteger(doctype) || doctype < 0 || doctype > 10) throw new AppError(Code.VALIDATION_ERROR, t('write.doctypeUnsupported'));
      const fmt = postMessageFmt({ message, doctype, quotepid: 0 }, GroupId.ADMIN);
      stmts.push(
        db
          .prepare('UPDATE bbs_post SET doctype = ?, message = ?, message_fmt = ? WHERE pid = ?')
          .bind(doctype, fmt.message, fmt.message_fmt, Number(first.pid)) as unknown as Stmt,
        db.prepare('UPDATE bbs_thread SET image_urls = ? WHERE tid = ?').bind(extractImageUrls(message), tid) as unknown as Stmt,
        db.prepare('UPDATE bbs_thread SET summary = ? WHERE tid = ?').bind(extractSummary(message), tid) as unknown as Stmt,
      );
    }

    if (!stmts.length) throw new AppError(Code.VALIDATION_ERROR, t('common.noFieldsToUpdate'));

    stmts.push(
      db
        .prepare('INSERT INTO bbs_modlog (uid,tid,pid,subject,comment,create_date,action) VALUES (?,?,?,?,?,?,?)')
        .bind(await adminUidOf(c), tid, Number(first.pid), subject, '', now(), 'update') as unknown as Stmt,
    );

    await db.batch(stmts);
    if (moved) await cache.del('forumlist');
    await invalidateThreadSeo({ db, cache }, c, [tid]);
    return ok(c, t('common.saved'), { data: { tid } });
  });

  return app;
}

function accessStmt(db: D1b, fid: number, a: AccessInput): Stmt {
  return db
    .prepare('INSERT OR REPLACE INTO bbs_forum_access (fid,gid,allowread,allowthread,allowpost,allowattach,allowdown) VALUES (?,?,?,?,?,?,?)')
    .bind(fid, a.gid, a.allowread ?? 0, a.allowthread ?? 0, a.allowpost ?? 0, a.allowattach ?? 0, a.allowdown ?? 0) as unknown as Stmt;
}
