/**
 * geo 插件（T4-5）：AI 爬虫 robots 分条（默认允许、config 可关）+ llms.txt（registerRoute）；
 * seo/geo 各自独立启停互不影响（§14 DoD）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { buildRuntime } from '../src/core/extensions/registry';
import { geoPlugin, aiCrawlerRobots } from '../src/extensions/geo';
import { POLICY_CRAWLERS, classifyUserAgent, matchPolicyCrawler } from '../src/core/crawler';
import { l0Clear } from '../src/core/cache';
import { fakeAssets, fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';

const SETTING = JSON.stringify({
  runlevel: 5, sitename: 'FreeIDX', brief: 'b', desc: '', url: 'http://localhost',
});
const GUEST_GROUP = {
  gid: 0, name: '游客组', creditsfrom: 0, creditsto: 0, allowread: 1, allowthread: 0, allowpost: 1,
  allowattach: 0, allowdown: 1, allowtop: 0, allowupdate: 0, allowdelete: 0, allowmove: 0, allowbanuser: 0, allowdeleteuser: 0, allowviewip: 0,
};
const FORUM_OPEN = { fid: 1, name: '默认版块', rank: 1, threads: 2, todayposts: 0, todaythreads: 0, brief: '介绍', announcement: '', accesson: 0, orderby: 0, icon: 0, moduids: '', seo_title: '', seo_keywords: '' };

function kvFor(opts: { state?: Record<string, unknown>; geo?: Record<string, unknown>; seo?: Record<string, unknown> }): Record<string, { v: string }> {
  return {
    'extensions': opts.state ? { v: JSON.stringify(opts.state) } : ({ v: '' } as never),
    setting: { v: SETTING },
    'ext:geo:config': opts.geo ? { v: JSON.stringify(opts.geo) } : { v: '' },
    'ext:seo:config': opts.seo ? { v: JSON.stringify(opts.seo) } : { v: '' },
  };
}

function envFor(kv: Record<string, { v: string }>) {
  const rules: SqlRule[] = [
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: (p: readonly unknown[]) => { const r = kv[String(p[0])]; return r && r.v ? r : null; } },
    { test: /REPLACE INTO bbs_kv/, rows: [] },
    { test: /FROM bbs_group/, rows: [GUEST_GROUP] },
    { test: /FROM bbs_forum ORDER BY/, rows: [FORUM_OPEN] },
    { test: /bbs_forum_access/, rows: [] },
    { test: /digest > 0/, rows: [{ tid: 7, subject: '精华帖' }] },
    { test: /FROM bbs_thread ORDER BY last_date DESC LIMIT 1000/, rows: [] },
    { test: /FROM bbs_thread ORDER BY last_date DESC LIMIT 50/, rows: [] },
    // 索引页预渲染（「Bytespider 默认仍给正文」用例）：真实 SQL 带 WHERE ok = 1，
    // 上面两条泛化规则都不含该子句故从不匹配，这里补一条精确的
    { test: /FROM bbs_thread WHERE ok = 1 ORDER BY last_date DESC LIMIT 50/, rows: [] },
    { test: /bbs_cache/, first: null },
  ];
  const { db } = fakeD1Sql(rules);
  return { env: { DB: db, CACHE: fakeKv(), FILES: {}, ASSETS: fakeAssets(), SITE_URL: 'http://localhost' } };
}

beforeEach(() => l0Clear());

describe('aiCrawlerRobots（§16.3 默认允许，config 可关）', () => {
  it(`默认全部 Allow，覆盖策略名单全部 ${POLICY_CRAWLERS.length} 个爬虫`, () => {
    const lines = aiCrawlerRobots({});
    expect(lines).toContain('User-agent: GPTBot');
    expect(lines).toContain('User-agent: Bytespider');
    // 名字统一后：名单的每个成员都必须有 robots 行（识别范围 = 开关范围）
    for (const { label } of POLICY_CRAWLERS) expect(lines).toContain(`User-agent: ${label}`);
    expect(lines.filter((l) => l === 'Allow: /')).toHaveLength(POLICY_CRAWLERS.length);
    expect(lines).not.toContain('Disallow: /');
  });
  it('按 bot 关闭：仅该 bot Disallow', () => {
    const lines = aiCrawlerRobots({ GPTBot: 'deny', ClaudeBot: 'allow' });
    expect(lines.slice(0, 2)).toEqual(['User-agent: GPTBot', 'Disallow: /']);
    expect(lines.slice(2, 4)).toEqual(['User-agent: ClaudeBot', 'Allow: /']);
  });
  it('Amazon 行使用真实可识别的 Amazonbot，旧空 token AWS2Bot 不再输出', () => {
    const lines = aiCrawlerRobots({});
    // Amazon 官方只公布 Amazonbot / Amzn-SearchBot / Amzn-User，无 aws2bot —— 旧行谁都不认
    expect(lines).toContain('User-agent: Amazonbot');
    expect(lines).not.toContain('User-agent: AWS2Bot');
  });
  it('存量旧键 AWS2Bot:deny 仍生效（legacyLabels 回读）', () => {
    const lines = aiCrawlerRobots({ AWS2Bot: 'deny' });
    expect(lines).toContain('User-agent: Amazonbot');
    expect(lines[lines.indexOf('User-agent: Amazonbot') + 1]).toBe('Disallow: /');
  });
  it('Google-Extended 是 robots 专用 token，不作为 UA 命中（无请求可拦）', () => {
    expect(matchPolicyCrawler('Google-Extended')).toBeNull();
    expect(matchPolicyCrawler('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBeNull();
  });
  it('名单内每个 token 都能被匹配到，且分类永不为 human（否则闸门没机会执行、开关静默失效）', () => {
    for (const entry of POLICY_CRAWLERS) {
      for (const t of entry.tokens) {
        const ua = `Mozilla/5.0 (compatible; ${t}/1.0)`;
        expect(matchPolicyCrawler(ua)?.label, entry.label).toBe(entry.label);
        // Amzn-User / Claude-User / Perplexity-User 这类 UA 不含 bot/spider 字样，必须靠名单救济
        expect(classifyUserAgent(ua), entry.label).not.toBe('human');
      }
    }
  });
});

describe('geo 开关的执行侧（§16.4：关掉的爬虫真拒绝，不再供给正文）', () => {
  // Bytespider 出厂由泛化兜底判为 searchbot（给正文）；关掉开关后必须变成 403
  const BYTESPIDER = { 'user-agent': 'Mozilla/5.0 (compatible; Bytespider/1.0)' };
  it('未配置：Bytespider 仍按搜索爬虫供给预渲染正文', async () => {
    const { env } = envFor(kvFor({}));
    const res = await app.request('/', { headers: BYTESPIDER }, env as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<h1>');
  });
  it('关掉 Bytespider：页面请求 403，预渲染正文不再供给', async () => {
    const { env } = envFor(kvFor({ geo: { aiBots: { Bytespider: 'deny' } } }));
    const res = await app.request('/', { headers: BYTESPIDER }, env as never);
    expect(res.status).toBe(403);
  });
  it('关掉纯 AI 爬虫 GPTBot：同样 403，而非 200 空壳', async () => {
    const { env } = envFor(kvFor({ geo: { aiBots: { GPTBot: 'deny' } } }));
    const res = await app.request('/', { headers: { 'user-agent': 'GPTBot/1.0' } }, env as never);
    expect(res.status).toBe(403);
  });
  // Amazonbot 官方 UA：.../compatible; Amazonbot/0.1...
  const AMAZONBOT = { 'user-agent': 'Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)' };
  it('未配置：Amazonbot 维持出厂行为，仍按搜索爬虫供给正文', async () => {
    const { env } = envFor(kvFor({}));
    const res = await app.request('/', { headers: AMAZONBOT }, env as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<h1>');
  });
  it('关掉 Amazonbot：403（更名后开关真能拦住真实 UA，改前是空开关）', async () => {
    const { env } = envFor(kvFor({ geo: { aiBots: { Amazonbot: 'deny' } } }));
    const res = await app.request('/', { headers: AMAZONBOT }, env as never);
    expect(res.status).toBe(403);
  });
  it('关掉旧键 AWS2Bot：同样 403（存量配置不失联）', async () => {
    const { env } = envFor(kvFor({ geo: { aiBots: { AWS2Bot: 'deny' } } }));
    const res = await app.request('/', { headers: AMAZONBOT }, env as never);
    expect(res.status).toBe(403);
  });
  it('未配置：GPTBot 维持 ai 分类 → 不给正文，回落 SPA 壳', async () => {
    const { env } = envFor(kvFor({}));
    const res = await app.request('/', { headers: { 'user-agent': 'GPTBot/1.0' } }, env as never);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('<h1>');
  });
  // 用户触发型/检索型（UA 多不含 bot 字样）：改判后默认给正文，且开关能真拦住它们
  const BODY_READERS = [
    'Mozilla/5.0 (compatible; ChatGPT-User/1.0)',
    'Mozilla/5.0 (compatible; Claude-User/1.0)',
    'Mozilla/5.0 (compatible; Perplexity-User/1.0)',
    'Mozilla/5.0 (compatible; OAI-SearchBot/1.0)',
    'Mozilla/5.0 (compatible; Amzn-User/1.0)',
    'Mozilla/5.0 (compatible; Amzn-SearchBot/1.0)',
  ];
  it('未配置：用户触发型/检索型均供给预渲染正文', async () => {
    for (const ua of BODY_READERS) {
      const { env } = envFor(kvFor({}));
      const res = await app.request('/', { headers: { 'user-agent': ua } }, env as never);
      expect(res.status, ua).toBe(200);
      expect(await res.text(), ua).toContain('<h1>');
    }
  });
  it('关掉其中任一个：403（含不含 bot 字样的 UA，靠名单而非泛化兜底）', async () => {
    for (const label of ['ChatGPT-User', 'Claude-User', 'Perplexity-User', 'OAI-SearchBot', 'Amzn-User', 'Amzn-SearchBot']) {
      // 每轮配置不同，而 ext 配置按 isolate 级 L0 缓存 → 轮间必须清，否则读到上一轮的 deny
      l0Clear();
      const { env } = envFor(kvFor({ geo: { aiBots: { [label]: 'deny' } } }));
      const res = await app.request('/', { headers: { 'user-agent': `Mozilla/5.0 (compatible; ${label}/1.0)` } }, env as never);
      expect(res.status, label).toBe(403);
    }
  });
});

describe('开关说明与实际效力一致（防文案漂移）', () => {
  const switches = (geoPlugin.schema?.fields ?? []).filter((f) => f.type === 'switch');
  const helpOf = (key: string): string => JSON.stringify(switches.find((f) => f.key === key)?.help ?? '');
  it('会走闸门的条目在说明里写明 403', () => {
    for (const entry of POLICY_CRAWLERS.filter((c) => !c.robotsOnly)) {
      expect(helpOf(entry.label), entry.label).toContain('403');
    }
  });
  it('robotsOnly 条目（Google-Extended）说明里没有 403，并讲明只写声明', () => {
    expect(helpOf('Google-Extended')).not.toContain('403');
    expect(helpOf('Google-Extended')).toContain('robots.txt');
  });
  it('出厂给正文的条目（Bytespider/Amazonbot）在说明里点明默认给正文', () => {
    for (const entry of POLICY_CRAWLERS.filter((c) => c.prerender)) {
      expect(helpOf(entry.label), entry.label).toContain('检索类');
    }
  });
});

describe('geo robots 贡献（config 同步预载即时生效）', () => {
  function robotsOf(geoCfg: Record<string, unknown>): string[] {
    const rt = buildRuntime([geoPlugin], { geo: { installed: 1, enable: 1 } }, undefined, { geo: geoCfg });
    return rt.robots.flatMap((c) => c.lines);
  }
  it('无 config：默认放行', () => expect(robotsOf({})[0]).toBe('User-agent: GPTBot'));
  it('停用 geo：无 AI 片段（回落核心默认）', () => {
    const rt = buildRuntime([geoPlugin], { geo: { installed: 1, enable: 0 } }, undefined, {});
    expect(rt.robots).toHaveLength(0);
    expect(rt.routes).toHaveLength(0);
  });
});

describe('/robots.txt 端点（geo 片段并入核心装配）', () => {
  it('默认：含 GPTBot Allow 行', async () => {
    const { env } = envFor(kvFor({}));
    const text = await (await app.request('/robots.txt', {}, env as never)).text();
    expect(text).toContain('User-agent: GPTBot');
    expect(text).toContain('User-agent: PerplexityBot');
  });
  it('config 关闭某 bot：该行变 Disallow', async () => {
    const { env } = envFor(kvFor({ geo: { aiBots: { GPTBot: 'deny' } } }));
    const text = await (await app.request('/robots.txt', {}, env as never)).text();
    expect(text).toContain('User-agent: GPTBot\nDisallow: /');
    expect(text).toContain('User-agent: ClaudeBot\nAllow: /');
  });
});

describe('/llms.txt（registerRoute）', () => {
  it('输出站名/版块目录/精华入口/内容许可', async () => {
    const { env } = envFor(kvFor({ geo: { contentLicense: 'CC BY 4.0' } }));
    const res = await app.request('/llms.txt', { headers: { 'user-agent': 'Mozilla/5.0' } }, env as never);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('# FreeIDX');
    expect(text).toContain('- [默认版块](http://localhost/forum/1)');
    expect(text).toContain('- [精华帖](http://localhost/thread/7)');
    expect(text).toContain('CC BY 4.0');
  });
});

describe('seo/geo 独立启停互不影响（§14 DoD）', () => {
  it('停用 geo：llms.txt 404、robots 无 AI 行，但 sitemap 仍在（seo 不受影响）', async () => {
    const { env } = envFor(kvFor({ state: { geo: { installed: 1, enable: 0 } } }));
    const robots = await (await app.request('/robots.txt', {}, env as never)).text();
    expect(robots).not.toContain('GPTBot');
    expect(robots).toContain('Sitemap:');
    const llms = await app.request('/llms.txt', {}, env as never);
    expect(((await llms.json()) as { code: number }).code).toBe(Code.NOT_FOUND);
    const sm = await app.request('/sitemap.xml', {}, env as never);
    expect(sm.status).toBe(200);
  });
  it('停用 seo：sitemap 404，但 llms.txt 200 + robots AI 行仍在（geo 不受影响）', async () => {
    const { env } = envFor(kvFor({ state: { seo: { installed: 1, enable: 0 } } }));
    const sm = await app.request('/sitemap.xml', {}, env as never);
    expect(((await sm.json()) as { code: number }).code).toBe(Code.NOT_FOUND);
    const llms = await app.request('/llms.txt', {}, env as never);
    expect(llms.status).toBe(200);
    const robots = await (await app.request('/robots.txt', {}, env as never)).text();
    expect(robots).toContain('GPTBot');
    expect(robots).not.toContain('Sitemap:');
  });
});
