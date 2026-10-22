/**
 * SEO 核心保底（§16.4，不可停用）：
 *  - robots.txt 装配引擎：核心基线 + 插件片段有序合并去重
 *  - PageMeta 构造（契约 ⑤ 上下文：路由类型 + 实体数据 + setting 源）
 *  - 爬虫预渲染分发：Cache API 前置 → R2 seo/{tid}.html → 模板串兜底（请求期 CPU≈0）
 * sitemap/JSON-LD/OG/.htm 301 归 seo 插件（extensions/seo.ts）。
 */
import { Hono } from 'hono';
import type { PageMeta, RobotsContribution, SiteSetting } from '@freeidx/shared';
import type { D1b } from '../../core/db';
import type { Cache } from '../../core/cache';
import { BOT_HTML_TTL, SHARED_UA, edgeLookup, edgeStore, isPersonalRequest, maybeCtx } from '../../core/cache/edge';
import { loadSetting } from '../../core/loaders';
import { createApiT } from '../../core/i18n';
import { getExtensions } from '../../core/extensions';
import { escAttr } from '../../core/fmt';
import type { ExtensionsRuntime } from '../../core/extensions/registry';
import { classifyUserAgent, matchPolicyCrawler, pageRoute } from '../../core/crawler';
import { canonicalBase } from '../../core/site';
import { redactPaidBlocks, stripPaidMarkers } from '../shared';
import type { Env } from '../../types/env';

type ReadEnv = { Bindings: Env; Variables: { db: D1b; cache: Cache; runlevel: number } };

/** 核心 robots 基线（含 serach-* 历史拼写兼容存量规则）+ 新路径 */
export const CORE_ROBOTS_BASE = ['User-agent: *', 'Disallow: /admin', 'Disallow: /user-*', 'Disallow: /serach-*'];

/** robots.txt 边缘缓存 TTL（与响应头 max-age 一致：爬虫本就按该值缓存，边缘层只是把这句承诺落到实处） */
const ROBOTS_TTL = 3600;

/** 装配引擎：order 小者在前、同 order 按贡献顺序；逐行去重 */
export function assembleRobots(base: string[], contribs: RobotsContribution[]): string {
  const sorted = [...contribs].sort((a, b) => a.order - b.order);
  const lines: string[] = [];
  for (const l of [...base, ...sorted.flatMap((c) => c.lines)]) {
    if (!lines.includes(l)) lines.push(l);
  }
  return lines.join('\n') + '\n';
}

export function seoCoreRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  app.get('/robots.txt', async (c) => {
    // 边缘缓存前置：robots.txt 是全站同值文档、且是爬虫最高频抓取目标，命中即省掉整套扩展装配（getExtensions）。
    // 带登录轨 Cookie 的请求（站长自查）跳过读缓存，保证配置变更当场可见。
    if (!isPersonalRequest(c.req.raw.headers)) {
      const hit = await edgeLookup(c.req.url, SHARED_UA);
      if (hit) return hit;
    }
    const rt = await getExtensions(c.get('cache'), c.get('db'));
    const base = ['User-agent: *', ...CORE_ROBOTS_BASE.slice(1), 'Disallow: /api/'];
    // 插件贡献的 {SITE_URL} 占位在请求期替换：主域名 = 后台「站点网址」优先（多域名部署），
    // SITE_URL 兜底；两者皆空回落当前请求域。sitemap 绝对地址必须指向主域名，否则备用域会各自声明一份。
    const setting = await loadSetting(c.get('cache'), c.get('db'));
    const body = assembleRobots(base, rt.robots).replace(/\{SITE_URL\}/g, canonicalBase(c, setting));
    edgeStore(c.req.url, SHARED_UA, body, ROBOTS_TTL, maybeCtx(c), 'text/plain; charset=utf-8');
    return c.text(body, 200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': `public, max-age=${ROBOTS_TTL}`,
    });
  });

  return app;
}

export function newPageMeta(
  kind: PageMeta['kind'],
  canonical: string,
  setting: SiteSetting,
  entity?: PageMeta['entity'],
): PageMeta {
  const base: Omit<PageMeta, 'title' | 'description'> = { kind, canonical, lang: setting.lang, head: [], jsonLd: [], og: {}, entity };
  /* 站点图标/Logo（后台基础设置上传，site/ 前缀 R2 直链）：favicon 注入 head，logo 作 og:image（有站点网址则拼绝对地址） */
  const favicon = setting.favicon_url ? String(setting.favicon_url) : '';
  const logo = setting.logo_url ? String(setting.logo_url) : '';
  if (favicon) base.head.push(`<link rel="icon" href="${escAttr(favicon)}">`);
  if (logo) base.og['og:image'] = setting.url ? `${setting.url.replace(/\/$/, '')}${logo}` : logo;
  switch (kind) {
    case 'index':
      return { ...base, title: setting.sitename, description: setting.desc || setting.brief };
    case 'forum':
      return {
        ...base,
        title: entity?.seoTitle || setting.sitename,
        description: setting.desc || setting.brief,
      };
    case 'thread':
      return { ...base, title: entity?.seoTitle ?? setting.sitename, description: setting.desc || setting.brief };
    case 'user':
      return { ...base, title: `${setting.sitename}`, description: setting.desc || setting.brief, noindex: true };
    default:
      return { ...base, title: setting.sitename, description: setting.desc || setting.brief };
  }
}

/** 模板串兜底渲染（微秒级；绝不在热路径触发 SSR；失败由调用侧 try/catch 回落） */
export function renderFallbackHtml(meta: PageMeta, bodyHtml: string): string {
  const og = Object.entries(meta.og)
    .map(([k, v]) => `<meta property="${escAttr(k)}" content="${escAttr(v)}">`)
    .join('\n');
  const ld = meta.jsonLd
    .map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, '\\u003c')}</script>`)
    .join('\n');
  return [
    '<!doctype html>',
    `<html lang="${escAttr(meta.lang || 'en-us')}"><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escAttr(meta.title)}</title>`,
    `<link rel="canonical" href="${escAttr(meta.canonical)}">`,
    meta.description ? `<meta name="description" content="${escAttr(meta.description)}">` : '',
    meta.noindex ? '<meta name="robots" content="noindex,follow">' : '',
    og,
    meta.head.join('\n'),
    ld,
    '</head><body>',
    `<div id="root">${bodyHtml}</div>`,
    '</body></html>',
  ]
    .filter(Boolean)
    .join('\n');
}

interface FallbackData {
  meta: PageMeta;
  body: string;
}

/** 各页面类型的最小语义 HTML（无 JS 可提取：h1/文章/链接/时间齐备） */
async function buildFallback(
  route: { kind: 'index' | 'forum' | 'thread' | 'user'; id?: number; page?: number },
  c: { get: (k: string) => unknown; env: Env; req: { url: string } },
): Promise<FallbackData | null> {
  const db = c.get('db') as D1b;
  const cache = c.get('cache') as Cache;
  const setting = await loadSetting(cache, db);
  const t = createApiT(setting.lang);
  const canonical = new URL(c.req.url).pathname;
  // 预渲染 HTML 的 canonical / 翻页绝对链接一律用主域名（后台「站点网址」优先，SITE_URL 兜底）
  const rt = `${canonicalBase(c, setting)}${canonical}`;

  if (route.kind === 'thread' && route.id) {
    const tid = route.id;
    const th = await db
      .prepare<{
        subject: string;
        username: string;
        create_date: number;
        posts: number;
        ok: number;
        content_buy: number;
      }>(
        'SELECT subject,username,create_date,posts,ok,content_buy FROM bbs_thread WHERE tid = ?',
      )
      .bind(tid)
      .first<{
        subject: string;
        username: string;
        create_date: number;
        posts: number;
        ok: number;
        content_buy: number;
      }>();
    if (!th) return null; // 主题不存在 → 交回核心 404
    if (Number(th.ok) !== 1) return null; // tt_check：未过审/回收站主题不预渲染（爬虫落到 404）
    const first = await db
      .prepare<{ message_fmt: string }>('SELECT message_fmt FROM bbs_post WHERE tid = ? ORDER BY pid ASC LIMIT 1')
      .bind(tid)
      .first<{ message_fmt: string }>();
    const meta = newPageMeta('thread', rt, setting, { tid, seoTitle: th.subject, lastDate: th.create_date });
    const body =
      `<main><article><h1>${escAttr(th.subject)}</h1>` +
      `<p>${escAttr(t('seo.author', { name: th.username }))} · <time datetime="${new Date(th.create_date * 1000).toISOString()}">` +
      `${new Date(th.create_date * 1000).toISOString().slice(0, 10)}</time> · ${escAttr(t('seo.replies', { n: th.posts }))}</p>` +
      `<div>${
        Number(th.content_buy) > 0
          ? redactPaidBlocks(first?.message_fmt ?? '')
          : stripPaidMarkers(first?.message_fmt ?? '')
      }</div></article>` +
      `<p><a href="${escAttr(rt.replace(/\/thread\/\d+/, `/thread/${tid}/p/2`))}">${escAttr(t('seo.nextPage'))}</a></p></main>`;
    return { meta, body };
  }

  if (route.kind === 'forum' && route.id) {
    const fid = route.id;
    const f = await db
      .prepare<{ name: string; brief: string; seo_title: string }>(
        'SELECT name,brief,seo_title FROM bbs_forum WHERE fid = ?',
      )
      .bind(fid)
      .first<{ name: string; brief: string; seo_title: string }>();
    if (!f) return null;
    const rows = await db
      .prepare<{ tid: number; subject: string }>(
        'SELECT tid,subject FROM bbs_thread WHERE fid = ? AND ok = 1 ORDER BY last_date DESC LIMIT 50',
      )
      .bind(fid)
      .all();
    const meta = newPageMeta('forum', rt, setting, { fid, seoTitle: f.seo_title || f.name, seoKeywords: '' });
    const list = rows.results
      .map((t) => `<li><a href="/thread/${t.tid}">${escAttr(t.subject)}</a></li>`)
      .join('');
    return { meta, body: `<main><h1>${escAttr(f.name)}</h1><p>${escAttr(f.brief)}</p><ul>${list}</ul></main>` };
  }

  if (route.kind === 'user' && route.id) {
    const uid = route.id;
    const u = await db
      .prepare<{ username: string }>('SELECT username FROM bbs_user WHERE uid = ?')
      .bind(uid)
      .first<{ username: string }>();
    if (!u) return null;
    const rows = await db
      .prepare<{ tid: number; subject: string }>(
        'SELECT tid,subject FROM bbs_thread WHERE uid = ? AND ok = 1 ORDER BY tid DESC LIMIT 50',
      )
      .bind(uid)
      .all();
    const meta = newPageMeta('user', rt, setting, { uid });
    const list = rows.results.map((t) => `<li><a href="/thread/${t.tid}">${escAttr(t.subject)}</a></li>`).join('');
    return { meta, body: `<main><h1>${escAttr(u.username)}</h1><ul>${list}</ul></main>` };
  }

  // index
  const rows = await db
    .prepare<{ tid: number; subject: string }>('SELECT tid,subject FROM bbs_thread WHERE ok = 1 ORDER BY last_date DESC LIMIT 50')
    .all();
  const meta = newPageMeta('index', rt, setting);
  if (route.page && route.page > 1) meta.noindex = true; // 分页 noindex 保底（§16.2）
  const list = rows.results.map((t) => `<li><a href="/thread/${t.tid}">${escAttr(t.subject)}</a></li>`).join('');
  return { meta, body: `<main><h1>${escAttr(setting.sitename)}</h1><p>${escAttr(setting.brief)}</p><ul>${list}</ul></main>` };
}

/**
 * 爬虫预渲染分发（核心管线，seo 插件的 head 贡献在此被消费）：
 * searchbot + 页面路径 → Cache API → R2 seo/{tid}.html → 模板串兜底；异常回落 SPA 壳（next()）。
 * 名单内 AI 爬虫（POLICY_CRAWLERS）额外先过一道插件策略闸门：被后台关掉者在此 403。
 */
type PrerenderCtx = {
  req: { method: string; url: string; path: string; header: (k: string) => string | undefined };
  env: Env;
  get: (k: string) => unknown;
  finalized: boolean;
  res: Response;
};

/** 契约 ①：按注册顺序跑插件中间件；任一插件写入 c.res 即视为接管（返回 true，调用方直接收工） */
async function runExtMiddlewares(c: PrerenderCtx, rt: ExtensionsRuntime): Promise<boolean> {
  for (const mw of rt.middlewares) {
    await mw(c, async () => {});
    if (c.finalized) return true;
  }
  return false;
}

export function prerender() {
  return (async (c: PrerenderCtx, next: () => Promise<void>) => {
    if (c.req.method !== 'GET') return next();
    const ua = c.req.header('user-agent') ?? '';
    const uaClass = classifyUserAgent(ua);
    // 人类请求直通：不装载插件运行时，与改动前同口径（铁律 3 预算）
    if (uaClass === 'human') return next();
    const route = pageRoute(c.req.path);
    if (!route) return next();
    // 命中策略名单的爬虫才需读插件策略；Googlebot/Bingbot 等名单外搜索爬虫走原链路，零额外 KV/D1 读
    const policyHit = matchPolicyCrawler(ua) !== null;
    if (!policyHit && uaClass !== 'searchbot') return next();
    try {
      const cache = c.get('cache') as Cache;
      const db = c.get('db') as D1b;
      let rt: ExtensionsRuntime | null = null;
      if (policyHit) {
        /* 爬虫策略闸门（契约 ① 执行点扩展到「名单内爬虫」）：
           必须先于 Cache API —— 被站长关掉的爬虫即便已有缓存的预渲染产物也不得命中，
           否则「后台禁止 + 正文照给」的错配只是从模板挪到了缓存里。geo 在此把 robots 开关落成 403。 */
        rt = await getExtensions(cache, db);
        if (await runExtMiddlewares(c, rt)) return;
        if (uaClass !== 'searchbot') return next(); // 放行的 AI 爬虫：照旧不给正文，回落 SPA 壳
      }
      // Cache API 前置：命中即出，插件中间件/D1/KV/R2 全部不触达（仅自定义域下真正生效，否则恒 miss）
      const hit = await edgeLookup(c.req.url, 'searchbot');
      if (hit) {
        c.res = hit;
        return;
      }
      if (!rt) {
        rt = await getExtensions(cache, db);
        // 插件中间件先接管（契约 ①）：名单外搜索爬虫走的仍是这条原路径
        if (await runExtMiddlewares(c, rt)) return;
      }
      // thread 预渲染产物：R2 get（I/O 不计 CPU）
      if (route.kind === 'thread' && route.id) {
        const key = `seo/${route.id}.html`;
        const r2 = c.env.FILES as unknown as { get?: (k: string) => Promise<{ text: () => Promise<string> } | null> };
        const obj = await r2.get?.(key);
        if (obj) {
          const html = await obj.text();
          c.res = new Response(html, {
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' },
          });
          edgeStore(c.req.url, 'searchbot', html, BOT_HTML_TTL, maybeCtx(c));
          return;
        }
      }
      const fb = await buildFallback(route, c as never);
      if (!fb) return next();
      await rt.bus.emit('render:head', fb.meta);
      const html = renderFallbackHtml(fb.meta, fb.body);
      c.res = new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' },
      });
      edgeStore(c.req.url, 'searchbot', html, BOT_HTML_TTL, maybeCtx(c));
      return;
    } catch (err) {
      console.warn('[seo] prerender fallback failed:', err);
      return next(); // 绝不让爬虫拿到 5xx/1102
    }
  }) as never;
}
