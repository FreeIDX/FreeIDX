/**
 * T4-2：在线用户列表 + GET /api/me 统计与未读提示。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';

const now = Math.floor(Date.now() / 1000);
const AUTHOR = { uid: 1, gid: 1, username: 'admin', avatar: 7, password: 'x', salt: '', token_version: 0, email: 'a@b.c' };

function onlineRows(): SqlRule[] {
  return [
    { test: /SELECT v FROM bbs_kv/, first: { v: JSON.stringify({ runlevel: 5 }) } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    {
      test: /FROM bbs_session s INNER JOIN bbs_user/,
      rows: [{ uid: 1, fid: 0, url: '/thread/9', ip: 16909060, last_date: now, username: 'admin', gid: 1, avatar: 7 }],
    },
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_session/, first: { c: 7 } },
  ];
}
function loginRows(): SqlRule[] {
  return [
    { test: /FROM bbs_session WHERE sid/, first: { uid: 1, last_date: now } },
    { test: /FROM bbs_user WHERE uid = \?/, first: AUTHOR },
    { test: /SELECT v FROM bbs_kv/, first: { v: JSON.stringify({ runlevel: 5 }) } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /FROM bbs_group/, rows: [{ gid: 1, name: '管理员' }] },
  ];
}

function makeEnv(over: SqlRule[] = []) {
  const { db, calls } = fakeD1Sql(over);
  return { env: { DB: db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost' } as never, calls };
}
const loginCookie = (): HeadersInit => ({ cookie: 'sid=sessA' });
async function jsonOf(res: Response) {
  return (await res.json()) as { code: number; data?: Record<string, unknown> };
}

beforeEach(() => l0Clear());

describe('GET /api/online（T4-2）', () => {
  it('游客：total=会话总数（含游客），列表无 ip_fmt', async () => {
    const { env, calls } = makeEnv(onlineRows());
    const body = await jsonOf(await app.request('/api/online', {}, env));
    expect(body.code).toBe(Code.OK);
    const d = body.data as { total: number; list: { username: string; ip_fmt?: string }[] };
    expect(d.total).toBe(7);
    expect(d.list[0]!.username).toBe('admin');
    expect(d.list[0]!.ip_fmt).toBeUndefined();
    expect(calls.some((c) => /FROM bbs_session s INNER JOIN bbs_user/.test(c.sql))).toBe(true);
  });

  it('summary=1：只回 total，不查 500 行会话、不解析访问者', async () => {
    const { env, calls } = makeEnv(onlineRows());
    const body = await jsonOf(await app.request('/api/online?summary=1', {}, env));
    expect(body.code).toBe(Code.OK);
    expect(body.data).toEqual({ total: 7 });
    // 少了这条查询才是路径真的变轻了（否则只是少序列化了 list）
    expect(calls.some((c) => /FROM bbs_session s INNER JOIN bbs_user/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /SELECT COUNT\(\*\) AS c FROM bbs_session/.test(c.sql))).toBe(true);
    // 游客本就不查 viewer；此处确认 summary 路径连 bbs_user 都不碰
    expect(calls.some((c) => /FROM bbs_user/.test(c.sql))).toBe(false);
  });

  it('summary=1 对登录用户同样跳过 viewer 解析（不为人数查 bbs_user）', async () => {
    const { env, calls } = makeEnv([
      { test: /SELECT COUNT\(\*\) AS c FROM bbs_session/, first: { c: 7 } },
      { test: /SELECT v FROM bbs_kv/, first: { v: JSON.stringify({ runlevel: 5 }) } },
      { test: /SELECT v FROM bbs_cache/, first: null },
    ]);
    const body = await jsonOf(await app.request('/api/online?summary=1', { headers: loginCookie() }, env));
    expect(body.data).toEqual({ total: 7 });
    expect(calls.some((c) => /FROM bbs_user/.test(c.sql))).toBe(false);
  });

  it('管理员（gid=1）：可见 ip_fmt（1.2.3.4）', async () => {
    const { env } = makeEnv([{ test: /FROM bbs_user WHERE uid = \?/, first: AUTHOR }, { test: /FROM bbs_session WHERE sid/, first: { uid: 1, last_date: now } }, ...onlineRows()]);
    const body = await jsonOf(await app.request('/api/online', { headers: loginCookie() }, env));
    const d = body.data as { list: { ip_fmt?: string }[] };
    expect(d.list[0]!.ip_fmt).toBe('1.2.3.4');
  });
});

describe('GET /api/me（T4-2）', () => {
  it('未登录 → NOT_LOGIN', async () => {
    const { env } = makeEnv(loginRows());
    const res = await app.request('/api/me', {}, env);
    expect((await jsonOf(res)).code).toBe(Code.NOT_LOGIN);
  });

  it('登录：返回统计 + 组名 + 未读新回帖', async () => {
    const { env } = makeEnv([
      { test: /vip_expire_at FROM bbs_user WHERE uid = \?/, first: { uid: 1, gid: 1, username: 'admin', avatar: 7, threads: 3, posts: 12, credits: 20, create_date: 1, login_date: now - 100, login_ip: 0, logins: 5, email: 'a@b.c', golds: 2, rmbs: 1, vip_expire_at: 0 } },
      { test: /FROM bbs_post p INNER JOIN bbs_thread/, first: { c: 4 } },
      ...loginRows(),
    ]);
    const body = await jsonOf(await app.request('/api/me', { headers: loginCookie() }, env));
    expect(body.code).toBe(Code.OK);
    const d = body.data as Record<string, number | string>;
    expect(d.username).toBe('admin');
    expect(d.group_name).toBe('管理员');
    expect(d.threads).toBe(3);
    expect(d.new_replies).toBe(4);
  });
});
