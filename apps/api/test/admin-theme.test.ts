/**
 * 主题管理（/api/admin/theme + /api/theme/active）：
 * 启用状态只落 kv `theme`（一个 id），主题清单在前端构建期自动发现，后端不做白名单；
 * 简蓝主题已移到主题管理，插件中心列表不再重复出现（hiddenInCatalog），但详情接口仍可用。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';
import { issueAdminToken } from '../src/core/auth/admin';

const SECRET = 'admin-secret';

function baseRules(theme?: string): SqlRule[] {
  return [
    { test: /SELECT gid,token_version FROM bbs_user/, first: { gid: 1, token_version: 0 } },
    {
      test: /SELECT v FROM bbs_kv/,
      first: (p: readonly unknown[]) => {
        const k = p[0];
        if (k === 'theme' && theme !== undefined) return { v: JSON.stringify(theme) };
        if (k === 'extensions') return null;
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

function makeEnv(rules: SqlRule[]) {
  const { db, calls } = fakeD1Sql(rules);
  const env = { JWT_SECRET: SECRET, SITE_URL: 'http://localhost', DB: db, CACHE: fakeKv(), FILES: {} } as never;
  return { env, calls };
}

const cookie = async () => `admin_at=${await issueAdminToken(SECRET, 1, 0)}`;
const writeHeaders = async () => ({ cookie: `${await cookie()}; csrf=t`, 'content-type': 'application/json', 'x-csrf-token': 't' });
async function jsonOf(res: Response) {
  return (await res.json()) as { code: number; data?: Record<string, unknown> };
}

beforeEach(() => l0Clear());

describe('主题启用状态', () => {
  it('公开 GET /api/theme/active：kv 无值 → 回落 light', async () => {
    const { env } = makeEnv(baseRules());
    const body = await jsonOf(await app.request('/api/theme/active', {}, env));
    expect(body.code).toBe(Code.OK);
    expect(body.data).toEqual({ id: 'light' });
  });

  it('公开 GET /api/theme/active：读取已保存的 id', async () => {
    const { env } = makeEnv(baseRules('demo'));
    expect((await jsonOf(await app.request('/api/theme/active', {}, env))).data).toEqual({ id: 'demo' });
  });

  it('后台 GET /api/admin/theme：同时回当前值与内置兜底', async () => {
    const { env } = makeEnv(baseRules('demo'));
    const body = await jsonOf(await app.request('/api/admin/theme', { headers: { cookie: await cookie() } }, env));
    expect(body.data).toEqual({ active: 'demo', default: 'light' });
  });

  it('后台 PUT：写入 kv theme，非法 id 拒绝', async () => {
    const { env, calls } = makeEnv(baseRules());
    const okRes = await jsonOf(
      await app.request('/api/admin/theme', { method: 'PUT', headers: await writeHeaders(), body: JSON.stringify({ id: 'demo' }) }, env),
    );
    expect(okRes.code).toBe(Code.OK);
    const write = calls.find((c) => /REPLACE INTO bbs_kv/.test(c.sql) && c.params[0] === 'theme');
    expect(write).toBeTruthy();
    expect(JSON.parse(String(write!.params[1]))).toBe('demo');

    l0Clear();
    const bad = await app.request('/api/admin/theme', { method: 'PUT', headers: await writeHeaders(), body: JSON.stringify({ id: '../evil' }) }, env);
    expect((await jsonOf(bad)).code).toBe(Code.VALIDATION_ERROR);
  });

  it('插件中心列表不重复出现简蓝（hiddenInCatalog），详情仍可访问', async () => {
    const { env } = makeEnv(baseRules());
    const list = (await jsonOf(await app.request('/api/admin/extensions', { headers: { cookie: await cookie() } }, env))).data as {
      extensions: { id: string }[];
    };
    expect(list.extensions.some((x) => x.id === 'light')).toBe(false);

    const detail = await app.request('/api/admin/extensions/light', { headers: { cookie: await cookie() } }, env);
    expect((await jsonOf(detail)).code).toBe(Code.OK);
  });
});
