import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';
import { issueAdminToken } from '../src/core/auth/admin';
import { ipToLong } from '../src/core/auth/session';

const SECRET = 'admin-secret';
const SETTING = JSON.stringify({ runlevel: 5 });

function rules(): SqlRule[] {
  return [
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: SETTING } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /SELECT gid,token_version FROM bbs_user/, first: { gid: 1, token_version: 0 } },
    { test: /INSERT INTO bbs_forum \(name/, first: { fid: 5 } },
    { test: /SELECT fid,icon_file FROM bbs_forum WHERE fid = \?/, first: { fid: 8, icon_file: '' } },
    { test: /SELECT fid FROM bbs_forum WHERE fid = \?/, first: { fid: 8 } },
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_forum WHERE parent_fid = \?/, first: { c: 0 } },
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_forum WHERE fid = \? AND parent_fid = 0/, first: { c: 1 } },
    { test: /UPDATE bbs_forum SET/, rows: [] },
    { test: /INSERT OR REPLACE INTO bbs_forum_access/, rows: [] },
    { test: /SELECT .* FROM bbs_forum ORDER BY/, rows: () => [{ fid: 8, name: '综合', accesson: 0, rank: 1, threads: 0 }] },
    { test: /SELECT fid,gid,allowread[\s\S]*FROM bbs_forum_access/, rows: () => [] },
    { test: /SELECT \* FROM bbs_group/, rows: () => [{ gid: 1 }, { gid: 3 }] },
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_thread/, first: { c: 42 } },
    { test: /SELECT tid,fid,uid,username,avatar,subject,posts[\s\S]*FROM bbs_thread[\s\S]*ORDER BY tid DESC/, rows: () => [{ tid: 101, fid: 8, subject: '示例主题' }] },
    { test: /SELECT tid,uid FROM bbs_thread WHERE fid = \?/, rows: () => [{ tid: 101, uid: 7 }] },
    { test: /SELECT uid, COUNT\(\*\) AS c FROM bbs_post WHERE tid IN/, rows: () => [{ uid: 7, c: 3 }] },
    // 真删前收集附件 R2 key（core/purge.attachKeysBy*）
    { test: /SELECT filename FROM bbs_attach/, rows: [] },
    { test: /UPDATE bbs_user SET/, rows: [] },
    { test: /DELETE FROM bbs_/, rows: [] },
  ];
}

interface Env { JWT_SECRET: string; SITE_URL: string; DB: unknown; CACHE: unknown; FILES: unknown }
function makeEnv() {
  const { db, calls } = fakeD1Sql(rules());
  const kv = fakeKv();
  return { env: { JWT_SECRET: SECRET, SITE_URL: 'http://localhost', DB: db, CACHE: kv, FILES: {} } as Env, calls, kv };
}
async function token(): Promise<string> {
  return issueAdminToken(SECRET, 1, 0);
}
async function jsonOf(res: Response) {
  return (await res.json()) as { code: number; message: string } & Record<string, unknown>;
}
const writeHeaders = (tk: string) => ({
  cookie: `admin_at=${tk}; csrf=t`,
  'content-type': 'application/json',
  'x-csrf-token': 't',
});

beforeEach(() => l0Clear());

describe('版块管理 CRUD（T3-5）', () => {
  it('GET：返回版块 + 用户组', async () => {
    const { env } = makeEnv();
    const res = await app.request('/api/admin/forums', { headers: { cookie: `admin_at=${await token()}` } }, env as never);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    const data = body.data as { forums: unknown[]; groups: unknown[] };
    expect(data.forums.length).toBe(1);
    expect(data.groups.length).toBe(2);
  });

  it('POST：创建版块 RETURNING fid，写 access 矩阵并清 forumlist 缓存', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request(
      '/api/admin/forums',
      { method: 'POST', headers: writeHeaders(await token()), body: JSON.stringify({ name: '新手区', accesson: 1, access: [{ gid: 3, allowread: 1, allowpost: 1 }] }) },
      env as never,
    );
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    expect((body.data as { fid: number }).fid).toBe(5);
    expect(calls.some((c) => /INSERT INTO bbs_forum \(name/.test(c.sql))).toBe(true);
    const acc = calls.find((c) => /INSERT OR REPLACE INTO bbs_forum_access/.test(c.sql));
    expect(acc).toBeTruthy();
    expect(acc?.params).toEqual([5, 3, 1, 0, 1, 0, 0]);
  });

  it('POST：空版块名 → VALIDATION_ERROR', async () => {
    const { env } = makeEnv();
    const res = await app.request(
      '/api/admin/forums',
      { method: 'POST', headers: writeHeaders(await token()), body: JSON.stringify({ name: '   ' }) },
      env as never,
    );
    expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
  });

  it('PUT：更新 + 整表替换 access 矩阵（先删后插）', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request(
      '/api/admin/forums/8',
      { method: 'PUT', headers: writeHeaders(await token()), body: JSON.stringify({ name: '综合区', access: [{ gid: 3, allowread: 1 }] }) },
      env as never,
    );
    expect((await jsonOf(res)).code).toBe(Code.OK);
    expect(calls.some((c) => /UPDATE bbs_forum SET/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /DELETE FROM bbs_forum_access/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /INSERT OR REPLACE INTO bbs_forum_access/.test(c.sql))).toBe(true);
  });

  it('PUT：不存在 → NOT_FOUND', async () => {
    const rs: SqlRule[] = rules();
    // 令存在性查询返回 null
    const idx = rs.findIndex((r) => /SELECT fid FROM bbs_forum WHERE/.test(r.test.source));
    rs[idx] = { test: /SELECT fid FROM bbs_forum WHERE fid = \?/, first: null };
    const { db, calls } = fakeD1Sql(rs);
    const res = await app.request(
      '/api/admin/forums/999',
      { method: 'PUT', headers: writeHeaders(await token()), body: JSON.stringify({ name: 'x' }) },
      { JWT_SECRET: SECRET, SITE_URL: 'http://localhost', DB: db, CACHE: fakeKv(), FILES: {} } as never,
    );
    expect((await jsonOf(res)).code).toBe(Code.NOT_FOUND);
    expect(calls.some((c) => /UPDATE bbs_forum SET/.test(c.sql))).toBe(false);
  });

  it('DELETE：级联删主题/回帖并回退计数', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/admin/forums/8', { method: 'DELETE', headers: writeHeaders(await token()) }, env as never);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    expect((body.data as { threads: number }).threads).toBe(1);
    expect(calls.some((c) => /UPDATE bbs_user SET posts/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /UPDATE bbs_user SET threads/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /DELETE FROM bbs_thread WHERE fid = \?/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /DELETE FROM bbs_forum WHERE fid = \?/.test(c.sql))).toBe(true);
  });

  it('DoD：改权限后立即清 forumlist 缓存 → 下次读取重新装配 accesslist', async () => {
    const { env, calls } = makeEnv();
    const tk = await token();
    // forumlist 现在落 L2（D1 bbs_cache 表）而非 L1(KV)：KV 写/删各 1,000 次/天且同 key 1 次/秒，
    // 而 forumlist 会随每次发帖/回帖失效 → 放 KV 时「1,000 帖/天」即打满额度并让发帖 500。
    const cachedForumlist = () => calls.filter((c) => /REPLACE INTO bbs_cache/.test(c.sql) && String(c.params[0]) === 'forumlist');
    const invalidated = () => calls.filter((c) => /DELETE FROM bbs_cache WHERE k = \?/.test(c.sql) && String(c.params[0]) === 'forumlist');
    // 先 GET 令 forumlist 落入 L2
    await app.request('/api/admin/forums', { headers: { cookie: `admin_at=${tk}` } }, env as never);
    expect(cachedForumlist().length).toBeGreaterThan(0);
    const cacheWritesBefore = cachedForumlist().length;
    // PUT 改权限 → forumlist 失效（L2 行删除）
    await app.request(
      '/api/admin/forums/8',
      { method: 'PUT', headers: writeHeaders(tk), body: JSON.stringify({ name: '综合区', accesson: 1, access: [{ gid: 3, allowread: 1 }] }) },
      env as never,
    );
    expect(invalidated().length).toBeGreaterThan(0);
    // 再次 GET 触发重装配（读过滤反映新权限）
    await app.request('/api/admin/forums', { headers: { cookie: `admin_at=${tk}` } }, env as never);
    expect(cachedForumlist().length).toBeGreaterThan(cacheWritesBefore);
  });
});

describe('二级版块（0018_forum_parent）', () => {
  const envOf = (rs: SqlRule[]) => {
    const { db, calls } = fakeD1Sql(rs);
    return { env: { JWT_SECRET: SECRET, SITE_URL: 'http://localhost', DB: db, CACHE: fakeKv(), FILES: {} } as never, calls };
  };
  const withRule = (rs: SqlRule[], re: RegExp, replace: SqlRule): SqlRule[] => {
    const i = rs.findIndex((r) => re.test(r.test.source));
    rs[i] = replace;
    return rs;
  };

  it('POST：父版块不是一级版块 → VALIDATION_ERROR，不插入', async () => {
    const rs = withRule(rules(), /AND parent_fid = 0/, {
      test: /SELECT COUNT\(\*\) AS c FROM bbs_forum WHERE fid = \? AND parent_fid = 0/,
      first: { c: 0 },
    });
    const { env, calls } = envOf(rs);
    const res = await app.request(
      '/api/admin/forums',
      { method: 'POST', headers: writeHeaders(await token()), body: JSON.stringify({ name: '子版', parent_fid: 9 }) },
      env,
    );
    expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
    expect(calls.some((c) => /INSERT INTO bbs_forum \(name/.test(c.sql))).toBe(false);
  });

  it('PUT：设置合法一级父版块 → UPDATE 带 parent_fid', async () => {
    const { env, calls } = envOf(rules());
    const res = await app.request(
      '/api/admin/forums/8',
      { method: 'PUT', headers: writeHeaders(await token()), body: JSON.stringify({ name: '子版', parent_fid: 5 }) },
      env,
    );
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const upd = calls.find((c) => /UPDATE bbs_forum SET/.test(c.sql));
    expect(upd?.sql).toContain('parent_fid=?');
    expect(upd?.params?.at(-2)).toBe(5);
  });

  it('PUT：已有子版块的版块改为子版块 → 阻止（避免三级）', async () => {
    const rs = withRule(rules(), /FROM bbs_forum WHERE parent_fid/, {
      test: /SELECT COUNT\(\*\) AS c FROM bbs_forum WHERE parent_fid = \?/,
      first: { c: 1 },
    });
    const { env, calls } = envOf(rs);
    const res = await app.request(
      '/api/admin/forums/8',
      { method: 'PUT', headers: writeHeaders(await token()), body: JSON.stringify({ name: 'x', parent_fid: 5 }) },
      env,
    );
    expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
    expect(calls.some((c) => /UPDATE bbs_forum SET/.test(c.sql))).toBe(false);
  });

  it('DELETE：仍有子版块 → 阻止删除且不发 DELETE', async () => {
    const rs = withRule(rules(), /FROM bbs_forum WHERE parent_fid/, {
      test: /SELECT COUNT\(\*\) AS c FROM bbs_forum WHERE parent_fid = \?/,
      first: { c: 2 },
    });
    const { env, calls } = envOf(rs);
    const res = await app.request('/api/admin/forums/8', { method: 'DELETE', headers: writeHeaders(await token()) }, env);
    expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
    expect(calls.some((c) => /DELETE FROM bbs_forum WHERE fid = \?/.test(c.sql))).toBe(false);
  });
});

describe('主题管理列表（T3-5）', () => {
  it('GET：keyword 过滤 + 分页元信息', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/admin/threads?keyword=%E7%A4%BA%E4%BE%8B&page=2&size=20', { headers: { cookie: `admin_at=${await token()}` } }, env as never);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    const data = body.data as { total: number; page: number; totalPage: number; list: unknown[] };
    expect(data.total).toBe(42);
    expect(data.page).toBe(2);
    expect(data.list.length).toBe(1);
    const listCall = calls.find((c) => /ORDER BY tid DESC/.test(c.sql));
    expect(listCall?.sql).toContain('subject LIKE ?');
  });

  it('GET：uid/create_ip/top/closed/digest/since/until 并进同一个 where（0 值参与过滤，count 与 list 共用条件）', async () => {
    const { env, calls } = makeEnv();
    const qs =
      '/api/admin/threads?fid=8&keyword=%E7%A4%BE&uid=7&create_ip=1.2.3.4&top=1&closed=0&digest=2&since=1700000000&until=1700003600';
    const res = await app.request(qs, { headers: { cookie: `admin_at=${await token()}` } }, env as never);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const expectedWhere =
      ' WHERE fid = ? AND subject LIKE ? AND uid = ? AND userip = ? AND top = ? AND closed = ? AND digest = ?' +
      ' AND create_date >= ? AND create_date <= ?';
    // 主题管理列表的 IP 条件是整数列 userip（bbs_thread 无 create_ip 列）
    const expectedParams = [8, '%社%', 7, ipToLong('1.2.3.4'), 1, 0, 2, 1700000000, 1700003600];
    const cnt = calls.find((c) => /SELECT COUNT\(\*\) AS c FROM bbs_thread/.test(c.sql));
    expect(cnt?.sql).toContain(expectedWhere);
    expect(cnt?.params).toEqual(expectedParams);
    const list = calls.find((c) => /ORDER BY tid DESC/.test(c.sql));
    expect(list?.sql).toContain(expectedWhere);
    expect(list?.params).toEqual([...expectedParams, 20, 0]);
  });

  it('GET：非法 create_ip（IPv6/串）不作为 0 过滤，免误命中无 IP 存量行', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/admin/threads?create_ip=2001%3Adb8%3A%3A1', { headers: { cookie: `admin_at=${await token()}` } }, env as never);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const cnt = calls.find((c) => /SELECT COUNT\(\*\) AS c FROM bbs_thread/.test(c.sql));
    expect(cnt?.sql).not.toContain('userip');
    expect(cnt?.params).toEqual([]);
  });
});
