import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

// gid=1 管理组：全权限；LEVEL 组仅用于升组判定（本用例不触发升组）
const GROUP_ADMIN = {
  gid: 1, name: '管理员', creditsfrom: 0, creditsto: 0,
  allowread: 1, allowthread: 1, allowpost: 1, allowattach: 1, allowdown: 1,
  allowtop: 1, allowupdate: 1, allowdelete: 1, allowmove: 1, allowbanuser: 1, allowdeleteuser: 1, allowviewip: 1,
};
const GROUP_LEVEL1 = { ...GROUP_ADMIN, gid: 101, name: '初级会员', allowtop: 0, allowupdate: 0, allowdelete: 0, allowmove: 0, creditsfrom: 0, creditsto: 200 };
const FORUM1 = { fid: 1, name: '默认版块', rank: 1, threads: 2, todayposts: 0, todaythreads: 0, brief: '', announcement: '', accesson: 0, orderby: 0, icon: 0, moduids: '', seo_title: '', seo_keywords: '' };
const FORUM2 = { ...FORUM1, fid: 2, name: '灌水版块' };

const AUTHOR = { uid: 1, gid: 1, username: 'admin', avatar: 7, password: 'x', salt: '', token_version: 0, email: 'a@b.c', threads: 2, posts: 5 };
const QUOTED_USER = { uid: 2, username: 'user2', avatar: 3 };

function threadRow(over: Record<string, unknown> = {}) {
  return { fid: 1, closed: 0, top: 0, subject: '原标题', uid: 1, lastpid: 88, ...over };
}

function baseRules(): SqlRule[] {
  return [
    // 读缓存层
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: SETTING } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    // 真删前收集附件 R2 key（core/purge.attachKeysBy*）
    { test: /SELECT filename FROM bbs_attach/, rows: [] },
    // forumlist / grouplist 装载
    { test: /FROM bbs_forum ORDER BY/, rows: [FORUM1, FORUM2] },
    { test: /bbs_forum_access/, rows: [] },
    { test: /FROM bbs_group/, rows: [GROUP_ADMIN, GROUP_LEVEL1] },
    // viewer + 权威作者数据（两处 WHERE uid = ?）
    { test: /FROM bbs_session WHERE sid/, first: (p: readonly unknown[]) => ({ uid: Number(p[0]) === 0 ? 0 : 1, last_date: now() }) },
    { test: /FROM bbs_user WHERE uid = \?/, first: (p: readonly unknown[]) => (Number(p[0]) === 2 ? QUOTED_USER : AUTHOR) },
    // 批量升组读取（upgradeGroupsByCredits）：与上面单条读取同源（AUTHOR gid=1 → 不换组）
    { test: /SELECT uid,gid,credits FROM bbs_user WHERE uid IN/, rows: (p: readonly unknown[]) => p.map((u) => ({ uid: Number(u), gid: 1, credits: 0 })) },
    // 主题读取
    { test: /FROM bbs_thread WHERE tid = \?/, first: () => threadRow() },
    // 引用/编辑/删除：按 pid 读回帖
    { test: /SELECT pid,tid,uid,isfirst FROM bbs_post WHERE pid/, first: (p: readonly unknown[]) => ({ pid: Number(p[0]), tid: 9, uid: 1, isfirst: 0 }) },
    // 删除回帖：postPurgeStmts 联表读取（B1 后含 ok/create_date/fid；ok=1 → 回退 thread.posts/todayposts）
    { test: /SELECT p\.pid,p\.tid,p\.uid,p\.isfirst,p\.ok,p\.create_date,t\.fid FROM bbs_post p INNER JOIN bbs_thread/, first: (p: readonly unknown[]) => ({ pid: Number(p[0]), tid: 9, uid: 1, isfirst: 0, ok: 1, create_date: 1699999000, fid: 1 }) },
    { test: /SELECT pid,tid,uid,message FROM bbs_post WHERE pid/, first: { pid: 5, tid: 9, uid: 2, message: '<p>被引用内容</p>' } },
    // 级联删作者聚合（isfirst=0：首帖不计入 user.posts）+ lastpid 回退
    { test: /SELECT uid, COUNT\(\*\) AS c FROM bbs_post WHERE tid = \? AND isfirst = 0 GROUP BY uid/, rows: [{ uid: 1, c: 1 }, { uid: 2, c: 3 }] },
    // 删除回扣楼层列表（级联删逐楼层扣 post_*）
    { test: /SELECT pid,uid FROM bbs_post WHERE tid = \? AND isfirst = 0/, rows: [{ pid: 101, uid: 2 }] },
    { test: /SELECT pid,uid,create_date FROM bbs_post WHERE tid = \? ORDER BY pid DESC/, first: { pid: 87, uid: 2, create_date: 1700000000 } },
    // 删末帖回退 lastpid（purge：pid <> ? 排除自身取倒数第二楼；B1 后仅取已过审楼层）
    { test: /SELECT pid,uid,create_date FROM bbs_post WHERE tid = \? AND pid <> \? AND ok = 1/, first: { pid: 86, uid: 2, create_date: 1699999000 } },
    // 写：INSERT RETURNING
    { test: /INSERT INTO bbs_post/, first: { pid: 100 }, rows: [{ pid: 100 }] },
    { test: /INSERT INTO bbs_thread/, first: { tid: 500 }, rows: [{ tid: 500 }] },
    // 回帖/审核通知作者（0006_notice）
    { test: /INSERT INTO bbs_notice/, first: { nid: 1 } },
    // 写：其余语句（batch/单条），first 兜 null、rows 空
    { test: /UPDATE bbs_post|UPDATE bbs_thread|UPDATE bbs_forum|UPDATE bbs_user/, rows: [] },
    { test: /INSERT INTO bbs_mythread|INSERT INTO bbs_mypost/, rows: [] },
    { test: /UPDATE bbs_thread_top/, rows: [] },
    { test: /DELETE FROM bbs_post|DELETE FROM bbs_thread|DELETE FROM bbs_mythread|DELETE FROM bbs_mypost|DELETE FROM bbs_thread_top|DELETE FROM bbs_attach|DELETE FROM bbs_like|DELETE FROM bbs_favorite|DELETE FROM bbs_post_like|DELETE FROM bbs_paylist/, rows: [] },
  ];
}

interface Res {
  env: unknown;
  calls: { sql: string; params: readonly unknown[] }[];
  kv: ReturnType<typeof fakeKv>;
}
function makeEnv(rules: SqlRule[], opts: { turnstileSecret?: string } = {}): Res {
  const { db, calls } = fakeD1Sql(rules);
  const kv = fakeKv();
  const env: Record<string, unknown> = { DB: db, CACHE: kv, FILES: {}, SITE_URL: 'http://localhost' };
  if (opts.turnstileSecret) env.TURNSTILE_SECRET = opts.turnstileSecret;
  return { env, calls, kv };
}

/** siteverify 替身：默认放行，可指定 success:false 复现验证失败 */
function stubFetch(result: { json?: unknown } = { json: { success: true } }) {
  const fn = vi.fn(async () => ({ ok: true, json: async () => result.json }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function authed(r: Res, headers: Record<string, string> = {}): HeadersInit {
  const csrf = 'tok123';
  return {
    'content-type': 'application/json',
    cookie: `sid=${r.calls.length ? 'sessA' : 'sessA'}; csrf=${csrf}`,
    'x-csrf-token': csrf,
    ...headers,
  };
}

async function jsonOf(res: Response) {
  return (await res.json()) as { code: number; message: string } & Record<string, unknown>;
}

beforeEach(() => l0Clear());
afterEach(() => vi.unstubAllGlobals());

describe('内容写接口集成（T2-6 DoD）', () => {
  it('未登录 → NOT_LOGIN', async () => {
    const r = makeEnv(baseRules());
    const res = await app.request('/api/threads', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'csrf=t', 'x-csrf-token': 't' }, body: '{}' }, r.env as never);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.NOT_LOGIN);
  });

  it('CSRF 缺失 → CSRF_FAILED', async () => {
    const r = makeEnv(baseRules());
    const res = await app.request('/api/threads', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'sid=sessA' }, body: '{}' }, r.env as never);
    expect((await jsonOf(res)).code).toBe(Code.CSRF_FAILED);
  });

  it('POST /api/threads：首帖→主题→回填→倒排→计数→失效', async () => {
    const r = makeEnv(baseRules());
    const res = await app.request(
      '/api/threads',
      { method: 'POST', headers: authed(r), body: JSON.stringify({ fid: 1, subject: '新标题', message: '<p>正文</p>', doctype: 0 }) },
      r.env as never,
    );
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    expect(body.data).toEqual({ tid: 500, pid: 100 });
    const sqls = r.calls.map((c) => c.sql).join('\n');
    expect(sqls).toMatch(/INSERT INTO bbs_post/);
    expect(sqls).toMatch(/INSERT INTO bbs_thread/);
    expect(sqls).toMatch(/UPDATE bbs_post SET tid/); // firstpid 关联回填
    expect(sqls).toMatch(/INSERT INTO bbs_mythread/);
    expect(sqls).toMatch(/INSERT INTO bbs_mypost/);
    expect(sqls).toMatch(/threads = threads \+ 1/);
    expect(sqls).toMatch(/todaythreads = todaythreads \+ 1/);
    // 28 = 原 25 + 3（forumlist 移出 KV 走 L2：装载 1 SELECT + 回填 1 REPLACE + 失效 1 DELETE）
    // 代价是 3 条 D1 查询（免费层 50 条/次，仍远未触顶），换来的是 KV 1,000 写/天不再成为发帖天花板
    expect(r.calls.length).toBeLessThanOrEqual(29);
  });

  it('POST 主题：版块绑定语言（0024）→ 忽略用户选择与自动检测，强制落该语言', async () => {
    const rules = baseRules();
    const fl = rules.find((x) => /FROM bbs_forum ORDER BY/.test(x.test.source));
    if (fl) fl.rows = [{ ...FORUM1, lang: 'ja' }, FORUM2];
    const r = makeEnv(rules);
    const res = await app.request(
      '/api/threads',
      { method: 'POST', headers: authed(r), body: JSON.stringify({ fid: 1, subject: '中文标题', message: '<p>中文正文</p>', doctype: 0, lang: 'en' }) },
      r.env as never,
    );
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const ins = r.calls.find((c) => /INSERT INTO bbs_thread/.test(c.sql));
    // INSERT 末位即 lang 列
    expect(ins?.params.at(-1)).toBe('ja');
  });

  it('POST 主题：subject 超长 / 空正文 → 校验错误', async () => {
    const r = makeEnv(baseRules());
    const res = await app.request('/api/threads', { method: 'POST', headers: authed(r), body: JSON.stringify({ fid: 1, subject: '标'.repeat(129), message: 'x', doctype: 0 }) }, r.env as never);
    expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
  });

  it('回帖：closed 帖非版主禁回（游客/等级组）', async () => {
    const rules = baseRules();
    const tr = rules.find((x) => /FROM bbs_thread WHERE tid/.test(x.test.source));
    if (tr) tr.first = () => threadRow({ closed: 1 });
    // 以 gid=101 用户身份（需非版主）——改为 viewer 非管理组
    const ur = rules.find((x) => /bbs_user WHERE uid/.test(x.test.source));
    if (ur) ur.first = () => ({ ...AUTHOR, gid: 101 });
    const r = makeEnv(rules);
    const res = await app.request('/api/threads/9/posts', { method: 'POST', headers: authed(r), body: JSON.stringify({ message: '回复', doctype: 0 }) }, r.env as never);
    expect((await jsonOf(res)).code).toBe(Code.NO_PERMISSION);
  });

  it('回帖：quotepid 同帖校验通过则引用前缀入 message_fmt，跨帖则归零', async () => {
    const r = makeEnv(baseRules());
    const res = await app.request('/api/threads/9/posts', { method: 'POST', headers: authed(r), body: JSON.stringify({ message: '回复', doctype: 0, quotepid: 5 }) }, r.env as never);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const ins = r.calls.find((c) => /INSERT INTO bbs_post/.test(c.sql));
    const fmt = String(ins?.params[7] ?? '');
    expect(fmt).toContain('<blockquote');
    expect(fmt).toContain('user2');
    // 跨帖引用（quoted tid != 9）：改引用读取返回 tid=7
    const rules2 = baseRules();
    const q = rules2.find((x) => /SELECT pid,tid,uid,message FROM bbs_post WHERE pid/.test(x.test.source));
    if (q) q.first = { pid: 5, tid: 7, uid: 2, message: '<p>x</p>' };
    const r2 = makeEnv(rules2);
    const res2 = await app.request('/api/threads/9/posts', { method: 'POST', headers: authed(r2), body: JSON.stringify({ message: '回复', doctype: 0, quotepid: 5 }) }, r2.env as never);
    expect((await jsonOf(res2)).code).toBe(Code.OK);
    const ins2 = r2.calls.find((c) => /INSERT INTO bbs_post/.test(c.sql));
    expect(String(ins2?.params[7] ?? '')).not.toContain('<blockquote');
    expect(Number(ins2?.params[5])).toBe(0); // quotepid 归零入库
  });

  it('回帖计数：thread posts+1 / user posts+1 / forum todayposts+1（非 threads）+ 尾列补 lastusername', async () => {
    const r = makeEnv(baseRules());
    await app.request('/api/threads/9/posts', { method: 'POST', headers: authed(r), body: JSON.stringify({ message: '回复', doctype: 0 }) }, r.env as never);
    const sqls = r.calls.map((c) => c.sql).join('\n');
    expect(sqls).toMatch(/posts = posts \+ 1/);
    expect(sqls).toMatch(/todayposts = todayposts \+ 1/);
    expect(sqls).not.toMatch(/forum SET threads/);
    // §20.2 结构性修复：回帖尾列必须带 lastusername（= 回帖者当前用户名），否则"最后回复 by X"恒显示楼主名
    const tail = r.calls.find((c) => /UPDATE bbs_thread SET posts = posts \+ 1, lastpid = \?, lastuid = \?, last_date = \?, lastusername = \?/.test(c.sql));
    expect(tail).toBeTruthy();
    expect(String(tail?.params[3])).toBe('admin');
  });

  it('编辑 isfirst：改 subject + 移动版块触发 forum threads ±1 + thread_top fid 更新 + forumlist 缓存失效', async () => {
    const rules = baseRules();
    const pr = rules.find((x) => /SELECT pid,tid,uid,isfirst FROM bbs_post WHERE pid/.test(x.test.source));
    if (pr) pr.first = (p: readonly unknown[]) => ({ pid: Number(p[0]), tid: 9, uid: 1, isfirst: 1 });
    const r = makeEnv(rules);
    const res = await app.request('/api/posts/100', { method: 'PUT', headers: authed(r), body: JSON.stringify({ subject: '改后的新标题', fid: 2, message: '编辑正文', doctype: 0 }) }, r.env as never);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const sqls = r.calls.map((c) => c.sql).join('\n');
    expect(sqls).toMatch(/UPDATE bbs_thread SET subject/);
    expect(sqls).toMatch(/UPDATE bbs_thread SET fid/);
    expect(sqls).toMatch(/threads = threads \+ 1 WHERE fid/);
    expect(sqls).toMatch(/threads = threads - 1 WHERE fid/);
    expect(sqls).toMatch(/UPDATE bbs_thread_top SET fid/);
    expect(r.calls.some((c) => /DELETE FROM bbs_cache/.test(c.sql) && String(c.params[0]) === 'forumlist')).toBe(true);
  });

  it('编辑：非版主且主题已关闭 → 拒绝', async () => {
    const rules = baseRules();
    rules.find((x) => /FROM bbs_thread WHERE tid/.test(x.test.source))!.first = () => threadRow({ closed: 1 });
    rules.find((x) => /bbs_user WHERE uid/.test(x.test.source))!.first = () => ({ ...AUTHOR, gid: 101 });
    rules.find((x) => /isfirst FROM bbs_post WHERE pid/.test(x.test.source))!.first = (p: readonly unknown[]) => ({ pid: Number(p[0]), tid: 9, uid: 1, isfirst: 0 });
    const r = makeEnv(rules);
    const res = await app.request('/api/posts/100', { method: 'PUT', headers: authed(r), body: JSON.stringify({ message: '改', doctype: 0 }) }, r.env as never);
    expect((await jsonOf(res)).code).toBe(Code.NO_PERMISSION);
  });

  it('删除回帖：posts-1 + lastpid 回退 + mypost 撤除', async () => {
    const r = makeEnv(baseRules());
    const res = await app.request('/api/posts/88', { method: 'DELETE', headers: authed(r) }, r.env as never);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const sqls = r.calls.map((c) => c.sql).join('\n');
    expect(sqls).toMatch(/posts = posts - 1/);
    expect(sqls).toMatch(/DELETE FROM bbs_post WHERE pid/);
    expect(sqls).toMatch(/DELETE FROM bbs_mypost/);
    expect(sqls).toMatch(/DELETE FROM bbs_post_like WHERE pid/); // B3：楼层点赞随删
    expect(sqls).toMatch(/UPDATE bbs_thread SET lastpid/); // 删的是最后回帖 → 回退
    expect(sqls).toMatch(/lastusername = \(SELECT username FROM bbs_user WHERE uid = \?\)/); // §20.2：回退同步补 lastusername（标量子查询取新尾作者当前用户名）
  });

  it('删除待审回帖（ok=0）：不回退 thread.posts（发帖时未计入），user.posts 仍回退', async () => {
    const rules = baseRules();
    rules.find((x) => /INNER JOIN bbs_thread/.test(x.test.source))!.first = (p: readonly unknown[]) => ({ pid: Number(p[0]), tid: 9, uid: 1, isfirst: 0, ok: 0, create_date: 1699999000, fid: 1 });
    const r = makeEnv(rules);
    const res = await app.request('/api/posts/88', { method: 'DELETE', headers: authed(r) }, r.env as never);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const sqls = r.calls.map((c) => c.sql).join('\n');
    expect(sqls).toMatch(/UPDATE bbs_user SET posts = posts - 1/);
    expect(sqls).not.toMatch(/UPDATE bbs_thread SET posts = posts - 1/);
  });

  it('删除首帖：级联删主题 + forum threads-1 + 各作者 posts 回退', async () => {
    const rules = baseRules();
    rules.find((x) => /SELECT pid,tid,uid,isfirst FROM bbs_post WHERE pid/.test(x.test.source))!.first = (p: readonly unknown[]) => ({ pid: Number(p[0]), tid: 9, uid: 1, isfirst: 1 });
    const r = makeEnv(rules);
    const res = await app.request('/api/posts/100', { method: 'DELETE', headers: authed(r) }, r.env as never);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    expect((body.data as { cascade: boolean }).cascade).toBe(true);
    const sqls = r.calls.map((c) => c.sql).join('\n');
    expect(sqls).toMatch(/DELETE FROM bbs_thread WHERE tid/);
    expect(sqls).toMatch(/DELETE FROM bbs_post WHERE tid/);
    expect(sqls).toMatch(/threads = threads - 1/);
    expect(sqls).toMatch(/SET posts = posts - \? WHERE uid/); // 各作者 posts 回退（逐组 bind）
    const decrementParams = r.calls.filter((c) => /SET posts = posts - \?/.test(c.sql)).map((c) => Number(c.params[0]));
    expect(decrementParams).toEqual(expect.arrayContaining([1, 3]));
  });

  it('写路径读侧零 sanitize：fmt 结果入库、无 HTML_White 二次调用（写请求查询在预算内）', async () => {
    const rules = baseRules();
    // 普通用户（gid≥100）doctype0 走 xnHtmlSafe；管理员原样入库（管理员特权）
    rules.find((x) => /bbs_user WHERE uid/.test(x.test.source))!.first = () => ({ ...AUTHOR, gid: 101 });
    const r = makeEnv(rules);
    const res = await app.request('/api/threads/9/posts', { method: 'POST', headers: authed(r), body: JSON.stringify({ message: '<script>alert(1)</script>hi', doctype: 0 }) }, r.env as never);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const ins = r.calls.find((c) => /INSERT INTO bbs_post/.test(c.sql));
    const fmt = String(ins?.params[7] ?? '');
    expect(fmt).not.toContain('<script>'); // 写侧定稿已净化
    expect(fmt).toContain('hi');
    expect(r.calls.length).toBeLessThanOrEqual(27); // 原 25 + forumlist 走 L2 的 1 SELECT/1 REPLACE/1 DELETE
  });
});

describe('发帖/回帖人机验证（附录 B：覆盖点含发帖、回帖）', () => {
  const THREAD_BODY = { fid: 1, subject: '标题', message: '<p>正文</p>', doctype: 0 };
  const REPLY_BODY = { message: '回复', doctype: 0 };

  it('未配置 TURNSTILE_SECRET ⇒ 不带 token 也直通（铁律 8 降级）', async () => {
    const r = makeEnv(baseRules());
    const res = await app.request('/api/threads', { method: 'POST', headers: authed(r), body: JSON.stringify(THREAD_BODY) }, r.env as never);
    expect((await jsonOf(res)).code).toBe(Code.OK);
  });

  it('发帖缺 token → CAPTCHA_FAILED，且 siteverify 与 D1 写都没发生', async () => {
    const fn = stubFetch();
    const r = makeEnv(baseRules(), { turnstileSecret: 'ts' });
    const res = await app.request('/api/threads', { method: 'POST', headers: authed(r), body: JSON.stringify(THREAD_BODY) }, r.env as never);
    expect((await jsonOf(res)).code).toBe(Code.CAPTCHA_FAILED);
    expect(fn).not.toHaveBeenCalled();
    expect(r.calls.map((c) => c.sql).join('\n')).not.toMatch(/INSERT INTO bbs_post/);
  });

  it('发帖：siteverify 拒绝 → CAPTCHA_FAILED；放行 → 正常创建', async () => {
    stubFetch({ json: { success: false } });
    const r1 = makeEnv(baseRules(), { turnstileSecret: 'ts' });
    const bad = await app.request(
      '/api/threads',
      { method: 'POST', headers: authed(r1), body: JSON.stringify({ ...THREAD_BODY, turnstileToken: 'tok' }) },
      r1.env as never,
    );
    expect((await jsonOf(bad)).code).toBe(Code.CAPTCHA_FAILED);

    const fn = stubFetch({ json: { success: true } });
    const r2 = makeEnv(baseRules(), { turnstileSecret: 'ts' });
    const good = await app.request(
      '/api/threads',
      { method: 'POST', headers: authed(r2), body: JSON.stringify({ ...THREAD_BODY, turnstileToken: 'tok' }) },
      r2.env as never,
    );
    expect((await jsonOf(good)).code).toBe(Code.OK);
    const call = (fn.mock.calls as unknown as [string, { body: string }][]).find((a) =>
      String(a[0]).includes('siteverify'),
    );
    expect(String(call?.[1].body)).toContain('secret=ts');
    expect(String(call?.[1].body)).toContain('response=tok');
  });

  it('回帖把门在校验之前：缺 token 连主题都不查', async () => {
    const r = makeEnv(baseRules(), { turnstileSecret: 'ts' });
    const res = await app.request('/api/threads/9/posts', { method: 'POST', headers: authed(r), body: JSON.stringify(REPLY_BODY) }, r.env as never);
    expect((await jsonOf(res)).code).toBe(Code.CAPTCHA_FAILED);
    expect(r.calls.map((c) => c.sql).join('\n')).not.toMatch(/FROM bbs_thread WHERE tid/);
  });

  it('编辑回帖不挂人机验证（人机验证只覆盖发帖/回帖）', async () => {
    const r = makeEnv(baseRules(), { turnstileSecret: 'ts' });
    const res = await app.request('/api/posts/100', { method: 'PUT', headers: authed(r), body: JSON.stringify({ message: '改', doctype: 0 }) }, r.env as never);
    expect((await jsonOf(res)).code).toBe(Code.OK);
  });
});
