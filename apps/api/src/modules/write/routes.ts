/**
 * 内容写接口（T2-6，§8.3 写时定稿 + §14 铁律 8）：
 *  POST   /api/threads                发主题（首帖→回填 firstpid→计数→倒排）
 *  POST   /api/threads/:tid/posts     回帖（closed 非版主禁回、quotepid 同帖校验→引用前缀）
 *  PUT    /api/posts/:pid             编辑（isfirst 可改 subject/fid，重跑 fmt 用当前 gid）
 *  DELETE /api/posts/:pid             删除（isfirst→主题级联删；回帖 lastpid 回退）
 * 计数回写在 DB.batch() 事务内完成；读路径零 sanitize——定稿只在写侧发生。
 * 事件发射点（契约②）：post:created / post:updated / post:deleted / thread:created / thread:deleted / user:group-changed。
 * runtime 计数走缓存键 'runtime'（无 bbs_runtime 表）；mypost 倒排由本模块真实维护。
 * 人机验证：发帖/回帖在参数解析后立刻校验 Turnstile token（附录 B 覆盖 登录/注册/发帖/回帖/找回密码/发码），早于任何 D1 读写。
 */
import { Hono, type Context } from 'hono';
import { Code, detectContentLang, normalizeContentLang, type CreatePostReq, type CreateThreadReq } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { D1b, Stmt } from '../../core/db';
import type { Cache } from '../../core/cache';
import { postMessageFmt } from '../../core/fmt';
import { canDeletePost, canUpdatePost, forumAccessMod, forumAccessUser } from '../../core/access';
import { forumLangOf, loadSetting, loadViewer, reqIp } from '../../core/loaders';
import { CheckStatus, checkOrNot, hasSeeCheck } from '../../core/check';
import { attachKeysByPid, attachKeysByTid, postPurgeStmts, purgeR2Objects, threadPurgeStmts } from '../../core/purge';
import { ipToLong } from '../../core/auth/session';
import { verifyTurnstile } from '../../core/turnstile';
import { revokeAffectedUids, revokeForPostDelete, threadRevokeEntries, upgradeGroupsByCredits } from '../../core/points';
import { associateAttachments } from '../attach/routes';
import { scheduleSeo } from '../seo/generate';
import { getExecCtx, intParam, patchRuntime, readJson, type ReadEnv } from '../shared';
import {
  assertNotBanned,
  createReplyCore,
  createThreadCore,
  emit,
  extractImageUrls,
  extractSummary,
  loadAuthorRow,
  makeWriteActor,
  upgradeAfterGrant,
  type WriteActor,
  type WriteDeps,
} from './core';

type Ctx = Context<ReadEnv>;
interface Core {
  db: D1b;
  cache: Cache;
}

const codeLen = (s: string): number => [...s].length;
const ipLongOf = (c: Ctx): number => ipToLong(reqIp(c));

/** 写依赖：db/cache/env + 执行上下文（SEO 产物走 waitUntil，不拖慢写请求） */
async function writeDeps(c: Ctx): Promise<WriteDeps> {
  const ex = await getExecCtx(c);
  return {
    db: c.get('db'),
    cache: c.get('cache'),
    env: c.env,
    waitUntil: ex?.waitUntil ? (p: Promise<unknown>) => ex.waitUntil?.(p) : undefined,
  };
}

/**
 * 登录态 + 权威用户行 + 封禁/小黑屋双保险。
 * 权限与落库全部转交 modules/write/core.ts（MCP 写工具走同一份实现）。
 */
async function requireLogin(core: Core, c: Ctx): Promise<WriteActor> {
  const t = c.get('t');
  const v = await loadViewer(core.cache, core.db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const author = await loadAuthorRow(core.db, v.uid);
  if (!author) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  assertNotBanned(author, t);
  return makeWriteActor({ ...core, env: c.env }, author);
}

/* 引用块 / 引用摘要 / 事件发射 / 标签归一 / 图片组与摘要提取全部下沉到 ./core，
   与 MCP 写工具（extensions/mcp/write.ts）共用同一份实现，避免两套写入逻辑漂移。 */

/* extractImageUrls / extractSummary 由 ./core 提供（编辑路径也会重算这两列）。 */

/** 发帖（thread_create）：解析 + 人机验证 → ./core 统一写入（与 MCP 工具同一实现） */
async function createThread(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core: Core = { db: c.get('db'), cache: c.get('cache') };
  const actor = await requireLogin(core, c);
  const b = await readJson<CreateThreadReq>(c);
  // 人机验证只存在于浏览器入口；MCP 入口用令牌档位 + 每分钟限流替代（extensions/mcp/auth.ts）
  if (!(await verifyTurnstile(c.env, b.turnstileToken, reqIp(c)))) throw new AppError(Code.CAPTCHA_FAILED, t('auth.captchaFailed'));
  const r = await createThreadCore(
    await writeDeps(c),
    actor,
    {
      fid: Number(b.fid ?? 0),
      subject: String(b.subject ?? ''),
      message: String(b.message ?? ''),
      doctype: Number(b.doctype ?? 0),
      contentBuy: Number(b.contentBuy ?? 0),
      contentBuyType: Number(b.contentBuyType ?? 0),
      tags: (b as { tags?: unknown }).tags,
      lang: (b as { lang?: unknown }).lang,
      attachAids: b.attachAids ?? [],
    },
    ipLongOf(c),
    t,
  );
  return ok(c, r.gain ? `${t('write.threadCreated')} ${r.gain}` : t('write.threadCreated'), {
    data: { tid: r.tid, pid: r.pid },
  });
}

/** 回帖（post_create）：解析 + 人机验证 → ./core 统一写入（与 MCP 工具同一实现） */
async function createReply(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core: Core = { db: c.get('db'), cache: c.get('cache') };
  const actor = await requireLogin(core, c);
  const tid = intParam(c.req.param('tid'));
  const b = await readJson<CreatePostReq>(c);
  if (!(await verifyTurnstile(c.env, b.turnstileToken, reqIp(c)))) throw new AppError(Code.CAPTCHA_FAILED, t('auth.captchaFailed'));
  const r = await createReplyCore(
    await writeDeps(c),
    actor,
    tid,
    {
      message: String(b.message ?? ''),
      doctype: Number(b.doctype ?? 0),
      quotepid: Number(b.quotepid ?? 0),
      attachAids: b.attachAids ?? [],
    },
    ipLongOf(c),
    t,
  );

  return ok(c, r.gain || t('write.replyDone'), { data: { pid: r.pid, tid } });
}

/* 回帖通知与升组同属写路径语义，统一由 ./core 提供。 */

/** 编辑（post_update）：重跑 fmt（当前 gid）；isfirst 可改 subject/fid（含版块移动计数） */
async function updatePost(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core: Core = { db: c.get('db'), cache: c.get('cache') };
  const { viewer, ctx } = await requireLogin(core, c);
  const pid = intParam(c.req.param('pid'));
  const b = await readJson<{ subject?: string; fid?: number; message: string; doctype?: number; attachAids?: number[]; contentBuy?: number; contentBuyType?: number }>(c);

  const post = await core.db
    .prepare<{ pid: number; tid: number; uid: number; isfirst: number }>('SELECT pid,tid,uid,isfirst FROM bbs_post WHERE pid = ?')
    .bind(pid)
    .first<{ pid: number; tid: number; uid: number; isfirst: number }>();
  if (!post) throw new AppError(Code.NOT_FOUND, t('common.postNotFound'));
  const tid = Number(post.tid);
  const isfirst = Number(post.isfirst) === 1;
  const thread = await core.db
    .prepare<{ fid: number; closed: number; top: number; subject: string; uid: number; lang: string }>(
      'SELECT fid,closed,top,subject,uid,lang FROM bbs_thread WHERE tid = ?',
    )
    .bind(tid)
    .first<{ fid: number; closed: number; top: number; subject: string; uid: number; lang: string }>();
  if (!thread) throw new AppError(Code.NOT_FOUND, t('common.threadNotFound'));
  const fid = Number(thread.fid);
  if (!ctx.forumlist[fid]) throw new AppError(Code.NOT_FOUND, t('common.forumNotFound'));

  if (!forumAccessUser(ctx, fid, 'allowpost')) throw new AppError(Code.NO_PERMISSION, t('common.groupPermDenied'));
  const modAllow = forumAccessMod(ctx, fid, 'allowupdate');
  if (!canUpdatePost(ctx, fid, Number(post.uid)) && !modAllow) throw new AppError(Code.NO_PERMISSION, t('common.noEditPerm'));
  if (!modAllow && Number(thread.closed) > 0) throw new AppError(Code.NO_PERMISSION, t('write.threadClosed'));

  const message = (b.message ?? '').toString();
  if (!message.trim()) throw new AppError(Code.VALIDATION_ERROR, t('write.contentRequired'));
  // 编辑上限 2048000（与创建上限 2028000 不一致，按既有行为保留）
  if (codeLen(message) > 2_048_000) throw new AppError(Code.FORM_MESSAGE_TOO_LONG, t('write.contentTooLong'));
  const doctype = Number(b.doctype ?? 0);
  const fmt = postMessageFmt({ message, doctype, quotepid: 0 }, viewer.gid);

  const batchStmts: Stmt[] = [
    core.db.prepare('UPDATE bbs_post SET doctype = ?, message = ?, message_fmt = ? WHERE pid = ?').bind(doctype, fmt.message, fmt.message_fmt, pid) as unknown as Stmt,
  ];

  let movedForum = false;
  if (isfirst) {
    const newFid = Number(b.fid ?? fid);
    const subject = b.subject !== undefined ? b.subject.toString() : thread.subject;
    // 标题上限与创建口径统一（128，write.subjectTooLong）：历史 80 上限会使 81~128 字的存量标题一旦改动即无法保存
    if (subject !== thread.subject && codeLen(subject) > 128) {
      throw new AppError(Code.VALIDATION_ERROR, t('write.subjectTooLong'));
    }
    const arr: Record<string, number | string> = {};
    if (newFid !== fid) {
      if (!ctx.forumlist[newFid]) throw new AppError(Code.NOT_FOUND, t('common.forumNotFound'));
      // 移动需同时具备【旧版块】编辑权与【目标版块】发版权：否则可把主题塞进无权限/私密版块
      if (!forumAccessUser(ctx, fid, 'allowthread') || !forumAccessUser(ctx, newFid, 'allowthread')) {
        throw new AppError(Code.NO_PERMISSION, t('common.groupPermDenied'));
      }
      if (Number(post.uid) !== viewer.uid && !forumAccessMod(ctx, fid, 'allowupdate')) throw new AppError(Code.NO_PERMISSION, t('common.groupPermDenied'));
      arr.fid = newFid;
      movedForum = true;
      batchStmts.push(core.db.prepare('UPDATE bbs_forum SET threads = threads + 1 WHERE fid = ?').bind(newFid) as unknown as Stmt);
      batchStmts.push(core.db.prepare('UPDATE bbs_forum SET threads = threads - 1 WHERE fid = ?').bind(fid) as unknown as Stmt);
      batchStmts.push(core.db.prepare('UPDATE bbs_thread_top SET fid = ? WHERE tid = ?').bind(newFid, tid) as unknown as Stmt);
    }
    if (subject !== thread.subject) arr.subject = subject;

    if (arr.subject !== undefined) {
      batchStmts.push(core.db.prepare('UPDATE bbs_thread SET subject = ? WHERE tid = ?').bind(subject, tid) as unknown as Stmt);
    }
    if (arr.fid !== undefined) {
      batchStmts.push(core.db.prepare('UPDATE bbs_thread SET fid = ? WHERE tid = ?').bind(newFid, tid) as unknown as Stmt);
    }
    /* 内容语言：版块有效语言（自身绑定 / 继承父版块）优先——绑定版块内的主题语言必须与版块一致，
       故编辑首帖时顺带把绑定前创建的存量主题对齐（含移动后的目标版块）；
       未绑定时：显式提交优先，已有值保持（不因编辑正文静默改写用户当初的选择），
       仅当 lang 为空时按新标题+正文补判（编辑顺带完成一次回填）。 */
    const nextLang =
      forumLangOf(ctx.forumlist, newFid) ||
      normalizeContentLang((b as { lang?: unknown }).lang) ||
      (thread.lang ? String(thread.lang) : detectContentLang(`${subject} ${message}`));
    if (nextLang && nextLang !== thread.lang) {
      batchStmts.push(core.db.prepare('UPDATE bbs_thread SET lang = ? WHERE tid = ?').bind(nextLang, tid) as unknown as Stmt);
    }
    // 收费设置：仅 allowsell 组提交收费字段时生效；
    // 「否」/空数/非法数 → 清 content_buy = 0（清空分支不回落 content_buy_type）。
    // 对非首帖编辑不误清所在主题价格——本项目按「仅首帖生效」处理；未提交该字段则不动。
    if (b.contentBuy !== undefined && Number(ctx.grouplist[viewer.gid]?.allowsell ?? 0) === 1) {
      const rawBuy = Math.trunc(Number(b.contentBuy));
      if (Number.isFinite(rawBuy) && rawBuy > 0) {
        const type = [1, 2, 3].includes(Number(b.contentBuyType)) ? Number(b.contentBuyType) : 1;
        batchStmts.push(
          core.db
            .prepare('UPDATE bbs_thread SET content_buy = ?, content_buy_type = ? WHERE tid = ?')
            .bind(Math.min(rawBuy, 9_999_999), type, tid) as unknown as Stmt,
        );
      } else {
        batchStmts.push(core.db.prepare('UPDATE bbs_thread SET content_buy = 0 WHERE tid = ?').bind(tid) as unknown as Stmt);
      }
    }
    // 列表图片组：首帖正文变更后重提取（列表缩略图随编辑同步）
    batchStmts.push(core.db.prepare('UPDATE bbs_thread SET image_urls = ? WHERE tid = ?').bind(extractImageUrls(message), tid) as unknown as Stmt);
    // 列表摘要：首帖正文变更后重提取（列表摘要随编辑同步）
    batchStmts.push(core.db.prepare('UPDATE bbs_thread SET summary = ? WHERE tid = ?').bind(extractSummary(message), tid) as unknown as Stmt);
  }

  // 编辑后重置审核：
  //  isfirst → check_or_not(组, 新 fid, 'thread') → 主题+首帖置 0（未传 fid 则不触发）；
  //  非 isfirst → check_or_not(组, 当前 fid, 'thread') → 该回帖置 0（沿用 'thread' 条件位）。
  const checkForum = isfirst ? (b.fid !== undefined ? ctx.forumlist[Number(b.fid)] : undefined) : ctx.forumlist[fid];
  if (checkOrNot(ctx.grouplist[viewer.gid], checkForum, 'thread')) {
    if (isfirst) {
      batchStmts.push(
        core.db.prepare('UPDATE bbs_thread SET ok = ? WHERE tid = ?').bind(CheckStatus.PENDING, tid) as unknown as Stmt,
        core.db.prepare('UPDATE bbs_post SET ok = ? WHERE tid = ? AND isfirst = 1').bind(CheckStatus.PENDING, tid) as unknown as Stmt,
      );
    } else {
      batchStmts.push(
        core.db.prepare('UPDATE bbs_post SET ok = ? WHERE pid = ? AND isfirst = 0').bind(CheckStatus.PENDING, pid) as unknown as Stmt,
      );
    }
  }

  await core.db.batch(batchStmts);
  if (movedForum) await core.cache.del('forumlist');
  await associateAttachments({ db: core.db, env: c.env, uid: viewer.uid, tid, pid, isfirst, aids: b.attachAids ?? [] });
  await emit(core, 'post:updated', { pid, tid, uid: Number(post.uid) });
  await scheduleSeo(core, c, tid, 'gen');
  return ok(c, t('write.editDone'), { data: { pid, tid } });
}

/** 删除（post_delete / thread_delete 级联） */
async function deletePost(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core: Core = { db: c.get('db'), cache: c.get('cache') };
  const { viewer, ctx } = await requireLogin(core, c);
  const pid = intParam(c.req.param('pid'));

  const post = await core.db
    .prepare<{ pid: number; tid: number; uid: number; isfirst: number }>('SELECT pid,tid,uid,isfirst FROM bbs_post WHERE pid = ?')
    .bind(pid)
    .first<{ pid: number; tid: number; uid: number; isfirst: number }>();
  if (!post) throw new AppError(Code.NOT_FOUND, t('common.postNotFound'));
  const tid = Number(post.tid);
  const isfirst = Number(post.isfirst) === 1;
  const thread = await core.db
    .prepare<{ fid: number; closed: number; uid: number; lastpid: number; ok: number }>('SELECT fid,closed,uid,lastpid,ok FROM bbs_thread WHERE tid = ?')
    .bind(tid)
    .first<{ fid: number; closed: number; uid: number; lastpid: number; ok: number }>();
  if (!thread) throw new AppError(Code.NOT_FOUND, t('common.threadNotFound'));
  const fid = Number(thread.fid);
  if (!ctx.forumlist[fid]) throw new AppError(Code.NOT_FOUND, t('common.forumNotFound'));

  if (!forumAccessUser(ctx, fid, 'allowpost')) throw new AppError(Code.NO_PERMISSION, t('common.groupPermDenied'));
  const delMod = forumAccessMod(ctx, fid, 'allowdelete');
  if (!canDeletePost(ctx, fid, Number(post.uid)) && !delMod) throw new AppError(Code.NO_PERMISSION, t('common.noDeletePerm'));
  if (!delMod && Number(thread.closed) > 0) throw new AppError(Code.NO_PERMISSION, t('write.threadClosed'));

  const postUid = Number(post.uid);

  if (isfirst) {
    // 回收站：recycle=1 时首帖删除 → 主题软删除（ok=-2，不改计数）；
    // 已是回收站状态且操作者含 see_check → 跳过软删除走真删
    const setting = await loadSetting(core.cache, core.db);
    if (setting.recycle && !(Number(thread.ok) === CheckStatus.RECYCLE && hasSeeCheck(ctx.grouplist[viewer.gid]))) {
      await core.db.batch([
        core.db.prepare('UPDATE bbs_thread SET ok = ? WHERE tid = ?').bind(CheckStatus.RECYCLE, tid) as unknown as Stmt,
        core.db.prepare('UPDATE bbs_post SET ok = ? WHERE tid = ? AND isfirst = 1').bind(CheckStatus.RECYCLE, tid) as unknown as Stmt,
      ]);
      await scheduleSeo(core, c, tid, 'del');
      return ok(c, t('common.deleted'), { data: { tid, recycle: true } });
    }
    // 主题级联删（复用 core/purge.threadPurgeStmts：按作者聚合回退 user.posts + 社交/购买孤儿清理 + 当日计数回退）。
    // `isfirst = 0`：首帖不计入 user.posts（发帖只 threads+1），否则作者计数会每删一贴多减 1 并漂成负数。
    const stmts: Stmt[] = [];
    await threadPurgeStmts(core.db, { tid, fid, uid: Number(thread.uid) }, stmts);
    // 积分回扣条目与附件 key 须在删除前读取楼层/附件
    const revokeEntries = await threadRevokeEntries(core.db, tid, Number(thread.uid));
    const attachKeys = await attachKeysByTid(core.db, tid);
    await core.db.batch(stmts);
    purgeR2Objects(c.env, await getExecCtx(c), attachKeys);
    // 积分回扣 + 批量按新经验重算等级组（1 次 SELECT + 1 次 batch，取代逐 uid 往返）
    await revokeForPostDelete(core, revokeEntries);
    for (const up of await upgradeGroupsByCredits(core, revokeAffectedUids(revokeEntries), ctx.grouplist)) {
      await emit(core, 'user:group-changed', { uid: up.uid, oldGid: up.oldGid, newGid: up.newGid });
    }
    await patchRuntime(core.cache, { threads: -1 });
    await core.cache.del('forumlist');
    await emit(core, 'post:deleted', { pid, tid, uid: postUid });
    await emit(core, 'thread:deleted', { tid, fid });
    await scheduleSeo(core, c, tid, 'del');
    return ok(c, t('common.deleted'), { data: { tid, cascade: true } });
  }

  // 回帖删除：始终真删（recycle 模式仅首帖软删除，回帖不受影响）
  const purge = await postPurgeStmts(core.db, pid);
  if (purge) {
    const attachKeys = await attachKeysByPid(core.db, pid);
    await core.db.batch(purge.stmts);
    await patchRuntime(core.cache, { posts: -1 });
    purgeR2Objects(c.env, await getExecCtx(c), attachKeys);
    // 积分回扣（非首帖扣作者 post_*）→ 按新经验重算等级组
    await revokeForPostDelete(core, [{ uid: postUid, isfirst: 0, pid }]);
    await upgradeAfterGrant(core, postUid, ctx.grouplist);
  }
  await core.cache.del(`user:${postUid}`);
  await emit(core, 'post:deleted', { pid, tid, uid: postUid });
  await scheduleSeo(core, c, tid, 'gen');
  return ok(c, t('common.deleted'), { data: { pid, tid } });
}

export function writeRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();
  app.post('/api/threads', createThread);
  app.post('/api/threads/:tid/posts', createReply);
  app.put('/api/posts/:pid', updatePost);
  app.delete('/api/posts/:pid', deletePost);
  return app;
}
