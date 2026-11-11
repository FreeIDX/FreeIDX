/**
 * MCP 内置只读工具集（论坛内容面）。
 *
 * 三条不变量（任何一个破了都会造成「AI 能看到的比网页多」）：
 *  1. 权限只走 core/access.ts：版块可见性用 forumListAccessFilter / forumAccessUser，
 *     列表行用 threadListAccessFilter，绝不自己写一套 gid 判断；
 *  2. 审核可见性只走 core/check.ts：ok!=1 的行一律按 canSeeUnapproved 过滤（see_check 组/作者例外）；
 *  3. 付费墙只在服务端脱敏：付费段正文用 redactPaidBlocks 抹掉后再交给模型，
 *     与 GET /api/threads/:tid 同一口径（不依赖前端隐藏）。
 *
 * 输出刻意「瘦」：只给模型做判断所需字段（不含 avatar/images/userip 等展示位），
 * 既省 token 也减少内部字段外泄面。
 */
import {
  PageSize,
  type LocText,
  type McpToolScope,
} from '@freeidx/shared';
import type { McpCallCtx, McpResourceDef, McpToolDef, McpToolResult } from '../../core/extensions/registry';
import type { D1b } from '../../core/db';
import type { Cache } from '../../core/cache';
import {
  forumAccessUser,
  forumListAccessFilter,
  threadListAccessFilter,
  type AccessCtx,
  type GroupForAccess,
} from '../../core/access';
import type { ForumRow } from '../../core/loaders';
import { loadForumlist, loadGrouplist, loadSetting } from '../../core/loaders';
import { canSeeUnapproved, hasSeeCheck } from '../../core/check';
import { cursorCond } from '../../core/db/paginate';
import { POST_PAGE_COLS, THREAD_DETAIL_COLS, THREAD_LIST_COLS, USER_PUBLIC_COLS } from '../../core/db/columns';
import { loadRuntime, redactPaidBlocks } from '../../modules/shared';
import { L } from '../../core/i18n';

/** 工具业务错误：server 层统一转成 MCP `isError`（让模型自行纠正参数），不占用 JSON-RPC 错误码 */
export class ToolError extends Error {}

/* ------------------------------ 参数归一 ------------------------------ */

function numArg(v: unknown, dflt: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function strArg(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max);
}

function boolArg(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/** HTML → 纯文本：模型读正文用，避免把标签算 token；同时保住换行语义 */
function plain(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 超长正文截断（单条工具结果回灌模型，过大会挤爆上下文） */
function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

const unix = (sec: number): string => (Number(sec) > 0 ? new Date(Number(sec) * 1000).toISOString() : '');

/* ------------------------------ 数据面 ------------------------------ */

interface ThreadRow {
  tid: number;
  fid: number;
  top: number;
  digest: number;
  closed: number;
  uid: number;
  username: string;
  subject: string;
  posts: number;
  views: number;
  lastpid: number;
  lastuid: number;
  lastusername: string;
  create_date: number;
  last_date: number;
  ok: number;
  content_buy: number;
  content_buy_type: number;
  tags?: string;
  summary?: string;
}

interface PostRow {
  pid: number;
  tid: number;
  uid: number;
  isfirst: number;
  create_date: number;
  doctype: number;
  quotepid: number;
  message: string;
  message_fmt: string;
  ok: number;
}

async function loadAccess(
  db: D1b,
  cache: Cache,
  uid: number,
  gid: number,
): Promise<{ ctx: AccessCtx; forumlist: Record<number, ForumRow>; grouplist: Record<number, GroupForAccess> }> {
  const [forumlist, grouplist] = await Promise.all([loadForumlist(cache, db), loadGrouplist(cache, db)]);
  return { ctx: { uid, gid, forumlist, grouplist }, forumlist, grouplist };
}

/** 可读版块 fid 集合（accesson 双与由 forumAccessUser 完成） */
function readableFids(ctx: AccessCtx, forumlist: Record<number, ForumRow>): number[] {
  return Object.keys(forumlist)
    .map(Number)
    .filter((fid) => forumAccessUser(ctx, fid, 'allowread'));
}

function threadBrief(t: ThreadRow): Record<string, unknown> {
  return {
    tid: Number(t.tid),
    fid: Number(t.fid),
    subject: String(t.subject ?? ''),
    author: String(t.username ?? ''),
    authorUid: Number(t.uid),
    replies: Math.max(0, Number(t.posts) - 1),
    views: Number(t.views ?? 0),
    pinned: Number(t.top) > 0,
    digest: Number(t.digest) > 0,
    closed: Number(t.closed) > 0,
    createdAt: unix(Number(t.create_date)),
    lastReplyAt: unix(Number(t.last_date)),
    lastReplyBy: String(t.lastusername ?? ''),
    ...(t.tags ? { tags: String(t.tags) } : {}),
    ...(t.summary ? { summary: clip(String(t.summary), 200) } : {}),
    ...(Number(t.content_buy) > 0 ? { paid: true } : {}),
  };
}

/** 审核过滤：非正常状态内容仅 see_check 组与作者可见 */
async function loadModeration(
  cache: Cache,
  db: D1b,
  gid: number,
  uid: number,
): Promise<{ seeCheck: boolean; isAuthor: (authorUid: number) => boolean }> {
  const grouplist = await loadGrouplist(cache, db);
  const seeCheck = hasSeeCheck(grouplist[gid]);
  return { seeCheck, isAuthor: (authorUid: number) => uid > 0 && authorUid === uid };
}

/* ------------------------------ 工具实现 ------------------------------ */

async function forumList(_args: Record<string, unknown>, ctx: McpCallCtx): Promise<McpToolResult> {
  const { forumlist, grouplist } = await loadAccess(ctx.db, ctx.cache, ctx.principal.uid, ctx.principal.gid);
  const visible = forumListAccessFilter(forumlist, ctx.principal.gid, grouplist, 'allowread');
  const list = Object.values(visible)
    .map((f) => ({
      fid: Number(f.fid),
      name: String(f.name ?? ''),
      brief: clip(String(f.brief ?? ''), 200),
      parentFid: Number(f.parent_fid ?? 0),
      threads: Number(f.threads ?? 0),
      todayPosts: Number(f.todayposts ?? 0),
      ...(f.announcement ? { announcement: clip(plain(String(f.announcement)), 300) } : {}),
    }))
    .sort((a, b) => a.fid - b.fid);
  return { text: JSON.stringify({ forums: list }, null, 2) };
}

async function threadList(args: Record<string, unknown>, ctx: McpCallCtx): Promise<McpToolResult> {
  const { db, cache } = ctx;
  const { ctx: actx, forumlist } = await loadAccess(db, cache, ctx.principal.uid, ctx.principal.gid);
  const fid = numArg(args.fid, 0, 0, 1e9);
  const size = numArg(args.pageSize, 20, 1, 50);
  const before = numArg(args.cursor, 0, 0, Number.MAX_SAFE_INTEGER) || undefined;
  const digest = boolArg(args.digest);
  const setting = await loadSetting(cache, db);
  const col: 'tid' | 'lastpid' =
    args.orderby === 'tid' ? 'tid' : args.orderby === 'lastpid' ? 'lastpid' : fid > 0 ? ((forumlist[fid]?.orderby ?? 0) === 1 ? 'tid' : 'lastpid') : (Number(setting.forumOrderby) === 1 ? 'tid' : 'lastpid');

  let fids: number[];
  if (fid > 0) {
    if (!forumlist[fid]) throw new ToolError(`Forum ${fid} not found`);
    if (!forumAccessUser(actx, fid, 'allowread')) throw new ToolError(`No permission to read forum ${fid}`);
    fids = [fid];
  } else {
    fids = readableFids(actx, forumlist);
  }
  if (!fids.length) return { text: JSON.stringify({ threads: [], nextCursor: null }, null, 2) };

  const cur = cursorCond({ column: col, size, before, desc: true });
  const sql =
    `SELECT ${THREAD_LIST_COLS} FROM bbs_thread WHERE fid IN (${fids.map(() => '?').join(',')}) ${cur.where}` +
    (digest ? ' AND digest > 0' : '') +
    ` ${cur.order} LIMIT ?`;
  const r = await db.prepare<ThreadRow>(sql).bind(...fids, ...cur.params, size).all();

  const mod = await loadModeration(cache, db, ctx.principal.gid, ctx.principal.uid);
  const list = threadListAccessFilter(actx, r.results)
    .filter((t) => canSeeUnapproved(Number(t.ok), { seeCheck: mod.seeCheck, isAuthor: mod.isAuthor(Number(t.uid)) }))
    .map(threadBrief);
  const last = r.results.at(-1);
  return {
    text: JSON.stringify(
      { threads: list, cursorColumn: col, nextCursor: r.results.length === size && last ? Number(last[col]) : null },
      null,
      2,
    ),
  };
}

/** 付费可见性（与 GET /api/threads/:tid 同口径）：作者本人或已购者才拿得到付费段正文 */
async function isPurchased(db: D1b, tid: number, uid: number, authorUid: number, contentBuy: number, firstFmt: string): Promise<boolean> {
  if (Number(contentBuy) <= 0) return true;
  if (!/\[ttPay\][\s\S]*?\[\/ttPay\]/i.test(firstFmt)) return true;
  if (uid > 0 && uid === authorUid) return true;
  if (uid <= 0) return false;
  const paid = await db
    .prepare<{ x: number }>('SELECT 1 AS x FROM bbs_paylist WHERE tid = ? AND uid = ? AND type = 1')
    .bind(tid, uid)
    .first<{ x: number }>();
  return Boolean(paid);
}

async function loadThreadForRead(
  ctx: McpCallCtx,
  tid: number,
): Promise<{
  thread: ThreadRow & { firstpid: number };
  forum: ForumRow;
  actx: AccessCtx;
  seeCheck: boolean;
}> {
  const { db, cache } = ctx;
  const { ctx: actx, forumlist, grouplist } = await loadAccess(db, cache, ctx.principal.uid, ctx.principal.gid);
  const thread = await db
    .prepare<ThreadRow & { firstpid: number }>(`SELECT ${THREAD_DETAIL_COLS} FROM bbs_thread WHERE tid = ?`)
    .bind(tid)
    .first<ThreadRow & { firstpid: number }>();
  if (!thread) throw new ToolError(`Thread ${tid} not found`);
  const forum = forumlist[thread.fid];
  if (!forum) throw new ToolError(`Thread ${tid} not found`);
  if (!forumAccessUser(actx, thread.fid, 'allowread')) throw new ToolError(`No permission to read thread ${tid}`);
  const seeCheck = hasSeeCheck(grouplist[ctx.principal.gid]);
  if (!canSeeUnapproved(Number(thread.ok), { seeCheck, isAuthor: ctx.principal.uid === Number(thread.uid) })) {
    throw new ToolError(`Thread ${tid} is not publicly visible (pending review or removed)`);
  }
  return { thread, forum, actx, seeCheck };
}

async function threadGet(args: Record<string, unknown>, ctx: McpCallCtx): Promise<McpToolResult> {
  const { db } = ctx;
  const tid = numArg(args.tid, 0, 1, Number.MAX_SAFE_INTEGER);
  if (!tid) throw new ToolError('tid is required');
  const replyPage = numArg(args.replyPage, 1, 1, 100);
  const replySize = numArg(args.replyPageSize, PageSize.POST_PAGE, 1, 30);
  const { thread, forum, seeCheck } = await loadThreadForRead(ctx, tid);

  const first = await db
    .prepare<PostRow>(`SELECT ${POST_PAGE_COLS} FROM bbs_post WHERE tid = ? ORDER BY pid ASC LIMIT 1`)
    .bind(tid)
    .first<PostRow>();
  const purchased = first
    ? await isPurchased(db, tid, ctx.principal.uid, Number(thread.uid), Number(thread.content_buy), first.message_fmt ?? '')
    : true;

  const repliesR = await db
    .prepare<PostRow>(`SELECT ${POST_PAGE_COLS} FROM bbs_post WHERE tid = ? ORDER BY pid ASC LIMIT ? OFFSET ?`)
    .bind(tid, replySize, (replyPage - 1) * replySize)
    .all();
  const replies = repliesR.results
    .filter((p) => Number(p.isfirst) !== 1)
    .filter((p) => canSeeUnapproved(Number(p.ok), { seeCheck, isAuthor: ctx.principal.uid === Number(p.uid) }))
    .map((p) => ({
      pid: Number(p.pid),
      authorUid: Number(p.uid),
      createdAt: unix(Number(p.create_date)),
      content: clip(plain(p.message_fmt ?? ''), 2000),
      ...(Number(p.quotepid) > 0 ? { quotePid: Number(p.quotepid) } : {}),
    }));

  const attachR = await db
    .prepare<{ aid: number; pid: number; orgfilename: string; filesize: number; isimage: number; credits: number }>(
      'SELECT aid,pid,orgfilename,filesize,isimage,credits FROM bbs_attach WHERE tid = ? ORDER BY aid ASC LIMIT 50',
    )
    .bind(tid)
    .all();
  const attachments = attachmentsOf(attachR.results);

  const body = first ? (purchased ? (first.message_fmt ?? '') : redactPaidBlocks(first.message_fmt ?? '', true)) : '';
  return {
    text: JSON.stringify(
      {
        thread: threadBrief(thread),
        forum: { fid: Number(forum.fid), name: String(forum.name ?? '') },
        content: clip(plain(body), 8000),
        paid: Number(thread.content_buy) > 0,
        purchased,
        ...(attachments.length ? { attachments } : {}),
        replyPage,
        replyPageSize: replySize,
        replies,
      },
      null,
      2,
    ),
  };
}

function attachmentsOf(rows: { aid: number; orgfilename: string; filesize: number; isimage: number; credits: number }[]): Record<string, unknown>[] {
  return rows.map((a) => ({
    aid: Number(a.aid),
    filename: String(a.orgfilename ?? ''),
    size: Number(a.filesize ?? 0),
    image: Number(a.isimage) === 1,
    ...(Number(a.credits) > 0 ? { credits: Number(a.credits) } : {}),
  }));
}

async function threadReplies(args: Record<string, unknown>, ctx: McpCallCtx): Promise<McpToolResult> {
  const { db } = ctx;
  const tid = numArg(args.tid, 0, 1, Number.MAX_SAFE_INTEGER);
  if (!tid) throw new ToolError('tid is required');
  const size = numArg(args.pageSize, 20, 1, 50);
  const before = numArg(args.cursor, 0, 0, Number.MAX_SAFE_INTEGER) || undefined;
  const { seeCheck } = await loadThreadForRead(ctx, tid);

  const cur = cursorCond({ column: 'pid', size, before, desc: false });
  const r = await db
    .prepare<PostRow>(`SELECT ${POST_PAGE_COLS} FROM bbs_post WHERE tid = ? AND isfirst = 0 ${cur.where} ORDER BY pid ASC LIMIT ?`)
    .bind(tid, ...cur.params, size)
    .all();
  const list = r.results
    .filter((p) => canSeeUnapproved(Number(p.ok), { seeCheck, isAuthor: ctx.principal.uid === Number(p.uid) }))
    .map((p) => ({
      pid: Number(p.pid),
      authorUid: Number(p.uid),
      createdAt: unix(Number(p.create_date)),
      content: clip(plain(p.message_fmt ?? ''), 1500),
      ...(Number(p.quotepid) > 0 ? { quotePid: Number(p.quotepid) } : {}),
    }));
  const last = r.results.at(-1);
  return {
    text: JSON.stringify({ replies: list, nextCursor: r.results.length === size && last ? Number(last.pid) : null }, null, 2),
  };
}

/** LIKE 通配转义（与 core 搜索同口径，配合 ESCAPE '\' 使用） */
const likeOf = (s: string): string => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

async function search(args: Record<string, unknown>, ctx: McpCallCtx): Promise<McpToolResult> {
  const { db, cache } = ctx;
  const q = strArg(args.q, 64);
  if (!q) throw new ToolError('q is required');
  const range = args.range === 'all' ? 'all' : 'thread';
  const size = numArg(args.pageSize, 20, 1, 50);
  const page = numArg(args.page, 1, 1, 100);
  const { ctx: actx, forumlist } = await loadAccess(db, cache, ctx.principal.uid, ctx.principal.gid);
  const fid = numArg(args.fid, 0, 0, 1e9);

  let fids: number[];
  if (fid > 0) {
    if (!forumAccessUser(actx, fid, 'allowread')) throw new ToolError(`No permission to read forum ${fid}`);
    fids = [fid];
  } else {
    fids = readableFids(actx, forumlist);
  }
  if (!fids.length) return { text: JSON.stringify({ keyword: q, total: 0, threads: [] }, null, 2) };

  const terms = q.split(/\s+/).filter(Boolean).slice(0, 4).map(likeOf);
  const conds: string[] = [];
  const params: string[] = [];
  for (const lk of terms) {
    if (range === 'all') {
      conds.push(`(subject LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM bbs_post p WHERE p.tid = bbs_thread.tid AND p.ok = 1 AND p.message LIKE ? ESCAPE '\\'))`);
      params.push(lk, lk);
    } else {
      conds.push(`subject LIKE ? ESCAPE '\\'`);
      params.push(lk);
    }
  }
  const where = `WHERE (${conds.join(' AND ')}) AND fid IN (${fids.map(() => '?').join(',')})`;
  const cnt = await db
    .prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM bbs_thread ${where}`)
    .bind(...params, ...fids)
    .first<{ c: number }>();
  const r = await db
    .prepare<ThreadRow>(`SELECT ${THREAD_LIST_COLS} FROM bbs_thread ${where} ORDER BY tid DESC LIMIT ? OFFSET ?`)
    .bind(...params, ...fids, size, (page - 1) * size)
    .all();

  const mod = await loadModeration(cache, db, ctx.principal.gid, ctx.principal.uid);
  const list = threadListAccessFilter(actx, r.results)
    .filter((t) => canSeeUnapproved(Number(t.ok), { seeCheck: mod.seeCheck, isAuthor: mod.isAuthor(Number(t.uid)) }))
    .map(threadBrief);
  return { text: JSON.stringify({ keyword: q, range, page, total: Number(cnt?.c ?? 0), threads: list }, null, 2) };
}

async function userGet(args: Record<string, unknown>, ctx: McpCallCtx): Promise<McpToolResult> {
  const { db } = ctx;
  const uid = numArg(args.uid, 0, 0, Number.MAX_SAFE_INTEGER);
  const username = strArg(args.username, 40);
  if (!uid && !username) throw new ToolError('uid or username is required');
  // 只取公开列：email / create_ip / 封禁信息一律不出现在 MCP 返回面
  const row = uid
    ? await db.prepare<Record<string, unknown>>(`SELECT ${USER_PUBLIC_COLS} FROM bbs_user WHERE uid = ?`).bind(uid).first<Record<string, unknown>>()
    : await db.prepare<Record<string, unknown>>(`SELECT ${USER_PUBLIC_COLS} FROM bbs_user WHERE username = ?`).bind(username).first<Record<string, unknown>>();
  if (!row) throw new ToolError('User not found');
  return {
    text: JSON.stringify(
      {
        uid: Number(row.uid),
        username: String(row.username ?? ''),
        threads: Number(row.threads ?? 0),
        posts: Number(row.posts ?? 0),
        credits: Number(row.credits ?? 0),
        registeredAt: unix(Number(row.create_date)),
        lastLoginAt: unix(Number(row.login_date)),
        verified: String(row.v ?? '0') !== '0',
      },
      null,
      2,
    ),
  };
}

async function siteInfo(_args: Record<string, unknown>, ctx: McpCallCtx): Promise<McpToolResult> {
  const setting = await loadSetting(ctx.cache, ctx.db);
  const runtime = await loadRuntime({ db: ctx.db, cache: ctx.cache });
  return {
    text: JSON.stringify(
      {
        name: String(setting.sitename ?? ''),
        description: clip(plain(String(setting.brief ?? '')), 500),
        url: String(setting.url ?? ''),
        lang: String(setting.lang ?? ''),
        runlevel: Number(setting.runlevel ?? 5),
        stats: {
          threads: Number(runtime.threads ?? 0),
          posts: Number(runtime.posts ?? 0),
          users: Number(runtime.users ?? 0),
          online: Number(runtime.onlines ?? 0),
        },
        viewer: { uid: ctx.principal.uid, group: ctx.principal.gid, lang: ctx.lang },
      },
      null,
      2,
    ),
  };
}

/* ------------------------------ 工具注册表 ------------------------------ */

function tool(
  name: string,
  description: LocText,
  scope: McpToolScope,
  inputSchema: Record<string, unknown>,
  handler: (args: Record<string, unknown>, ctx: McpCallCtx) => Promise<McpToolResult>,
): McpToolDef {
  return { name, description, scope, inputSchema, handler };
}

/** 分页参数声明（多处复用，避免各工具的说法不一致让模型猜） */
const PAGE_SIZE_SCHEMA = { type: 'integer', minimum: 1, maximum: 50, description: 'Items per page (default 20)' };

export const CORE_MCP_TOOLS: McpToolDef[] = [
  tool(
    'forum_list',
    L(
      '列出当前令牌持有者有权访问的版块（含版块 ID、名称、简介与主题数）。',
      '列出目前權杖持有者有權存取的版塊（含版塊 ID、名稱、簡介與主題數）。',
      'List forums the token owner may read, with forum id, name, brief and thread counts.',
      'Список разделов, доступных владельцу токена (ID, название, описание, число тем).',
      'แสดงบอร์ดที่ผู้ถือโทเคนเข้าถึงได้ (ID ชื่อ คำอธิบาย จำนวนกระทู้)',
      'Foren auflisten, die der Token-Inhaber lesen darf (ID, Name, Kurzbeschreibung, Themenzahl).',
      'トークン所有者が閲覧できるフォーラムを一覧します（ID・名前・概要・スレッド数）。',
      '토큰 소유자가 접근할 수 있는 게시판을 나열합니다(ID, 이름, 설명, 스레드 수).',
      'Lista los foros a los que el titular del token puede acceder (ID, nombre, descripción, temas).',
      'Liste les forums accessibles au propriétaire du jeton (ID, nom, description, sujets).',
    ),
    'read',
    { type: 'object', properties: {}, additionalProperties: false },
    forumList,
  ),
  tool(
    'thread_list',
    L(
      '按版块列出主题（游标分页）。fid 省略时返回全部可读版块的最新主题。',
      '按版塊列出主題（游標分頁）。fid 省略時回傳全部可讀版塊的最新主題。',
      'List threads by forum with cursor paging. Omit fid to list latest threads across all readable forums.',
      'Темы раздела с курсорной разбивкой. Без fid — последние темы всех доступных разделов.',
      'แสดงกระทู้ตามบอร์ดแบบเคอร์เซอร์ ถ้าไม่ระบุ fid จะแสดงกระทู้ล่าสุดของทุกบอร์ดที่อ่านได้',
      'Themen je Forum mit Cursor-Blättern. Ohne fid: neueste Themen aller lesbaren Foren.',
      'フォーラム別にスレッドを一覧します（カーソル方式）。fid 省略時は閲覧可能な全フォーラムの最新スレッドを返します。',
      '게시판별 스레드를 커서 방식으로 나열합니다. fid를 생략하면 읽을 수 있는 모든 게시판의 최신 스레드를 반환합니다.',
      'Lista temas por foro con paginación por cursor. Sin fid devuelve los últimos temas de todos los foros legibles.',
      'Liste les sujets par forum avec pagination par curseur. Sans fid, renvoie les derniers sujets de tous les forums lisibles.',
    ),
    'read',
    {
      type: 'object',
      properties: {
        fid: { type: 'integer', minimum: 1, description: 'Forum id; omit for all readable forums' },
        cursor: { type: 'integer', description: 'nextCursor returned by the previous call' },
        pageSize: PAGE_SIZE_SCHEMA,
        digest: { type: 'boolean', description: 'Only featured (digest) threads' },
        orderby: { type: 'string', enum: ['tid', 'lastpid'], description: 'Sort column' },
      },
      additionalProperties: false,
    },
    threadList,
  ),
  tool(
    'thread_get',
    L(
      '读取主题详情：标题、作者、正文与一页回复。付费主题未购买时正文按付费墙脱敏。',
      '讀取主題詳情：標題、作者、正文與一頁回覆。付費主題未購買時正文按付費牆脫敏。',
      'Read a thread: subject, author, body and one page of replies. Paid content is redacted unless purchased.',
      'Чтение темы: заголовок, автор, текст и одна страница ответов. Платный текст скрыт без покупки.',
      'อ่านกระทู้: หัวข้อ ผู้เขียน เนื้อหา และหนึ่งหน้าของการตอบกลับ เนื้อหาแบบเสียเงินจะถูกปิดบังหากยังไม่ซื้อ',
      'Thema lesen: Titel, Autor, Text und eine Seite Antworten. Bezahlter Text wird ohne Kauf unkenntlich gemacht.',
      'スレッド詳細（タイトル・作者・本文・返信1ページ）を読みます。有料部分は未購入だと伏せられます。',
      '스레드 상세(제목, 작성자, 본문, 답글 1페이지)를 읽습니다. 유료 본문은 미구매 시 가려집니다.',
      'Lee un tema: título, autor, cuerpo y una página de respuestas. El contenido de pago se oculta si no se compró.',
      'Lit un sujet : titre, auteur, corps et une page de réponses. Le contenu payant est masqué sans achat.',
    ),
    'read',
    {
      type: 'object',
      properties: {
        tid: { type: 'integer', minimum: 1, description: 'Thread id' },
        replyPage: { type: 'integer', minimum: 1, maximum: 100, description: 'Reply page (default 1)' },
        replyPageSize: { type: 'integer', minimum: 1, maximum: 30, description: 'Replies per page (default 10)' },
      },
      required: ['tid'],
      additionalProperties: false,
    },
    threadGet,
  ),
  tool(
    'thread_replies',
    L(
      '按楼层游标拉取主题回复（翻页用），返回纯文本内容。',
      '按樓層游標拉取主題回覆（翻頁用），回傳純文字內容。',
      'Page through thread replies by floor cursor; returns plain-text content.',
      'Постранично читать ответы темы по курсору этажа; текст в виде простого текста.',
      'ไล่อ่านการตอบกลับตามเคอร์เซอร์ชั้น; คืนค่าเป็นข้อความล้วน',
      'Antworten eines Themas per Beitrags-Cursor blättern; reiner Text.',
      '投稿カーソルでスレッドの返信をページ送りします（プレーンテキスト）。',
      '층 커서로 스레드 답글을 넘겨 읽습니다(일반 텍스트).',
      'Recorre las respuestas por cursor de piso; devuelve texto plano.',
      'Parcourt les réponses par curseur de message ; renvoie du texte brut.',
    ),
    'read',
    {
      type: 'object',
      properties: {
        tid: { type: 'integer', minimum: 1, description: 'Thread id' },
        cursor: { type: 'integer', description: 'nextCursor returned by the previous call' },
        pageSize: PAGE_SIZE_SCHEMA,
      },
      required: ['tid'],
      additionalProperties: false,
    },
    threadReplies,
  ),
  tool(
    'search',
    L(
      '站内搜索主题标题（range=all 时同时匹配正文），仅在可读版块内检索。',
      '站內搜尋主題標題（range=all 時同時比對正文），僅在可讀版塊內檢索。',
      'Search thread subjects (range=all also matches post bodies) across readable forums only.',
      'Поиск по заголовкам тем (range=all также по тексту ответов) только в доступных разделах.',
      'ค้นหาหัวข้อกระทู้ (range=all ค้นเนื้อหาด้วย) เฉพาะบอร์ดที่อ่านได้',
      'Thementitel durchsuchen (range=all auch Beitragstexte), nur in lesbaren Foren.',
      'スレッドタイトルを検索（range=all は本文も対象）。閲覧可能なフォーラムのみ。',
      '스레드 제목 검색(range=all은 본문도 검색), 읽을 수 있는 게시판만.',
      'Busca títulos de temas (range=all también cuerpos) solo en foros legibles.',
      'Recherche les titres de sujets (range=all inclut les corps) dans les forums lisibles uniquement.',
    ),
    'read',
    {
      type: 'object',
      properties: {
        q: { type: 'string', minLength: 1, maxLength: 64, description: 'Keywords, space-separated (AND)' },
        range: { type: 'string', enum: ['thread', 'all'], description: 'thread = subject only; all = subject + body' },
        fid: { type: 'integer', minimum: 1, description: 'Limit to one forum id' },
        page: { type: 'integer', minimum: 1, maximum: 100, description: 'Page number (default 1)' },
        pageSize: PAGE_SIZE_SCHEMA,
      },
      required: ['q'],
      additionalProperties: false,
    },
    search,
  ),
  tool(
    'user_get',
    L(
      '查询用户公开资料（用户名、主题/帖子数、积分、注册与最近登录时间）。',
      '查詢使用者公開資料（使用者名稱、主題/帖子數、積分、註冊與最近登入時間）。',
      'Look up a user public profile (name, thread/post counts, credits, join and last-login time).',
      'Публичный профиль пользователя (имя, число тем/сообщений, баллы, регистрация и последний вход).',
      'ดูโปรไฟล์สาธารณะของผู้ใช้ (ชื่อ จำนวนกระทู้/โพสต์ เครดิต วันสมัครและเข้าสู่ระบบล่าสุด)',
      'Öffentliches Profil (Name, Themen-/Beitragszahl, Punkte, Registrierung, letzter Login).',
      'ユーザーの公開プロフィール（名前・スレッド/投稿数・ポイント・登録日・最終ログイン）。',
      '사용자 공개 프로필(이름, 스레드/게시글 수, 포인트, 가입일, 최근 로그인).',
      'Perfil público del usuario (nombre, temas/mensajes, créditos, alta y último acceso).',
      'Profil public d’un utilisateur (nom, sujets/messages, crédits, inscription, dernière connexion).',
    ),
    'read',
    {
      type: 'object',
      properties: {
        uid: { type: 'integer', minimum: 1, description: 'User id' },
        username: { type: 'string', maxLength: 40, description: 'Username (exact match)' },
      },
      additionalProperties: false,
    },
    userGet,
  ),
  tool(
    'site_info',
    L(
      '读取站点信息与统计（站名、简介、访问档位、主题/帖子/用户/在线数）。',
      '讀取站點資訊與統計（站名、簡介、存取檔位、主題/帖子/使用者/線上數）。',
      'Read site info and stats (name, brief, access level, threads/posts/users/online).',
      'Информация о сайте и статистика (название, описание, уровень доступа, темы/сообщения/пользователи/онлайн).',
      'ข้อมูลไซต์และสถิติ (ชื่อ คำอธิบาย ระดับการเข้าถึง กระทู้/โพสต์/ผู้ใช้/ออนไลน์)',
      'Site-Info und Statistik (Name, Beschreibung, Zugriffsstufe, Themen/Beiträge/Nutzer/Online).',
      'サイト情報と統計（サイト名・概要・アクセス段階・スレッド/投稿/ユーザー/オンライン数）。',
      '사이트 정보와 통계(이름, 설명, 접근 단계, 스레드/게시글/사용자/접속자 수).',
      'Información y estadísticas del sitio (nombre, descripción, nivel de acceso, temas/mensajes/usuarios/en línea).',
      'Infos et statistiques du site (nom, description, niveau d’accès, sujets/messages/utilisateurs/en ligne).',
    ),
    'read',
    { type: 'object', properties: {}, additionalProperties: false },
    siteInfo,
  ),
];

/* ------------------------------ 资源（契约 ⑨） ------------------------------ */

/**
 * 资源是 MCP 的「可直接挂载」形态：客户端把 freeidx://thread/12 作为上下文引用，
 * 不必先调工具再粘贴。权限、审核、付费墙与对应工具完全同一套实现（直接复用），
 * 避免出现「工具看不到、资源能读到」的分叉。
 */
async function forumResource(vars: Record<string, string>, ctx: McpCallCtx): Promise<string> {
  const fid = Number.parseInt(vars.fid ?? '', 10);
  if (!Number.isInteger(fid) || fid <= 0) throw new ToolError('Invalid forum uri');
  const { ctx: actx, forumlist } = await loadAccess(ctx.db, ctx.cache, ctx.principal.uid, ctx.principal.gid);
  const f = forumlist[fid];
  if (!f) throw new ToolError(`Forum ${fid} not found`);
  if (!forumAccessUser(actx, fid, 'allowread')) throw new ToolError(`No permission to read forum ${fid}`);
  return JSON.stringify(
    {
      fid: Number(f.fid),
      name: String(f.name ?? ''),
      brief: clip(plain(String(f.brief ?? '')), 500),
      threads: Number(f.threads ?? 0),
      todayPosts: Number(f.todayposts ?? 0),
      ...(f.announcement ? { announcement: clip(plain(String(f.announcement)), 1000) } : {}),
    },
    null,
    2,
  );
}

export const CORE_MCP_RESOURCES: McpResourceDef[] = [
  {
    uriTemplate: 'freeidx://thread/{tid}',
    mimeType: 'application/json',
    name: L(
      '主题', '主題', 'Thread', 'Тема', 'กระทู้', 'Thema', 'スレッド', '스레드', 'Tema', 'Sujet',
    ),
    handler: async (vars, ctx) => (await threadGet({ tid: vars.tid }, ctx)).text,
  },
  {
    uriTemplate: 'freeidx://forum/{fid}',
    mimeType: 'application/json',
    name: L(
      '版块', '版塊', 'Forum', 'Раздел', 'บอร์ด', 'Forum', 'フォーラム', '게시판', 'Foro', 'Forum',
    ),
    handler: forumResource,
  },
];
