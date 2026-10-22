/**
 * SEO HTML 生成侧（T2-7，§16.1/§16.4）：写入期定稿产物——把主题详情页渲染成静态 HTML 存 R2 `seo/{tid}.html`，
 * 供爬虫预渲染分发（modules/seo/core.ts prerender）直接命中，请求期 CPU≈0。
 *  - 生成时机：post:created/updated（首帖或回帖使 last_date/subject 变化）、thread 删除→主动失效。
 *  - head 贡献：经 getExtensions().bus.emit('render:head', meta)，seo 插件的 OG/JSON-LD 在此并入（契约⑤）。
 *  - 韧性：整体 try/catch，失败仅回落到分发侧模板串兜底，绝不影响写请求成功语义。
 */
import type { Context } from 'hono';
import type { D1b } from '../../core/db';
import type { Cache } from '../../core/cache';
import type { Env } from '../../types/env';
import { loadSetting } from '../../core/loaders';
import { createApiT } from '../../core/i18n';
import { getExtensions } from '../../core/extensions';
import { escAttr } from '../../core/fmt';
import { canonicalBaseFromSetting } from '../../core/site';
import { getExecCtx, redactPaidBlocks, stripPaidMarkers, type ReadEnv } from '../shared';
import { newPageMeta, renderFallbackHtml } from './core';

interface SeoDeps {
  db: D1b;
  cache: Cache;
  env: Env;
}

interface ThreadSeoRow {
  tid: number;
  subject: string;
  username: string;
  create_date: number;
  posts: number;
  views: number;
  /** 付费主题价格>0 时，静态页必须剥离 [ttPay] 段正文（爬虫/游客无购买态） */
  content_buy: number;
  /** 审核位（tt_check）：非 1（待审/拒绝/回收站）不产出，且调用方删除旧产物 */
  ok: number;
}

/** R2 key：与分发侧 prerender 读取的 `seo/{tid}.html` 完全一致 */
export const seoKey = (tid: number): string => `seo/${tid}.html`;

/**
 * 生成并写入单主题 SEO HTML。返回：true=已写、false=主题不存在（调用方应删除产物）。
 * 不抛异常——失败由 catch 记录后返回 false，写请求不受影响（G3 写时定稿韧性）。
 */
export async function generateThreadSeoHtml(deps: SeoDeps, tid: number): Promise<boolean> {
  try {
    const { db, cache, env } = deps;
    const th = await db
      .prepare<ThreadSeoRow>(
        'SELECT tid,subject,username,create_date,posts,views,ok,content_buy FROM bbs_thread WHERE tid = ?',
      )
      .bind(tid)
      .first<ThreadSeoRow>();
    if (!th) return false;
    // tt_check：未过审/回收站主题不产出静态页（返回 false → 调用方 deleteThreadSeoHtml 清旧产物）
    if (Number(th.ok) !== 1) return false;
    const first = await db
      .prepare<{ message_fmt: string }>('SELECT message_fmt FROM bbs_post WHERE tid = ? ORDER BY pid ASC LIMIT 1')
      .bind(tid)
      .first<{ message_fmt: string }>();

    const setting = await loadSetting(cache, db);
    const t = createApiT(setting.lang);
    // 写时定稿无请求上下文：主域名取后台「站点网址」优先，SITE_URL 兜底；都未配置则用相对路径
    const site = canonicalBaseFromSetting(setting, env);
    const canonical = `${site}/thread/${tid}`;
    const meta = newPageMeta('thread', canonical, setting, { tid, seoTitle: th.subject, lastDate: th.create_date });

    // 契约⑤：插件（seo）贡献 OG/JSON-LD/head 片段，核心保底 title/canonical 已在 renderFallbackHtml 输出
    const rt = await getExtensions(cache, db);
    await rt.bus.emit('render:head', meta);

    const date = new Date(th.create_date * 1000).toISOString();
    const body =
      `<main><article><h1>${escAttr(th.subject)}</h1>` +
      `<p>${escAttr(t('seo.author', { name: th.username }))} · <time datetime="${date}">${date.slice(0, 10)}</time>` +
      ` · ${escAttr(t('seo.replies', { n: th.posts }))} · ${escAttr(t('seo.views', { n: th.views }))}</p>` +
      // 静态页无购买态：付费主题剥离段内正文，免费主题仅去掉历史残留标记
      `<div>${
        Number(th.content_buy) > 0
          ? redactPaidBlocks(first?.message_fmt ?? '')
          : stripPaidMarkers(first?.message_fmt ?? '')
      }</div></article>` +
      (th.posts > 0 ? `<p><a href="${escAttr(`${site}/thread/${tid}/p/2`)}">${escAttr(t('seo.nextPage'))}</a></p>` : '') +
      `</main>`;

    const html = renderFallbackHtml(meta, body);
    await env.FILES.put(seoKey(tid), html, {
      httpMetadata: { contentType: 'text/html; charset=utf-8', cacheControl: 'public, max-age=3600' },
    });
    return true;
  } catch (err) {
    console.warn(`[seo] generate html failed for tid=${tid}:`, err);
    return false;
  }
}

/** 主动失效：主题删除/编辑回落时移除陈旧产物（分发侧随即回落模板串） */
export async function deleteThreadSeoHtml(deps: SeoDeps, tid: number): Promise<void> {
  try {
    await deps.env.FILES.delete(seoKey(tid));
  } catch (err) {
    console.warn(`[seo] delete html failed for tid=${tid}:`, err);
  }
}

/** SEO HTML 旁路调度（写时定稿产物）：未绑定 R2 跳过；有执行上下文 waitUntil，否则内联等待 */
export async function scheduleSeo(
  deps: { db: D1b; cache: Cache },
  c: Context<ReadEnv>,
  tid: number,
  mode: 'gen' | 'del',
): Promise<void> {
  const files = c.env.FILES as unknown as { put?: unknown } | undefined;
  if (!files || typeof files.put !== 'function') return;
  const seoDeps = { db: deps.db, cache: deps.cache, env: c.env };
  const work =
    mode === 'del'
      ? deleteThreadSeoHtml(seoDeps, tid)
      : generateThreadSeoHtml(seoDeps, tid).then((written) => (written ? undefined : deleteThreadSeoHtml(seoDeps, tid)));
  const ex = await getExecCtx(c);
  if (ex?.waitUntil) ex.waitUntil(work);
  else await work;
}

/** SEO HTML 批量失效旁路（列表删除/版块删除）：未绑定 R2 跳过；有执行上下文 waitUntil，否则内联等待 */
export async function invalidateThreadSeo(
  deps: { db: D1b; cache: Cache },
  c: Context<ReadEnv>,
  tids: number[],
): Promise<void> {
  const files = c.env.FILES as unknown as { put?: unknown } | undefined;
  if (!files || typeof files.put !== 'function' || !tids.length) return;
  const seoDeps = { db: deps.db, cache: deps.cache, env: c.env };
  const work = Promise.all(tids.map((tid) => deleteThreadSeoHtml(seoDeps, tid).catch(() => undefined)));
  const ex = await getExecCtx(c);
  if (ex?.waitUntil) ex.waitUntil(work);
  else await work;
}
/* ---------------- 改名 SEO 重建队列（§20.2 C 档） ---------------- */

/** bbs_kv 队列键：v = [{uid, cursor}]（JSON），expiry 30 天防无限残留 */
const RENAME_QUEUE_KEY = 'seo:rename-pending';
const RENAME_QUEUE_TTL = 30 * 86400;

type RenameEntry = { uid: number; cursor: number };

async function readRenameQueue(db: D1b): Promise<RenameEntry[]> {
  const row = await db.prepare<{ v: string }>('SELECT v FROM bbs_kv WHERE k = ?').bind(RENAME_QUEUE_KEY).first<{ v: string }>();
  try {
    const q = JSON.parse(row?.v ?? '[]') as RenameEntry[];
    return Array.isArray(q) ? q.filter((x) => x && Number(x.uid) > 0) : [];
  } catch {
    return [];
  }
}

/**
 * 改名入队（backfillUsername 旁路调用）：seo/{tid}.html 烧录的是回写前的旧楼主名，
 * D1 快照回写不触发 SEO 重建——由 cron 每小时档消费队列逐批重生成。
 * 幂等：同 uid 已在队则跳过。尽力而为（与改名回写同语义），失败仅告警。
 */
export async function enqueueSeoRename(db: D1b, uid: number): Promise<void> {
  try {
    const q = await readRenameQueue(db);
    if (q.some((x) => Number(x.uid) === uid)) return;
    q.push({ uid, cursor: 0 });
    await db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,?)').bind(RENAME_QUEUE_KEY, JSON.stringify(q), RENAME_QUEUE_TTL).run();
  } catch (err) {
    console.warn('[seo] enqueue rename-rebuild failed:', err);
  }
}

/**
 * 消费队列头部用户：按 tid 游标重建该用户名下主题的 SEO HTML（generate 内部 SELECT 读的是
 * 回写后的 bbs_thread.username，产物即为新名）。每轮 ≤limit 条：
 * 每条 = 2 D1 + 1 R2 put ≈ 3 子请求，limit=10 → ~32 子请求（含队列读写 2 D1），
 * 与每小时档既有任务共存仍留免费层 50 上限余量。普通作者（<240 帖）一天内完成；
 * 极端大作者多天消化——改名 SEO 陈旧本可接受（§20.2 已声明），慢速重建纯增益。
 * 未过审/已删主题（generate 返 false）顺带删除旧产物。返回本轮处理条数。
 */
export async function seoRebuildRenamed(deps: SeoDeps, limit = 10): Promise<number> {
  const { db, cache, env } = deps;
  if (!env.FILES || typeof env.FILES.put !== 'function') return 0;
  const q = await readRenameQueue(db);
  const head = q[0];
  if (!q.length || !head) return 0;
  const uid = Number(head.uid);
  const cursor = Number(head.cursor ?? 0);
  const r = await db
    .prepare<{ tid: number }>('SELECT tid FROM bbs_thread WHERE uid = ? AND tid > ? ORDER BY tid ASC LIMIT ?')
    .bind(uid, cursor, limit)
    .all();
  let done = 0;
  for (const row of r.results) {
    const tid = Number(row.tid);
    if (!(await generateThreadSeoHtml({ db, cache, env }, tid))) await deleteThreadSeoHtml({ db, cache, env }, tid);
    done++;
  }
  if (r.results.length < limit) q.shift();
  else q[0] = { uid, cursor: Number(r.results[r.results.length - 1]?.tid ?? cursor) };
  await db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,?)').bind(RENAME_QUEUE_KEY, JSON.stringify(q), RENAME_QUEUE_TTL).run();
  return done;
}
