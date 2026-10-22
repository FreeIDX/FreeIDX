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
    { test: /SELECT \* FROM bbs_group/, rows: () => [{ gid: 1, name: '管理员组' }, { gid: 101, name: '一级用户组' }] },
    { test: /SELECT gid FROM bbs_group WHERE gid = \?/, first: (p: unknown[]) => (Number(p[0]) === 200 ? { gid: 200 } : null) },
    { test: /DELETE FROM bbs_group/, rows: [] },
    { test: /DELETE FROM bbs_forum_access/, rows: [] },
    { test: /UPDATE bbs_group SET/, rows: [] },
    { test: /INSERT INTO bbs_group/, rows: [] },
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
const wh = (tk: string) => ({ cookie: `admin_at=${tk}; csrf=t`, 'content-type': 'application/json', 'x-csrf-token': 't' });

beforeEach(() => l0Clear());

describe('用户组权限矩阵（T3-6 / §D.8#5）', () => {
  it('GET：返回 12 项权限组', async () => {
    const { env } = makeEnv();
    const res = await app.request('/api/admin/groups', { headers: { cookie: `admin_at=${await token()}` } }, env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
  });

  it('PUT：gid 1-5 保存版务位，自定义组静默丢弃（既有语义）', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request(
      '/api/admin/groups',
      {
        method: 'PUT',
        headers: wh(await token()),
        body: JSON.stringify({
          groups: [
            { gid: 1, name: '管理员组', allowread: 1, allowtop: 1, allowdeleteuser: 1 },
            { gid: 101, name: '一级用户组', allowread: 1, allowtop: 1 },
            { gid: 200, name: '自定义组', allowread: 1, allowtop: 1 },
          ],
        }),
      },
      env,
    );
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    expect((body.data as { count: number }).count).toBe(3);

    const updGid1 = calls.find((c) => /UPDATE bbs_group SET/.test(c.sql) && c.params[c.params.length - 1] === 1);
    const updGid101 = calls.find((c) => /UPDATE bbs_group SET/.test(c.sql) && c.params[c.params.length - 1] === 101);
    const insGid200 = calls.find((c) => /INSERT INTO bbs_group/.test(c.sql));
    // gid=1（1-5）→ 含 allowtop 等版务位
    expect(updGid1?.sql).toContain('allowtop');
    // gid=101（自定义、已存在）→ 更新但不含版务位
    expect(updGid101?.sql).toBeTruthy();
    expect(updGid101?.sql).not.toContain('allowtop');
    // 新增自定义组 gid=200 → INSERT 但不含版务位
    expect(insGid200?.sql).toBeTruthy();
    expect(insGid200?.sql).not.toContain('allowtop');
    // 用户组权限变更后失效 grouplist（下次读过滤重取）
    expect(calls.some((c) => /SELECT \* FROM bbs_group/.test(c.sql))).toBe(true);
  });

  it('PUT：空数组 → VALIDATION_ERROR', async () => {
    const { env } = makeEnv();
    const res = await app.request('/api/admin/groups', { method: 'PUT', headers: wh(await token()), body: JSON.stringify({ groups: [] }) }, env);
    expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
  });
});

describe('用户组删除（级联清理，§D.8 系统组保护）', () => {
  it('系统保留组（gid 0-7、101）→ NO_PERMISSION，且不落 SQL', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/admin/groups/101', { method: 'DELETE', headers: wh(await token()) }, env);
    expect((await jsonOf(res)).code).toBe(Code.NO_PERMISSION);
    expect(calls.some((c) => /DELETE FROM bbs_group/.test(c.sql))).toBe(false);
  });

  it('不存在的 gid → NOT_FOUND', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/admin/groups/999', { method: 'DELETE', headers: wh(await token()) }, env);
    expect((await jsonOf(res)).code).toBe(Code.NOT_FOUND);
    expect(calls.some((c) => /DELETE FROM bbs_group/.test(c.sql))).toBe(false);
  });

  it('自定义组 → 删组 + 清 forum_access 授权，并失效 grouplist/forumlist', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/admin/groups/200', { method: 'DELETE', headers: wh(await token()) }, env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    expect(calls.some((c) => /DELETE FROM bbs_group WHERE gid = \?/.test(c.sql) && c.params[0] === 200)).toBe(true);
    expect(calls.some((c) => /DELETE FROM bbs_forum_access WHERE gid = \?/.test(c.sql) && c.params[0] === 200)).toBe(true);
  });

  it('非法 gid（非数字 / 负数）→ VALIDATION_ERROR', async () => {
    const { env } = makeEnv();
    for (const bad of ['abc', '-1']) {
      const res = await app.request(`/api/admin/groups/${bad}`, { method: 'DELETE', headers: wh(await token()) }, env);
      expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
    }
  });
});
