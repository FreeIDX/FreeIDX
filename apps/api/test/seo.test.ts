/**
 * T1-9 seo 插件一期（分发侧）+ SEO 核心保底测试：
 *  - .htm 301 映射（纯函数 + 经 Worker 分发）
 *  - robots.txt 装配引擎（基线 + 插件片段 + {SITE_URL} 占位）
 *  - sitemap.xml（契约 ③）
 *  - 爬虫预渲染（R2 → 模板串兜底；人类 UA 不受影响；分页 noindex）
 *  - 停用 seo 插件后核心保底仍可收录（§16.4 验收）
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { l0Clear } from '../src/core/cache';
import { assembleRobots, CORE_ROBOTS_BASE, newPageMeta } from '../src/modules/seo/core';
import { mapLegacyPath } from '../src/extensions/seo';
import { classifyUserAgent, matchRegisteredPath } from '../src/core/crawler';
import { fakeAssets, fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import type { RobotsContribution, SiteSetting } from '@freeidx/shared';

const BOT = { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' };
const HUMAN = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' };

const SETTING = JSON.stringify({
  runlevel: 5, sitename: 'FreeIDX', brief: 'b', url: 'http://localhost', kw: '', desc: '',
  user_create_on: 1, user_create_email_on: 0, user_resetpw_on: 1,
  forum_orderby: 0, update_views_on: 1, upload_max_size: 1048576, lang: 'zh-cn',
});
const GUEST_GROUP = {
  gid: 0, name: '游客组', creditsfrom: 0, creditsto: 0,
  allowread: 1, allowthread: 0, allowpost: 1, allowattach: 0, allowdown: 1,
  allowtop: 0, allowupdate: 0, allowdelete: 0, allowmove: 0, allowbanuser: 0, allowdeleteuser: 0, allowviewip: 0,
};
const FORUM_OPEN = {
  fid: 1, name: '默认版块', rank: 1, threads: 2, todayposts: 0, todaythreads: 0,
  brief: '介绍', announcement: '', accesson: 0, orderby: 0, icon: 0, moduids: '', seo_title: '', seo_keywords: '',
};

function rules(extState?: Record<string, unknown>): SqlRule[] {
  return [
    {
      test: /FROM bbs_kv/,
      first: (params: readonly unknown[]) =>
        params[0] === 'extensions' ? (extState ? { v: JSON.stringify(extState) } : null) : { v: SETTING },
    },
    { test: /FROM bbs_group/, rows: [GUEST_GROUP] },
    { test: /FROM bbs_forum ORDER BY/, rows: [FORUM_OPEN] },
    { test: /FROM bbs_forum WHERE fid/, first: FORUM_OPEN },
    { test: /bbs_forum_access/, rows: [] },
    { test: /message_fmt FROM bbs_post/, first: { message_fmt: '<p>首贴内容</p>' } },
    { test: /FROM bbs_thread WHERE tid = \?/, first: { subject: '你好世界', username: 'admin', create_date: 1700000001, posts: 1, ok: 1 } },
    { test: /FROM bbs_thread WHERE ok = 1 ORDER BY last_date DESC LIMIT 1000/, rows: [{ tid: 2, last_date: 1700000002 }] },
    { test: /FROM bbs_thread WHERE ok = 1 ORDER BY last_date DESC LIMIT 50/, rows: [{ tid: 2, subject: '你好世界' }] },
    { test: /FROM bbs_thread WHERE fid = \?/, rows: [{ tid: 2, subject: '你好世界' }] },
    { test: /FROM bbs_thread WHERE uid = \?/, rows: [{ tid: 2, subject: '你好世界' }] },
    { test: /FROM bbs_user WHERE uid = \?/, first: { username: 'admin' } },
    { test: /bbs_cache/, first: null },
  ];
}

function envFor(extState?: Record<string, unknown>, files: Record<string, string> = {}) {
  const fake = fakeD1Sql(rules(extState));
  return {
    env: {
      DB: fake.db,
      CACHE: fakeKv(),
      FILES: { get: async (k: string) => (files[k] ? { text: async () => files[k]! } : null) },
      ASSETS: fakeAssets(),
      SITE_URL: 'http://localhost',
    },
    calls: fake.calls,
  };
}

beforeEach(() => l0Clear());

describe('mapLegacyPath（遗留 .htm dash-positional → 新路由）', () => {
  it('已知页名按参数位映射', () => {
    expect(mapLegacyPath('/thread-1.htm')).toBe('/thread/1');
    expect(mapLegacyPath('/thread-1-2.htm')).toBe('/thread/1/p/2');
    expect(mapLegacyPath('/thread-1-2-关键词.htm')).toBe('/thread/1/p/2');
    expect(mapLegacyPath('/forum-3.htm')).toBe('/forum/3');
    expect(mapLegacyPath('/forum-3-2.htm')).toBe('/forum/3?page=2');
    expect(mapLegacyPath('/index.htm')).toBe('/');
    expect(mapLegacyPath('/index-2.htm')).toBe('/page/2');
    expect(mapLegacyPath('/user-5.htm')).toBe('/user/5');
    expect(mapLegacyPath('/user-5-1.htm')).toBe('/user/5');
  });
  it('未知页名/非法参数回落首页（杜绝开放重定向）', () => {
    expect(mapLegacyPath('/post-1.htm')).toBe('/');
    expect(mapLegacyPath('/https://evil.example/x.htm')).toBe('/');
    expect(mapLegacyPath('/thread-abc.htm')).toBe('/');
    expect(mapLegacyPath('/thread-.htm')).toBe('/');
  });
});

describe('robots 装配引擎（核心）', () => {
  it('order 排序 + 逐行去重', () => {
    const contribs: RobotsContribution[] = [
      { order: 20, lines: ['Sitemap: x', 'Disallow: /api/'] },
      { order: 10, lines: ['Disallow: /special/'] },
    ];
    const out = assembleRobots(['User-agent: *', 'Disallow: /api/'], contribs);
    // 核心基线在前，插件片段按 order 升序追加；重复行丢弃
    expect(out.split('\n')).toEqual([
      'User-agent: *',
      'Disallow: /api/',
      'Disallow: /special/',
      'Sitemap: x',
      '',
    ]);
  });

  it('核心基线规则保留（含 serach-* 历史拼写）', () => {
    expect(CORE_ROBOTS_BASE).toEqual(['User-agent: *', 'Disallow: /admin', 'Disallow: /user-*', 'Disallow: /serach-*']);
  });
});

describe('robots.txt 端点', () => {
  it('seo 出厂启用：基线 + /api + Sitemap（{SITE_URL} 请求期替换）', async () => {
    const { env } = envFor();
    const res = await app.request('/robots.txt', {}, env as never);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('Disallow: /serach-*');
    expect(text).toContain('Disallow: /api/');
    expect(text).toContain('Sitemap: http://localhost/sitemap.xml');
    expect(text).not.toContain('{SITE_URL}');
  });

  it('停用 seo：核心保底仍在（基线规则 + /api，无 Sitemap 行）', async () => {
    const { env } = envFor({ seo: { installed: 1, enable: 0 } });
    const res = await app.request('/robots.txt', {}, env as never);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain('Disallow: /admin');
    expect(text).toContain('Disallow: /api/');
    expect(text).not.toContain('Sitemap:');
  });
});

describe('sitemap.xml（契约 ③ registerRoute）', () => {
  it('启用：首页/可见版块/主题清单', async () => {
    const { env } = envFor();
    const res = await app.request('/sitemap.xml', { headers: HUMAN }, env as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    const xml = await res.text();
    expect(xml).toContain('<loc>http://localhost/</loc>');
    expect(xml).toContain('<loc>http://localhost/forum/1</loc>');
    expect(xml).toContain('<loc>http://localhost/thread/2</loc>');
    expect(xml).toContain('<lastmod>2023-11-14</lastmod>');
  });

  it('停用 seo 后 404（属插件职责，核心不代发 sitemap）', async () => {
    const { env } = envFor({ seo: { installed: 1, enable: 0 } });
    const res = await app.request('/sitemap.xml', { headers: HUMAN }, env as never);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(-4);
  });
});

describe('.htm 301 层（经插件路由分发）', () => {
  it('已知旧链接 301 到新路由', async () => {
    const { env } = envFor();
    const res = await app.request('/thread-1-2.htm', { headers: HUMAN }, env as never);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('http://localhost/thread/1/p/2');
  });
  it('未知页名 301 到站点根（不跟随任意输入）', async () => {
    const { env } = envFor();
    const res = await app.request('/whatever-9.htm', { headers: HUMAN }, env as never);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('http://localhost/');
  });
});

describe('爬虫预渲染分发（§16.1 核心管线）', () => {
  it('UA 分类：searchbot/aibot/human + 泛化兜底', () => {
    expect(classifyUserAgent(BOT['user-agent']!)).toBe('searchbot');
    expect(classifyUserAgent('Mozilla/5.0 (compatible; Baiduspider/2.0)')).toBe('searchbot');
    expect(classifyUserAgent('Mozilla/5.0 (compatible; some-generic-spider/1.0)')).toBe('searchbot');
    expect(classifyUserAgent('Mozilla/5.0 (compatible; GPTBot/1.0)')).toBe('aibot');
    expect(classifyUserAgent(HUMAN['user-agent']!)).toBe('human');
    expect(classifyUserAgent('')).toBe('human');
  });

  it('通配匹配：*.htm 命中页面路径，不命中其他后缀', () => {
    expect(matchRegisteredPath('*.htm', '/thread-1.htm')).toBe(true);
    expect(matchRegisteredPath('*.htm', '/thread-1.html')).toBe(false);
    expect(matchRegisteredPath('/sitemap.xml', '/sitemap.xml')).toBe(true);
  });

  it('searchbot GET /thread/2 → 兜底语义 HTML（title/canonical/h1 + seo 插件 JSON-LD/OG）', async () => {
    const { env } = envFor();
    const res = await app.request('/thread/2', { headers: BOT }, env as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<title>你好世界</title>');
    expect(html).toContain('<link rel="canonical" href="http://localhost/thread/2">');
    expect(html).toContain('<h1>你好世界</h1>');
    expect(html).toContain('DiscussionForumPosting'); // 契约 ⑤：seo 插件贡献 JSON-LD
    expect(html).toContain('og:title');
    expect(html).toContain('<p>首贴内容</p>');
  });

  it('R2 已有 seo/2.html 产物 → 直接吐出（生成侧写权在 T2-7）', async () => {
    const { env } = envFor(undefined, { 'seo/2.html': '<html>PRERENDERED</html>' });
    const res = await app.request('/thread/2', { headers: BOT }, env as never);
    expect(await res.text()).toBe('<html>PRERENDERED</html>');
  });

  it('停用 seo：核心保底仍有语义 HTML，但无 JSON-LD/OG 片段', async () => {
    const { env } = envFor({ seo: { installed: 1, enable: 0 } });
    const res = await app.request('/thread/2', { headers: BOT }, env as never);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('<title>你好世界</title>');
    expect(html).toContain('<html lang="zh-cn">');
    expect(html).not.toContain('application/ld+json');
    expect(html).not.toContain('og:title');
  });

  it('人类 UA 不被预渲染接管（合并部署下回 SPA 壳，交给 BrowserRouter）', async () => {
    const { env } = envFor();
    const res = await app.request('/thread/2', { headers: HUMAN }, env as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    // 壳页而非预渲染正文：不含 thread 的语义化标题
    expect(html).not.toContain('<h1>你好世界</h1>');
  });

  it('列表分页 page>1 兜底页带 noindex（§16.2 保底）', async () => {
    const { env } = envFor();
    const res = await app.request('/page/2', { headers: BOT }, env as never);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('noindex');
  });

  it('用户页 noindex + 论坛/首页语义列表', async () => {
    const { env } = envFor();
    const u = await app.request('/user/1', { headers: BOT }, env as never);
    expect(await u.text()).toContain('noindex,follow');
    const f = await app.request('/forum/1', { headers: BOT }, env as never);
    expect(await f.text()).toContain('<h1>默认版块</h1>');
    const i = await app.request('/', { headers: BOT }, env as never);
    expect(await i.text()).toContain('<title>FreeIDX</title>');
  });

  it('主题不存在 → 交回核心 404，不硬造页面', async () => {
    const fake = fakeD1Sql([{ test: /FROM bbs_thread WHERE tid = \?/, first: null }, ...rules()]);
    const env = { DB: fake.db, CACHE: fakeKv(), FILES: {}, ASSETS: fakeAssets(), SITE_URL: 'http://localhost' };
    const res = await app.request('/thread/999', { headers: BOT }, env as never);
    expect(res.status).toBe(404);
  });
});

describe('newPageMeta 默认值（核心保底字段）', () => {
  const setting = { sitename: 'S', brief: 'br', desc: 'd' } as SiteSetting;
  it('thread 用实体标题，缺失回落站名；user 页 noindex', () => {
    const t = newPageMeta('thread', 'http://x/thread/1', setting, { tid: 1, seoTitle: 'T' });
    expect(t.title).toBe('T');
    const t2 = newPageMeta('thread', 'http://x/thread/1', setting);
    expect(t2.title).toBe('S');
    expect(newPageMeta('user', 'http://x/user/1', setting, { uid: 1 }).noindex).toBe(true);
  });
});
