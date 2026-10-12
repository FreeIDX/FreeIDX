/**
 * 消息原语（huux_notice）。
 *  - noticeSend：fromuid/recvuid 为空或相同不发；type=0 归一为 99。
 *  - noticeSubstr：strip 标签 → HTML 转义 → 码点截断 + '...'（len 默认 20）。
 *  - 消息体为服务端生成的受限 HTML（用户输入一律转义）。
 *  - 模板文案按站点语言取词（t = c.get('t')，缺省 t0=zh-cn 兼容单测直调）。
 * type：0 全部（仅筛选）· 2 评论 · 3 系统（版务/管理员）· 99 其他。
 */
import type { ApiKey } from '@freeidx/shared';
import type { D1b, Stmt } from './db';
import { t0, type ApiT } from './i18n';

export const NoticeType = { ALL: 0, COMMENT: 2, SYSTEM: 3, PM: 7, OTHER: 99 } as const;

/** 类型名：按站点语言取词 */
export function noticeTypeName(t: ApiT, type: number): string {
  if (Number(type) === NoticeType.COMMENT) return t('notice.typeComment');
  if (Number(type) === NoticeType.SYSTEM) return t('notice.typeSystem');
  if (Number(type) === NoticeType.PM) return t('notice.typePm');
  return t('notice.typeOther');
}

/** HTML 转义（消息体拼 HTML 时对一切用户输入使用） */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 摘要截断：strip 标签 → 转义 → 按码点截断，超长补 '...' */
function noticeSubstr(s: string, len = 20): string {
  const escaped = escapeHtml(s.replace(/<[^>]*>/g, ''));
  const cps = [...escaped];
  return cps.length > len ? cps.slice(0, len).join('') + '...' : escaped;
}

/** 发送单条消息：fromuid/recvuid 为空或相同不发；返回 nid / null */
export async function noticeSend(
  db: D1b,
  args: { fromuid: number; recvuid: number; message: string; type?: number; ts?: number },
): Promise<number | null> {
  const { fromuid, recvuid, message } = args;
  if (!fromuid || !recvuid || fromuid === recvuid) return null;
  const type = args.type || NoticeType.OTHER;
  const row = await db
    .prepare<{ nid: number }>(
      'INSERT INTO bbs_notice (fromuid,recvuid,create_date,isread,type,message) VALUES (?,?,?,0,?,?) RETURNING nid',
    )
    .bind(fromuid, recvuid, args.ts ?? Math.floor(Date.now() / 1000), type, message)
    .first<{ nid: number }>();
  return row ? Number(row.nid) : null;
}

/**
 * 批量发送：与 noticeSend 完全同规则（fromuid/recvuid 为空或相同则跳过、type=0 归一 99），
 * 但合并为单次 DB.batch —— 1 子请求 N 条语句（§7），批量版务/审核通知不再随条目数线性增长。
 * 批量场景调用方不使用自增 nid，故不返回。
 */
export async function noticeSendMany(
  db: D1b,
  items: { fromuid: number; recvuid: number; message: string; type?: number; ts?: number }[],
): Promise<void> {
  const dfltTs = Math.floor(Date.now() / 1000);
  const stmts: Stmt[] = [];
  for (const it of items) {
    if (!it.fromuid || !it.recvuid || it.fromuid === it.recvuid) continue;
    stmts.push(
      db
        .prepare('INSERT INTO bbs_notice (fromuid,recvuid,create_date,isread,type,message) VALUES (?,?,?,0,?,?)')
        .bind(it.fromuid, it.recvuid, it.ts ?? dfltTs, it.type || NoticeType.OTHER, it.message),
    );
  }
  if (stmts.length) await db.batch(stmts);
}

const threadHref = (tid: number) => `/thread/${tid}`;

/** 评论通知（回复分支）：回复了你的《主题》+ 回复摘要 */
export function noticeReplyHtml(tid: number, subject: string, pid: number, message: string, t: ApiT = t0): string {
  const sub = noticeSubstr(subject, 20);
  const brief = noticeSubstr(message, 40);
  const topic = `<a href="${threadHref(tid)}">${t('notice.topicWrap', { subject: sub })}</a>`;
  return (
    `<div class="comment-info"><a class="mr-1 text-grey" href="${threadHref(tid)}#${pid}">${t('notice.replyAnchor')}</a>` +
    `${t('notice.replyTemplate', { topic })}</div>` +
    `<div class="single-comment"><a href="${threadHref(tid)}#${pid}">${brief}</a></div>`
  );
}

/** 引用通知（引用分支）：回复了你在《主题》中的评论 + 被引摘要 + 新回复摘要 */
export function noticeQuoteHtml(
  tid: number,
  subject: string,
  pid: number,
  quoteMessage: string,
  replyMessage: string,
  t: ApiT = t0,
): string {
  const sub = noticeSubstr(subject, 20);
  const topic = `<a href="${threadHref(tid)}">${t('notice.topicWrap', { subject: sub })}</a>`;
  return (
    `<div class="comment-info"><a class="mr-1 text-grey" href="${threadHref(tid)}#${pid}">${t('notice.replyAnchor')}</a>` +
    `${t('notice.quoteTemplate', { topic })}</div>` +
    `<div class="quote-comment">${noticeSubstr(quoteMessage, 40)}</div>` +
    `<div class="reply-comment"><a href="${threadHref(tid)}#${pid}">${noticeSubstr(replyMessage, 40)}</a></div>`
  );
}

/** 版务动作文案键（lang 键 notice.mod*） */
const MOD_TODO_KEY: Record<string, ApiKey> = {
  top1: 'notice.modTop1',
  top3: 'notice.modTop3',
  top0: 'notice.modTop0',
  close1: 'notice.modClose1',
  close0: 'notice.modClose0',
  move: 'notice.modMove',
  delete: 'notice.modDelete',
};

/** 版务通知：管理员 + 动作 + 你的主题《…》[到【版块】] */
export function noticeModHtml(
  opts: {
    action: keyof typeof MOD_TODO_KEY;
    tid: number;
    subject: string;
    newFid?: number;
    newForumName?: string;
  },
  t: ApiT = t0,
): string {
  const todo = t(MOD_TODO_KEY[opts.action] ?? 'notice.modOther');
  const sub = noticeSubstr(opts.subject, 20);
  const topic = `<a href="${threadHref(opts.tid)}">${t('notice.topicWrap', { subject: sub })}</a>`;
  let html = t('notice.modTemplate', { todo, topic });
  if (opts.action === 'move' && opts.newFid !== undefined) {
    const forum = `<a href="/forum/${opts.newFid}">${t('notice.forumWrap', { name: escapeHtml(opts.newForumName ?? '') })}</a>`;
    html += t('notice.modMoveSuffix', { forum });
  }
  return html;
}
