/**
 * 写入核心（§8.3 写时定稿）：发主题 / 回帖的**唯二**实现。
 *
 * 为什么单独一层：内容写入有两个入口 ——
 *   ① HTTP  `POST /api/threads`、`POST /api/threads/:tid/posts`（modules/write/routes.ts）
 *   ② MCP   插件工具 `thread_create`、`reply_create`（extensions/mcp/write.ts）
 * 两个入口的权限、审核、积分、附件、通知、事件、SEO 必须完全一致，否则会出现
 * 「网页发帖要审核 / AI 发帖绕过审核」这类静默分叉。故所有判定与落库都在本文件，
 * 入口层只负责解析请求、人机验证（Turnstile 仅浏览器场景）与响应封装。
 *
 * 不变量：
 *  - 权限只走 core/access.ts；审核只走 core/check.ts；积分只走 core/points.ts；
 *  - 待审回帖不更新主题反规范化列（posts/lastpid/…），也不发通知（通知正文会绕过审核触达作者）；
 *  - 计数回写在 DB.batch() 事务内完成，失败按原路径回滚。
 */
import {
  Code,
  detectContentLang,
  effectiveBanScope,
  normalizeContentLang,
  type EventName,
  type EventPayload,
} from '@freeidx/shared';
import { AppError } from '../../middleware/envelope';
import type { D1b, Stmt } from '../../core/db';
import type { Cache } from '../../core/cache';
import type { Env } from '../../types/env';
import { postMessageFmt, MESSAGE_MAX_CHARS } from '../../core/fmt';
import { forumAccessUser, type AccessCtx } from '../../core/access';
import { forumLangOf, loadForumlist, loadGrouplist, loadSetting, makeAccessCtx } from '../../core/loaders';
import { CheckStatus, canSeeUnapproved, checkOrNot, hasSeeCheck, shouldBlockUnapproved } from '../../core/check';
import { getExtensions } from '../../core/extensions';
import { isEnabled, loadExtensionsState } from '../../core/extensions/registry';
import { loadExtConfig } from '../../core/ext-store';
import { QUICK_REPLY_EXT_ID, QUICK_REPLY_MANIFEST } from '../../extensions/legacy-extensions';
import { LIGHT_EXT_ID, parseLightConfig } from '../../extensions/light';
import { grantForPost, postCreditGate, upgradeGroupByCredits } from '../../core/points';
import { NoticeType, noticeQuoteHtml, noticeReplyHtml, noticeSend } from '../../core/notice';
import { banMessage } from '../../core/ban';
import { associateAttachments } from '../attach/routes';
import { deleteThreadSeoHtml, generateThreadSeoHtml } from '../seo/generate';
import { patchRuntime } from '../shared';
import type { ApiT } from '../../core/i18n';

export interface WriteDeps {
  db: D1b;
  cache: Cache;
  env: Env;
  /** 有执行上下文时把 SEO 产物生成放到 waitUntil（不拖慢写请求）；缺省内联等待 */
  waitUntil?: (p: Promise<unknown>) => void;
}

/** 写路径需要的权威用户行（viewer 缓存不含 avatar/threads/posts/ok/封禁列） */
export interface AuthorRow {
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

export interface WriteActor {
  viewer: AuthorRow;
  ctx: AccessCtx;
}

export interface ThreadDraft {
  fid: number;
  subject: string;
  message: string;
  doctype: number;
  contentBuy: number;
  contentBuyType: number;
  tags: unknown;
  lang: unknown;
  attachAids: number[];
}

export interface ReplyDraft {
  message: string;
  doctype: number;
  quotepid: number;
  attachAids: number[];
}

const now = (): number => Math.floor(Date.now() / 1000);
const codeLen = (s: string): number => [...s].length;

/* ----------------------------- 身份与写入闸门 ----------------------------- */

/** 按 uid 取写路径权威行（HTTP 端 uid 来自会话，MCP 端来自令牌） */
export async function loadAuthorRow(db: D1b, uid: number): Promise<AuthorRow | null> {
  if (uid <= 0) return null;
  const row = await db
    .prepare<AuthorRow>('SELECT uid,gid,username,avatar,threads,posts,ok,ban_scope,ban_until,ban_reason FROM bbs_user WHERE uid = ?')
    .bind(uid)
    .first<AuthorRow>();
  return row && Number(row.uid) > 0 ? row : null;
}

/** 组装写上下文（版块/组矩阵与学生成访问矩阵） */
export async function makeWriteActor(deps: WriteDeps, author: AuthorRow): Promise<WriteActor> {
  const [forumlist, grouplist] = await Promise.all([loadForumlist(deps.cache, deps.db), loadGrouplist(deps.cache, deps.db)]);
  return { viewer: author, ctx: makeAccessCtx(author, forumlist, grouplist) };
}

/**
 * 小黑屋双保险（banGuard 已全局收口，但 MCP 直挂 /mcp 不在 /api 前缀内，必须自己判）：
 * 写操作任一封禁维度都拒绝。
 */
export function assertNotBanned(author: AuthorRow, t: ApiT): void {
  const banScope = effectiveBanScope(author.ban_scope, author.ban_until, now());
  if (banScope) {
    throw new AppError(Code.BANNED, banMessage(banScope, Number(author.ban_until ?? 0), String(author.ban_reason ?? ''), t), {
      banScope,
      banUntil: Number(author.ban_until ?? 0),
    });
  }
}

/* -------------------------------- 内部工具 -------------------------------- */

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

/** 契约② 事件发射（编辑/删除路径也复用；不预载插件配置，保持写路径零额外 D1） */
export async function emit<N extends EventName>(
  core: { db: D1b; cache: Cache },
  event: N,
  payload: EventPayload<N>,
): Promise<void> {
  const rt = await getExtensions(core.cache, core.db, undefined, { preloadConfigs: false });
  await rt.bus.emit(event, payload);
}

/** 标签归一（idx_tag 轻量实现）：仅保留 light 扩展「标签定义」内的名称（服务端白名单） */
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
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, SUMMARY_STORE_MAX);
}

/** 积分变动后的自动升组（按 credits 落组）；gid<100 短路 */
export async function upgradeAfterGrant(
  core: { db: D1b; cache: Cache },
  uid: number,
  grouplist: AccessCtx['grouplist'],
  gid?: number,
): Promise<void> {
  if (gid !== undefined && gid < 100) return;
  const up = await upgradeGroupByCredits(core, uid, grouplist);
  if (up) await emit(core, 'user:group-changed', { uid, oldGid: up.oldGid, newGid: up.newGid });
}

/** 回帖消息：主题作者评论通知 + 引用通知（type=2）；待审回帖不发（会绕过审核触达） */
async function sendReplyNotices(
  core: { db: D1b; cache: Cache },
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

/** SEO 产物旁路：未绑定 R2 直接跳过（与 scheduleSeo 同口径，但不依赖 Hono Context） */
function scheduleSeo(deps: WriteDeps, tid: number, mode: 'gen' | 'del'): void {
  const files = deps.env.FILES as unknown as { put?: unknown } | undefined;
  if (!files || typeof files.put !== 'function') return;
  const seoDeps = { db: deps.db, cache: deps.cache, env: deps.env };
  const work =
    mode === 'del'
      ? deleteThreadSeoHtml(seoDeps, tid)
      : generateThreadSeoHtml(seoDeps, tid).then((written) => (written ? undefined : deleteThreadSeoHtml(seoDeps, tid)));
  if (deps.waitUntil) deps.waitUntil(work);
  else void work;
}

/* ------------------------------- 发主题 ------------------------------- */

/**
 * 发主题：首帖 → 主题（firstpid/lastpid 回填）→ 倒排 + 计数 + 审核置位（事务）→ 附件 → 事件 → 积分。
 * 返回 gain 为「经验+N …」后缀（无线则空串），文案拼接由入口层决定。
 */
export async function createThreadCore(
  deps: WriteDeps,
  actor: WriteActor,
  draft: ThreadDraft,
  ip: number,
  t: ApiT,
): Promise<{ tid: number; pid: number; gain: string; pending: boolean }> {
  const core = { db: deps.db, cache: deps.cache };
  const { viewer, ctx } = actor;
  const fid = Number(draft.fid ?? 0);
  const forum = ctx.forumlist[fid];
  if (!forum) throw new AppError(Code.NOT_FOUND, t('common.forumNotFound'));
  if (!forumAccessUser(ctx, fid, 'allowthread')) throw new AppError(Code.NO_PERMISSION, t('common.groupPermDenied'));
  // 账号未过审闸门（user_check 开启时未过审账号禁发帖）
  if (shouldBlockUnapproved(await loadSetting(deps.cache, deps.db), Number(viewer.ok))) {
    throw new AppError(Code.NO_PERMISSION, t('write.approvalWaitThread'));
  }
  // 积分闸门（负向规则会把余额扣成负数 → 拒绝发帖）
  const gate = await postCreditGate(core, viewer.uid, 1);
  if (gate) throw new AppError(Code.FORM_INSUFFICIENT_CREDITS, gate);
  // 收费帖设置（仅 allowsell 组生效，未开启组静默忽略）
  const allowsell = Number(ctx.grouplist[viewer.gid]?.allowsell ?? 0) === 1;
  const rawBuy = Math.trunc(Number(draft.contentBuy ?? 0));
  const contentBuy = allowsell && Number.isFinite(rawBuy) && rawBuy > 0 ? Math.min(rawBuy, 9_999_999) : 0;
  const contentBuyType = contentBuy > 0 && [1, 2, 3].includes(Number(draft.contentBuyType)) ? Number(draft.contentBuyType) : 1;
  const subject = String(draft.subject ?? '');
  if (!subject.trim()) throw new AppError(Code.VALIDATION_ERROR, t('write.subjectRequired'));
  if (codeLen(subject) > 128) throw new AppError(Code.VALIDATION_ERROR, t('write.subjectTooLong'));
  const message = String(draft.message ?? '');
  if (!message.trim()) throw new AppError(Code.VALIDATION_ERROR, t('write.contentRequired'));
  const doctype = Number(draft.doctype ?? 0);
  if (doctype > 10) throw new AppError(Code.VALIDATION_ERROR, t('write.doctypeUnsupported'));
  if (codeLen(message) > MESSAGE_MAX_CHARS) throw new AppError(Code.FORM_MESSAGE_TOO_LONG, t('write.contentTooLong'));

  const ts = now();
  const fmt = postMessageFmt({ message, doctype, quotepid: 0 }, viewer.gid);

  // 1) 首帖（tid 待回填）
  const postR = await deps.db
    .prepare<{ pid: number }>(
      'INSERT INTO bbs_post (tid,uid,isfirst,create_date,userip,doctype,quotepid,message,message_fmt) VALUES (0,?,1,?,?,?,0,?,?) RETURNING pid',
    )
    .bind(viewer.uid, ts, ip, doctype, fmt.message, fmt.message_fmt)
    .first<{ pid: number }>();
  const pid = Number(postR?.pid ?? 0);
  if (!pid) throw new AppError(Code.SYSTEM_ERROR, t('write.postCreateFailed'));

  // 2) 主题（content_buy 随创建同批写入；tags 仅接受后台定义的标签；image_urls ≤9 张）
  const lightCfg = parseLightConfig(await loadExtConfig(deps.cache, deps.db, LIGHT_EXT_ID));
  const tags = normalizeTags(draft.tags, new Set(lightCfg.tags.map((x) => x.name)));
  const imageUrls = extractImageUrls(message);
  const summary = extractSummary(message);
  /* 内容语言（写时定稿）：版块有效语言（自身绑定或继承父版块）非空则强制该语言，
     忽略用户选择与自动检测；否则显式选择优先，再否则按标题+正文自动检测。 */
  const lang = forumLangOf(ctx.forumlist, fid) || normalizeContentLang(draft.lang) || detectContentLang(`${subject} ${message}`);
  const threadR = await deps.db
    .prepare<{ tid: number }>(
      'INSERT INTO bbs_thread (fid,uid,username,avatar,userip,subject,create_date,last_date,firstpid,lastpid,lastuid,lastusername,content_buy,content_buy_type,tags,image_urls,summary,lang) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING tid',
    )
    .bind(fid, viewer.uid, viewer.username, viewer.avatar, ip, subject, ts, ts, pid, pid, viewer.uid, viewer.username, contentBuy, contentBuyType, tags, imageUrls, summary, lang)
    .first<{ tid: number }>();
  const tid = Number(threadR?.tid ?? 0);
  if (!tid) {
    await deps.db.prepare('DELETE FROM bbs_post WHERE pid = ?').bind(pid).run(); // 回滚孤儿首帖
    throw new AppError(Code.SYSTEM_ERROR, t('write.threadCreateFailed'));
  }

  // 3) 关联 + 倒排 + 计数（事务内）
  const batchStmts: Stmt[] = [
    deps.db.prepare('UPDATE bbs_post SET tid = ? WHERE pid = ?').bind(tid, pid) as unknown as Stmt,
    deps.db.prepare('INSERT INTO bbs_mythread (uid,tid) VALUES (?,?)').bind(viewer.uid, tid) as unknown as Stmt,
    deps.db.prepare('INSERT INTO bbs_mypost (uid,tid,pid) VALUES (?,?,?)').bind(viewer.uid, tid, pid) as unknown as Stmt,
    deps.db.prepare('UPDATE bbs_forum SET threads = threads + 1, todaythreads = todaythreads + 1 WHERE fid = ?').bind(fid) as unknown as Stmt,
    deps.db.prepare('UPDATE bbs_user SET threads = threads + 1 WHERE uid = ?').bind(viewer.uid) as unknown as Stmt,
  ];
  // 审核置位（check_or_not(组, 板块, 'thread') → 主题与首帖 ok=0）
  const threadPending = checkOrNot(ctx.grouplist[viewer.gid], forum, 'thread');
  if (threadPending) {
    batchStmts.push(
      deps.db.prepare('UPDATE bbs_thread SET ok = ? WHERE tid = ?').bind(CheckStatus.PENDING, tid) as unknown as Stmt,
      deps.db.prepare('UPDATE bbs_post SET ok = ? WHERE tid = ? AND isfirst = 1').bind(CheckStatus.PENDING, tid) as unknown as Stmt,
    );
  }
  try {
    await deps.db.batch(batchStmts);
  } catch (e) {
    // batch 具事务性，但前两步独立 INSERT 已提交 → 手动回滚，否则留下幽灵主题
    await deps.db
      .batch([
        deps.db.prepare('DELETE FROM bbs_thread WHERE tid = ?').bind(tid) as unknown as Stmt,
        deps.db.prepare('DELETE FROM bbs_post WHERE pid = ?').bind(pid) as unknown as Stmt,
      ])
      .catch(() => undefined);
    throw e;
  }

  await patchRuntime(deps.cache, { threads: 1, todaythreads: 1 });
  await deps.cache.del('forumlist');
  await associateAttachments({ db: deps.db, env: deps.env, uid: viewer.uid, tid, pid, isfirst: true, aids: draft.attachAids });
  await emit(core, 'thread:created', { tid, fid, uid: viewer.uid });
  await emit(core, 'post:created', { pid, tid, uid: viewer.uid, isfirst: 1 });
  const gain = await grantForPost(core, { uid: viewer.uid, isfirst: 1, pid, ts });
  await upgradeAfterGrant(core, viewer.uid, ctx.grouplist, viewer.gid);
  scheduleSeo(deps, tid, 'gen');
  return { tid, pid, gain, pending: threadPending };
}

/* -------------------------------- 回帖 -------------------------------- */

/**
 * 回帖：closed 判定（管理组可回）→ 可见性/审核 → 快速回复限制 → 引用校验 → 写入 → 计数 → 通知。
 * 返回 pending=true 表示本条进入待审（入口层据此提示「待审核」）。
 */
export async function createReplyCore(
  deps: WriteDeps,
  actor: WriteActor,
  tid: number,
  draft: ReplyDraft,
  ip: number,
  t: ApiT,
): Promise<{ pid: number; gain: string; pending: boolean }> {
  const core = { db: deps.db, cache: deps.cache };
  const { viewer, ctx } = actor;
  if (!tid) throw new AppError(Code.NOT_FOUND, t('common.threadNotFound'));

  const thread = await deps.db
    .prepare<{ fid: number; closed: number; top: number; uid: number; posts: number; subject: string; ok: number }>(
      'SELECT fid,closed,top,uid,posts,subject,ok FROM bbs_thread WHERE tid = ?',
    )
    .bind(tid)
    .first<{ fid: number; closed: number; top: number; uid: number; posts: number; subject: string; ok: number }>();
  if (!thread) throw new AppError(Code.NOT_FOUND, t('common.threadNotFound'));
  const fid = Number(thread.fid);
  if (!ctx.forumlist[fid]) throw new AppError(Code.NOT_FOUND, t('common.forumNotFound'));
  if (!forumAccessUser(ctx, fid, 'allowpost')) throw new AppError(Code.NO_PERMISSION, t('common.groupPermDenied'));
  // 可见性口径同读路径（防借回帖成功与否探测待审/回收主题；版务与主题作者可回）
  if (
    !canSeeUnapproved(Number(thread.ok), {
      seeCheck: hasSeeCheck(ctx.grouplist[viewer.gid]),
      isAuthor: Number(thread.uid) === viewer.uid,
    })
  ) {
    throw new AppError(Code.NOT_FOUND, t('common.threadNotFound'));
  }
  // 账号未过审闸门
  if (shouldBlockUnapproved(await loadSetting(deps.cache, deps.db), Number(viewer.ok))) {
    throw new AppError(Code.NO_PERMISSION, t('write.approvalWaitReply'));
  }
  // 积分闸门
  const gate = await postCreditGate(core, viewer.uid, 0);
  if (gate) throw new AppError(Code.FORM_INSUFFICIENT_CREDITS, gate);
  // 快速回复限制：开关开且本帖回帖数已达阈值，且该用户在本帖回帖数 >= 上限则拒绝
  const qrState = await loadExtensionsState(deps.cache, deps.db);
  if (isEnabled(QUICK_REPLY_MANIFEST, qrState)) {
    const qr = await loadExtConfig(deps.cache, deps.db, QUICK_REPLY_EXT_ID);
    const limit = Math.trunc(Number(qr.post_message_count_by_uid));
    if (Number(qr.is_quick_reply_message) === 1 && limit > 0 && Number(thread.posts) >= limit) {
      const mine = await deps.db
        .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_post WHERE tid = ? AND uid = ?')
        .bind(tid, viewer.uid)
        .first<{ c: number }>();
      if (Number(mine?.c ?? 0) >= limit) {
        throw new AppError(Code.VALIDATION_ERROR, String(qr.post_message_error || t('write.qrLimit')));
      }
    }
  }
  // closed：游客与等级组禁回，gid 1..5（管理/超版/版主/实习）可回
  if (Number(thread.closed) > 0 && (viewer.gid === 0 || viewer.gid > 5)) {
    throw new AppError(Code.NO_PERMISSION, t('write.threadClosed'));
  }

  const message = String(draft.message ?? '');
  if (!message.trim()) throw new AppError(Code.VALIDATION_ERROR, t('write.contentRequired'));
  const doctype = Number(draft.doctype ?? 0);
  if (codeLen(message) > MESSAGE_MAX_CHARS) throw new AppError(Code.FORM_MESSAGE_TOO_LONG, t('write.contentTooLong'));

  // quotepid 校验：必须存在且同属本主题，否则归零
  let quotepid = Number(draft.quotepid ?? 0);
  let quoteHtml = '';
  let quoteUid = 0;
  let quoteMessage = '';
  if (quotepid > 0) {
    const q = await deps.db
      .prepare<{ pid: number; tid: number; uid: number; message: string }>('SELECT pid,tid,uid,message FROM bbs_post WHERE pid = ?')
      .bind(quotepid)
      .first<{ pid: number; tid: number; uid: number; message: string }>();
    if (!q || Number(q.tid) !== tid) {
      quotepid = 0;
    } else {
      quoteUid = Number(q.uid);
      quoteMessage = String(q.message);
      const qu = await deps.db
        .prepare<{ username: string; avatar: number }>('SELECT username,avatar FROM bbs_user WHERE uid = ?')
        .bind(Number(q.uid))
        .first<{ username: string; avatar: number }>();
      quoteHtml = postQuoteHtml(Number(q.uid), String(qu?.username ?? ''), Number(qu?.avatar ?? 0), postBrief(String(q.message)));
    }
  }

  const fmt = postMessageFmt({ message, doctype, quotepid }, viewer.gid, quoteHtml);
  const ts = now();

  const postR = await deps.db
    .prepare<{ pid: number }>(
      'INSERT INTO bbs_post (tid,uid,isfirst,create_date,userip,doctype,quotepid,message,message_fmt) VALUES (?,?,0,?,?,?,?,?,?) RETURNING pid',
    )
    .bind(tid, viewer.uid, ts, ip, doctype, quotepid, fmt.message, fmt.message_fmt)
    .first<{ pid: number }>();
  const pid = Number(postR?.pid ?? 0);
  if (!pid) throw new AppError(Code.SYSTEM_ERROR, t('write.replyFailed'));

  const replyStmts: Stmt[] = [
    deps.db.prepare('UPDATE bbs_user SET posts = posts + 1 WHERE uid = ?').bind(viewer.uid) as unknown as Stmt,
    deps.db.prepare('UPDATE bbs_forum SET todayposts = todayposts + 1 WHERE fid = ?').bind(fid) as unknown as Stmt,
    deps.db.prepare('INSERT INTO bbs_mypost (uid,tid,pid) VALUES (?,?,?)').bind(viewer.uid, tid, pid) as unknown as Stmt,
  ];
  // 审核置位（check_or_not(组, 板块, 'post') → 回帖 ok=0）
  const replyPending = checkOrNot(ctx.grouplist[viewer.gid], ctx.forumlist[fid], 'post');
  if (replyPending) {
    // 待审回帖不更新主题反规范化列：否则列表页泄露「幽灵回复」；过审时由 /api/check 补列
    replyStmts.push(deps.db.prepare('UPDATE bbs_post SET ok = ? WHERE pid = ? AND isfirst = 0').bind(CheckStatus.PENDING, pid) as unknown as Stmt);
  } else {
    replyStmts.push(
      deps.db
        .prepare('UPDATE bbs_thread SET posts = posts + 1, lastpid = ?, lastuid = ?, last_date = ?, lastusername = ? WHERE tid = ?')
        .bind(pid, viewer.uid, ts, viewer.username, tid) as unknown as Stmt,
    );
  }
  await deps.db.batch(replyStmts);

  await patchRuntime(deps.cache, { posts: 1, todayposts: 1 });
  await deps.cache.del('forumlist');
  await deps.cache.del(`user:${viewer.uid}`);
  await associateAttachments({ db: deps.db, env: deps.env, uid: viewer.uid, tid, pid, isfirst: false, aids: draft.attachAids });
  await emit(core, 'post:created', { pid, tid, uid: viewer.uid, isfirst: 0 });
  const gain = await grantForPost(core, { uid: viewer.uid, isfirst: 0, pid, ts });
  await upgradeAfterGrant(core, viewer.uid, ctx.grouplist, viewer.gid);
  if (!replyPending) {
    await sendReplyNotices(
      core,
      {
        tid,
        pid,
        fromUid: viewer.uid,
        threadUid: Number(thread.uid),
        subject: String(thread.subject),
        message,
        quoteUid,
        quoteMessage,
        ts,
      },
      t,
    );
  }
  scheduleSeo(deps, tid, 'gen');
  return { pid, gain, pending: replyPending };
}
