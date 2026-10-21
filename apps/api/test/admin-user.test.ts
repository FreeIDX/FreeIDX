import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';
import { issueAdminToken } from '../src/core/auth/admin';

const SECRET = 'admin-secret';
const PWH = '0123456789abcdef0123456789abcdef'; // 前端预哈希 32hex

function baseRules(): SqlRule[] {
  return [
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: JSON.stringify({ runlevel: 5 }) } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    /* PUT 改资料先读旧行做字段级 diff（仅更新变化字段） */
    { test: /SELECT uid,gid,email,username,ok FROM bbs_user WHERE uid = \?/, first: { uid: 9, gid: 101, email: 'old@x.c', username: 'oldname', ok: 1 } },
    { test: /SELECT gid,token_version FROM bbs_user/, first: { gid: 1, token_version: 0 } },
    /* 建号 gid 归属校验：目标用户组必须存在 */
    { test: /SELECT gid FROM bbs_group WHERE gid = \?/, first: { gid: 101 } },
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_user/, first: { c: 3 } },
    { test: /SELECT uid,gid,email,username FROM bbs_user WHERE uid = \?/, first: { uid: 5, gid: 101, email: 'a@b.co', username: 'old' } },
    { test: /SELECT uid,gid FROM bbs_user WHERE uid = \?/, first: { uid: 5, gid: 101 } },
    /* deleteUserCascade 级联删前的自定义头像探测（avatar>0 才有 R2 对象） */
    { test: /SELECT avatar FROM bbs_user WHERE uid = \?/, first: { avatar: 7 } },
    { test: /SELECT uid FROM bbs_user WHERE email = \? AND uid <> \?/, first: null },
    { test: /SELECT uid FROM bbs_user WHERE username = \? AND uid <> \?/, first: null },
    { test: /SELECT uid FROM bbs_user WHERE email = \?/, first: null },
    { test: /SELECT uid FROM bbs_user WHERE username = \?/, first: null },
    { test: /INSERT INTO bbs_user \(gid,email,username/, first: { uid: 9 } },
    { test: /SELECT uid,gid,username,avatar,threads,posts,credits,create_date,login_date,ok,v,avatar_auto,bgimg, email, create_ip FROM bbs_user/, rows: () => [{ uid: 9, email: 'x@y.z', create_ip: 16909060 }] },
    { test: /SELECT tid,fid FROM bbs_thread WHERE uid = \?/, rows: () => [{ tid: 101, fid: 1 }] },
    { test: /SELECT uid, COUNT\(\*\) AS c FROM bbs_post WHERE tid IN/, rows: () => [{ uid: 3, c: 2 }] },
    { test: /SELECT tid, COUNT\(\*\) AS c FROM bbs_post WHERE uid = \? AND isfirst = 0/, rows: () => [] },
    // 真删前收集附件 R2 key（core/purge.attachKeysBy*）
    { test: /SELECT filename FROM bbs_attach/, rows: [] },
    { test: /UPDATE bbs_/, rows: [] },
    { test: /DELETE FROM bbs_/, rows: [] },
  ];
}

function makeEnv(rs = baseRules()) {
  const { db, calls } = fakeD1Sql(rs);
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

describe('用户管理（T3-6）', () => {
  it('GET：分页列表', async () => {
    const { env } = makeEnv();
    const res = await app.request('/api/admin/users?page=1', { headers: { cookie: `admin_at=${await token()}` } }, env);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    expect((body.data as { total: number }).total).toBe(3);
    // 后台投影额外带 email + create_ip_fmt（16909060 → long2ip '1.2.3.4'）
    const first = (body.data as { list: Record<string, unknown>[] }).list[0]!;
    expect(first.email).toBe('x@y.z');
    expect(first.create_ip_fmt).toBe('1.2.3.4');
  });

  it('POST：建号写 PBKDF2 口令', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/admin/users', { method: 'POST', headers: wh(await token()), body: JSON.stringify({ email: 'new@user.com', username: 'newbie', password: PWH, gid: 101 }) }, env);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    expect((body.data as { uid: number }).uid).toBe(9);
    const ins = calls.find((c) => /INSERT INTO bbs_user/.test(c.sql));
    expect(ins).toBeTruthy();
    expect(String(ins?.params[3])).toContain('pbkdf2'); // 非明文，PBKDF2 编码串
  });

  it('POST：邮箱重复 → FORM_EMAIL_EXISTS', async () => {
    const rs = baseRules();
    const dup = rs.find((x) => String(x.test) === '/SELECT uid FROM bbs_user WHERE email = \\?/')!;
    dup.first = { uid: 42 };
    const { env, calls } = makeEnv(rs);
    const res = await app.request('/api/admin/users', { method: 'POST', headers: wh(await token()), body: JSON.stringify({ email: 'dup@user.com', username: 'ok', password: PWH }) }, env);
    expect((await jsonOf(res)).code).toBe(Code.FORM_EMAIL_EXISTS);
    expect(calls.some((c) => /INSERT INTO bbs_user/.test(c.sql))).toBe(false);
  });

  it('PUT：仅改 gid → 动态 SET + 失效 user 缓存', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/admin/users/5', { method: 'PUT', headers: wh(await token()), body: JSON.stringify({ gid: 102 }) }, env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const upd = calls.find((c) => /UPDATE bbs_user SET/.test(c.sql));
    expect(upd?.sql).toBe('UPDATE bbs_user SET gid = ? WHERE uid = ?');
  });

  it('PUT：改用户名 → 反规范化回写 thread.username/lastusername（§5.2/§20.2 承诺落地）', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/admin/users/5', { method: 'PUT', headers: wh(await token()), body: JSON.stringify({ username: 'newname' }) }, env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    // 楼主名快照：WHERE uid 命中该用户全部主题，`<> 新值` 守卫省 rows_written
    const un = calls.find((c) => /UPDATE bbs_thread SET username = \? WHERE uid = \? AND username <> \?/.test(c.sql));
    expect(un?.params).toEqual(['newname', 5, 'newname']);
    // 最后回复人快照：WHERE lastuid 命中该用户作为最后回复人的主题
    const lu = calls.find((c) => /UPDATE bbs_thread SET lastusername = \? WHERE lastuid = \? AND lastusername <> \?/.test(c.sql));
    expect(lu?.params).toEqual(['newname', 5, 'newname']);
    // §20.2 C 档：改名同时入队 SEO 重建（seo/{tid}.html 烧录旧名，由 cron 每小时档消费）
    const enqueue = calls.find((c) => /REPLACE INTO bbs_kv/.test(c.sql) && String(c.params[0]) === 'seo:rename-pending');
    expect(enqueue).toBeTruthy();
    expect(JSON.parse(String(enqueue?.params[1] ?? '[]'))).toEqual([{ uid: 5, cursor: 0 }]);
  });

  it('PUT：无变化字段 → VALIDATION_ERROR', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/admin/users/5', { method: 'PUT', headers: wh(await token()), body: JSON.stringify({ gid: 101 }) }, env);
    expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
    expect(calls.some((c) => /UPDATE bbs_user SET/.test(c.sql))).toBe(false);
  });

  it('DELETE：gid=1 管理员拒绝删除', async () => {
    const rs = baseRules();
    rs.find((r) => /SELECT uid,gid FROM bbs_user WHERE uid/.test(String(r.test)))!.first = { uid: 1, gid: 1 };
    const { env, calls } = makeEnv(rs);
    const res = await app.request('/api/admin/users/1', { method: 'DELETE', headers: wh(await token()) }, env);
    expect((await jsonOf(res)).code).toBe(Code.NO_PERMISSION);
    expect(calls.some((c) => /DELETE FROM bbs_user/.test(c.sql))).toBe(false);
  });

  it('DELETE：普通用户级联删', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/admin/users/5', { method: 'DELETE', headers: wh(await token()) }, env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    expect(calls.some((c) => /DELETE FROM bbs_user WHERE uid = \?/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /DELETE FROM bbs_thread WHERE uid = \?/.test(c.sql))).toBe(true);
    // 他人被删主题内的附件按 tid 清理，避免孤儿附件
    expect(calls.some((c) => /DELETE FROM bbs_attach WHERE tid IN/.test(c.sql))).toBe(true);
    // 倒排（收藏/回帖索引）同样按 tid 清理：漏掉会留下指向已删主题的孤儿行
    expect(calls.some((c) => /DELETE FROM bbs_mypost WHERE tid IN/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /DELETE FROM bbs_mythread WHERE tid IN/.test(c.sql))).toBe(true);
    // R2 对象侧：删除前先收集附件 key（本人上传 + 本人主题内他人上传），随后尽力删除
    expect(calls.some((c) => /SELECT filename FROM bbs_attach WHERE uid = \? OR tid IN/.test(c.sql))).toBe(true);
    // 自定义头像对象一并清理（avatar>0 → avatar/{3位}/{uid}.png 加入 R2 删除清单）
    expect(calls.some((c) => /SELECT avatar FROM bbs_user/.test(c.sql))).toBe(true);
    // runtime.users 无校准兜底 → 删用户即时回退（写 runtime 缓存）
    expect(calls.some((c) => /REPLACE INTO bbs_cache/.test(c.sql) && JSON.stringify(c.params).includes('runtime'))).toBe(true);
  });
});
