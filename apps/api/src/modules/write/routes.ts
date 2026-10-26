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
import { Code, detectContentLang, effectiveBanScope, normalizeContentLang, type CreatePostReq, type CreateThreadReq, type EventName, type EventPayload } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { D1b, Stmt } from '../../core/db';
import type { Cache } from '../../core/cache';
import { postMessageFmt, MESSAGE_MAX_CHARS } from '../../core/fmt';
import {
  canDeletePost,
  canUpdatePost,
  forumAccessMod,
  forumAccessUser,
  type AccessCtx,
} from '../../core/access';
import { forumLangOf, loadForumlist, loadGrouplist, loadSetting, loadViewer, reqIp, makeAccessCtx } from '../../core/loaders';
import { CheckStatus, canSeeUnapproved, checkOrNot, hasSeeCheck, shouldBlockUnapproved } from '../../core/check';
import { attachKeysByPid, attachKeysByTid, postPurgeStmts, purgeR2Objects, threadPurgeStmts } from '../../core/purge';
import { ipToLong } from '../../core/auth/session';
import { getExtensions } from '../../core/extensions';
import { isEnabled, loadExtensionsState } from '../../core/extensions/registry';
import { loadExtConfig } from '../../core/ext-store';
import { QUICK_REPLY_EXT_ID, QUICK_REPLY_MANIFEST } from '../../extensions/legacy-extensions';
import { LIGHT_EXT_ID, parseLightConfig } from '../../extensions/light';
import { verifyTurnstile } from '../../core/turnstile';
import {
  grantForPost,
  postCreditGate,
  revokeAffectedUids,
  revokeForPostDelete,
  threadRevokeEntries,
  upgradeGroupByCredits,
  upgradeGroupsByCredits,
} from '../../core/points';
import { NoticeType, noticeQuoteHtml, noticeReplyHtml, noticeSend } from '../../core/notice';
import { banMessage } from '../../core/ban';
import { associateAttachments } from '../attach/routes';
import { scheduleSeo } from '../seo/generate';
import { getExecCtx, intParam, patchRuntime, readJson, type ReadEnv } from '../shared';
import type { ApiT } from '../../core/i18n';

type Ctx = Context<ReadEnv>;
interface Core {
  db: D1b;
  cache: Cache;
}

const now = () => Math.floor(Date.now() / 1000);
const codeLen = (s: string): number => [...s].length;
const ipLongOf = (c: Ctx): number => ipToLong(reqIp(c));

/** 当前登录用户权威数据（写路径需要 avatar/threads/posts/ok，viewer 缓存不含这些列） */
interface AuthorRow {
  uid: number;
  gid: number;
  username: string;
  avatar: number;
  threads: number;
  posts: number;
  /** 账号审核状态（tt_check）：非 1 且开启 user_check 时禁发帖回帖 */
  ok: number;
  /** 小黑屋（0025）：封禁位掩码/到期/理由 */
  ban_scope: number;
  ban_until: number;
  ban_reason: string;
}

async function requireLogin(core: Core, c: Ctx): Promise<{ viewer: AuthorRow; ctx: AccessCtx }> {
  const t = c.get('t');
  const { db, cache } = core;
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const author = await db
    .prepare<AuthorRow>('SELECT uid,gid,username,avatar,threads,posts,ok,ban_scope,ban_until,ban_reason FROM bbs_user WHERE uid = ?')
    .bind(v.uid)
    .first<AuthorRow>();
  if (!author || author.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  /**
   * 小黑屋双保险（banGuard 已全局收口）：写路径是 banGuard 唯一的 MUTE 判定面，
   * 此处再判一次，防止将来新增绕过 /api 前缀的写入口（如插件直挂路由）时漏拦。
   * 本模块所有入口都是写操作，故任一封禁维度都拒绝。
   */
  const banScope = effectiveBanScope(author.ban_scope, author.ban_until, now());
  if (banScope) {
    throw new AppError(Code.BANNED, banMessage(banScope, Number(author.ban_until ?? 0), String(author.ban_reason ?? ''), t), {
      banScope,
      banUntil: Number(author.ban_until ?? 0),
    });
  }
  const [forumlist, grouplist] = await Promise.all([loadForumlist(cache, db), loadGrouplist(cache, db)]);
  return { viewer: author, ctx: makeAccessCtx(author, forumlist, grouplist) };
}

/** 引用块：正文原文 → 去标签转义截 100 → 带头像/用户名链接的 blockquote */
function postQuoteHtml(uid: number, username: string, avatar: number, brief: string): string {
  const userHref = `/user/${uid}`;
  const avatarSrc = avatar > 0 ? `/files/avatar/${String(uid).padStart(9, '0').slice(0, 3)}/${uid}.png?v=${avatar}` : '';
  return (
    '<blockquote class="blockquote">' +
    `<a href="${userHref}" class="text-small text-muted user">` +
    `<img class="avatar-1" src="${avatarSrc}">` +
    `${username}</a>${brief}</blockquote>`
  );
}

/** 引用摘要：去标签 → HTML 转义 → 超 100 码点加 ' ... ' → 截断 → \n→<br> */
function postBrief(html: string): string {
  const text = html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const cps = [...escaped];
  const more = cps.length > 100 ? ' ... ' : '';
  return cps.slice(0, 100).join('') + more;
}

async function emit<N extends EventName>(core: Core, event: N, payload: EventPayload<N>): Promise<void> {
  const rt = await getExtensions(core.cache, core.db, undefined, { preloadConfigs: false });
  await rt.bus.emit(event, payload);
}

/** 标签归一（idx_tag 轻量实现）：仅保留 light 扩展「标签定义」内的名称（服务端白名单），
 *  ≤4 个、每个 ≤12 字、剔空白/逗号、去重，存逗号分隔串；未定义标签直接丢弃（与发帖页可选集合一致） */
function normalizeTags(input: unknown, allowed: Set<string>): string {
  if (!Array.isArray(input)) return '';
  const out: string[] = [];
  for (const v of input) {
    const s = String(v ?? '')
      .replace(/[,\s]+/g, '')
      .slice(0, 12);
    if (s && allowed.has(s) && !out.includes(s)) out.push(s);
    if (out.length >= 4) break;
  }
  return out.join(',');
}

/** 列表图片组提取（thread_summary_pic）：首帖 HTML 中的 <img src>，≤9 张、去重，逗号分隔存 image_urls；
 *  跳过 data:/blob: 内联图与含逗号/引号的非法值（会破坏逗号分隔存储与 DTO） */
export function extractImageUrls(message: string): string {
  const out: string[] = [];
  const re = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let m: RegExpExecArray | null;
  while (out.length < 9 && (m = re.exec(message))) {
    const src = (m[1] ?? m[2] ?? m[3] ?? '').replace(/&amp;/g, '&').trim();
    if (!src || /^(?:data|blob|javascript):/i.test(src) || /[,"']/.test(src) || out.includes(src)) continue;
    out.push(src);
  }
  return out.join(',');
}

/** 列表摘要存储上限（前台按配置再截断，此处留足余量） */
const SUMMARY_STORE_MAX = 300;

/** 列表摘要提取（thread_summary_word）：首帖 HTML 去标签 → 纯文本，折叠空白、截断 ≤300 字存 summary 列。
 *  与 extractImageUrls 同为写时定稿的反规范化（列表零 JOIN 直出） */
export function extractSummary(message: string): string {
  const text = message
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, SUMMARY_STORE_MAX);
}

/** 发帖（thread_create）：首帖→主题→回填→倒排→计数，事务内在 pid/tid 已知后一次 batch */
async function createThread(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core: Core = { db: c.get('db'), cache: c.get('cache') };
  const { viewer, ctx } = await requireLogin(core, c);
  const b = await readJson<CreateThreadReq>(c);
  if (!(await verifyTurnstile(c.env, b.turnstileToken, reqIp(c)))) throw new AppError(Code.CAPTCHA_FAILED, t('auth.captchaFailed'));
  const fid = Number(b.fid ?? 0);
  const forum = ctx.forumlist[fid];
  if (!forum) throw new AppError(Code.NOT_FOUND, t('common.forumNotFound'));
  if (!forumAccessUser(ctx, fid, 'allowthread')) throw new AppError(Code.NO_PERMISSION, t('common.groupPermDenied'));
  // 账号未过审闸门（user_check 开启时未过审账号禁发帖）
  if (shouldBlockUnapproved(await loadSetting(core.cache, core.db), Number(viewer.ok))) {
    throw new AppError(Code.NO_PERMISSION, t('write.approvalWaitThread'));
  }
  // 积分闸门（负向规则会把余额扣成负数 → 拒绝发帖）
  const gate = await postCreditGate(core, viewer.uid, 1);
  if (gate) throw new AppError(Code.FORM_INSUFFICIENT_CREDITS, gate);
  // 收费帖设置（仅 allowsell 组生效，未开启组静默忽略）
  const allowsell = Number(ctx.grouplist[viewer.gid]?.allowsell ?? 0) === 1;
  const rawBuy = Math.trunc(Number(b.contentBuy ?? 0));
  const contentBuy = allowsell && Number.isFinite(rawBuy) && rawBuy > 0 ? Math.min(rawBuy, 9_999_999) : 0;
  const contentBuyType = contentBuy > 0 && [1, 2, 3].includes(Number(b.contentBuyType)) ? Number(b.contentBuyType) : 1;
  const subject = (b.subject ?? '').toString();
  if (!subject.trim()) throw new AppError(Code.VALIDATION_ERROR, t('write.subjectRequired'));
  if (codeLen(subject) > 128) throw new AppError(Code.VALIDATION_ERROR, t('write.subjectTooLong'));
  const message = (b.message ?? '').toString();
  if (!message.trim()) throw new AppError(Code.VALIDATION_ERROR, t('write.contentRequired'));
  const doctype = Number(b.doctype ?? 0);
  if (doctype > 10) throw new AppError(Code.VALIDATION_ERROR, t('write.doctypeUnsupported'));
  if (codeLen(message) > MESSAGE_MAX_CHARS) throw new AppError(Code.FORM_MESSAGE_TOO_LONG, t('write.contentTooLong'));

  const ts = now();
  const ip = ipLongOf(c);
  const fmt = postMessageFmt({ message, doctype, quotepid: 0 }, viewer.gid);

  // 1) 首帖（tid 待回填）
  const postR = await core.db
    .prepare<{ pid: number }>(
      'INSERT INTO bbs_post (tid,uid,isfirst,create_date,userip,doctype,quotepid,message,message_fmt) VALUES (0,?,1,?,?,?,0,?,?) RETURNING pid',
    )
    .bind(viewer.uid, ts, ip, doctype, fmt.message, fmt.message_fmt)
    .first<{ pid: number }>();
  const pid = Number(postR?.pid ?? 0);
  if (!pid) throw new AppError(Code.SYSTEM_ERROR, t('write.postCreateFailed'));

  // 2) 主题（firstpid=lastpid=pid；content_buy 随创建同批写入，无需创建后 UPDATE；tags 为简蓝主题标签；
  //    image_urls 为列表图片组：从首帖正文提取 ≤9 张图片地址）
  // 标签白名单取自 light 扩展「标签定义」（idx_tag：标签由后台维护，仅接受已定义名称）
  const lightCfg = parseLightConfig(await loadExtConfig(core.cache, core.db, LIGHT_EXT_ID));
  const tags = normalizeTags((b as { tags?: unknown }).tags, new Set(lightCfg.tags.map((x) => x.name)));
  const imageUrls = extractImageUrls(message);
  const summary = extractSummary(message);
  /* 内容语言（写时定稿）：版块有效语言（自身绑定，或继承父版块；0024）非空则强制该语言，
     忽略用户选择与自动检测；否则显式选择优先（用户可覆盖检测结果），再否则按标题+正文自动检测；
     都判不出时落空串（= 不参与语言过滤，存量数据同口径）。 */
  const lang =
    forumLangOf(ctx.forumlist, fid) ||
    normalizeContentLang((b as { lang?: unknown }).lang) ||
    detectContentLang(`${subject} ${message}`);
  const threadR = await core.db
    .prepare<{ tid: number }>(
      'INSERT INTO bbs_thread (fid,uid,username,avatar,userip,subject,create_date,last_date,firstpid,lastpid,lastuid,lastusername,content_buy,content_buy_type,tags,image_urls,summary,lang) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING tid',
    )
    .bind(fid, viewer.uid, viewer.username, viewer.avatar, ip, subject, ts, ts, pid, pid, viewer.uid, viewer.username, contentBuy, contentBuyType, tags, imageUrls, summary, lang)
    .first<{ tid: number }>();
  const tid = Number(threadR?.tid ?? 0);
  if (!tid) {
    await core.db.prepare('DELETE FROM bbs_post WHERE pid = ?').bind(pid).run(); // 回滚孤儿首帖
    throw new AppError(Code.SYSTEM_ERROR, t('write.threadCreateFailed'));
  }

  // 3) 关联 + 倒排 + 计数（事务内，参数此时全部已知）
  const batchStmts: Stmt[] = [
    core.db.prepare('UPDATE bbs_post SET tid = ? WHERE pid = ?').bind(tid, pid) as unknown as Stmt,
    core.db.prepare('INSERT INTO bbs_mythread (uid,tid) VALUES (?,?)').bind(viewer.uid, tid) as unknown as Stmt,
    core.db.prepare('INSERT INTO bbs_mypost (uid,tid,pid) VALUES (?,?,?)').bind(viewer.uid, tid, pid) as unknown as Stmt,
    core.db.prepare('UPDATE bbs_forum SET threads = threads + 1, todaythreads = todaythreads + 1 WHERE fid = ?').bind(fid) as unknown as Stmt,
    core.db.prepare('UPDATE bbs_user SET threads = threads + 1 WHERE uid = ?').bind(viewer.uid) as unknown as Stmt,
  ];
  // 审核置位（check_or_not(组, 板块, 'thread') → 主题与首帖 ok=0）
  if (checkOrNot(ctx.grouplist[viewer.gid], forum, 'thread')) {
    batchStmts.push(
      core.db.prepare('UPDATE bbs_thread SET ok = ? WHERE tid = ?').bind(CheckStatus.PENDING, tid) as unknown as Stmt,
      core.db.prepare('UPDATE bbs_post SET ok = ? WHERE tid = ? AND isfirst = 1').bind(CheckStatus.PENDING, tid) as unknown as Stmt,
    );
  }
  try {
    await core.db.batch(batchStmts);
  } catch (e) {
    // 第三步 batch 失败：D1 batch 具事务性、其内语句已整体回滚，但前两步独立 INSERT（首帖/主题）已提交 →
    // 手动回滚删两行，否则留下无倒排/无计数的脏主题（首页出现幽灵主题）。
    await core.db
      .batch([
        core.db.prepare('DELETE FROM bbs_thread WHERE tid = ?').bind(tid) as unknown as Stmt,
        core.db.prepare('DELETE FROM bbs_post WHERE pid = ?').bind(pid) as unknown as Stmt,
      ])
      .catch(() => undefined);
    throw e;
  }

  await patchRuntime(core.cache, { threads: 1, todaythreads: 1 });
  await core.cache.del('forumlist'); // forum_list_cache_delete
  await associateAttachments({ db: core.db, env: c.env, uid: viewer.uid, tid, pid, isfirst: true, aids: b.attachAids ?? [] });
  await emit(core, 'thread:created', { tid, fid, uid: viewer.uid });
  await emit(core, 'post:created', { pid, tid, uid: viewer.uid, isfirst: 1 });
  // 三币种发放 → 按经验重算等级组；成功文案拼「经验+N ...」后缀
  const gain = await grantForPost(core, { uid: viewer.uid, isfirst: 1, pid, ts: ts });
  await upgradeAfterGrant(core, viewer.uid, ctx.grouplist, viewer.gid);
  await scheduleSeo(core, c, tid, 'gen');
  return ok(c, gain ? `${t('write.threadCreated')} ${gain}` : t('write.threadCreated'), { data: { tid, pid } });
}

/** 回帖（post_create） */
async function createReply(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core: Core = { db: c.get('db'), cache: c.get('cache') };
  const { viewer, ctx } = await requireLogin(core, c);
  const tid = intParam(c.req.param('tid'));
  const b = await readJson<CreatePostReq>(c);
  if (!(await verifyTurnstile(c.env, b.turnstileToken, reqIp(c)))) throw new AppError(Code.CAPTCHA_FAILED, t('auth.captchaFailed'));

  const thread = await core.db
    .prepare<{ fid: number; closed: number; top: number; uid: number; posts: number; subject: string; ok: number }>(
      'SELECT fid,closed,top,uid,posts,subject,ok FROM bbs_thread WHERE tid = ?',
    )
    .bind(tid)
    .first<{ fid: number; closed: number; top: number; uid: number; posts: number; subject: string; ok: number }>();
  if (!thread) throw new AppError(Code.NOT_FOUND, t('common.threadNotFound'));
  const fid = Number(thread.fid);
  if (!ctx.forumlist[fid]) throw new AppError(Code.NOT_FOUND, t('common.forumNotFound'));
  if (!forumAccessUser(ctx, fid, 'allowpost')) throw new AppError(Code.NO_PERMISSION, t('common.groupPermDenied'));
  // 可见性口径同读路径（防借回帖成功与否探测待审/回收主题的存在；版务与主题作者可回）
  if (
    !canSeeUnapproved(Number(thread.ok), {
      seeCheck: hasSeeCheck(ctx.grouplist[viewer.gid]),
      isAuthor: Number(thread.uid) === viewer.uid,
    })
  ) {
    throw new AppError(Code.NOT_FOUND, t('common.threadNotFound'));
  }
  // 账号未过审闸门（user_check 开启时未过审账号禁回帖）
  if (shouldBlockUnapproved(await loadSetting(core.cache, core.db), Number(viewer.ok))) {
    throw new AppError(Code.NO_PERMISSION, t('write.approvalWaitReply'));
  }
  // 积分闸门（负向规则会把余额扣成负数 → 拒绝回帖）
  const gate = await postCreditGate(core, viewer.uid, 0);
  if (gate) throw new AppError(Code.FORM_INSUFFICIENT_CREDITS, gate);
  // 快速回复限制：开关开且本帖回帖数已达阈值时，
  // 该用户在本帖的回帖数 >= 上限则拒绝。按 COUNT(*) >= count 判满，
  // 与逐行取满再数行数等价（超过上限的用户两种口径结果一致）。
  const qrState = await loadExtensionsState(core.cache, core.db);
  if (isEnabled(QUICK_REPLY_MANIFEST, qrState)) {
    const qr = await loadExtConfig(core.cache, core.db, QUICK_REPLY_EXT_ID);
    const limit = Math.trunc(Number(qr.post_message_count_by_uid));
    if (Number(qr.is_quick_reply_message) === 1 && limit > 0 && Number(thread.posts) >= limit) {
      const mine = await core.db
        .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_post WHERE tid = ? AND uid = ?')
        .bind(tid, viewer.uid)
        .first<{ c: number }>();
      if (Number(mine?.c ?? 0) >= limit) {
        throw new AppError(Code.VALIDATION_ERROR, String(qr.post_message_error || t('write.qrLimit')));
      }
    }
  }
  // closed：游客(gid=0)与等级组(gid>5)禁回，gid 1..5（管理/超版/版主/版主/实习）可回
  if (Number(thread.closed) > 0 && (viewer.gid === 0 || viewer.gid > 5)) {
    throw new AppError(Code.NO_PERMISSION, t('write.threadClosed'));
  }

  const message = (b.message ?? '').toString();
  if (!message.trim()) throw new AppError(Code.VALIDATION_ERROR, t('write.contentRequired'));
  const doctype = Number(b.doctype ?? 0);
  if (codeLen(message) > MESSAGE_MAX_CHARS) throw new AppError(Code.FORM_MESSAGE_TOO_LONG, t('write.contentTooLong'));

  // quotepid 校验：必须存在且同属本主题，否则归零（发帖前置校验）
  let quotepid = Number(b.quotepid ?? 0);
  let quoteHtml = '';
  let quoteUid = 0; // 被引用楼层作者（消息通知用；无效引用归 0）
  let quoteMessage = '';
  if (quotepid > 0) {
    const q = await core.db
      .prepare<{ pid: number; tid: number; uid: number; message: string }>(
        'SELECT pid,tid,uid,message FROM bbs_post WHERE pid = ?',
      )
      .bind(quotepid)
      .first<{ pid: number; tid: number; uid: number; message: string }>();
    if (!q || Number(q.tid) !== tid) {
      quotepid = 0;
    } else {
      quoteUid = Number(q.uid);
      quoteMessage = String(q.message);
      const qu = await core.db
        .prepare<{ username: string; avatar: number }>('SELECT username,avatar FROM bbs_user WHERE uid = ?')
        .bind(Number(q.uid))
        .first<{ username: string; avatar: number }>();
      quoteHtml = postQuoteHtml(Number(q.uid), String(qu?.username ?? ''), Number(qu?.avatar ?? 0), postBrief(String(q.message)));
    }
  }

  const fmt = postMessageFmt({ message, doctype, quotepid }, viewer.gid, quoteHtml);
  const ts = now();
  const ip = ipLongOf(c);


  const postR = await core.db
    .prepare<{ pid: number }>(
      'INSERT INTO bbs_post (tid,uid,isfirst,create_date,userip,doctype,quotepid,message,message_fmt) VALUES (?,?,0,?,?,?,?,?,?) RETURNING pid',
    )
    .bind(tid, viewer.uid, ts, ip, doctype, quotepid, fmt.message, fmt.message_fmt)
    .first<{ pid: number }>();
  const pid = Number(postR?.pid ?? 0);
  if (!pid) throw new AppError(Code.SYSTEM_ERROR, t('write.replyFailed'));

  const replyStmts: Stmt[] = [
    core.db.prepare('UPDATE bbs_user SET posts = posts + 1 WHERE uid = ?').bind(viewer.uid) as unknown as Stmt,
    core.db.prepare('UPDATE bbs_forum SET todayposts = todayposts + 1 WHERE fid = ?').bind(fid) as unknown as Stmt,
    core.db.prepare('INSERT INTO bbs_mypost (uid,tid,pid) VALUES (?,?,?)').bind(viewer.uid, tid, pid) as unknown as Stmt,
  ];
  // 审核置位（check_or_not(组, 板块, 'post') → 回帖 ok=0）
  const replyPending = checkOrNot(ctx.grouplist[viewer.gid], ctx.forumlist[fid], 'post');
  if (replyPending) {
    // 待审回帖不更新主题反规范化列（posts/lastpid/lastuid/last_date）：否则列表页泄露「幽灵回复」、
    // 分页出现空尾页；过审时由 /api/check（act=1,opt=1）补列。user.posts/todayposts 为发帖行为计数，不受审核影响。
    replyStmts.push(
      core.db.prepare('UPDATE bbs_post SET ok = ? WHERE pid = ? AND isfirst = 0').bind(CheckStatus.PENDING, pid) as unknown as Stmt,
    );
  } else {
    replyStmts.push(
      core.db.prepare('UPDATE bbs_thread SET posts = posts + 1, lastpid = ?, lastuid = ?, last_date = ?, lastusername = ? WHERE tid = ?').bind(pid, viewer.uid, ts, viewer.username, tid) as unknown as Stmt,
    );
  }
  await core.db.batch(replyStmts);

  await patchRuntime(core.cache, { posts: 1, todayposts: 1 });
  await core.cache.del('forumlist');
  await core.cache.del(`user:${viewer.uid}`);
  await associateAttachments({ db: core.db, env: c.env, uid: viewer.uid, tid, pid, isfirst: false, aids: b.attachAids ?? [] });
  await emit(core, 'post:created', { pid, tid, uid: viewer.uid, isfirst: 0 });
  // 三币种发放（有线则文案=积分串，无线才回落「回帖成功」）→ 按经验重算等级组
  const gain = await grantForPost(core, { uid: viewer.uid, isfirst: 0, pid, ts: ts });
  await upgradeAfterGrant(core, viewer.uid, ctx.grouplist, viewer.gid);
  // 待审回帖不发通知：通知正文嵌入回帖原文，若即时发出则绕过审核直接触达主题作者/被引用者（被拒后无法撤回）。
  if (!replyPending) {
    await sendReplyNotices(core, {
      tid,
      pid,
      fromUid: viewer.uid,
      threadUid: Number(thread.uid),
      subject: String(thread.subject),
      message,
      quoteUid,
      quoteMessage,
      ts,
    }, t);
  }
  await scheduleSeo(core, c, tid, 'gen');

  return ok(c, gain || t('write.replyDone'), { data: { pid, tid } });
}

/**
 * 回帖消息：主题作者评论通知（被引用者即主题作者时跳过，避免重复）
 * + 有效引用时给被引用楼层作者发引用通知。type=2（评论）。
 */
async function sendReplyNotices(
  core: Core,
  o: {
    tid: number;
    pid: number;
    fromUid: number;
    threadUid: number;
    subject: string;
    message: string;
    quoteUid: number;
    quoteMessage: string;
    ts: number;
  },
  t: ApiT,
): Promise<void> {
  if (o.quoteUid !== o.threadUid) {
    await noticeSend(core.db, {
      fromuid: o.fromUid,
      recvuid: o.threadUid,
      type: NoticeType.COMMENT,
      message: noticeReplyHtml(o.tid, o.subject, o.pid, o.message, t),
      ts: o.ts,
    });
  }
  if (o.quoteUid > 0) {
    await noticeSend(core.db, {
      fromuid: o.fromUid,
      recvuid: o.quoteUid,
      type: NoticeType.COMMENT,
      message: noticeQuoteHtml(o.tid, o.subject, o.pid, o.quoteMessage, o.message, t),
      ts: o.ts,
    });
  }
}

/**
 * 积分变动后的自动升组（按 credits 落组，非发帖数口径）。
 * 传 gid 时先做 gid<100 短路（管理组直接返回，省一次查询）；
 * 删除回扣路径只知道受影响 uid、组未知，省略 gid 由 upgradeGroupByCredits 内部判定。
 */
async function upgradeAfterGrant(core: Core, uid: number, grouplist: AccessCtx['grouplist'], gid?: number): Promise<void> {
  if (gid !== undefined && gid < 100) return;
  const up = await upgradeGroupByCredits(core, uid, grouplist);
  if (up) await emit(core, 'user:group-changed', { uid, oldGid: up.oldGid, newGid: up.newGid });
}

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
