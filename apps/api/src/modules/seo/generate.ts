/**
 * SEO HTML 生成侧（T2-7，§16.1/§16.4）：写入期定稿产物——把主题详情页渲染成静态 HTML 存 R2 `seo/{tid}.html`，
 * 供爬虫预渲染分发（modules/seo/core.ts prerender）直接命中，请求期 CPU≈0。
 *  - 生成时机：post:created/updated（首帖或回帖使 last_date/subject 变化）、thread 删除→主动失效。
 *  - head 贡献：经 getExtensions().bus.emit('render:head', meta)，seo 插件的 OG/JSON-LD 在此并入（契约⑤）。
 *  - 韧性：整体 try/catch，失败仅回落到分发侧模板串兜底，绝不影响写请求成功语义。
 */
import type { D1b } from '../../core/db';
import type { Cache } from '../../core/cache';
import type { Env } from '../../types/env';
import { loadSetting } from '../../core/loaders';
import { createApiT } from '../../core/i18n';
import { getExtensions } from '../../core/extensions';
import { newPageMeta, renderFallbackHtml } from './core';

interface SeoDeps {
  db: D1b;
  cache: Cache;
  env: Env;
}

const escAttr = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface ThreadSeoRow {
  tid: number;
  subject: string;
  username: string;
  create_date: number;
  posts: number;
  views: number;
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
        'SELECT tid,subject,username,create_date,posts,views,ok FROM bbs_thread WHERE tid = ?',
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
    const site = (env.SITE_URL ?? '').replace(/\/$/, '');
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
      `<div>${first?.message_fmt ?? ''}</div></article>` +
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
