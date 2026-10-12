/**
 * T2-2 双轨会话测试：JWT(HS256) 签发/验签/过期、session 轨命中、JWT 重建 session、
 * token_version 改密吊销（>30min 复核窗口）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { l0Clear } from '../src/core/cache';
import { ACCESS_TOKEN_TTL, issueAccessToken, signJwt, verifyJwt } from '../src/core/auth/jwt';
import { ipToLong } from '../src/core/auth/session';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';

const SECRET = 'unit-test-jwt-secret';
const USER = {
  uid: 1, gid: 2, username: 'admin', avatar: 0, threads: 2, posts: 5, credits: 3,
  token_version: 7, password: 'x', salt: 's', email: 'a@b.c',
};
const SETTING = JSON.stringify({
  runlevel: 5, sitename: 'FreeIDX', brief: 'b', url: 'http://localhost', kw: '', desc: '',
  user_create_on: 1, user_create_email_on: 0, user_resetpw_on: 1,
  forum_orderby: 0, update_views_on: 1, upload_max_size: 1048576, lang: 'zh-cn',
});

function rules(extra: SqlRule[] = []): SqlRule[] {
  return [
    ...extra,
    { test: /FROM bbs_kv/, first: { v: SETTING } },
    { test: /FROM bbs_group/, rows: [] },
    { test: /FROM bbs_forum ORDER BY/, rows: [] },
    /* bootstrap 站点数据卡 runtime 计数（全站贴子/用户数） */
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_post$/, first: { c: 0 } },
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_user$/, first: { c: 0 } },
    /* bootstrap「我的」计数卡（0002_social 关注/收藏、0006_notice 未读） */
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_follow/, first: { c: 0 } },
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_favorite/, first: { c: 0 } },
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_notice/, first: { c: 0 } },
    { test: /bbs_forum_access/, rows: [] },
    { test: /FROM bbs_user WHERE uid = \?/, first: USER },
    { test: /bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_session/, rows: [] },
    { test: /SELECT uid,last_date FROM bbs_session/, first: null },
  ];
}

function envFor(rs: SqlRule[]) {
  const fake = fakeD1Sql(rs);
  return { env: { DB: fake.db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost', JWT_SECRET: SECRET }, calls: fake.calls };
}

async function meOf(env: unknown, cookie?: string) {
  const res = await app.request('/api/bootstrap', cookie ? { headers: { cookie } } : {}, env as never);
  const body = (await res.json()) as { data: { me: { uid: number } | null } };
  return body.data.me;
}

beforeEach(() => l0Clear());

describe('JWT HS256（WebCrypto）', () => {
  it('签发/验签往返；错密钥与篡改拒绝', async () => {
    const t = await issueAccessToken(SECRET, 42, 3);
    const p = await verifyJwt(t, SECRET);
    expect(p).toMatchObject({ uid: 42, tv: 3 });
    expect(await verifyJwt(t, 'other-secret')).toBeNull();
    expect(await verifyJwt(t.slice(0, -3) + 'aaa', SECRET)).toBeNull();
    expect(await verifyJwt('garbage', SECRET)).toBeNull();
  });
  it('exp 过期拒绝；TTL=100 天（bbs_token 存量口径）', async () => {
    const now = Math.floor(Date.now() / 1000);
    const t = await signJwt({ uid: 1, tv: 0, iat: now - ACCESS_TOKEN_TTL, exp: now - 1 }, SECRET);
    expect(await verifyJwt(t, SECRET)).toBeNull();
    const fresh = await issueAccessToken(SECRET, 1, 0);
    const p = await verifyJwt(fresh, SECRET);
    expect(p && p.exp - p.iat).toBe(ACCESS_TOKEN_TTL);
  });
});

describe('ipToLong', () => {
  it('IPv4 → 无符号整数；IPv6/非法 → 0', () => {
    expect(ipToLong('127.0.0.1')).toBe(2130706433);
    expect(ipToLong('255.255.255.255')).toBe(4294967295);
    expect(ipToLong('::1')).toBe(0);
    expect(ipToLong('')).toBe(0);
  });
});

describe('双轨合并', () => {
  it('session 轨命中：sid → uid → me', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { env } = envFor(rules([{ test: /SELECT uid,last_date FROM bbs_session/, first: { uid: 1, last_date: now } }]));
    const me = await meOf(env, 'sid=abcdef;');
    expect(me).toMatchObject({ uid: 1, username: 'admin' });
  });

  it('session 缺失由 JWT 重建：at 有效 → me 非空 + 下发新 sid cookie', async () => {
    const token = await issueAccessToken(SECRET, 1, USER.token_version);
    const { env, calls } = envFor(rules());
    const res = await app.request('/api/bootstrap', { headers: { cookie: `at=${token}` } }, env as never);
    const body = (await res.json()) as { data: { me: { uid: number } | null } };
    expect(body.data.me?.uid).toBe(1);
    expect(calls.some((c) => /REPLACE INTO bbs_session/.test(c.sql))).toBe(true);
    expect(res.headers.get('set-cookie') ?? '').toMatch(/sid=[0-9a-f]{32}/);
  });

  it('30 分钟内的 token 不回查 token_version（省 1 次 D1）', async () => {
    const token = await issueAccessToken(SECRET, 1, 999); // tv 与库不符但签发 <30min
    const { env, calls } = envFor(rules());
    const me = await meOf(env, `at=${token}`);
    expect(me?.uid).toBe(1);
    expect(calls.some((c) => /SELECT token_version FROM bbs_user/.test(c.sql))).toBe(false);
  });

  it('>30min 且 token_version 不符 → 改密吊销，游客处理', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = await signJwt({ uid: 1, tv: 123, iat: now - 3600, exp: now + 3600 }, SECRET);
    const { env } = envFor(rules());
    const me = await meOf(env, `at=${stale}`);
    expect(me).toBeNull();
  });

  it('>30min 且 token_version 相符 → 放行', async () => {
    const now = Math.floor(Date.now() / 1000);
    const ok = await signJwt({ uid: 1, tv: USER.token_version, iat: now - 3600, exp: now + 3600 }, SECRET);
    const { env } = envFor(rules());
    const me = await meOf(env, `at=${ok}`);
    expect(me?.uid).toBe(1);
  });

  it('畸形 Cookie（百分号编码非法，如 sid=%）按「无此 cookie」处理：游客而非 500', async () => {
    const { env } = envFor(rules());
    const res = await app.request('/api/bootstrap', { headers: { cookie: 'sid=%; at=%E0%A4%A' } }, env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; data: { me: { uid: number } | null } };
    expect(body.code).toBe(0);
    expect(body.data.me).toBeNull();
  });

  it('无 JWT_SECRET 配置时 token 轨整体停用（不报错）', async () => {
    const token = await issueAccessToken(SECRET, 1, USER.token_version);
    const fake = fakeD1Sql(rules());
    const env = { DB: fake.db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost' };
    const me = await meOf(env as never, `at=${token}`);
    expect(me).toBeNull();
  });
});
