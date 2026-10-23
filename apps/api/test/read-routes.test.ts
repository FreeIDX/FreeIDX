import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';

const SETTING = JSON.stringify({
  runlevel: 5, sitename: 'FreeIDX', brief: 'b', url: 'http://localhost', kw: '', desc: '',
  user_create_on: 1, user_create_email_on: 0, user_resetpw_on: 1,
  forum_orderby: 0, update_views_on: 1, upload_max_size: 1048576, lang: 'zh-cn',
});

const GUEST_GROUP = {
  gid: 0, name: '游客组', creditsfrom: 0, creditsto: 0,
  allowread: 1, allowthread: 0, allowpost: 1, allowattach: 0, allowdown: 1,
  allowtop: 0, allowupdate: 0, allowdelete: 0, allowmove: 0, allowbanuser: 0, allowdeleteuser: 0, allowviewip: 0,
};
const FORUM_OPEN = {
  fid: 1, name: '默认版块', rank: 1, threads: 2, todayposts: 0, todaythreads: 0,
  brief: '介绍', announcement: '', accesson: 0, orderby: 0, icon: 0, moduids: '', seo_title: '', seo_keywords: '',
};
const T2 = {
  tid: 2, fid: 1, top: 0, digest: 0, closed: 0, uid: 1, username: 'admin', avatar: 0,
  subject: '你好世界', posts: 1, views: 10, images: 0, files: 0, ok: 1,
  lastpid: 2, lastuid: 2, lastusername: 'user2', create_date: 1700000001, last_date: 1700000002,
};
const T1 = { ...T2, tid: 1, subject: '第一贴', posts: 0, lastpid: 1, lastuid: 1, lastusername: 'admin' };
const DETAIL = { ...T2, firstpid: 1, mods: 0, userip: 2130706433 };

function baseRules(over: Partial<Record<string, unknown[] | null>> = {}): SqlRule[] {
  const forum = (over['forum'] as unknown[]) ?? [FORUM_OPEN];
  const access = (over['access'] as unknown[]) ?? [];
  const threads = (over['threads'] as unknown[]) ?? [T2, T1];
  return [
    { test: /FROM bbs_kv/, first: { v: SETTING } },
    { test: /FROM bbs_group/, rows: [GUEST_GROUP, { ...GUEST_GROUP, gid: 1, allowread: 1, allowviewip: 1 }] },
    { test: /FROM bbs_forum ORDER BY/, rows: forum },
    /* bootstrap 站点数据卡 runtime 计数（全站贴子/用户数） */
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_post$/, first: { c: 2 } },
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_user$/, first: { c: 2 } },
    { test: /bbs_forum_access/, rows: access },
    { test: /bbs_thread_top/, rows: [] },
    { test: /FROM bbs_thread WHERE fid IN/, rows: threads },
    { test: /FROM bbs_thread WHERE uid = \?/, rows: [T2] },
    { test: /FROM bbs_thread WHERE tid = \?/, first: DETAIL },
    /* 上一篇/下一篇（同版块 tid 邻接；UNION ALL 单语句取两条） */
    { test: /FROM bbs_thread WHERE fid = \? AND tid [<>] \?/, rows: [] },
    /* 用户页「最后活跃」（0002 后 user/routes 实时查 session 最后心跳） */
    { test: /FROM bbs_session WHERE uid = \?/, first: { last_date: 1700000002 } },
    /* 主题详情点赞计数 + 访问者态（A4/A5：bbs_like 实时 COUNT） */
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_like WHERE tid = \?/, first: { c: 0 } },
    { test: /SELECT 1 AS x FROM bbs_like WHERE uid = \? AND tid = \?/, first: null },
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_favorite WHERE tid = \?/, first: { c: 0 } },
    /*  楼层点赞计数（一次 IN 批量；游客无已赞集合查询） */
    { test: /FROM bbs_post_like WHERE pid IN/, rows: [] },
    /* 用户页粉丝/关注计数 + 是否已关注（0002_social） */
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_follow/, first: { c: 0 } },
    { test: /SELECT 1 AS x FROM bbs_follow/, first: null },
    { test: /UPDATE bbs_thread SET views/, rows: [] },
    { test: /FROM bbs_post WHERE tid = \?/, rows: [
      { pid: 1, tid: 2, uid: 1, isfirst: 1, ok: 1, create_date: 1700000001, userip: 16 << 24, images: 0, files: 0, doctype: 0, quotepid: 0, message: '原始首贴', message_fmt: '<p>首贴内容</p>' },
      { pid: 2, tid: 2, uid: 2, isfirst: 0, ok: 1, create_date: 1700000002, userip: 16 << 24, images: 0, files: 0, doctype: 0, quotepid: 1, message: '原始回复', message_fmt: '<p>回复内容</p>' },
    ] },
    { test: /FROM bbs_post WHERE pid IN/, rows: [{ pid: 1, uid: 1, message_fmt: '<p>首贴内容</p>' }] },
    { test: /bbs_attach/, rows: [] },
    { test: /FROM bbs_user WHERE uid IN/, rows: (params) => params.map((uid) => Number(uid) === 2 ? { uid: 2, username: 'user2', avatar: 9 } : { uid: Number(uid), username: 'admin', avatar: 0 }) },
    { test: /FROM bbs_user WHERE uid = \?/, first: { uid: 1, gid: 1, username: 'admin', avatar: 0, threads: 2, posts: 5, credits: 3, create_date: 1, login_date: 2 } },
    { test: /bbs_cache/, first: null },
  ];
}

function envFor(rules: SqlRule[]) {
  const { db, calls } = fakeD1Sql(rules);
  return { env: { DB: db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost' }, calls };
}

async function json(res: Response) {
  return (await res.json()) as { code: number; message: string } & Record<string, unknown>;
}

beforeEach(() => l0Clear());

describe('只读接口集成（T1-4 DoD）', () => {
  it('GET /api/threads：游客列表 + camelCase DTO + 查询数远低于 50', async () => {
    const { env, calls } = envFor(baseRules());
    const res = await app.request('/api/threads', {}, env as never);
    const body = await json(res);
    expect(body.code).toBe(Code.OK);
    const data = body.data as { list: Record<string, unknown>[]; totalPage: number; nextCursor: number; cursorCol: string };
    expect(data.list).toHaveLength(2);
    expect(data.list[0]!.subject).toBe('你好世界');
    expect(data.list[0]!.createDate).toBe(1700000001);
    expect(data.list[0]!).not.toHaveProperty('create_date');
    expect(data.nextCursor).toBe(1);
    expect(data.cursorCol).toBe('lastpid'); // 默认版块序按最后回复；前端据此拼 before_lastpid
    expect(calls.length).toBeLessThanOrEqual(15);
    expect(calls.filter((c) => /FROM bbs_user/.test(c.sql))).toHaveLength(1); // 作者 V 头衔/预设头像随行批量补查恰 1 次
  });

  it('digest=1 时不并置顶表', async () => {
    const { env, calls } = envFor(baseRules());
    const res = await app.request('/api/threads?digest=1', {}, env as never);
    expect((await json(res)).code).toBe(Code.OK);
    expect(calls.some((c) => /bbs_thread_top/.test(c.sql))).toBe(false);
  });

  it('编号分页：page=1 走首页窗口（无 OFFSET），page>1 走浅层 OFFSET 移动窗口', async () => {
    const p1 = envFor(baseRules());
    expect((await json(await app.request('/api/threads?page=1', {}, p1.env as never))).code).toBe(Code.OK);
    const q1 = p1.calls.find((c) => /FROM bbs_thread WHERE fid IN/.test(c.sql))!;
    expect(q1.sql).not.toContain('OFFSET'); // 首页仍是 LIMIT size，与游标窗口一致

    const p2 = envFor(baseRules());
    expect((await json(await app.request('/api/threads?page=2', {}, p2.env as never))).code).toBe(Code.OK);
    const q2 = p2.calls.find((c) => /FROM bbs_thread WHERE fid IN/.test(c.sql))!;
    expect(q2.sql).toMatch(/LIMIT \? OFFSET \?/); // 编号页码真正移动窗口，修复"点第2页仍是第1页"
    expect(q2.params).toContain(30); // THREAD_LIST size=30 → 第 2 页 OFFSET 30
    expect(p2.calls.some((c) => /bbs_thread_top/.test(c.sql))).toBe(false); // 置顶仅首页并入
  });

  it('GET /api/threads/2：作者映射 + 引用块 + 游客权限位 + userip 不外泄', async () => {
    const { env, calls } = envFor(baseRules());
    const waited: Promise<unknown>[] = [];
    const res = await app.request('/api/threads/2', {}, env as never, {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    } as never);
    const body = await json(res);
    expect(body.code).toBe(Code.OK);
    const d = body.data as {
      thread: { tid: number };
      posts: { list: Record<string, unknown>[]; totalPage: number };
      perms: Record<string, boolean>;
    };
    expect(d.thread.tid).toBe(2);
    const [first, reply] = d.posts.list as [{ username: string; avatar: number; userip?: number; quoted?: { pid: number; username: string } }, ...unknown[]];
    expect(first.username).toBe('admin');
    expect(first.userip).toBeUndefined(); // 游客无 allowviewip
    const r = reply as { username: string; avatar: number; quoted?: { pid: number; username: string } };
    expect(r.username).toBe('user2');
    expect(r.avatar).toBe(9);
    expect(r.quoted).toEqual({ pid: 1, username: 'admin', messageSnippet: '首贴内容' });
    expect(d.perms).toEqual({ allowpost: true, allowupdate: false, allowdelete: false, allowmod: false, seeCheck: false });
    // 原文 message 仅下发给可编辑者（对读者剥离 message）：游客 allowupdate=false → 帖子不带 message
    expect(first).not.toHaveProperty('message');
    expect(r).not.toHaveProperty('message');
    // 详情页 SELECT 仍投影 message（供编辑初值），只是按权限门控输出
    expect(calls.some((c) => /SELECT[\s\S]*\bmessage,\s*message_fmt\b[\s\S]*FROM/.test(c.sql))).toBe(true);
    // 19 = 原 15 + 上一篇/下一篇（UNION ALL 单语句）+ 楼层点赞计数
    //      + 2（forumlist 从 L1 KV 移到 L2：冷读 1 次 SELECT bbs_cache + 回填 1 次 REPLACE）
    // 换来的收益：forumlist 失效不再消耗 KV 写额度（免费层 1,000/天 → 每次发帖 1 次即打满）
    expect(calls.length).toBeLessThanOrEqual(20);
    await Promise.all(waited); // waitUntil 旁路落库
    expect(calls.some((c) => /UPDATE bbs_thread SET views/.test(c.sql))).toBe(true);
  });

  it('GET /api/threads/9：不存在 → NOT_FOUND 信封', async () => {
    const rules = baseRules();
    const rule = rules.find((x) => /bbs_thread WHERE tid/.test(x.test.source));
    if (rule) rule.first = null;
    const { env } = envFor(rules);
    const res = await app.request('/api/threads/9', {}, env as never);
    expect((await json(res)).code).toBe(Code.NOT_FOUND);
  });

  it('accesson 私密版块：游客首页过滤 + 版块页 403 语义', async () => {
    const rules = baseRules({
      forum: [{ ...FORUM_OPEN, accesson: 1 }],
      access: [{ fid: 1, gid: 1, allowread: 1, allowthread: 1, allowpost: 1, allowattach: 1, allowdown: 1 }],
    });
    const { env } = envFor(rules);
    const list = await json(await app.request('/api/threads', {}, env as never));
    expect((list.data as { list: unknown[] }).list).toHaveLength(0);
    const page = await json(await app.request('/api/forums/1/threads', {}, env as never));
    expect(page.code).toBe(Code.NO_PERMISSION);
  });

  it('GET /api/bootstrap：版块树 + 游客 me=null', async () => {
    const { env } = envFor(baseRules());
    const body = await json(await app.request('/api/bootstrap', {}, env as never));
    expect(body.code).toBe(Code.OK);
    const d = body.data as { forumlist: { fid: number; name: string }[]; me: unknown; setting: { sitename: string; mailOn?: boolean } };
    expect(d.forumlist[0]!.name).toBe('默认版块');
    expect(d.me).toBeNull();
    expect(d.setting.sitename).toBe('FreeIDX');
    // 未配置 SMTP 池 ⇒ mailOn=false：前端据此隐藏验证码框（后端此时按「验证关闭」降级）
    expect(d.setting.mailOn).toBe(false);
  });

  it('GET /api/users/1 + /threads：公开列零敏感字段、我的主题走权限过滤', async () => {
    const { env } = envFor(baseRules());
    const body = await json(await app.request('/api/users/1', {}, env as never));
    expect(body.code).toBe(Code.OK);
    const d = body.data as Record<string, unknown>;
    expect(d.username).toBe('admin');
    expect(d.email).toBeUndefined();
    expect(d.password).toBeUndefined();
    const mine = await json(await app.request('/api/users/1/threads', {}, env as never));
    expect(mine.code).toBe(Code.OK);
    expect((mine.data as { list: unknown[] }).list.length).toBeGreaterThanOrEqual(0);
  });
});
