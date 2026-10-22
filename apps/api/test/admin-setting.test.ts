import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
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
