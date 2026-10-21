import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';

const now = () => Math.floor(Date.now() / 1000);
const SETTING = JSON.stringify({ runlevel: 5, sitename: 'F', url: 'http://localhost', forum_orderby: 0, update_views_on: 1, upload_max_size: 1048576, lang: 'zh-cn' });

const GROUP_ADMIN = { gid: 1, name: '管理员', creditsfrom: 0, creditsto: 0, allowread: 1, allowthread: 1, allowpost: 1, allowattach: 1, allowdown: 1, allowtop: 1, allowupdate: 1, allowdelete: 1, allowmove: 1, allowdeleteuser: 1, allowviewip: 1 };
const GROUP_MEMBER = { gid: 101, name: '会员', creditsfrom: 0, creditsto: 200, allowread: 1, allowthread: 1, allowpost: 1, allowattach: 0, allowdown: 0, allowtop: 0, allowupdate: 0, allowdelete: 0, allowmove: 0, allowdeleteuser: 0, allowviewip: 0 };
const FORUM1 = { fid: 1, name: '版块', rank: 1, threads: 2, todayposts: 0, todaythreads: 0, brief: '', announcement: '', accesson: 0, orderby: 0, icon: 0, moduids: '', seo_title: '', seo_keywords: '' };
const ADMIN = { uid: 1, gid: 1, username: 'admin', avatar: 7, password: 'x', salt: '', token_version: 0, email: 'a@b.c', threads: 2, posts: 5 };
const MEMBER = { uid: 5, gid: 101, username: 'member', avatar: 0, password: 'x', salt: '', token_version: 0, email: 'm@b.c', threads: 2, posts: 1 };

function deleteRules(): SqlRule[] {
  return [
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: SETTING } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /FROM bbs_forum ORDER BY/, rows: [FORUM1] },
    { test: /bbs_forum_access/, rows: [] },
    { test: /FROM bbs_group/, rows: [GROUP_ADMIN, GROUP_MEMBER] },
    { test: /FROM bbs_session WHERE sid/, first: (p: readonly unknown[]) => ({ uid: Number(p[0]) === 0 ? 0 : 1, last_date: now() }) },
    // 查看者 uid=1→ADMIN；目标 uid=5→MEMBER（gid<6 保护用例改此绑定）
    { test: /FROM bbs_user WHERE uid = \?/, first: (p: readonly unknown[]) => (Number(p[0]) === 5 ? MEMBER : ADMIN) },
    // 批量升组读取（upgradeGroupsByCredits）：与上面单条读取同源（受影响作者 gid=1 → 不换组）
    { test: /SELECT uid,gid,credits FROM bbs_user WHERE uid IN/, rows: (p: readonly unknown[]) => p.map((u) => ({ uid: Number(u), gid: 1, credits: 0 })) },
    { test: /SELECT tid,fid FROM bbs_thread WHERE uid = \?/, rows: [{ tid: 9, fid: 1 }, { tid: 10, fid: 1 }] },
    { test: /SELECT uid, COUNT\(\*\) AS c FROM bbs_post WHERE tid IN.*AND uid <> \?.*GROUP BY uid/, rows: [{ uid: 3, c: 2 }] },
    // 删除回扣楼层列表（user_delete → thread_delete → post_delete_by_tid）
    { test: /SELECT pid,uid FROM bbs_post WHERE tid IN.*AND isfirst = 0 AND uid <> \?/, rows: [{ pid: 101, uid: 3 }] },
    // userPurgeStmts：他主题内回帖的 thread.posts 回退（B1 后仅统计已过审回帖）
    { test: /SELECT tid, COUNT\(\*\) AS c FROM bbs_post WHERE uid = \? AND isfirst = 0 AND ok = 1 GROUP BY tid/, rows: [{ tid: 20, c: 1 }] },
    // 真删前收集附件 R2 key（core/purge.attachKeysBy*）
    { test: /SELECT filename FROM bbs_attach/, rows: [] },
    { test: /UPDATE bbs_|DELETE FROM bbs_|INSERT/, rows: [] },
  ];
}

function replyRules(): SqlRule[] {
  return [
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: SETTING } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /FROM bbs_forum ORDER BY/, rows: [FORUM1] },
    { test: /bbs_forum_access/, rows: [] },
    { test: /FROM bbs_group/, rows: [GROUP_ADMIN, GROUP_MEMBER] },
    { test: /FROM bbs_session WHERE sid/, first: (p: readonly unknown[]) => (Number(p[0]) === 0 ? null : { uid: 1, last_date: now() }) },
    { test: /FROM bbs_user WHERE uid = \?/, first: () => ADMIN },
    {
      test: /FROM bbs_mypost mp JOIN bbs_post p ON/,
      rows: [
        { pid: 100, tid: 9, uid: 5, subject: '主题九', fid: 1, top: 0, message_fmt: '<p>回复内容</p>', create_date: 1700000000 },
        { pid: 90, tid: 10, uid: 5, subject: '主题十', fid: 1, top: 1, message_fmt: '<p>另一回复</p>', create_date: 1699999000 },
      ],
    },
  ];
}

interface Res { env: unknown; calls: { sql: string; params: readonly unknown[] }[] }
function makeEnv(rules: SqlRule[]): Res {
  const { db, calls } = fakeD1Sql(rules);
  return { env: { DB: db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost' }, calls };
}
const authed = (): HeadersInit => ({ 'content-type': 'application/json', cookie: 'sid=sessA; csrf=tok', 'x-csrf-token': 'tok' });
const guest = (): HeadersInit => ({ 'content-type': 'application/json', cookie: 'csrf=tok', 'x-csrf-token': 'tok' });
async function jsonOf(res: Response) {
  return (await res.json()) as { code: number; message: string } & Record<string, unknown>;
}
const sqls = (r: Res) => r.calls.map((c) => c.sql).join('\n');

beforeEach(() => l0Clear());

describe('版务删用户（T3-2）', () => {
  it('未登录 → NOT_LOGIN', async () => {
    const r = makeEnv(deleteRules());
    expect((await jsonOf(await app.request('/api/mod/users/5', { method: 'DELETE', headers: guest() }, r.env as never))).code).toBe(Code.NOT_LOGIN);
  });

  it('查看者组无 allowdeleteuser → NO_PERMISSION', async () => {
    const rules = deleteRules();
    rules.find((x) => /bbs_user WHERE uid/.test(x.test.source))!.first = (p: readonly unknown[]) => (Number(p[0]) === 1 ? { ...ADMIN, gid: 101 } : MEMBER);
    const r = makeEnv(rules);
    expect((await jsonOf(await app.request('/api/mod/users/5', { method: 'DELETE', headers: authed() }, r.env as never))).code).toBe(Code.NO_PERMISSION);
  });

  it('目标 gid<6 管理组 → 拒绝删除', async () => {
    const rules = deleteRules();
    rules.find((x) => /bbs_user WHERE uid/.test(x.test.source))!.first = (p: readonly unknown[]) => (Number(p[0]) === 5 ? { ...MEMBER, gid: 4 } : ADMIN);
    const r = makeEnv(rules);
    expect((await jsonOf(await app.request('/api/mod/users/5', { method: 'DELETE', headers: authed() }, r.env as never))).code).toBe(Code.NO_PERMISSION);
  });

  it('目标不存在 → NOT_FOUND', async () => {
    const rules = deleteRules();
    rules.find((x) => /bbs_user WHERE uid/.test(x.test.source))!.first = (p: readonly unknown[]) => (Number(p[0]) === 5 ? null : ADMIN);
    const r = makeEnv(rules);
    expect((await jsonOf(await app.request('/api/mod/users/5', { method: 'DELETE', headers: authed() }, r.env as never))).code).toBe(Code.NOT_FOUND);
  });

  it('级联删：主题/回帖/倒排/附件/用户行 + forum.threads 回退 + 他人 posts 回退', async () => {
    const r = makeEnv(deleteRules());
    const body = await jsonOf(await app.request('/api/mod/users/5', { method: 'DELETE', headers: authed() }, r.env as never));
    expect(body.code).toBe(Code.OK);
    expect((body.data as { threads: number }).threads).toBe(2);
    const s = sqls(r);
    expect(s).toMatch(/DELETE FROM bbs_user WHERE uid/);
    expect(s).toMatch(/DELETE FROM bbs_thread WHERE uid/);
    expect(s).toMatch(/DELETE FROM bbs_post WHERE tid IN/);
    expect(s).toMatch(/DELETE FROM bbs_mythread WHERE uid/);
    expect(s).toMatch(/DELETE FROM bbs_mypost WHERE uid/);
    expect(s).toMatch(/DELETE FROM bbs_attach WHERE uid/);
    // 倒排/附件按 tid 维度同清（他人在这批主题内的收藏与上传，漏掉即成孤儿行 / R2 泄漏）
    expect(s).toMatch(/DELETE FROM bbs_mypost WHERE tid IN/);
    expect(s).toMatch(/DELETE FROM bbs_mythread WHERE tid IN/);
    expect(s).toMatch(/DELETE FROM bbs_attach WHERE tid IN/);
    expect(s).toMatch(/SELECT filename FROM bbs_attach WHERE uid = \? OR tid IN/);
    expect(s).toMatch(/UPDATE bbs_forum SET threads = threads - \?/);
    expect(s).toMatch(/UPDATE bbs_thread SET posts = posts - \? WHERE tid = \?/); // 他主题回帖回退
    // 他人作者 posts 回退（uid=3, c=2）
    const dec = r.calls.find((c) => /SET posts = posts - \? WHERE uid = \?/.test(c.sql));
    expect(dec && [Number(dec.params[0]), Number(dec.params[1])]).toEqual([2, 3]);
  });
});

describe('回帖列表（T3-2 补全）', () => {
  it('GET /api/users/:uid/posts 返回 mypost JOIN 结果', async () => {
    const r = makeEnv(replyRules());
    const body = await jsonOf(await app.request('/api/users/5/posts', { headers: authed() }, r.env as never));
    expect(body.code).toBe(Code.OK);
    const list = (body.data as { list: { pid: number; subject: string }[] }).list;
    expect(list.length).toBe(2);
    expect(list[0]).toMatchObject({ pid: 100, subject: '主题九' });
  });

  it('GET /api/me/posts 未登录 → NOT_LOGIN', async () => {
    const r = makeEnv(replyRules());
    expect((await jsonOf(await app.request('/api/me/posts', { headers: guest() }, r.env as never))).code).toBe(Code.NOT_LOGIN);
  });

  it('GET /api/me/posts 登录态复用同投影', async () => {
    const r = makeEnv(replyRules());
    const body = await jsonOf(await app.request('/api/me/posts', { headers: authed() }, r.env as never));
    expect(body.code).toBe(Code.OK);
    expect((body.data as { list: unknown[] }).list.length).toBe(2);
  });
});
