/**
 * ads 插件（T3-9）：bootstrap:contribute 注入广告位（runlevel 短路 / 未配置 client 隐 adsense）；
 * ads.txt 路由；§17.4 爬虫预渲染不注入 AdSense（ads 从不贡献 render:head）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRuntime } from '../src/core/extensions/registry';
import { adsPlugin } from '../src/extensions/ads';
import { Cache, l0Clear } from '../src/core/cache';
import { D1b } from '../src/core/db';
import { encryptSecret } from '../src/core/crypto';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';

const MASTER = btoa(String.fromCharCode(7).repeat(32));

const SLOT_ROWS = [
  { id: 1, position: 'header', type: 'html', config: '{"html":"<b>ad</b>"}', sort: 10 },
  { id: 2, position: 'thread_bottom', type: 'adsense', config: '{"slot":"12345"}', sort: 5 },
];

async function kvMap(opts: { runlevel?: number; config?: Record<string, unknown>; secret?: Record<string, unknown> }) {
  const map: Record<string, { v: string }> = {
    setting: { v: JSON.stringify({ runlevel: opts.runlevel ?? 5 }) },
    'ext:ads:config': { v: JSON.stringify(opts.config ?? { placeholder: { header: 90 } }) },
  };
  if (opts.secret) map['ext:ads:secret'] = { v: await encryptSecret(JSON.stringify(opts.secret), MASTER) };
  return map;
}

function runtimeWith(map: Record<string, { v: string }>, enable: 0 | 1, env: { SECRETS_MASTER_KEY?: string }) {
  const rules: SqlRule[] = [
    { test: /SELECT v FROM bbs_kv/, first: (p: readonly unknown[]) => map[String(p[0])] ?? null },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /FROM bbs_ad_slot/, rows: SLOT_ROWS },
  ];
  const { db } = fakeD1Sql(rules);
  const d1 = new D1b(db as never);
  const cache = new Cache({ DB: db, CACHE: fakeKv(), SITE_URL: '' } as never, d1);
  const rt = buildRuntime([adsPlugin], { ads: { installed: 1, enable } }, { db: d1, cache, env: env as never });
  return { rt, d1 };
}

beforeEach(() => l0Clear());

describe('ads bootstrap:contribute（T3-9）', () => {
  it('启用 + 已配置 client：注入 ads 字段，adsense 位保留', async () => {
    const { rt } = runtimeWith(await kvMap({ secret: { client: 'ca-pub-9', publisherId: 'pub-9' } }), 1, { SECRETS_MASTER_KEY: MASTER });
    const ext: Record<string, unknown> = {};
    await rt.bus.emit('bootstrap:contribute', { payload: ext });
    const ads = ext['ads'] as { client: string; slots: { type: string }[]; placeholder: Record<string, number> };
    expect(ads.client).toBe('ca-pub-9');
    expect(ads.slots.map((s) => s.type)).toEqual(['html', 'adsense']);
    expect(ads.placeholder).toEqual({ header: 90 });
  });

  it('未配置 client：自动隐藏全部 adsense 位（§17.3）', async () => {
    const { rt } = runtimeWith(await kvMap({}), 1, {}); // 无 master → secret={}
    const ext: Record<string, unknown> = {};
    await rt.bus.emit('bootstrap:contribute', { payload: ext });
    const ads = ext['ads'] as { client: string | null; slots: { type: string }[] };
    expect(ads.client).toBeNull();
    expect(ads.slots.map((s) => s.type)).toEqual(['html']);
  });

  it('runlevel 关站：短路不注入（§17.4）', async () => {
    const { rt } = runtimeWith(await kvMap({ runlevel: 0, secret: { client: 'c' } }), 1, { SECRETS_MASTER_KEY: MASTER });
    const ext: Record<string, unknown> = {};
    await rt.bus.emit('bootstrap:contribute', { payload: ext });
    expect(ext['ads']).toBeUndefined();
  });

  it('停用插件：bootstrap 无 ads 字段，全站零广告（§17.5）', async () => {
    const { rt } = runtimeWith(await kvMap({ secret: { client: 'c' } }), 0, { SECRETS_MASTER_KEY: MASTER });
    const ext: Record<string, unknown> = {};
    await rt.bus.emit('bootstrap:contribute', { payload: ext });
    expect(ext['ads']).toBeUndefined();
  });

  it('爬虫预渲染：ads 从不贡献 render:head → 无 AdSense 脚本注入（§17.4）', async () => {
    const { rt } = runtimeWith(await kvMap({ secret: { client: 'ca-pub-9' } }), 1, { SECRETS_MASTER_KEY: MASTER });
    const meta = { kind: 'index' as const, canonical: 'http://x/', title: 'T', description: '', head: [], jsonLd: [], og: {} };
    await rt.bus.emit('render:head', meta);
    expect(meta.head).toEqual([]);
    expect(JSON.stringify(meta)).not.toContain('adsbygoogle');
  });
});

describe('ads.txt 路由（§17.4）', () => {
  it('已配置发布商 ID：输出 AdSense 规范行', async () => {
    const map = await kvMap({ secret: { publisherId: 'pub-0000000000000000' } });
    const { rt, d1 } = runtimeWith(map, 1, { SECRETS_MASTER_KEY: MASTER });
    const route = rt.routes.find((r) => r.path === '/ads.txt')!;
    const cLike = { get: (k: string) => (k === 'db' ? d1 : undefined), env: { SECRETS_MASTER_KEY: MASTER } };
    const res = (await route.handler(cLike)) as Response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0\n');
  });

  it('未配置（无 master）：404，不输出空文件', async () => {
    const { rt, d1 } = runtimeWith(await kvMap({}), 1, {});
    const route = rt.routes.find((r) => r.path === '/ads.txt')!;
    const cLike = { get: (k: string) => (k === 'db' ? d1 : undefined), env: {} };
    const res = (await route.handler(cLike)) as Response;
    expect(res.status).toBe(404);
  });
});
