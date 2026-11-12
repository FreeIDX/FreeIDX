/**
 * Cache API 边缘响应缓存层（§7 读取屏障）测试：
 *  - 游客只读接口 HIT 后对 D1 零查询（runlevel 的 setting 查询一并省掉）
 *  - 个人化请求（登录轨 Cookie / Authorization）绕开，csrf Cookie 不影响参与资格
 *  - 只写入 200 且 Set-Cookie 仅限 csrf 的响应（缓存副本会剥掉该头，HIT 时按需补签）；
 *    抛错路径不落缓存
 *  - 缓存副本带 max-age，客户端响应不带（TTL 归边缘，不污染浏览器缓存）
 *  - UA 分类进键：爬虫 HTML 与人类响应互不串台（Cloudflare 缓存键不认 Vary）
 *  - 公共图片（附件预览）与二进制直链同口径：共享键、保留源头 max-age
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { l0Clear } from '../src/core/cache';
import { API_TTL } from '../src/core/cache/edge';
import { fakeAssets, fakeCaches, fakeD1Sql, fakeKv, fakeR2, type SqlRule } from './helpers/fake-d1';

const SETTING = JSON.stringify({
  runlevel: 5, sitename: 'FreeIDX', brief: 'b', url: 'http://localhost', kw: '', desc: '',
  user_create_on: 1, user_create_email_on: 0, user_resetpw_on: 1,
  forum_orderby: 0, update_views_on: 1, upload_max_size: 1048576, lang: 'zh-cn',
  favicon_url: '/files/site/favicon.png?v=1',
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
const THREAD = {
  tid: 2, fid: 1, top: 0, digest: 0, closed: 0, uid: 1, username: 'admin', avatar: 0,
  subject: '你好世界', posts: 1, views: 10, images: 0, files: 0,
  lastpid: 2, lastuid: 1, lastusername: 'admin', create_date: 1700000001, last_date: 1700000002,
};
const MEMBER_GROUP = { ...GUEST_GROUP, gid: 1, name: '会员组', allowthread: 1 };
const BOT = { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' };

function rules(): SqlRule[] {
  return [
    { test: /FROM bbs_kv/, first: (params: readonly unknown[]) => (params[0] === 'extensions' ? null : { v: SETTING }) },
    { test: /FROM bbs_session WHERE sid/, first: { uid: 1, last_date: Math.floor(Date.now() / 1000) } },
    { test: /FROM bbs_user WHERE uid/, first: { uid: 1, gid: 1, username: 'admin', token_version: 0 } },
    { test: /FROM bbs_group/, rows: [GUEST_GROUP, MEMBER_GROUP] },
    { test: /FROM bbs_forum ORDER BY/, rows: [FORUM_OPEN] },
    { test: /bbs_forum_access/, rows: [] },
    { test: /bbs_thread_top/, rows: [] },
    { test: /FROM bbs_thread WHERE fid IN/, rows: [THREAD] },
    { test: /FROM bbs_thread WHERE tid = \?/, first: (params: readonly unknown[]) => (Number(params[0]) === 9 ? null : { ...THREAD, ok: 1, firstpid: 1, mods: 0, userip: 0 }) },
    { test: /message_fmt FROM bbs_post/, first: { message_fmt: '<p>首贴内容</p>' } },
    { test: /FROM bbs_post WHERE tid = \?/, rows: [] },
    { test: /FROM bbs_thread ORDER BY last_date DESC LIMIT 50/, rows: [{ tid: 2, subject: '你好世界' }] },
    // sitemap.xml 的主题清单（全站最大的单条扫描：1000 行）
    { test: /FROM bbs_thread WHERE ok = 1 ORDER BY last_date DESC LIMIT 1000/, rows: [{ tid: 2, last_date: 1700000002 }] },
    // llms.txt 的精华主题清单
    { test: /FROM bbs_thread WHERE digest > 0/, rows: [{ tid: 2, subject: '你好世界' }] },
    /* 右栏用户榜（/api/rank/users）：公共只读，无 viewer 维度 */
    { test: /FROM bbs_user WHERE ok = 1 AND uid > 0 ORDER BY uid DESC/, rows: [{ uid: 1, username: 'admin', avatar: 0 }] },
    { test: /bbs_cache/, first: null },
  ];
}

function envFor() {
  const fake = fakeD1Sql(rules());
  return {
    env: {
      DB: fake.db,
      CACHE: fakeKv(),
      FILES: fakeR2(),
      ASSETS: fakeAssets(),
      SITE_URL: 'http://localhost',
    },
    calls: fake.calls,
  };
}

/** 用一条覆盖规则换掉 setting（其余规则沿用），供「站点级设置影响壳页注入」类断言使用 */
function envWithSetting(patch: Record<string, unknown>) {
  const base = { ...(JSON.parse(SETTING) as Record<string, unknown>), ...patch };
  const fake = fakeD1Sql([
    { test: /FROM bbs_kv/, first: (params: readonly unknown[]) => (params[0] === 'extensions' ? null : { v: JSON.stringify(base) }) },
    ...rules().filter((r) => !/FROM bbs_kv/.test(r.test.source)),
  ]);
  return {
    env: {
      DB: fake.db,
      CACHE: fakeKv(),
      FILES: fakeR2(),
      ASSETS: fakeAssets(),
      SITE_URL: 'http://localhost',
    },
    calls: fake.calls,
  };
}

/** 附件预览接口所需的数据面：公开件（credits=0）与受限期件（credits>0）共用 */
function attachEnv(credits = 0) {
  const fake = fakeD1Sql([
    ...rules(),
    {
      test: /FROM bbs_attach WHERE aid = \?/,
      first: {
        aid: 42, uid: 1, tid: 2, filename: 'attach/202410/x.png', orgfilename: 'x.png',
        filesize: 3, isimage: 1, status: 1, credits,
      },
    },
  ]);
  return {
    env: { DB: fake.db, CACHE: fakeKv(), FILES: fakeR2(), ASSETS: fakeAssets(), SITE_URL: 'http://localhost' },
    calls: fake.calls,
  };
}

let edge: ReturnType<typeof fakeCaches>;
beforeEach(() => {
  l0Clear();
  edge = fakeCaches();
  edge.install();
});
afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
});

/** 触发一次请求并等 waitUntil 旁路（缓存写）落定；默认按"已完成首访的游客"携带 csrf Cookie */
async function hit(path: string, headers: Record<string, string> = {}, source = envFor()) {
  const waited: Promise<unknown>[] = [];
  const res = await app.request(
    path,
    { headers: { cookie: 'csrf=token1', ...headers } },
    source.env as never,
    { waitUntil: (p: Promise<unknown>) => waited.push(p), passThroughOnException: () => {} } as never,
  );
  await Promise.all(waited);
  return { res, source };
}

describe('边缘缓存：游客只读接口', () => {
  it('首次 MISS 并回填，二次 HIT 且对 D1 零查询', async () => {
    const first = await hit('/api/threads');
    expect(first.res.headers.get('x-edge-cache')).toBe('MISS');
    const body1 = await first.res.json();
    expect(edge.entries.size).toBe(1);

    const second = await hit('/api/threads', {}, envFor());
    expect(second.res.headers.get('x-edge-cache')).toBe('HIT');
    expect(await second.res.json()).toEqual(body1);
    // HIT 由 caches 直接应答：runlevel 的 bbs_kv 查询、列表查询全不发生
    expect(second.source.calls.length).toBe(0);
  });

  it('缓存副本带 max-age，下发给客户端的响应不带（MISS 与 HIT 同口径）', async () => {
    await hit('/api/threads');
    const stored = Array.from(edge.entries.values())[0]!;
    expect(new Headers(stored.headers).get('cache-control')).toBe('public, max-age=60');
    expect(stored.headers.some(([k]) => k.toLowerCase() === 'x-edge-cache')).toBe(false);

    const fresh = await hit('/api/threads?fid=1', {}, envFor());
    expect(fresh.res.headers.get('cache-control')).toBeNull();

    // HIT 同样不得带 max-age：HTTP 缓存键不含 Cookie，游客在副本有效期内登录后重新拉
    // /api/bootstrap 会被浏览器喂回「游客版」→ 认证态串扰（登录成功但顶栏仍是游客）。
    const second = await hit('/api/threads', {}, envFor());
    expect(second.res.headers.get('x-edge-cache')).toBe('HIT');
    expect(second.res.headers.get('cache-control')).toBeNull();
  });

  it('查询串参与缓存键（分页/筛选各自成条目）', async () => {
    await hit('/api/threads?page=1');
    await hit('/api/threads?page=2');
    expect(edge.entries.size).toBe(2);
    expect(Array.from(edge.entries.keys()).every((k) => k.includes('fi-ua=human'))).toBe(true);
  });

  it('登录轨 Cookie（sid/at/admin_at）绕开缓存：既不读也不写', async () => {
    const { res, source } = await hit('/api/threads', { cookie: 'csrf=token1; sid=abcdef' });
    expect(res.headers.get('x-edge-cache')).toBeNull();
    expect(edge.entries.size).toBe(0);
    expect(((await res.json()) as { code: number }).code).toBe(0); // 登录链路完整走通，非错误信封
    expect(source.calls.length).toBeGreaterThan(0); // 走完整链路
  });

  it('Authorization 头绕开缓存', async () => {
    await hit('/api/threads', { authorization: 'Bearer x' });
    expect(edge.entries.size).toBe(0);
  });

  /* 右栏排行对登录用户放开边缘缓存（PUBLIC_READONLY）：响应体里没有任何按 uid/gid 定制的字段，
     放开后登录用户（含站长）刷新首页时右栏聚合接口不再每次冷穿透 Worker + D1。 */
  it('公共只读端点（排行）对登录轨也参与缓存；个人化端点仍绕开', async () => {
    const login = { cookie: 'csrf=token1; sid=abcdef; at=x' };
    const first = await hit('/api/rank/users?type=new&limit=16');
    expect(first.res.headers.get('x-edge-cache')).toBe('MISS');
    const body = await first.res.json();
    expect(edge.entries.size).toBe(1);

    const second = await hit('/api/rank/users?type=new&limit=16', login, envFor());
    expect(second.res.headers.get('x-edge-cache')).toBe('HIT');
    expect(second.source.calls.length).toBe(0); // 命中即零 D1 / 零 session 查询
    expect(await second.res.json()).toEqual(body);

    // 反向保证：同一登录轨访问按访问者定制的列表接口仍然完全不参与缓存
    const list = await hit('/api/threads', login);
    expect(list.res.headers.get('x-edge-cache')).toBeNull();
    expect(edge.entries.size).toBe(1);
  });

  it('首访（尚无 csrf Cookie）：MISS 也回填（副本剥掉 csrf 头），第二个人起直接 HIT 并补签', async () => {
    /* 首访请求本身仍会冷穿透（缓存里还没有东西），但这次 MISS 的产物必须落缓存：
       否则「每个新访客的第一屏接口都冷穿透」，低流量时段边缘命中率接近 0。 */
    const cold = await hit('/api/threads', { cookie: '_ga=1' });
    expect(cold.res.headers.get('x-edge-cache')).toBe('MISS');
    expect(cold.res.headers.get('set-cookie')).toContain('csrf='); // 下发给本次请求方的响应仍带签发

    expect(edge.entries.size).toBe(1);
    const stored = Array.from(edge.entries.values())[0]!;
    // 副本里不得残留 Set-Cookie：同一份副本会发给所有游客，csrftoken 必须由 HIT 分支现场补签
    expect(stored.headers.some(([k]) => k.toLowerCase() === 'set-cookie')).toBe(false);
    // 副本 max-age 归边缘 TTL（不污染浏览器缓存）

    const storedHeaders = new Headers(stored.headers);
    expect(storedHeaders.get('cache-control')).toBe('public, max-age=60');

    // 第二个首访（无 csrf Cookie）：HIT 且在响应上补签 csrf（与 csrf 中间件 GET 分支同口径），零 D1
    const firstVisit = await hit('/api/threads', { cookie: '_ga=1' }, envFor());
    expect(firstVisit.res.headers.get('x-edge-cache')).toBe('HIT');
    expect(firstVisit.res.headers.get('set-cookie')).toContain('csrf=');
    expect(firstVisit.source.calls.length).toBe(0);

    // 已持 csrf 的请求不重复签发
    const again = await hit('/api/threads', {}, envFor());
    expect(again.res.headers.get('x-edge-cache')).toBe('HIT');
    expect(again.res.headers.get('set-cookie')).toBeNull();
  });


  it('路由抛错（主题不存在）不落缓存', async () => {
    const { res } = await hit('/api/threads/9');
    expect(((await res.json()) as { code: number }).code).toBeLessThan(0);
    expect(res.headers.get('cache-control')).toBe('no-store'); // envelope 显式声明，写入门槛据此拒绝
    expect(res.headers.get('x-edge-cache')).toBeNull();
    expect(edge.entries.size).toBe(0);
  });

  it('非白名单接口（/api/me）不参与缓存', async () => {
    await hit('/api/me');
    expect(edge.entries.size).toBe(0);
  });

  /* 右栏/聚合类端点在 §7 扩容前完全没有边缘缓存：游客每次 PV 都真打 Worker + D1。
     下面的表驱动断言既守「别把已接入的端点改回去」，也守正则优先级（不能让
     /api/threads/hot-favorites 被 /api/threads/:tid 的规则吃掉）。 */
  it('右栏/聚合类只读接口均已纳入边缘缓存，且正则互不抢占', () => {
    const ttlOf = (path: string) => API_TTL.find(([re]) => re.test(path))?.[1];
    const required: Array<[string, number]> = [
      // 版块简介多语言：发现页按需拉（bootstrap 不再携带），站点结构低频变更
      ['/api/forums/briefs', 300],
      ['/api/online', 30],
      ['/api/posts/latest', 30],
      ['/api/rank/users', 600],
      ['/api/rank/threads', 3600],
      ['/api/rank/forum', 300],
      ['/api/rank/list', 300],
      ['/api/threads/hot-favorites', 300],
      ['/api/threads/7/hot-posts', 60],
      ['/api/insert-codes', 60],
      ['/api/quick-reply-message', 300],
      // 价格/通道后台可变且无全网络 purge：TTL 压到 30s，避免旧价展示与已停用通道
      ['/api/vip/plans', 30],
      ['/api/payment-providers', 30],
      ['/api/checkin', 30],
    ];
    for (const [path, ttl] of required) expect(ttlOf(path), `${path} 的边缘 TTL`).toBe(ttl);
    // 详情页与 hot-posts 是同级路径，细节规则不能互相覆盖
    expect(ttlOf('/api/threads/7')).toBe(120);
    // 付费/写侧接口必须仍在白名单外
    for (const path of ['/api/me', '/api/orders/abc', '/api/my/favorites', '/api/threads/7/paylist']) {
      expect(ttlOf(path), `${path} 不应参与边缘缓存`).toBeUndefined();
    }
  });

  it('配置类接口（/api/insert-codes）命中边缘后不再读 bbs_kv', async () => {
    const first = await hit('/api/insert-codes');
    expect(first.res.headers.get('x-edge-cache')).toBe('MISS');
    expect(first.source.calls.some((c) => /FROM bbs_kv/.test(c.sql))).toBe(true);
    expect(edge.entries.size).toBe(1);

    const second = await hit('/api/insert-codes', {}, envFor());
    expect(second.res.headers.get('x-edge-cache')).toBe('HIT');
    expect(second.source.calls.length).toBe(0);
    expect(await second.res.json()).toEqual(await first.res.json());
  });

  it('版块简介（发现页按需拉）命中边缘后不再查库', async () => {
    const first = await hit('/api/forums/briefs');
    expect(first.res.headers.get('x-edge-cache')).toBe('MISS');
    expect(edge.entries.size).toBe(1);

    const second = await hit('/api/forums/briefs', {}, envFor());
    expect(second.res.headers.get('x-edge-cache')).toBe('HIT');
    expect(second.source.calls.length).toBe(0);
  });

  it('无 Cache API 环境优雅降级（workers.dev / 本地预览）', async () => {
    delete (globalThis as { caches?: unknown }).caches;
    const { res, source } = await hit('/api/threads');
    expect(res.headers.get('x-edge-cache')).toBeNull();
    expect(((await res.json()) as { code: number }).code).toBe(0);
    expect(source.calls.length).toBeGreaterThan(0);
  });
});

describe('边缘缓存：公共图片（附件预览）', () => {
  it('公开件按二进制共享键缓存：保留源头 max-age，命中后不再读 R2/D1', async () => {
    const first = attachEnv();
    await first.env.FILES.put('attach/202410/x.png', 'IMG', { httpMetadata: { contentType: 'image/png' } });
    const a = await hit('/api/attachments/42/preview', {}, first as never);
    expect(a.res.headers.get('x-edge-cache')).toBe('MISS');
    expect(a.res.headers.get('cache-control')).toBe('public, max-age=86400');

    expect(edge.entries.size).toBe(1);
    const [key, stored] = Array.from(edge.entries.entries())[0]!;
    // 二进制与语言/UA 无关：不编 fi-lang，人类与爬虫共用一份
    expect(key).toContain('fi-ua=human');
    expect(key).not.toContain('fi-lang');
    // 副本保留源头 max-age（浏览器命中边缘后仍按 1 天缓存，不能退化成每次刷新都回源）
    expect(new Headers(stored.headers).get('cache-control')).toBe('public, max-age=86400');

    const second = await hit('/api/attachments/42/preview', { 'accept-language': 'en-US,en;q=0.9' }, attachEnv() as never);
    expect(second.res.headers.get('x-edge-cache')).toBe('HIT');
    expect(second.res.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(second.source.calls.length).toBe(0); // 不读 bbs_attach / bbs_thread / bbs_kv
    expect(await second.res.text()).toBe('IMG');
  });

  it('受限期件（付费未购）不落缓存：响应为 no-store 错误信封', async () => {
    const gated = attachEnv(10);
    const res = await hit('/api/attachments/42/preview', {}, gated as never);
    expect(res.res.headers.get('cache-control')).toBe('no-store');
    expect(res.res.headers.get('x-edge-cache')).toBeNull();
    expect(edge.entries.size).toBe(0);
  });
});

describe('边缘缓存：robots.txt / llms.txt（同值文档，AI 爬虫高频入口）', () => {
  it('robots.txt 首次落缓存，二次 HIT 不再走扩展装配', async () => {
    const first = await hit('/robots.txt');
    expect(first.res.status).toBe(200);
    expect(await first.res.text()).toContain('Disallow: /api/');
    expect(first.source.calls.some((c) => /FROM bbs_kv/.test(c.sql))).toBe(true);

    const second = await hit('/robots.txt', {}, envFor());
    expect(second.res.headers.get('x-edge-cache')).toBe('HIT');
    expect(second.source.calls.length).toBe(0);
  });

  it('llms.txt 首次落缓存，二次 HIT 不再查精华主题', async () => {
    const first = await hit('/llms.txt');
    expect(first.res.status).toBe(200);
    expect(await first.res.text()).toContain('# FreeIDX');
    expect(first.source.calls.some((c) => /FROM bbs_thread WHERE digest > 0/.test(c.sql))).toBe(true);

    const second = await hit('/llms.txt', {}, envFor());
    expect(second.res.headers.get('x-edge-cache')).toBe('HIT');
    expect(second.source.calls.some((c) => /FROM bbs_thread WHERE digest > 0/.test(c.sql))).toBe(false);
  });

  it('带登录轨 Cookie（站长自查）跳过读缓存，保证配置变更当场可见', async () => {
    await hit('/robots.txt');
    const admin = await hit('/robots.txt', { cookie: 'csrf=token1; admin_at=tok' }, envFor());
    expect(admin.res.headers.get('x-edge-cache')).toBeNull();
    expect(admin.res.status).toBe(200);
  });
});

describe('边缘缓存：sitemap.xml', () => {
  it('首次落缓存（含 1000 行主题扫描），二次 HIT 不再触发扫描与版块读穿', async () => {
    const first = await hit('/sitemap.xml');
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get('content-type')).toContain('application/xml');
    const xml = await first.res.text();
    expect(xml).toContain('<loc>http://localhost/</loc>');
    expect(xml).toContain('<loc>http://localhost/thread/2</loc>');
    expect(first.source.calls.some((c) => /FROM bbs_thread WHERE ok = 1/.test(c.sql))).toBe(true);

    // 缓存副本与响应头口径一致：application/xml（非默认 HTML）+ max-age=3600
    expect(edge.entries.size).toBe(1);
    const stored = Array.from(edge.entries.values())[0]!;
    const storedHeaders = new Headers(stored.headers);
    expect(storedHeaders.get('content-type')).toContain('application/xml');
    expect(storedHeaders.get('cache-control')).toBe('public, max-age=3600');

    const second = await hit('/sitemap.xml', {}, envFor());
    expect(second.res.headers.get('x-edge-cache')).toBe('HIT');
    expect(await second.res.text()).toContain('<loc>http://localhost/thread/2</loc>');
    // 命中即出：全站最大的那条扫描 + forumlist/grouplist 读穿都不再发生
    expect(second.source.calls.some((c) => /FROM bbs_thread WHERE ok = 1/.test(c.sql))).toBe(false);
    expect(second.source.calls.some((c) => /FROM bbs_forum ORDER BY/.test(c.sql))).toBe(false);
  });

  it('人类与爬虫共用同一份（全站同值文档，键不按 UA 区分）', async () => {
    await hit('/sitemap.xml');
    const bot = await hit('/sitemap.xml', BOT, envFor());
    expect(bot.res.headers.get('x-edge-cache')).toBe('HIT');
    expect(edge.entries.size).toBe(1);
  });
});

describe('边缘缓存：爬虫预渲染前置', () => {
  it('爬虫 HTML 首次 MISS 落缓存，二次 HIT 不再查库', async () => {
    const first = await hit('/thread/2', BOT);
    expect(await first.res.text()).toContain('你好世界');
    expect(first.source.calls.some((c) => /FROM bbs_thread/.test(c.sql))).toBe(true);
    expect(edge.entries.size).toBe(1);

    const second = await hit('/thread/2', BOT, envFor());
    expect(await second.res.text()).toContain('你好世界');
    expect(second.source.calls.some((c) => /FROM bbs_thread/.test(c.sql))).toBe(false);
  });

  it('人类请求不吃爬虫条目（UA 分类进键）', async () => {
    await hit('/thread/2', BOT);
    const human = await hit('/thread/2', { 'user-agent': 'Mozilla/5.0 Chrome/120' }, envFor());
    const html = await human.res.text();
    expect(html).toContain('id="root"'); // SPA 壳，而非爬虫 HTML
    expect(Array.from(edge.entries.keys()).filter((k) => k.includes('fi-ua=human'))).toHaveLength(0);
  });
});

describe('边缘缓存：SPA 壳 HTML（人类页面导航）', () => {
  /** 计数的 ASSETS 替身：HIT 后不应再出现「取 index.html」这一次子请求 */
  function countingEnv() {
    const base = envFor();
    const assets = fakeAssets();
    let shellFetches = 0;
    return {
      env: {
        ...base.env,
        ASSETS: {
          fetch: async (req: Request) => {
            if (new URL(req.url).pathname === '/index.html') shellFetches++;
            return assets.fetch(req);
          },
        },
      },
      calls: base.calls,
      count: () => shellFetches,
    };
  }

  it('首次 MISS 落边缘；二次 HIT 不再取 index.html 壳', async () => {
    const s = countingEnv();
    const first = await hit('/', {}, s as never);
    expect(first.res.headers.get('x-edge-cache')).toBe('MISS');
    expect(await first.res.text()).toContain('id="root"');
    expect(s.count()).toBe(1);

    const second = await hit('/', {}, s as never);
    expect(second.res.headers.get('x-edge-cache')).toBe('HIT');
    expect(s.count()).toBe(1);
  });

  it('任意深链共用同一条副本（键与请求路径无关）', async () => {
    const s = countingEnv();
    await hit('/', {}, s as never);
    const deep = await hit('/thread/2', {}, s as never);
    expect(deep.res.headers.get('x-edge-cache')).toBe('HIT');
    expect(s.count()).toBe(1);
    // 全站只占一条壳条目（键是固定 URL，不随深链摊薄）
    expect(Array.from(edge.entries.keys()).filter((k) => k.endsWith('/__fi/spa-shell'))).toHaveLength(1);
  });

  it('浏览器短缓存：HIT 与 MISS 同口径（max-age=120，对齐 SHELL_TTL 陈旧窗口）', async () => {
    const s = countingEnv();
    const first = await hit('/', {}, s as never);
    expect(first.res.headers.get('x-edge-cache')).toBe('MISS');
    expect(first.res.headers.get('cache-control')).toBe('public, max-age=120');
    const second = await hit('/', {}, s as never);
    expect(second.res.headers.get('x-edge-cache')).toBe('HIT');
    expect(second.res.headers.get('cache-control')).toBe('public, max-age=120');
  });

  it('站长轨（admin_at）跳过读缓存：改完设置/切完主题当场可见', async () => {
    const s = countingEnv();
    await hit('/', {}, s as never);
    const admin = await hit('/', { cookie: 'csrf=token1; admin_at=tok' }, s as never);
    expect(admin.res.headers.get('x-edge-cache')).not.toBe('HIT');
    expect(s.count()).toBe(2);
  });

  it('爬虫不写壳条目（正文 HTML 由 prerender 自己的条目负责）', async () => {
    const s = countingEnv();
    await hit('/thread/2', BOT, s as never);
    expect(Array.from(edge.entries.keys()).filter((k) => k.endsWith('/__fi/spa-shell'))).toHaveLength(0);
  });

  it('带扩展名的路径不参与壳缓存（/robots.txt 走自己的条目）', async () => {
    const s = countingEnv();
    await hit('/', {}, s as never);
    const res = await hit('/robots.txt', {}, s as never);
    expect(res.res.headers.get('x-edge-cache')).not.toBe('HIT');
  });

  it('壳页注入首屏预载：bootstrap 的 fetch 预载 + 站点语言的词条包 modulepreload', async () => {
    const base = envFor();
    const s = {
      env: {
        ...base.env,
        ASSETS: fakeAssets({
          '/assets/preload-map.json': JSON.stringify({ i18n: { 'zh-cn': 'assets/i18n-bbs-zh-cn-AAA.js' } }),
        }),
      },
      calls: base.calls,
    };
    const html = await (await hit('/', {}, s as never)).res.text();
    expect(html).toContain('as="fetch" href="/api/bootstrap" crossorigin="use-credentials"');
    expect(html).toContain('rel="modulepreload" crossorigin href="/assets/i18n-bbs-zh-cn-AAA.js"');
  });

  it('壳页注入站点 favicon link（后台已配置时）：浏览器不再盲请求 /favicon.ico', async () => {
    const html = await (await hit('/', {}, envFor() as never)).res.text();
    expect(html).toContain('<link rel="icon" href="/files/site/favicon.png?v=1">');
  });

  it('favicon 多尺寸：标签页只取 32×32，另派生 192 与 apple-touch-icon（同一版本号）', async () => {
    const env = envWithSetting({ favicon_url: '/files/site/favicon-32.png?v=99' });
    const html = await (await hit('/', {}, env as never)).res.text();
    expect(html).toContain('<link rel="icon" type="image/png" sizes="32x32" href="/files/site/favicon-32.png?v=99">');
    expect(html).toContain('<link rel="icon" type="image/png" sizes="192x192" href="/files/site/favicon-192.png?v=99">');
    expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/files/site/favicon-180.png?v=99">');
    // 原图直链不得再作为标签页图标下发（线上曾出现 830KB favicon）
    expect(html).not.toContain('<link rel="icon" href="/files/site/favicon-32.png');
  });

  it('预载清单缺失（本地 dev / 旧产物）：壳页仍带 bootstrap 预载，功能不受影响', async () => {
    const s = countingEnv(); // fakeAssets() 不含 preload-map.json → 404
    const html = await (await hit('/', {}, s as never)).res.text();
    expect(html).toContain('as="fetch" href="/api/bootstrap"');
    expect(html).not.toContain('modulepreload" crossorigin href="/assets/i18n-bbs');
  });
});
