/**
 * MCP 写工具（契约 ⑨，scope=write）：`thread_create` / `reply_create`。
 *
 * 与 HTTP 写接口共用 modules/write/core.ts —— 权限、审核、积分、附件、通知、事件、SEO 全在同一处，
 * 这里只做三件事：把工具参数归一化、用令牌持有者构造写身份、把结果转成模型可读的结构。
 *
 * 与浏览器入口的两点差异（都是刻意的）：
 *  1. 不校验 Turnstile：MCP 是机器调用，拿不到浏览器 token；替代手段是令牌档位 + 每分钟限流
 *     （见 auth.ts）+ 可随时撤销令牌。
 *  2. 不接收附件（attachAids）：MCP 没有上传通道，传了也会被忽略，避免模型误传他人附件 ID。
 *
 * 默认不可用：插件配置 `enabledScopes` 出厂为 `read`，且令牌本身也要带 write 档位，两者取交集。
 */
import { L } from '../../core/i18n';
import type { ApiT } from '../../core/i18n';
import type { McpCallCtx, McpToolDef, McpToolResult } from '../../core/extensions/registry';
import {
  assertNotBanned,
  createReplyCore,
  createThreadCore,
  loadAuthorRow,
  makeWriteActor,
  type WriteDeps,
} from '../../modules/write/core';
import { ToolError } from './tools';

/** 写工具的 MCP 上下文 → 写依赖（无 Hono Context，waitUntil 缺省即内联执行 SEO 产物） */
function writeDepsOf(ctx: McpCallCtx): WriteDeps {
  const env = ctx.env;
  // 运行期由 index.ts 注入 c.env，理论上不会为空；为空说明装配漏了，宁可报错也不要写出无绑定的数据
  if (!env) throw new ToolError('Server bindings unavailable');
  return { db: ctx.db, cache: ctx.cache, env };
}

/**
 * 令牌 → 写身份。三次失败都要给模型可执行的下一步，
 * 而不是让它在「权限不足」上反复重试：未登录态 / 被封禁 / 账号不存在是三件不同的事。
 */
async function loadActor(ctx: McpCallCtx, t: ApiT) {
  const author = await loadAuthorRow(ctx.db, ctx.principal.uid);
  if (!author) throw new ToolError('Token owner account no longer exists');
  assertNotBanned(author, t);
  return makeWriteActor(writeDepsOf(ctx), author);
}

/** 写结果统一结构：模型据此生成「已发布 / 待审核」的答复，不必再查一次 */
function writeResult(
  r: { tid: number; pid?: number; gain: string; pending: boolean },
  tid: number,
  pid?: number,
): McpToolResult {
  return {
    text: JSON.stringify(
      {
        tid,
        pid: pid ?? r.pid ?? 0,
        url: `/thread/${tid}`,
        pending: r.pending,
        credits: r.gain || undefined,
      },
      null,
      2,
    ),
  };
}

/* --------------------------------- 工具 --------------------------------- */

async function threadCreate(args: Record<string, unknown>, ctx: McpCallCtx): Promise<McpToolResult> {
  const actor = await loadActor(ctx, ctx.t);
  const r = await createThreadCore(
    writeDepsOf(ctx),
    actor,
    {
      fid: Number(args.fid ?? 0),
      subject: String(args.subject ?? ''),
      message: String(args.message ?? ''),
      doctype: Number(args.doctype ?? 0),
      contentBuy: Number(args.contentBuy ?? 0),
      contentBuyType: Number(args.contentBuyType ?? 0),
      tags: args.tags,
      lang: args.lang,
      // MCP 无上传通道：显式忽略模型可能臆造的附件 ID
      attachAids: [],
    },
    ctx.ip,
    ctx.t,
  );
  return writeResult(r, r.tid, r.pid);
}

async function replyCreate(args: Record<string, unknown>, ctx: McpCallCtx): Promise<McpToolResult> {
  const actor = await loadActor(ctx, ctx.t);
  const tid = Number(args.tid ?? 0);
  const r = await createReplyCore(
    writeDepsOf(ctx),
    actor,
    tid,
    {
      message: String(args.message ?? ''),
      doctype: Number(args.doctype ?? 0),
      quotepid: Number(args.quotepid ?? 0),
      attachAids: [],
    },
    ctx.ip,
    ctx.t,
  );
  return writeResult({ ...r, tid }, tid, r.pid);
}

export const MCP_WRITE_TOOLS: McpToolDef[] = [
  {
    name: 'thread_create',
    scope: 'write',
    description: L(
      '在指定版块发布主题（标题 + HTML 正文）。需要令牌具备 write 档位，且版块允许发帖；命中审核规则时返回 pending=true（不会立即公开）。',
      '在指定版塊發佈主題（標題 + HTML 正文）。需要權杖具備 write 檔位，且版塊允許發帖；命中審核規則時回傳 pending=true（不會立即公開）。',
      'Publish a thread (subject + HTML body) in a forum. Requires the write scope on the token and post permission in the forum; when moderation applies it returns pending=true (not public yet).',
      'Создать тему (заголовок + HTML) в разделе. Нужен уровень write у токена и право писать в разделе; при модерации вернётся pending=true.',
      'สร้างกระทู้ (หัวข้อ + เนื้อหา HTML) ในบอร์ด ต้องมีระดับ write และสิทธิ์โพสต์ในบอร์ด หากต้องตรวจสอบจะคืน pending=true',
      'Thema erstellen (Titel + HTML-Text) in einem Forum. Erfordert die Stufe write und Schreibrecht im Forum; bei Moderation kommt pending=true zurück.',
      '指定フォーラムにスレッドを投稿します（タイトル + HTML 本文）。write レベルと投稿権限が必要で、審査対象の場合は pending=true を返します。',
      '지정 게시판에 스레드를 작성합니다(제목 + HTML 본문). write 범위와 게시 권한이 필요하며, 심사 대상이면 pending=true를 반환합니다.',
      'Publica un tema (asunto + cuerpo HTML) en un foro. Requiere el nivel write y permiso de publicación; si hay moderación devuelve pending=true.',
      'Publie un sujet (titre + corps HTML) dans un forum. Nécessite le niveau write et le droit de publier ; en cas de modération, renvoie pending=true.',
    ),
    inputSchema: {
      type: 'object',
      properties: {
        fid: { type: 'integer', minimum: 1, description: 'Target forum id (see forum_list).' },
        subject: { type: 'string', minLength: 1, maxLength: 128, description: 'Thread subject, plain text.' },
        message: { type: 'string', minLength: 1, description: 'Thread body. HTML is allowed; plain text is also accepted.' },
        doctype: { type: 'integer', minimum: 0, maximum: 10, description: 'Editor format id, default 0 (HTML).' },
        contentBuy: { type: 'integer', minimum: 0, description: 'Paid-content price; ignored unless the group allows selling.' },
        contentBuyType: { type: 'integer', enum: [1, 2, 3], description: 'Paid-content unit when contentBuy > 0.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags; only names defined by the site are kept, at most 4.',
        },
        lang: { type: 'string', description: 'Content language code; ignored when the forum binds a language.' },
      },
      required: ['fid', 'subject', 'message'],
      additionalProperties: false,
    },
    handler: threadCreate,
  },
  {
    name: 'reply_create',
    scope: 'write',
    description: L(
      '回复指定主题（HTML 正文）。主题关闭时仅管理组可回；可带 quotepid 引用同帖楼层。命中审核规则时返回 pending=true。',
      '回覆指定主題（HTML 正文）。主題關閉時僅管理組可回；可帶 quotepid 引用同帖樓層。命中審核規則時回傳 pending=true。',
      'Reply to a thread (HTML body). Closed threads accept replies from moderators only; quotepid quotes a post in the same thread. Returns pending=true when moderation applies.',
      'Ответ в тему (HTML). В закрытую тему могут писать только модераторы; quotepid цитирует сообщение той же темы. При модерации вернётся pending=true.',
      'ตอบกลับกระทู้ (เนื้อหา HTML) กระทู้ที่ปิดรับเฉพาะผู้ดูแล; quotepid ใช้อ้างอิงโพสต์ในกระทู้เดียวกัน หากต้องตรวจสอบจะคืน pending=true',
      'Auf ein Thema antworten (HTML). Geschlossene Themen nur für Moderatoren; quotepid zitiert einen Beitrag desselben Themas. Bei Moderation pending=true.',
      'スレッドへ返信します（HTML 本文）。閉鎖中は管理組のみ、quotepid で同一スレッドの投稿を引用できます。審査対象なら pending=true。',
      '스레드에 답글을 작성합니다(HTML 본문). 닫힌 스레드는 관리자만 가능하며, quotepid로 같은 스레드의 글을 인용합니다. 심사 대상이면 pending=true.',
      'Responde a un tema (cuerpo HTML). Los temas cerrados solo admiten respuestas de moderadores; quotepid cita un mensaje del mismo tema. Devuelve pending=true si hay moderación.',
      'Répond à un sujet (corps HTML). Les sujets fermés n’acceptent que les modérateurs ; quotepid cite un message du même sujet. Renvoie pending=true en cas de modération.',
    ),
    inputSchema: {
      type: 'object',
      properties: {
        tid: { type: 'integer', minimum: 1, description: 'Target thread id.' },
        message: { type: 'string', minLength: 1, description: 'Reply body. HTML is allowed; plain text is also accepted.' },
        doctype: { type: 'integer', minimum: 0, maximum: 10, description: 'Editor format id, default 0 (HTML).' },
        quotepid: { type: 'integer', minimum: 0, description: 'Post id to quote; invalid ids are silently dropped.' },
      },
      required: ['tid', 'message'],
      additionalProperties: false,
    },
    handler: replyCreate,
  },
];
