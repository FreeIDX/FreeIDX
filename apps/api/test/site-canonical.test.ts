/**
 * 多域名部署：主域名解析（core/site）与页面导航 301 收敛（middleware/canonical-host）。
 * 决策：多域名 301 到主域名；主域名以后台「站点网址」优先、SITE_URL 兜底；登录态 host-only 不共享。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { SiteSetting } from '@freeidx/shared';
import { canonicalHostRedirect } from '../src/middleware/canonical-host';
import { D1b } from '../src/core/db';
import { Cache, l0Clear } from '../src/core/cache';
import { canonicalBase, canonicalBaseFromSetting, normalizeSiteUrl } from '../src/core/site';
import type { Env } from '../src/types/env';
import { fakeD1, fakeD1Sql, fakeKv } from './helpers/fake-d1';

type TestEnv = { Bindings: Env; Variables: { db: D1b; cache: Cache; runlevel: number } };

/** 最小应用：注入 db/cache → 收敛中间件 → 兜底 200（便于断言「没跳」） */
function makeApp() {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.set('db', new D1b(c.env.DB));
    c.set('cache', new Cache(c.env, c.get('db')));
    await next();
  });
  app.use('*', canonicalHostRedirect());
  app.all('*', (c) => c.text('ok'));
  return app;
}

function envWith(siteUrl = '', db: unknown = fakeD1().db) {
  return { DB: db, CACHE: fakeKv(), FILES: {}, ASSETS: {}, SITE_URL: siteUrl } as never;
}

/** 只用于断言 url 优先级的最小 setting（其余字段与本主题无关） */
const settingWith = (url: string): SiteSetting => ({ url }) as SiteSetting;
const DOC = { 'sec-fetch-dest': 'document' };

describe('core/site：地址解析', () => {
  it('normalizeSiteUrl 只保留 origin（丢弃路径/查询/尾斜杠），非法值返回空', () => {
    expect(normalizeSiteUrl('https://www.example.com/')).toBe('https://www.example.com');
    expect(normalizeSiteUrl('https://www.example.com/a?b=1')).toBe('https://www.example.com');
    expect(normalizeSiteUrl('  https://www.example.com  ')).toBe('https://www.example.com');
    expect(normalizeSiteUrl('')).toBe('');
    expect(normalizeSiteUrl('www.example.com')).toBe('');
    expect(normalizeSiteUrl('ftp://example.com')).toBe('');
  });

  it('主域名优先级：后台站点网址 > SITE_URL > 当前请求域', () => {
    const req = { req: { url: 'https://alt.example.com/thread/1' }, env: { SITE_URL: 'https://env.example.com' } };
    expect(canonicalBase(req, settingWith('https://admin.example.com'))).toBe('https://admin.example.com');
    expect(canonicalBase(req, null)).toBe('https://env.example.com');
    expect(canonicalBase({ req: req.req }, null)).toBe('https://alt.example.com');
  });

  it('无请求上下文（cron）：后台站点网址 > SITE_URL，都未配置返回空（调用方据此跳过推送）', () => {
    expect(canonicalBaseFromSetting(settingWith('https://admin.example.com'), { SITE_URL: 'https://env.example.com' })).toBe(
      'https://admin.example.com',
    );
    expect(canonicalBaseFromSetting(settingWith(''), { SITE_URL: 'https://env.example.com/' })).toBe('https://env.example.com');
    expect(canonicalBaseFromSetting(settingWith(''), { SITE_URL: '' })).toBe('');
  });
});

describe('多域名 301 收敛', () => {
  const app = makeApp();
  // L0 是 isolate 级共享缓存：逐用例清掉，避免前序 setting 影响主域名判定
  beforeEach(() => l0Clear());

  it('备用域页面导航 → 301 到主域名（保留路径与查询）', async () => {
    const res = await app.request('https://alt.example.com/thread/1?page=2', { headers: DOC }, envWith('https://www.example.com'));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://www.example.com/thread/1?page=2');
  });

  it('后台「站点网址」优先于 SITE_URL', async () => {
    const db = fakeD1Sql([
      { test: /FROM bbs_kv WHERE k = \?/, first: { v: JSON.stringify({ url: 'https://admin.example.com' }) } },
    ]).db;
    const res = await app.request('https://alt.example.com/', { headers: DOC }, envWith('https://env.example.com', db));
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe('https://admin.example.com/');
  });

  it('主域名不跳；http 访问主域名升级到 https', async () => {
    const canonical = await app.request('https://www.example.com/', { headers: DOC }, envWith('https://www.example.com'));
    expect(canonical.status).toBe(200);
    const insecure = await app.request('http://www.example.com/x', { headers: DOC }, envWith('https://www.example.com'));
    expect(insecure.status).toBe(301);
    expect(insecure.headers.get('location')).toBe('https://www.example.com/x');
  });

  it('非页面导航不跳：API / 静态文件 / 无 Sec-Fetch-Dest 且 Accept 非 html', async () => {
    for (const path of ['/api/bootstrap', '/assets/index.js', '/sitemap.xml', '/robots.txt', '/verify.txt', '/thread/1.htm']) {
      const res = await app.request(`https://alt.example.com${path}`, { headers: DOC }, envWith('https://www.example.com'));
      expect(res.status, path).toBe(200);
    }
    const plain = await app.request('https://alt.example.com/thread/1', { headers: { accept: 'application/json' } }, envWith('https://www.example.com'));
    expect(plain.status).toBe(200);
  });

  it('写请求永不跳（POST 落到备用域也只按原接口处理）', async () => {
    const res = await app.request(
      'https://alt.example.com/api/auth/login',
      { method: 'POST', headers: DOC },
      envWith('https://www.example.com'),
    );
    expect(res.status).toBe(200);
  });

  it('本地与 workers.dev 预览域不跳（避免开发/预览被带到线上）', async () => {
    for (const origin of ['http://localhost:8787', 'https://freeidx-api.xx.workers.dev']) {
      const res = await app.request(`${origin}/`, { headers: DOC }, envWith('https://www.example.com'));
      expect(res.status, origin).toBe(200);
    }
  });
});
