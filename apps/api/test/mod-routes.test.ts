import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';

const now = () => Math.floor(Date.now() / 1000);

const SETTING = JSON.stringify({
  runlevel: 5, sitename: 'FreeIDX', brief: 'b', url: 'http://localhost', kw: '', desc: '',
  user_create_on: 1, user_create_email_on: 0, user_resetpw_on: 1,
  forum_orderby: 0, update_views_on: 1, upload_max_size: 1048576, lang: 'zh-cn',
});

// gid=1 管理组：全版务权（forumAccessMod 恒 TRUE）
const GROUP_ADMIN = {
  gid: 1, name: '管理员', creditsfrom: 0, creditsto: 0,
  allowread: 1, allowthread: 1, allowpost: 1, allowattach: 1, allowdown: 1,
  allowtop: 1, allowupdate: 1, allowdelete: 1, allowmove: 1, allowbanuser: 1, allowdeleteuser: 1, allowviewip: 1,
};
// gid=4 版主：有版务组位，但需在 forum.moduids 名册内才有版务权
const GROUP_MOD = { ...GROUP_ADMIN, gid: 4, name: '版主', allowbanuser: 0, allowdeleteuser: 0 };
const FORUM1 = { fid: 1, name: '默认版块', rank: 1, threads: 2, todayposts: 0, todaythreads: 0, brief: '', announcement: '', accesson: 0, orderby: 0, icon: 0, moduids: '', seo_title: '', seo_keywords: '' };
const FORUM2 = { ...FORUM1, fid: 2, name: '灌水版块' };

const AUTHOR = { uid: 1, gid: 1, username: 'admin', avatar: 7, password: 'x', salt: '', token_version: 0, email: 'a@b.c', threads: 2, posts: 5 };

function th(over: Record<string, unknown> = {}) {
  return { tid: 9, fid: 1, uid: 2, subject: '主题九', firstpid: 80, top: 0, closed: 0, digest: 0, ...over };
}

function baseRules(threads: Record<string, unknown>[] = [th()]): SqlRule[] {
  return [
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: SETTING } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /FROM bbs_forum ORDER BY/, rows: [FORUM1, FORUM2] },
    { test: /bbs_forum_access/, rows: [] },
    { test: /FROM bbs_group/, rows: [GROUP_ADMIN, GROUP_MOD] },
    { test: /FROM bbs_session WHERE sid/, first: (p: readonly unknown[]) => ({ uid: Number(p[0]) === 0 ? 0 : 1, last_date: now() }) },
    { test: /FROM bbs_user WHERE uid = \?/, first: () => AUTHOR },
    // 批量升组读取（upgradeGroupsByCredits）：与上面单条读取同源（AUTHOR gid=1 → 不换组）
    { test: /SELECT uid,gid,credits FROM bbs_user WHERE uid IN/, rows: (p: readonly unknown[]) => p.map((u) => ({ uid: Number(u), gid: 1, credits: 0 })) },
    // 批量读主题
    { test: /FROM bbs_thread WHERE tid IN/, rows: threads },
    // 主题真删的当日判定（threadPurgeStmts B5：create_date → todaythreads 回退与否）
    { test: /SELECT create_date FROM bbs_thread WHERE tid = \?/, first: { create_date: 1700000000 } },
    // 级联删作者聚合（仅回帖 isfirst=0）
    { test: /SELECT uid, COUNT\(\*\) AS c FROM bbs_post WHERE tid = \? AND isfirst = 0 GROUP BY uid/, rows: [{ uid: 2, c: 2 }, { uid: 3, c: 1 }] },
    // 真删回扣楼层列表（tt_credits threadRevokeEntries）
    { test: /SELECT pid,uid FROM bbs_post WHERE tid = \? AND isfirst = 0/, rows: [{ pid: 81, uid: 3 }] },
    // 真删前收集附件 R2 key（core/purge.attachKeysBy*）
    { test: /SELECT filename FROM bbs_attach/, rows: [] },
    // 写：modlog / 主题通知（0006_notice：版务动作通知作者）/ thread_top replace / 其余 UPDATE+DELETE 兜空
    { test: /INSERT INTO bbs_modlog/, rows: [] },
    { test: /INSERT INTO bbs_notice/, first: { nid: 1 } },
    { test: /INSERT OR REPLACE INTO bbs_thread_top/, rows: [] },
    { test: /UPDATE bbs_thread|UPDATE bbs_forum|UPDATE bbs_user|UPDATE bbs_thread_top/, rows: [] },
    { test: /DELETE FROM bbs_post|DELETE FROM bbs_thread|DELETE FROM bbs_mythread|DELETE FROM bbs_mypost|DELETE FROM bbs_thread_top|DELETE FROM bbs_attach|DELETE FROM bbs_like|DELETE FROM bbs_favorite|DELETE FROM bbs_post_like|DELETE FROM bbs_paylist/, rows: [] },
  ];
}

interface Res {
  env: unknown;
  calls: { sql: string; params: readonly unknown[] }[];
}
function makeEnv(rules: SqlRule[]): Res {
  const { db, calls } = fakeD1Sql(rules);
  const kv = fakeKv();
  return { env: { DB: db, CACHE: kv, FILES: {}, SITE_URL: 'http://localhost' }, calls };
}
const authed = (): HeadersInit => ({
  'content-type': 'application/json',
  cookie: 'sid=sessA; csrf=tok',
  'x-csrf-token': 'tok',
});
async function jsonOf(res: Response) {
  return (await res.json()) as { code: number; message: string } & Record<string, unknown>;
}
const post = (r: Res, body: unknown) =>
  app.request('/api/mod/threads', { method: 'POST', headers: authed(), body: JSON.stringify(body) }, r.env as never);
const sqls = (r: Res) => r.calls.map((c) => c.sql).join('\n');
const modlogActions = (r: Res) => r.calls.filter((c) => /INSERT INTO bbs_modlog/.test(c.sql)).map((c) => String(c.params[6]));

beforeEach(() => l0Clear());

describe('版务批量接口（T3-1 DoD）', () => {
  it('未登录 → NOT_LOGIN', async () => {
    const r = makeEnv(baseRules());
    const res = await app.request('/api/mod/threads', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'csrf=t', 'x-csrf-token': 't' }, body: '{}' }, r.env as never);
    expect((await jsonOf(res)).code).toBe(Code.NOT_LOGIN);
  });

  it('CSRF 缺失 → CSRF_FAILED', async () => {
    const r = makeEnv(baseRules());
    const res = await app.request('/api/mod/threads', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'sid=sessA' }, body: '{}' }, r.env as never);
    expect((await jsonOf(res)).code).toBe(Code.CSRF_FAILED);
  });

  it('空 tids → VALIDATION_ERROR', async () => {
    const r = makeEnv(baseRules());
    expect((await jsonOf(await post(r, { tids: [], action: 'top', value: 1 }))).code).toBe(Code.VALIDATION_ERROR);
  });

  it('top：批量置顶 → thread.top + thread_top replace + modlog(top)', async () => {
    const r = makeEnv(baseRules([th({ tid: 9 }), th({ tid: 10, firstpid: 90 })]));
    const body = await jsonOf(await post(r, { tids: [9, 10], action: 'top', value: 1 }));
    expect(body.code).toBe(Code.OK);
    expect((body.data as { count: number }).count).toBe(2);
    const s = sqls(r);
    expect(s).toMatch(/UPDATE bbs_thread SET top = \?/);
    expect(s).toMatch(/INSERT OR REPLACE INTO bbs_thread_top/);
    expect(modlogActions(r)).toEqual(['top', 'top']);
    const ins = r.calls.find((c) => /INSERT INTO bbs_modlog/.test(c.sql))!;
    expect(ins.params[1]).toBe(9); // tid
    expect(ins.params[2]).toBe(80); // pid = firstpid
    expect(ins.params[3]).toBe('主题九'); // subject
  });

  it('top=3 全站置顶：非 gid1/2（版主）跳过 → 无动作 NO_PERMISSION', async () => {
    const rules = baseRules();
    rules.find((x) => /bbs_user WHERE uid/.test(x.test.source))!.first = () => ({ ...AUTHOR, gid: 4 });
    rules.find((x) => /FROM bbs_forum ORDER BY/.test(x.test.source))!.rows = [{ ...FORUM1, moduids: '1' }, FORUM2];
    const r = makeEnv(rules);
    const body = await jsonOf(await post(r, { tids: [9], action: 'top', value: 3 }));
    expect(body.code).toBe(Code.NO_PERMISSION);
  });

  it('top：值未变（top 已=1 再设 1）不动 → NO_PERMISSION', async () => {
    const r = makeEnv(baseRules([th({ top: 1 })]));
    expect((await jsonOf(await post(r, { tids: [9], action: 'top', value: 1 }))).code).toBe(Code.NO_PERMISSION);
  });

  it('close：复用 allowtop + §D.8#4 补齐失效 + modlog(close)', async () => {
    const r = makeEnv(baseRules());
    const body = await jsonOf(await post(r, { tids: [9], action: 'close', value: 1 }));
    expect(body.code).toBe(Code.OK);
    expect(sqls(r)).toMatch(/UPDATE bbs_thread SET closed = \?/);
    expect(modlogActions(r)).toEqual(['close']);
  });

  it('digest：精华写 thread.digest + modlog(digest)', async () => {
    const r = makeEnv(baseRules());
    const body = await jsonOf(await post(r, { tids: [9], action: 'digest', value: 2 }));
    expect(body.code).toBe(Code.OK);
    expect(sqls(r)).toMatch(/UPDATE bbs_thread SET digest = \?/);
    expect(modlogActions(r)).toEqual(['digest']);
  });

  it('digest：精华差额结算（digest1→2 补发经验差额 7 并记流水）', async () => {
    const rules = baseRules([th({ digest: 1 })]);
    rules.find((x) => /bbs_kv WHERE k/.test(x.test.source))!.first = (p: readonly unknown[]) => ({
      v: p[0] === 'tt_credits' ? JSON.stringify({ digest1_exp: 5, digest2_exp: 12 }) : SETTING,
    });
    const r = makeEnv(rules);
    expect((await jsonOf(await post(r, { tids: [9], action: 'digest', value: 2 }))).code).toBe(Code.OK);
    const upd = r.calls.find((c) => /SET credits = credits \+ \?/.test(c.sql));
    expect(upd && [Number(upd.params[0]), Number(upd.params[1])]).toEqual([7, 2]); // 差额 12-5，作者 uid=2
    expect(sqls(r)).toMatch(/INSERT INTO bbs_point_log/);
  });

  it('digest：摘除精华（1→0）反向追回差额', async () => {
    const rules = baseRules([th({ digest: 1 })]);
    rules.find((x) => /bbs_kv WHERE k/.test(x.test.source))!.first = (p: readonly unknown[]) => ({
      v: p[0] === 'tt_credits' ? JSON.stringify({ digest1_exp: 5 }) : SETTING,
    });
    const r = makeEnv(rules);
    expect((await jsonOf(await post(r, { tids: [9], action: 'digest', value: 0 }))).code).toBe(Code.OK);
    const upd = r.calls.find((c) => /SET credits = credits \+ \?/.test(c.sql));
    expect(upd && Number(upd.params[0])).toBe(-5);
  });

  it('delete：级联删主题/回帖 + 作者 posts 回退 + forum threads-1 + modlog(delete)', async () => {
    const r = makeEnv(baseRules());
    const body = await jsonOf(await post(r, { tids: [9], action: 'delete' }));
    expect(body.code).toBe(Code.OK);
    const s = sqls(r);
    expect(s).toMatch(/DELETE FROM bbs_thread WHERE tid/);
    expect(s).toMatch(/DELETE FROM bbs_post WHERE tid/);
    expect(s).toMatch(/DELETE FROM bbs_attach WHERE tid/);
    expect(s).toMatch(/UPDATE bbs_forum SET threads = threads - 1/);
    expect(s).toMatch(/SET posts = posts - \? WHERE uid/);
    expect(modlogActions(r)).toEqual(['delete']);
  });

  it('move：目标版块存在 + fid 更新 + 版块计数互换 + thread_top 迁移 + modlog(move)', async () => {
    const r = makeEnv(baseRules());
    const body = await jsonOf(await post(r, { tids: [9], action: 'move', value: 2 }));
    expect(body.code).toBe(Code.OK);
    const s = sqls(r);
    expect(s).toMatch(/UPDATE bbs_thread SET fid = \?/);
    expect(s).toMatch(/threads = threads \+ 1/);
    expect(s).toMatch(/threads = threads - 1/);
    expect(s).toMatch(/UPDATE bbs_thread_top SET fid/);
    expect(modlogActions(r)).toEqual(['move']);
  });

  it('move：目标版块不存在 → NOT_FOUND', async () => {
    const r = makeEnv(baseRules());
    expect((await jsonOf(await post(r, { tids: [9], action: 'move', value: 99 }))).code).toBe(Code.NOT_FOUND);
  });

  it('move：同版块（fid==newfid）跳过 → NO_PERMISSION', async () => {
    const r = makeEnv(baseRules([th({ fid: 2 })]));
    expect((await jsonOf(await post(r, { tids: [9], action: 'move', value: 2 }))).code).toBe(Code.NO_PERMISSION);
  });

  it('权限位：版主 gid=4 不在名册 → forumAccessMod 拒绝 delete', async () => {
    const rules = baseRules();
    rules.find((x) => /bbs_user WHERE uid/.test(x.test.source))!.first = () => ({ ...AUTHOR, gid: 4 });
    // FORUM1.moduids 空 → gid4 无权
    const r = makeEnv(rules);
    expect((await jsonOf(await post(r, { tids: [9], action: 'delete' }))).code).toBe(Code.NO_PERMISSION);
  });
});
