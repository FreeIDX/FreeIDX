import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';
import { issueAdminToken } from '../src/core/auth/admin';

const SECRET = 'admin-secret';

function rules(): SqlRule[] {
  return [
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: JSON.stringify({ runlevel: 5 }) } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /SELECT gid,token_version FROM bbs_user/, first: { gid: 1, token_version: 0 } },
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_modlog/, first: { c: 7 } },
    { test: /SELECT logid,uid,tid,pid,subject,comment,action,create_date FROM bbs_modlog/, rows: () => [{ logid: 7, uid: 1, action: 'top' }] },
    { test: /SELECT \(SELECT COUNT\(\*\) FROM bbs_user\) AS users/, first: { users: 12, threads: 34, posts: 56 } },
    { test: /SELECT SUM\(todaythreads\)/, first: { todaythreads: 2, todayposts: 5 } },
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_session WHERE last_date > \?/, first: { c: 3 } },
    {
      test: /SELECT \(SELECT COUNT\(\*\) FROM bbs_attach\)/,
      first: { attachs: 9, todayusers: 4 },
    },
    {
      test: /SELECT gid, COUNT\(\*\) AS c FROM bbs_user GROUP BY gid/,
      rows: () => [
        { gid: 1, c: 2 },
        { gid: 4, c: 5 },
        { gid: 101, c: 30 },
        { gid: 106, c: 3 },
      ],
    },
    {
      test: /SELECT uid,username,avatar,gid FROM bbs_user WHERE gid BETWEEN/,
      rows: () => [
        { uid: 40, username: 'mod4', avatar: 1700, gid: 4 },
        { uid: 12, username: 'admin2', avatar: 0, gid: 1 },
        { uid: 11, username: 'admin1', avatar: 5, gid: 1 },
      ],
    },
    {
      test: /SELECT \* FROM bbs_group/,
      rows: () => [
        { gid: 1, name: '管理员' },
        { gid: 4, name: '版主' },
        { gid: 101, name: '普通会员' },
        { gid: 106, name: 'VIP' },
      ],
    },
  ];
}
function makeEnv() {
  const { db, calls } = fakeD1Sql(rules());
  return { env: { JWT_SECRET: SECRET, SITE_URL: 'http://localhost', DB: db, CACHE: fakeKv(), FILES: {} } as never, calls };
}
async function token() {
  return issueAdminToken(SECRET, 1, 0);
}
async function jsonOf(res: Response) {
  return (await res.json()) as { code: number } & Record<string, unknown>;
}

beforeEach(() => l0Clear());

describe('modlog 面板（T3-7）', () => {
  it('GET：分页返回版务日志', async () => {
    const { env } = makeEnv();
    const res = await app.request('/api/admin/modlogs?page=1', { headers: { cookie: `admin_at=${await token()}` } }, env);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    const d = body.data as { total: number; list: unknown[] };
    expect(d.total).toBe(7);
    expect(d.list.length).toBe(1);
  });
});

describe('runtime 统计面板 + 三预算实测（T3-7 DoD：面板数值与 D1 实测一致）', () => {
  it('GET：全站/今日/在线计数 + 管理组/用户分布 + 服务器信息 + budget 段反映本请求真实查询数', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/admin/runtime', { headers: { cookie: `admin_at=${await token()}` } }, env);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    const d = body.data as {
      totals: { users: number; threads: number; posts: number; attachs: number };
      today: { threads: number; posts: number; users: number };
      online: number;
      groups: { gid: number; name: string; count: number; users: { uid: number; username: string; avatar: number }[] }[];
      server: { client_ip: string };
      budget: { d1_queries: number; subrequests: number; limits: Record<string, number> };
    };
    expect(d.totals).toEqual({ users: 12, threads: 34, posts: 56, attachs: 9 });
    expect(d.today).toEqual({ threads: 2, posts: 5, users: 4 });
    expect(d.online).toBe(3);
    // 管理组表（gid<=7）带 top 会员（uid 倒序），用户分布组（gid>100）只给人数
    expect(d.groups).toEqual([
      { gid: 1, name: '管理员', count: 2, users: [{ uid: 12, username: 'admin2', avatar: 0 }, { uid: 11, username: 'admin1', avatar: 5 }] },
      { gid: 4, name: '版主', count: 5, users: [{ uid: 40, username: 'mod4', avatar: 1700 }] },
      { gid: 101, name: '普通会员', count: 30, users: [] },
      { gid: 106, name: 'VIP', count: 3, users: [] },
    ]);
    // D1 禁用 sqlite_version()（真实实例报 "not authorized to use function"），面板只回静态标签 → 守住它不再混进 SQL
    expect(calls.some((x) => /sqlite_version\s*\(/i.test(x.sql))).toBe(false);
    expect(d.server.client_ip).toBe('0.0.0.0');
    // 面板 budget 与请求内 D1b 计数一致：本请求 SELECT 每计 1 查询/1 子请求
    expect(d.budget.d1_queries).toBeGreaterThan(0);
    expect(d.budget.d1_queries).toBe(d.budget.subrequests);
    expect(d.budget.limits.hard_d1_queries).toBe(50);
  });
});

describe('缓存一键清空（T3-7）', () => {
  it('POST：清 L1/L2 核心缓存键', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request(
      '/api/admin/cache/clear',
      { method: 'POST', headers: { cookie: `admin_at=${await token()}; csrf=t`, 'content-type': 'application/json', 'x-csrf-token': 't' } },
      env,
    );
    expect((await jsonOf(res)).code).toBe(Code.OK);
    // forumlist / runtime 属 L2 → 触发 bbs_cache 删除
    expect(calls.filter((c) => /DELETE FROM bbs_cache/.test(c.sql)).length).toBeGreaterThanOrEqual(2);
  });
});
