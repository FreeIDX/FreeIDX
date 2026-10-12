import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';
import { issueAdminToken } from '../src/core/auth/admin';

const SECRET = 'test-secret';
const SETTING = JSON.stringify({ runlevel: 5, sitename: 'F', url: 'http://localhost', forum_orderby: 0, update_views_on: 1, upload_max_size: 1048576, lang: 'zh-cn' });

function rulesForUser(uid: number, gid: number, tv: number): SqlRule[] {
  return [
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: SETTING } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /SELECT gid,token_version FROM bbs_user WHERE uid = \?/, first: (p: readonly unknown[]) => (Number(p[0]) === uid ? { gid, token_version: tv } : null) },
  ];
}

interface Env { JWT_SECRET: string; SITE_URL: string; DB: unknown; CACHE: unknown; FILES: unknown }
function env(rules: SqlRule[], jwt = SECRET): Env {
  const { db } = fakeD1Sql(rules);
  return { JWT_SECRET: jwt, SITE_URL: 'http://localhost', DB: db, CACHE: fakeKv(), FILES: {} };
}
async function hit(e: Env, cookie = '') {
  return app.request('/api/admin/anything', { headers: cookie ? { cookie } : {} }, e as never);
}

beforeEach(() => l0Clear());

describe('后台守卫 admin_at（T3-3 DoD）', () => {
  it('缺 admin_at → 403 NO_PERMISSION', async () => {
    const res = await hit(env(rulesForUser(1, 1, 0)));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: number }).code).toBe(Code.NO_PERMISSION);
  });

  it('令牌伪造/篡改 → 403', async () => {
    const res = await hit(env(rulesForUser(1, 1, 0)), 'admin_at=not.a.jwt');
    expect(res.status).toBe(403);
  });

  it('合法令牌但 gid≠1 → 403', async () => {
    const e = env(rulesForUser(1, 101, 0));
    const tok = await issueAdminToken(SECRET, 1, 0);
    const res = await hit(e, `admin_at=${tok}`);
    expect(res.status).toBe(403);
  });

  it('改密吊销：token_version 不匹配 → 403', async () => {
    const e = env(rulesForUser(1, 1, 7)); // 库内 tv=7
    const tok = await issueAdminToken(SECRET, 1, 3); // 令牌 tv=3
    const res = await hit(e, `admin_at=${tok}`);
    expect(res.status).toBe(403);
  });

  it('合法 gid=1 令牌：通过守卫（下游无路由→404）且续期 admin_at Cookie', async () => {
    const e = env(rulesForUser(1, 1, 0));
    const tok = await issueAdminToken(SECRET, 1, 0);
    const res = await hit(e, `admin_at=${tok}`);
    expect(res.status).toBe(404); // 通过守卫，到达 notFound
    const sc = res.headers.get('set-cookie') ?? '';
    expect(sc).toMatch(/admin_at=/);
    expect(sc).toMatch(/HttpOnly/i);
  });

  it('缺签名密钥（JWT_SECRET 未配置）→ 403', async () => {
    const e = env(rulesForUser(1, 1, 0), '');
    const res = await hit(e);
    expect(res.status).toBe(403);
  });
});
