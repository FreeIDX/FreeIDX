/**
 * T3-9 后台扩展管理：启停/配置只改 kv、零部署；secret AES-GCM 私钥不回显。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code, type LocText } from '@freeidx/shared';
import { extSchemaOf } from '../src/core/extensions';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';
import { issueAdminToken } from '../src/core/auth/admin';

const SECRET = 'admin-secret';
const MASTER = btoa(String.fromCharCode(7).repeat(32));

function baseRules(extState: Record<string, unknown> = {}): SqlRule[] {
  return [
    { test: /SELECT gid,token_version FROM bbs_user/, first: { gid: 1, token_version: 0 } },
    {
      test: /SELECT v FROM bbs_kv/,
      first: (p: readonly unknown[]) => {
        const k = p[0];
        if (k === 'extensions') return { v: JSON.stringify(extState) };
        if (k === 'setting') return { v: JSON.stringify({ runlevel: 5 }) };
        return null;
      },
    },
    { test: /REPLACE INTO bbs_kv/, rows: [] },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
  ];
}

function makeEnv(rules: SqlRule[], withMaster = true) {
  const { db, calls } = fakeD1Sql(rules);
  const env = {
    JWT_SECRET: SECRET,
    SITE_URL: 'http://localhost',
    DB: db,
    CACHE: fakeKv(),
    FILES: {},
    ...(withMaster ? { SECRETS_MASTER_KEY: MASTER } : {}),
  } as never;
  return { env, calls };
}

const cookie = async () => `admin_at=${await issueAdminToken(SECRET, 1, 0)}`;
const writeHeaders = async () => ({ cookie: `${await cookie()}; csrf=t`, 'content-type': 'application/json', 'x-csrf-token': 't' });
async function jsonOf(res: Response) {
  return (await res.json()) as { code: number; data?: Record<string, unknown> };
}
/** LocText 取词断言用：string 原样；map 取任一文案（列表投影不保证语言序） */
const briefText = (v?: LocText): string => (typeof v === 'string' ? v : Object.values(v ?? {})[0] ?? '');

beforeEach(() => l0Clear());

describe('扩展启停/配置（T3-9）', () => {
  it('GET 列表：反映 manifest 出厂态 + schema 轻量投影（brief）', async () => {
    const { env } = makeEnv(baseRules());
    const body = await jsonOf(await app.request('/api/admin/extensions', { headers: { cookie: await cookie() } }, env));
    expect(body.code).toBe(Code.OK);
    const list = (body.data as { extensions: { id: string; enable: number; installed: number; brief?: LocText }[] }).extensions;
    const byId = Object.fromEntries(list.map((x) => [x.id, x]));
    expect(byId['seo']!.enable).toBe(1);
    expect(byId['ads']!.enable).toBe(0);
    // 插件自声明 schema 的自动投影：卡片简介随列表下发（LocText：string 或 locale map 均非空）
    expect(briefText(byId['seo']!.brief).length).toBeGreaterThan(0);
    expect(briefText(byId['card']!.brief).length).toBeGreaterThan(0);
  });

  it('PUT enable=1：写入 kv extensions，零部署（REPLACE INTO bbs_kv）', async () => {
    const { env, calls } = makeEnv(baseRules({ ads: { installed: 1, enable: 0 } }));
    const res = await app.request('/api/admin/extensions/ads', { method: 'PUT', headers: await writeHeaders(), body: JSON.stringify({ enable: 1 }) }, env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const kvWrite = calls.find((c) => /REPLACE INTO bbs_kv/.test(c.sql) && c.params[0] === 'extensions');
    expect(kvWrite).toBeTruthy();
    expect(JSON.parse(String(kvWrite!.params[1])).ads).toEqual({ installed: 1, enable: 1 });
  });

  it('PUT config：非敏感配置写 ext:ads:config', async () => {
    const { env, calls } = makeEnv(baseRules());
    const res = await app.request('/api/admin/extensions/ads', { method: 'PUT', headers: await writeHeaders(), body: JSON.stringify({ config: { cmp: 1, placeholder: { header: 90 } } }) }, env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const kvWrite = calls.find((c) => /REPLACE INTO bbs_kv/.test(c.sql) && c.params[0] === 'ext:ads:config');
    expect(kvWrite).toBeTruthy();
    expect(JSON.parse(String(kvWrite!.params[1]))).toEqual({ cmp: 1, placeholder: { header: 90 } });
  });

  it('PUT secret：私钥 AES-GCM 加密后落 ext:ads:secret（密文 v1. 前缀，绝不存明文）', async () => {
    const { env, calls } = makeEnv(baseRules());
    const res = await app.request('/api/admin/extensions/ads', { method: 'PUT', headers: await writeHeaders(), body: JSON.stringify({ secret: { publisherId: 'pub-123', client: 'ca-pub-9' } }) }, env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const kvWrite = calls.find((c) => /REPLACE INTO bbs_kv/.test(c.sql) && c.params[0] === 'ext:ads:secret');
    expect(kvWrite).toBeTruthy();
    expect(String(kvWrite!.params[1]).startsWith('v1.')).toBe(true);
    expect(String(kvWrite!.params[1])).not.toContain('pub-123');
  });

  it('PUT secret 缺 SECRETS_MASTER_KEY → 校验失败（安全：不落明文）', async () => {
    const { env, calls } = makeEnv(baseRules(), false);
    const res = await app.request('/api/admin/extensions/ads', { method: 'PUT', headers: await writeHeaders(), body: JSON.stringify({ secret: { publisherId: 'pub-1' } }) }, env);
    expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
    expect(calls.some((c) => /REPLACE INTO bbs_kv/.test(c.sql) && c.params[0] === 'ext:ads:secret')).toBe(false);
  });

  it('GET 详情：config 回显、hasSecret 布尔（私钥值永不返回）', async () => {
    const { env, calls } = makeEnv(baseRules());
    const res = await app.request('/api/admin/extensions/ads', { method: 'PUT', headers: await writeHeaders(), body: JSON.stringify({ config: { cmp: 1 } }) }, env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    // 详情路径读 ext:ads:secret 原始密文以判存在，但响应不含密文
    const detail = await jsonOf(await app.request('/api/admin/extensions/ads', { headers: { cookie: await cookie() } }, env));
    expect(detail.code).toBe(Code.OK);
    const d = detail.data as { hasSecret: boolean; config: Record<string, unknown> };
    expect(d.hasSecret).toBe(false);
    expect(JSON.stringify(d)).not.toContain('v1.');
    expect(calls.some((c) => /SELECT v FROM bbs_kv/.test(c.sql) && c.params[0] === 'ext:ads:secret')).toBe(true);
  });

  it('未知扩展 id → NOT_FOUND', async () => {
    const { env } = makeEnv(baseRules());
    const res = await app.request('/api/admin/extensions/nope', { method: 'PUT', headers: await writeHeaders(), body: JSON.stringify({ enable: 1 }) }, env);
    expect((await jsonOf(res)).code).toBe(Code.NOT_FOUND);
  });

  it('GET 详情：schema 由插件自声明下发（seo 含 secret 字段与 SAFE_FILE 同源白名单，card 零字段）', async () => {
    const { env } = makeEnv(baseRules());
    const seo = await jsonOf(await app.request('/api/admin/extensions/seo', { headers: { cookie: await cookie() } }, env));
    expect(seo.code).toBe(Code.OK);
    const s = (seo.data as { schema?: { brief: LocText; fields: { key: string; target?: string; type: string; keyPattern?: string; autoGenerate?: boolean }[] } }).schema;
    expect(s).toBeTruthy();
    // 归一化保证 target 恒有值：password 与 secret 文本类密钥均为 secret
    const gpk = s!.fields.find((f) => f.key === 'googlePrivateKey');
    expect(gpk?.target).toBe('secret');
    expect(gpk?.type).toBe('textarea');
    const inow = s!.fields.find((f) => f.key === 'indexnowKey');
    // IndexNow key 为公开自拟值：自动生成、存 config（不占 secret 桶）
    expect(inow?.target).toBe('config');
    expect(inow?.type).toBe('text');
    expect(inow?.autoGenerate).toBe(true);
    // verifyFiles.keyPattern 与服务端 SAFE_FILE 白名单同源（单一份声明，不漂移）
    expect(s!.fields.find((f) => f.key === 'verifyFiles')?.keyPattern).toBe('^[A-Za-z0-9._-]{1,80}$');
    // 零配置插件：schema 存在但无字段
    const card = await jsonOf(await app.request('/api/admin/extensions/card', { headers: { cookie: await cookie() } }, env));
    expect(((card.data as { schema?: { fields: unknown[] } }).schema?.fields.length ?? -1)).toBe(0);
  });

  it('extSchemaOf：target 缺省规则归一化（password→secret，其余→config），无 schema → undefined', () => {
    const s = extSchemaOf({
      manifest: { id: 't', name: {}, version: '0', installed: 0, enable: 0 },
      schema: {
        brief: 'b',
        intro: 'i',
        fields: [
          { key: 'k1', type: 'password', label: 'K1' }, // 未写 target → 归一化 secret
          { key: 'k2', type: 'text', label: 'K2' }, // 未写 target → 归一化 config
        ],
      },
      setup() {},
    });
    expect(s?.fields[0]!.target).toBe('secret');
    expect(s?.fields[1]!.target).toBe('config');
    expect(extSchemaOf({ manifest: { id: 'x', name: {}, version: '0', installed: 0, enable: 0 }, setup() {} })).toBeUndefined();
  });
});
