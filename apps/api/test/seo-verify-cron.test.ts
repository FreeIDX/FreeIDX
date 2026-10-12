/**
 * seo 二期（T4-5）：站点验证文件/meta（ext:seo:config）+ 多引擎推送 cron（IndexNow/百度/Bing/Google，
 * token 存 ext:seo:secret）+ handleScheduled 插件 cron 分发接线。私钥不入日志。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { app } from '../src/index';
import { buildRuntime } from '../src/core/extensions/registry';
import { seoPlugin } from '../src/extensions/seo';
import { handleScheduled } from '../src/core/cron';
import { Cache, l0Clear } from '../src/core/cache';
import { D1b } from '../src/core/db';
import { encryptSecret } from '../src/core/crypto';
import { fakeAssets, fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';

const MASTER = btoa(String.fromCharCode(7).repeat(32));
const OTHER = btoa(String.fromCharCode(9).repeat(32));
const SETTING = JSON.stringify({ runlevel: 5, sitename: 'FreeIDX', brief: 'b', desc: '', url: 'http://localhost' });
const GUEST_GROUP = { gid: 0, name: '游客组', creditsfrom: 0, creditsto: 0, allowread: 1, allowthread: 0, allowpost: 1, allowattach: 0, allowdown: 1, allowtop: 0, allowupdate: 0, allowdelete: 0, allowmove: 0, allowbanuser: 0, allowdeleteuser: 0, allowviewip: 0 };
const FORUM_OPEN = { fid: 1, name: '默认版块', rank: 1, threads: 2, todayposts: 0, todaythreads: 0, brief: '介绍', announcement: '', accesson: 0, orderby: 0, icon: 0, moduids: '', seo_title: '', seo_keywords: '' };

function baseRules(kv: Record<string, string | null>): SqlRule[] {
  return [
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: (p: readonly unknown[]) => { const v = kv[String(p[0])]; return v ? { v } : null; } },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_kv/, rows: [] },
    { test: /UPDATE bbs_forum SET threads = \(SELECT/, rows: [] },
    { test: /UPDATE bbs_thread SET posts = \(SELECT/, rows: [] },
    { test: /UPDATE bbs_user SET/, rows: [] },
    { test: /SELECT \(SELECT COUNT\(\*\) FROM bbs_thread\) AS threads/, first: { threads: 0, posts: 0 } },
    { test: /UPDATE bbs_forum SET todayposts/, rows: [] },
    { test: /FROM bbs_attach WHERE status = 0/, rows: [] },
    { test: /DELETE FROM bbs_queue/, rows: [] },
    { test: /FROM bbs_forum ORDER BY/, rows: [FORUM_OPEN] },
    { test: /bbs_forum_access/, rows: [] },
    { test: /FROM bbs_group/, rows: [GUEST_GROUP] },
    { test: /FROM bbs_thread WHERE last_date > \?/, rows: [{ tid: 2, fid: 1 }] },
    { test: /digest > 0/, rows: [] },
    { test: /FROM bbs_thread ORDER BY last_date DESC LIMIT 1000/, rows: [] },
    { test: /FROM bbs_thread ORDER BY last_date DESC LIMIT 50/, rows: [] },
  ];
}

beforeEach(() => l0Clear());
afterEach(() => vi.unstubAllGlobals());

describe('站点验证文件 / meta（registerRoute + render:head）', () => {
  const kv = { extensions: null, setting: SETTING, 'ext:seo:config': JSON.stringify({ verifyFiles: { 'googleabc123.html': 'verifydata-xyz' }, verifyMeta: { 'google-site-verification': 'METAKEY' } }), 'ext:geo:config': null, 'ext:ads:config': null };

  it('验证文件按配置输出纯文本', async () => {
    const { db } = fakeD1Sql(baseRules(kv));
    const env = { DB: db, CACHE: fakeKv(), FILES: {}, ASSETS: fakeAssets(), SITE_URL: 'http://localhost' };
    const res = await app.request('/googleabc123.html', { headers: { 'user-agent': 'Mozilla/5.0' } }, env as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('verifydata-xyz');
  });

  it('非法文件名不注册（防路径穿越）', async () => {
    const bad = { ...kv, 'ext:seo:config': JSON.stringify({ verifyFiles: { '../etc/passwd': 'LEAKED' } }) };
    const { db } = fakeD1Sql(baseRules(bad));
    const env = { DB: db, CACHE: fakeKv(), FILES: {}, ASSETS: fakeAssets(), SITE_URL: 'http://localhost' };
    // 人类浏览器：合并部署下未注册路径回 SPA 壳，重点是穿越名没变成路由（不吐出内容）
    const human = await app.request('/etc/passwd', { headers: { 'user-agent': 'Mozilla/5.0' } }, env as never);
    expect(await human.text()).not.toContain('LEAKED');
    // 爬虫：同一必须是真 404，不能拿到壳页 200
    const bot = await app.request('/etc/passwd', { headers: { 'user-agent': 'Googlebot/2.1' } }, env as never);
    expect(bot.status).toBe(404);
  });

  it('config.indexnowKey → 自动托管 /{key}.txt 验证文件（IndexNow 所有权校验零人工）', async () => {
    const kvIndexNow = { ...kv, 'ext:seo:config': JSON.stringify({ indexnowKey: 'abc12345xyz98765' }) };
    const { db } = fakeD1Sql(baseRules(kvIndexNow));
    const env = { DB: db, CACHE: fakeKv(), FILES: {}, ASSETS: fakeAssets(), SITE_URL: 'http://localhost' };
    const res = await app.request('/abc12345xyz98765.txt', { headers: { 'user-agent': 'Mozilla/5.0' } }, env as never);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('abc12345xyz98765');
    // 非 key 路径不吐 key 内容（回落 SPA/404 语义）
    const miss = await app.request('/other1234567890.txt', { headers: { 'user-agent': 'Mozilla/5.0' } }, env as never);
    expect(await miss.text()).not.toBe('abc12345xyz98765');
  });

  it('searchbot 预渲染 head 注入验证 meta', async () => {
    const { db } = fakeD1Sql([...baseRules(kv), { test: /FROM bbs_thread WHERE tid = \?/, first: { subject: 'T', username: 'u', create_date: 1700000001, posts: 1, ok: 1 } }, { test: /message_fmt FROM bbs_post/, first: { message_fmt: '<p>c</p>' } }]);
    const env = { DB: db, CACHE: fakeKv(), FILES: {}, ASSETS: fakeAssets(), SITE_URL: 'http://localhost' };
    const res = await app.request('/thread/2', { headers: { 'user-agent': 'Googlebot/2.1' } }, env as never);
    const html = await res.text();
    expect(html).toContain('<meta name="google-site-verification" content="METAKEY">');
  });
});

describe('IndexNow / 百度推送 cron（run 直测）', () => {
  async function ctxFor(payload: Record<string, unknown>, storeMaster: string) {
    const token = await encryptSecret(JSON.stringify(payload), storeMaster);
    const kv: Record<string, string | null> = {
      extensions: null,
      setting: SETTING,
      'ext:seo:config': JSON.stringify({}),
      'ext:geo:config': null,
      'ext:seo:secret': token,
    };
    const { db, calls } = fakeD1Sql(baseRules(kv));
    const d1 = D1b.of(db as unknown as D1Database);
    const cache = new Cache({ DB: db, CACHE: fakeKv(), SITE_URL: 'http://localhost' } as never, d1);
    return { d1, cache, calls };
  }

  it('配置 indexnowKey + baiduToken → 两个端点各推一次（secret 存量 key 自动迁移到 config）', async () => {
    const c = await ctxFor({ indexnowKey: 'KEY12345', baiduToken: 'BDTOKEN' }, MASTER);
    const rt = buildRuntime([seoPlugin], {}, { db: c.d1, cache: c.cache, env: { SITE_URL: 'http://localhost', SECRETS_MASTER_KEY: MASTER } as never }, { seo: {} });
    const pushed: { url: string; body?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => { pushed.push({ url, body: init?.body }); return { ok: true, status: 200 }; });
    const cron = rt.crons.find((x) => x.name === 'seo:index_push')!;
    await cron.run({ sinceLastSec: 3600, now: 1_700_000_000, waitUntil: () => {} });
    expect(pushed.some((p) => p.url.includes('api.indexnow.org'))).toBe(true);
    expect(pushed.some((p) => p.url.includes('data.zz.baidu.com') && p.url.includes('token=BDTOKEN'))).toBe(true);
    const indexnow = pushed.find((p) => p.url.includes('indexnow'))!;
    expect(indexnow.body).toContain('KEY12345');
    expect(indexnow.body).toContain('/thread/2');
    // 存量 secret key 自动迁移：ext:seo:config 落了同名 key（此后验证文件自动托管）
    const cfgWrite = c.calls.find((x) => /REPLACE INTO bbs_kv/.test(x.sql) && x.params[0] === 'ext:seo:config');
    expect(cfgWrite).toBeTruthy();
    expect(JSON.parse(String(cfgWrite!.params[1])).indexnowKey).toBe('KEY12345');
  });

  it('零配置：IndexNow key 自动生成并持久化到 config，推送携带新生成 key', async () => {
    const c = await ctxFor({}, MASTER);
    const rt = buildRuntime([seoPlugin], {}, { db: c.d1, cache: c.cache, env: { SITE_URL: 'http://localhost', SECRETS_MASTER_KEY: MASTER } as never }, { seo: {} });
    const pushed: { url: string; body?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => { pushed.push({ url, body: init?.body }); return { ok: true, status: 200 }; });
    await rt.crons.find((x) => x.name === 'seo:index_push')!.run({ sinceLastSec: 3600, now: 1_700_000_000, waitUntil: () => {} });
    const cfgWrite = c.calls.find((x) => /REPLACE INTO bbs_kv/.test(x.sql) && x.params[0] === 'ext:seo:config');
    expect(cfgWrite).toBeTruthy();
    const key = String(JSON.parse(String(cfgWrite!.params[1])).indexnowKey);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(pushed.find((p) => p.url.includes('indexnow'))!.body).toContain(key);
    // secret 类凭据未配置 → 百度/Bing/Google 不外呼，仅 IndexNow 一次
    expect(pushed.length).toBe(1);
  });

  it('错误 master（secret 不可解）→ secret 类推送不外呼；IndexNow 走 config 自动生成仍推送', async () => {
    const c = await ctxFor({ baiduToken: 'BDTOKEN' }, MASTER); // 库存 MASTER 密文，运行侧用 OTHER → 解不开
    const rt = buildRuntime([seoPlugin], {}, { db: c.d1, cache: c.cache, env: { SITE_URL: 'http://localhost', SECRETS_MASTER_KEY: OTHER } as never }, { seo: {} });
    const pushed: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { pushed.push(String(url)); return { ok: true, status: 200 }; });
    await rt.crons.find((x) => x.name === 'seo:index_push')!.run({ sinceLastSec: 3600, now: 1_700_000_000, waitUntil: () => {} });
    // 百度 token 解不开 → 不外呼；IndexNow key 不依赖 master（config 明文）→ 自动生成后照常推送
    expect(pushed.length).toBe(1);
    expect(pushed[0]).toContain('api.indexnow.org');
  });

  it('配置 bingApiKey + Google 服务账号 → Bing 批量提交 + Google 换 token 后逐条 publish', async () => {
    // 生成真实 RSA PKCS#8 私钥（PEM）→ 验证 JWT 签名链路可跑通
    const kp = (await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign'],
    )) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', kp.privateKey as CryptoKey)) as ArrayBuffer);
    let b64 = '';
    for (const x of der) b64 += String.fromCharCode(x);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(b64)}\n-----END PRIVATE KEY-----`;

    const c = await ctxFor({ bingApiKey: 'BINGKEY', googleClientEmail: 'sa@test.iam.gserviceaccount.com', googlePrivateKey: pem }, MASTER);
    const rt = buildRuntime([seoPlugin], {}, { db: c.d1, cache: c.cache, env: { SITE_URL: 'http://localhost', SECRETS_MASTER_KEY: MASTER } as never }, { seo: {} });
    const pushed: { url: string; body?: string; auth?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string; headers?: Record<string, string> }) => {
      if (String(url).includes('oauth2.googleapis.com/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'GTOKEN' }) };
      }
      pushed.push({ url: String(url), body: init?.body, auth: init?.headers?.authorization });
      return { ok: true, status: 200 };
    });
    await rt.crons.find((x) => x.name === 'seo:index_push')!.run({ sinceLastSec: 3600, now: 1_700_000_000, waitUntil: () => {} });
    const bing = pushed.find((p) => p.url.includes('ssl.bing.com'))!;
    expect(bing.url).toContain('apikey=BINGKEY');
    expect(bing.body).toContain('"siteUrl":"http://localhost"');
    expect(bing.body).toContain('/thread/2');
    const google = pushed.find((p) => p.url.includes('indexing.googleapis.com'))!;
    expect(google.auth).toBe('Bearer GTOKEN');
    expect(google.body).toContain('URL_UPDATED');
    expect(google.body).toContain('/thread/2');
  });

  it('引擎返回非 2xx → run 抛错（分发层据此跳过水位推进，下轮重覆盖同一窗口）', async () => {
    const c = await ctxFor({ baiduToken: 'BDTOKEN' }, MASTER);
    const rt = buildRuntime([seoPlugin], {}, { db: c.d1, cache: c.cache, env: { SITE_URL: 'http://localhost', SECRETS_MASTER_KEY: MASTER } as never }, { seo: {} });
    vi.stubGlobal('fetch', async (url: string) =>
      String(url).includes('data.zz.baidu.com') ? { ok: false, status: 400 } : { ok: true, status: 200 },
    );
    const cron = rt.crons.find((x) => x.name === 'seo:index_push')!;
    await expect(cron.run({ sinceLastSec: 3600, now: 1_700_000_000, waitUntil: () => {} })).rejects.toThrow(/baidu:400/);
  });

  it('清单超过 Bing 单次上限 → 按批分片提交（不再整批被拒）', async () => {
    const token = await encryptSecret(JSON.stringify({ bingApiKey: 'BINGKEY' }), MASTER);
    const rules = baseRules({
      extensions: null,
      setting: SETTING,
      'ext:seo:config': JSON.stringify({}),
      'ext:geo:config': null,
      'ext:seo:secret': token,
    });
    // 501 条更新主题 → 需 2 批（BING_PUSH_CHUNK = 500）
    rules.find((r) => /bbs_thread WHERE last_date >/.test(r.test.source))!.rows = Array.from({ length: 501 }, (_v, i) => ({
      tid: 100 + i,
      fid: 1,
    }));
    const { db } = fakeD1Sql(rules);
    const d1 = D1b.of(db as unknown as D1Database);
    const cache = new Cache({ DB: db, CACHE: fakeKv(), SITE_URL: 'http://localhost' } as never, d1);
    const rt = buildRuntime([seoPlugin], {}, { db: d1, cache, env: { SITE_URL: 'http://localhost', SECRETS_MASTER_KEY: MASTER } as never }, { seo: {} });
    const batchSizes: number[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
      if (String(url).includes('ssl.bing.com')) {
        batchSizes.push((JSON.parse(String(init?.body)) as { urlList: unknown[] }).urlList.length);
      }
      return { ok: true, status: 200 };
    });
    await rt.crons.find((x) => x.name === 'seo:index_push')!.run({ sinceLastSec: 3600, now: 1_700_000_000, waitUntil: () => {} });
    expect(batchSizes).toEqual([500, 1]);
  });
});

describe('handleScheduled 分发插件 cron（每日档）', () => {
  it('0 3 档触发 seo 推送任务', async () => {
    const token = await encryptSecret(JSON.stringify({ indexnowKey: 'K' }), MASTER);
    const kv: Record<string, string | null> = { extensions: null, setting: SETTING, 'ext:seo:config': JSON.stringify({}), 'ext:geo:config': null, 'ext:ads:config': null, 'ext:seo:secret': token, 'cron:last:seo:index_push': null };
    const { db } = fakeD1Sql(baseRules(kv));
    const env = { DB: db, CACHE: fakeKv(), FILES: {}, ASSETS: fakeAssets(), SITE_URL: 'http://localhost', SECRETS_MASTER_KEY: MASTER };
    let indexnowHit = false;
    vi.stubGlobal('fetch', async (url: string) => { if (String(url).includes('api.indexnow.org')) indexnowHit = true; return { ok: true, status: 200 }; });
    const ctx = { waitUntil: (_p: Promise<unknown>) => {} } as ExecutionContext;
    await handleScheduled({ cron: '0 3 * * *' } as ScheduledController, env as never, ctx);
    expect(indexnowHit).toBe(true);
  });
});
