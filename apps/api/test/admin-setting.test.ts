import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, fakeR2, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';
import { issueAdminToken } from '../src/core/auth/admin';

const SECRET = 'admin-secret';
const STORED = JSON.stringify({ sitename: 'FreeIDX', runlevel: 5, user_create_on: 0, upload_max_size: 1048576, lang: 'zh-cn', custom_ext_keep: 'yes' });

function rules(): SqlRule[] {
  return [
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: STORED } },
    { test: /REPLACE INTO bbs_kv/, rows: [] },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /SELECT gid,token_version FROM bbs_user WHERE uid = \?/, first: () => ({ gid: 1, token_version: 0 }) },
  ];
}
interface Env { JWT_SECRET: string; SITE_URL: string; DB: unknown; CACHE: unknown; FILES: unknown }
function makeEnv(rs: SqlRule[]): { env: Env; calls: { sql: string; params: readonly unknown[] }[] } {
  const { db, calls } = fakeD1Sql(rs);
  return { env: { JWT_SECRET: SECRET, SITE_URL: 'http://localhost', DB: db, CACHE: fakeKv(), FILES: {} }, calls };
}
async function token(): Promise<string> {
  return issueAdminToken(SECRET, 1, 0);
}
async function jsonOf(res: Response) {
  return (await res.json()) as { code: number; message: string } & Record<string, unknown>;
}

beforeEach(() => l0Clear());

describe('站点设置后台（T3-4 DoD）', () => {
  it('无 admin_at → 守卫 403', async () => {
    const { env } = makeEnv(rules());
    const res = await app.request('/api/admin/setting', { headers: {} }, env as never);
    expect(res.status).toBe(403);
  });

  it('GET：返回存储态（snake 键原样回显）', async () => {
    const { env } = makeEnv(rules());
    const res = await app.request('/api/admin/setting', { headers: { cookie: `admin_at=${await token()}` } }, env as never);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    expect((body.data as Record<string, unknown>).sitename).toBe('FreeIDX');
    expect((body.data as Record<string, unknown>).custom_ext_keep).toBe('yes');
  });

  it('PUT：白名单合并写回 kv + 失效 setting 缓存', async () => {
    const { env, calls } = makeEnv(rules());
    const res = await app.request(
      '/api/admin/setting',
      { method: 'PUT', headers: { cookie: `admin_at=${await token()}; csrf=t`, 'content-type': 'application/json', 'x-csrf-token': 't' }, body: JSON.stringify({ sitename: '新站名', runlevel: 3, user_create_on: true }) },
      env as never,
    );
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    const rep = calls.find((c) => /REPLACE INTO bbs_kv/.test(c.sql));
    expect(rep).toBeTruthy();
    const written = JSON.parse(String(rep?.params[1])) as Record<string, unknown>;
    expect(written.sitename).toBe('新站名');
    expect(written.runlevel).toBe(3);
    expect(written.user_create_on).toBe(1); // bool → 0/1
    expect(written.custom_ext_keep).toBe('yes'); // 非白名单键保留
  });

  it('PUT nav：归一化为 JSON 字符串，labels/icon/iconUrl 原样保留（否则后台保存后多语言名与图标消失）', async () => {
    const { env, calls } = makeEnv(rules());
    const res = await app.request(
      '/api/admin/setting',
      {
        method: 'PUT',
        headers: { cookie: `admin_at=${await token()}; csrf=t`, 'content-type': 'application/json', 'x-csrf-token': 't' },
        body: JSON.stringify({
          nav: JSON.stringify([
            { label: '测试', labels: { 'zh-cn': '测试', 'en-us': 'Test', 'xx-xx': 'nope' }, icon: 'home', iconUrl: '/files/site/nav/a1b2c3.png', url: '/forum/1', sort: 0, on: 1 },
            { label: '停用项', url: '/new', sort: 1, on: 0, iconUrl: 'https://cdn.example.com/x.png' }, // 外链图标 → 丢弃
            { label: '', url: '/drop' }, // 缺名称 → 丢弃
            { label: '缺链接', url: '' }, // 缺链接 → 丢弃
          ]),
        }),
      },
      env as never,
    );
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const written = JSON.parse(String(calls.find((c) => /REPLACE INTO bbs_kv/.test(c.sql))?.params[1])) as Record<string, unknown>;
    const nav = JSON.parse(String(written.nav)) as Record<string, unknown>[];
    expect(nav).toHaveLength(2);
    expect(nav[0]).toMatchObject({ label: '测试', icon: 'home', iconUrl: '/files/site/nav/a1b2c3.png', url: '/forum/1', sort: 0, on: 1 });
    expect(nav[0]!.labels).toEqual({ 'zh-cn': '测试', 'en-us': 'Test' }); // 不支持语言被剔除
    expect(nav[1]).toMatchObject({ label: '停用项', url: '/new', on: 0 }); // 停用项保留，不加默认 icon/labels
    expect(nav[1]!.icon).toBeUndefined();
    expect(nav[1]!.labels).toBeUndefined();
    expect(nav[1]!.iconUrl).toBeUndefined(); // 只收本站上传目录的直链
  });

  it('PUT nav-icon：上传的图片只落 R2 site/nav/ 并回直链，不写 setting', async () => {
    const { db, calls } = fakeD1Sql(rules());
    const r2 = fakeR2();
    const env = { JWT_SECRET: SECRET, SITE_URL: 'http://localhost', DB: db, CACHE: fakeKv(), FILES: r2 };
    const res = await app.request(
      '/api/admin/setting/nav-icon',
      {
        method: 'PUT',
        headers: { cookie: `admin_at=${await token()}; csrf=t`, 'content-type': 'application/json', 'x-csrf-token': 't' },
        body: JSON.stringify({ data: 'data:image/png;base64,iVBORw0KGgo=' }),
      },
      env as never,
    );
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    const url = String((body.data as Record<string, unknown>).icon_url);
    expect(url).toMatch(/^\/files\/site\/nav\/[a-f0-9]+\.png$/);
    expect(r2.store.has(url.replace('/files/', ''))).toBe(true);
    // 图标直链由「导航栏设置」随 nav 保存，上传接口本身不碰 setting
    expect(calls.some((c) => /REPLACE INTO bbs_kv/.test(c.sql))).toBe(false);
  });

  it('PUT nav-icon：非图片 data URL → VALIDATION_ERROR', async () => {
    const { db } = fakeD1Sql(rules());
    const env = { JWT_SECRET: SECRET, SITE_URL: 'http://localhost', DB: db, CACHE: fakeKv(), FILES: fakeR2() };
    const res = await app.request(
      '/api/admin/setting/nav-icon',
      {
        method: 'PUT',
        headers: { cookie: `admin_at=${await token()}; csrf=t`, 'content-type': 'application/json', 'x-csrf-token': 't' },
        body: JSON.stringify({ data: 'https://example.com/icon.png' }),
      },
      env as never,
    );
    expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
  });

  it('PUT：runlevel 越界 → VALIDATION_ERROR', async () => {
    const { env, calls } = makeEnv(rules());
    const res = await app.request(
      '/api/admin/setting',
      { method: 'PUT', headers: { cookie: `admin_at=${await token()}; csrf=t`, 'content-type': 'application/json', 'x-csrf-token': 't' }, body: JSON.stringify({ runlevel: 7 }) },
      env as never,
    );
    expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
    expect(calls.some((c) => /REPLACE INTO bbs_kv/.test(c.sql))).toBe(false);
  });

  it('PUT：upload_max_size 负数 → VALIDATION_ERROR', async () => {
    const { env } = makeEnv(rules());
    const res = await app.request(
      '/api/admin/setting',
      { method: 'PUT', headers: { cookie: `admin_at=${await token()}; csrf=t`, 'content-type': 'application/json', 'x-csrf-token': 't' }, body: JSON.stringify({ upload_max_size: -5 }) },
      env as never,
    );
    expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
  });
});
