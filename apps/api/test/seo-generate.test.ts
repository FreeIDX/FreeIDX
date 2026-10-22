/**
 * T2-7 SEO HTML 生成侧（§16.1/§16.4）：
 *  - 单元：generateThreadSeoHtml 写 R2 `seo/{tid}.html`、主题不存在返回 false、delete 失效、backfill 增量游标。
 *  - 集成：写接口经 scheduleSeo 旁路（waitUntil）——发帖/回帖/编辑生成产物，主题级联删失效。
 * 断言产物存在性/内容，且写请求主路径查询数不因 SEO 生成膨胀（无 R2 时整段跳过）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { Cache, l0Clear } from '../src/core/cache';
import type { D1b } from '../src/core/db';
import { generateThreadSeoHtml, deleteThreadSeoHtml, seoKey, enqueueSeoRename, seoRebuildRenamed } from '../src/modules/seo/generate';

const now = () => Math.floor(Date.now() / 1000);
const SETTING = JSON.stringify({
  runlevel: 5, sitename: 'FreeIDX', brief: 'b', url: 'http://localhost', kw: '', desc: '',
  user_create_on: 1, user_create_email_on: 0, user_resetpw_on: 1,
  forum_orderby: 0, update_views_on: 1, upload_max_size: 1048576, lang: 'zh-cn',
});
const GROUP_ADMIN = {
  gid: 1, name: '管理员', creditsfrom: 0, creditsto: 0,
  allowread: 1, allowthread: 1, allowpost: 1, allowattach: 1, allowdown: 1,
  allowtop: 1, allowupdate: 1, allowdelete: 1, allowmove: 1, allowbanuser: 1, allowdeleteuser: 1, allowviewip: 1,
};
const FORUM1 = { fid: 1, name: '默认版块', rank: 1, threads: 2, todayposts: 0, todaythreads: 0, brief: '', announcement: '', accesson: 0, orderby: 0, icon: 0, moduids: '', seo_title: '', seo_keywords: '' };
const AUTHOR = { uid: 1, gid: 1, username: 'admin', avatar: 7, password: 'x', salt: '', token_version: 0, email: 'a@b.c', threads: 2, posts: 5 };
const SEO_THREAD = { tid: 500, subject: '新标题', username: 'admin', create_date: 1700000000, posts: 0, views: 1, ok: 1 };

/** 生成侧读取的 SELECT（须排在通用 bbs_thread/bbs_post 规则之前） */
function seoRules(): SqlRule[] {
  return [
    { test: /SELECT tid,subject,username,create_date,posts,views,ok,content_buy FROM bbs_thread/, first: () => ({ ...SEO_THREAD, content_buy: 0 }) },
    { test: /SELECT message_fmt FROM bbs_post WHERE tid = \? ORDER BY pid ASC/, first: { message_fmt: '<p>正文</p>' } },
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: SETTING } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    // 真删前收集附件 R2 key（core/purge.attachKeysBy*）
    { test: /SELECT filename FROM bbs_attach/, rows: [] },
    { test: /SELECT tid FROM bbs_thread WHERE tid > \? ORDER BY tid ASC/, rows: [{ tid: 1 }, { tid: 2 }] },
    { test: /FROM bbs_forum ORDER BY/, rows: [FORUM1] },
    { test: /bbs_forum_access/, rows: [] },
    { test: /FROM bbs_group/, rows: [GROUP_ADMIN] },
    { test: /FROM bbs_session WHERE sid/, first: (p: readonly unknown[]) => ({ uid: Number(p[0]) === 0 ? 0 : 1, last_date: now() }) },
    { test: /FROM bbs_user WHERE uid = \?/, first: () => AUTHOR },
    // 批量升组读取（upgradeGroupsByCredits）：与上面单条读取同源（AUTHOR gid=1 → 不换组）
    { test: /SELECT uid,gid,credits FROM bbs_user WHERE uid IN/, rows: (p: readonly unknown[]) => p.map((u) => ({ uid: Number(u), gid: 1, credits: 0 })) },
    { test: /FROM bbs_thread WHERE tid = \?/, first: () => ({ fid: 1, closed: 0, top: 0, subject: '原标题', uid: 1, lastpid: 88 }) },
    { test: /SELECT pid,tid,uid,isfirst FROM bbs_post/, first: (p: readonly unknown[]) => ({ pid: Number(p[0]), tid: 9, uid: 1, isfirst: 1 }) },
    { test: /SELECT uid, COUNT\(\*\) AS c FROM bbs_post/, rows: [] },
    // 删除回扣楼层列表（tt_credits threadRevokeEntries：级联删前读取）
    { test: /SELECT pid,uid FROM bbs_post WHERE tid = \? AND isfirst = 0/, rows: [] },
    { test: /INSERT INTO bbs_post/, first: { pid: 100 }, rows: [{ pid: 100 }] },
    { test: /INSERT INTO bbs_thread/, first: { tid: 500 }, rows: [{ tid: 500 }] },
    { test: /INSERT INTO bbs_mythread|INSERT INTO bbs_mypost/, rows: [] },
    { test: /UPDATE |DELETE /, rows: [] },
  ];
}

interface R2Stub {
  store: Map<string, { value: string; opts?: unknown }>;
  put: (k: string, v: string, o?: unknown) => Promise<void>;
  get: (k: string) => Promise<{ text: () => Promise<string> } | null>;
  delete: (k: string) => Promise<void>;
}
function fakeR2(): R2Stub {
  const store = new Map<string, { value: string; opts?: unknown }>();
  return {
    store,
    put: async (k, v, o) => {
      store.set(k, { value: v, opts: o });
    },
    get: async (k) => {
      const hit = store.get(k);
      return hit ? { text: async () => hit.value } : null;
    },
    delete: async (k) => {
      store.delete(k);
    },
  };
}

function makeDeps(rules: SqlRule[]) {
  const { db } = fakeD1Sql(rules);
  const r2 = fakeR2();
  const env = { DB: db, CACHE: fakeKv(), FILES: r2, SITE_URL: 'http://localhost' };
  const cache = new Cache(env as never, db as unknown as D1b);
  return { db, cache, r2, env };
}

beforeEach(() => l0Clear());

describe('SEO 生成侧单元（T2-7）', () => {
  it('generateThreadSeoHtml：主题存在 → 写 seo/{tid}.html 且含标题/正文/canonical', async () => {
    const d = makeDeps(seoRules());
    const ok = await generateThreadSeoHtml({ db: d.db as never, cache: d.cache, env: d.env as never }, 500);
    expect(ok).toBe(true);
    const html = d.r2.store.get(seoKey(500))?.value ?? '';
    expect(html).toContain('<title>');
    expect(html).toContain('新标题');
    expect(html).toContain('<p>正文</p>');
    expect(html).toContain('http://localhost/thread/500');
    expect(d.r2.store.get(seoKey(500))?.opts).toMatchObject({ httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  });

  it('generateThreadSeoHtml：主题不存在 → false 且不写产物', async () => {
    const { db } = fakeD1Sql([{ test: /FROM bbs_thread WHERE tid = \?/, first: null }]);
    const r2 = fakeR2();
    const env = { DB: db, CACHE: fakeKv(), FILES: r2, SITE_URL: 'http://localhost' };
    const ok = await generateThreadSeoHtml({ db: db as never, cache: new Cache(env as never, db as never), env: env as never }, 999);
    expect(ok).toBe(false);
    expect(r2.store.size).toBe(0);
  });

  it('deleteThreadSeoHtml：移除既有产物', async () => {
    const d = makeDeps(seoRules());
    await generateThreadSeoHtml({ db: d.db as never, cache: d.cache, env: d.env as never }, 500);
    expect(d.r2.store.has(seoKey(500))).toBe(true);
    await deleteThreadSeoHtml({ db: d.db as never, cache: d.cache, env: d.env as never }, 500);
    expect(d.r2.store.has(seoKey(500))).toBe(false);
  });
});

describe('写接口 SEO 旁路集成（T2-7 DoD）', () => {
  function authed(): HeadersInit {
    return { 'content-type': 'application/json', cookie: 'sid=sessA; csrf=tok123', 'x-csrf-token': 'tok123' };
  }

  it('发帖：waitUntil 旁路生成 seo/{tid}.html', async () => {
    const d = makeDeps(seoRules());
    const waited: Promise<unknown>[] = [];
    const res = await app.request(
      '/api/threads',
      { method: 'POST', headers: authed(), body: JSON.stringify({ fid: 1, subject: '新标题', message: '<p>正文</p>', doctype: 0 }) },
      d.env as never,
      { waitUntil: (p: Promise<unknown>) => waited.push(p) } as never,
    );
    expect(((await res.json()) as { code: number }).code).toBe(Code.OK);
    await Promise.all(waited);
    expect(d.r2.store.has(seoKey(500))).toBe(true);
    expect(d.r2.store.get(seoKey(500))?.value).toContain('新标题');
  });

  it('回帖：重新生成 seo 产物', async () => {
    const d = makeDeps(seoRules());
    const waited: Promise<unknown>[] = [];
    const res = await app.request(
      '/api/threads/9/posts',
      { method: 'POST', headers: authed(), body: JSON.stringify({ message: '<p>回复</p>', doctype: 0 }) },
      d.env as never,
      { waitUntil: (p: Promise<unknown>) => waited.push(p) } as never,
    );
    expect(((await res.json()) as { code: number }).code).toBe(Code.OK);
    await Promise.all(waited);
    expect(d.r2.store.has(seoKey(9))).toBe(true);
  });

  it('主题级联删：seo 产物失效', async () => {
    const d = makeDeps(seoRules());
    // 预置产物
    d.r2.store.set(seoKey(9), { value: '<html>old</html>' });
    const waited: Promise<unknown>[] = [];
    const res = await app.request(
      '/api/posts/100',
      { method: 'DELETE', headers: authed() },
      d.env as never,
      { waitUntil: (p: Promise<unknown>) => waited.push(p) } as never,
    );
    expect(((await res.json()) as { code: number }).code).toBe(Code.OK);
    await Promise.all(waited);
    expect(d.r2.store.has(seoKey(9))).toBe(false);
  });

  it('无 R2 绑定（FILES 无 put）→ 写主路径不生成、查询数不膨胀', async () => {
    const { db, calls } = fakeD1Sql(seoRules());
    const env = { DB: db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost' };
    const res = await app.request(
      '/api/threads',
      { method: 'POST', headers: authed(), body: JSON.stringify({ fid: 1, subject: '新标题', message: '<p>正文</p>', doctype: 0 }) },
      env as never,
    );
    expect(((await res.json()) as { code: number }).code).toBe(Code.OK);
    expect(calls.some((c) => /SELECT tid,subject,username,create_date,posts,views FROM bbs_thread/.test(c.sql))).toBe(false);
  });
});
describe('改名 SEO 重建队列（§20.2 C 档）', () => {
  const QUEUE_KEY = 'seo:rename-pending';

  /** 队列专用规则：bbs_kv 按 k 分流（setting / 队列）；游标取行按 uid+cursor 参数返回 */
  function queueRules(over: { tids?: number[]; queue?: { uid: number; cursor: number }[]; threadOk?: number } = {}) {
    const tids = over.tids ?? [];
    const queue = over.queue ?? [];
    const rules: SqlRule[] = [
      { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: (p: readonly unknown[]) => ({ v: String(p[0]) === QUEUE_KEY ? JSON.stringify(queue) : SETTING }) },
      { test: /REPLACE INTO bbs_kv/, rows: [] },
      { test: /SELECT tid FROM bbs_thread WHERE uid = \? AND tid > \? ORDER BY tid ASC LIMIT \?/, rows: (p: readonly unknown[]) => tids.filter((t) => t > Number(p[1])).slice(0, Number(p[2])).map((tid) => ({ tid })) },
      { test: /SELECT tid,subject,username,create_date,posts,views,ok,content_buy FROM bbs_thread/, first: () => ({ ...SEO_THREAD, ok: over.threadOk ?? 1, content_buy: 0 }) },
      { test: /SELECT message_fmt FROM bbs_post WHERE tid = \? ORDER BY pid ASC/, first: { message_fmt: '<p>正文</p>' } },
      { test: /SELECT v FROM bbs_cache/, first: null },
      { test: /REPLACE INTO bbs_cache/, rows: [] },
      { test: /DELETE FROM bbs_cache/, rows: [] },
    ];
    return rules;
  }

  it('enqueue：入队写 kv，同 uid 幂等跳过', async () => {
    const { db, calls } = fakeD1Sql(queueRules());
    await enqueueSeoRename(db as never, 5);
    const writes = calls.filter((c) => /REPLACE INTO bbs_kv/.test(c.sql) && String(c.params[0]) === QUEUE_KEY);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]?.params[1]))).toEqual([{ uid: 5, cursor: 0 }]);
    // 二次入队（队列已含 uid=5）→ 不再写 kv
    const second = fakeD1Sql(queueRules({ queue: [{ uid: 5, cursor: 0 }] }));
    await enqueueSeoRename(second.db as never, 5);
    expect(second.calls.some((c) => /REPLACE INTO bbs_kv/.test(c.sql))).toBe(false);
  });

  it('rebuild：首批满 limit → 逐 tid 生成产物并推进 cursor（不移出队列）', async () => {
    const { db, calls } = fakeD1Sql(queueRules({ queue: [{ uid: 5, cursor: 0 }], tids: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21] }));
    const r2 = fakeR2();
    const env = { DB: db, CACHE: fakeKv(), FILES: r2, SITE_URL: 'http://localhost' };
    const cache = new Cache(env as never, db as never);
    const n = await seoRebuildRenamed({ db: db as never, cache, env: env as never }, 10);
    expect(n).toBe(10);
    expect(r2.store.has(seoKey(11))).toBe(true);
    expect(r2.store.has(seoKey(20))).toBe(true);
    expect(r2.store.has(seoKey(21))).toBe(false); // 尾批未到
    const write = calls.find((c) => /REPLACE INTO bbs_kv/.test(c.sql) && String(c.params[0]) === QUEUE_KEY);
    expect(JSON.parse(String(write?.params[1] ?? '[]'))).toEqual([{ uid: 5, cursor: 20 }]);
  });

  it('rebuild：尾批（< limit）→ 处理完移出队列并清空', async () => {
    const { db, calls } = fakeD1Sql(queueRules({ queue: [{ uid: 5, cursor: 20 }], tids: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21] }));
    const r2 = fakeR2();
    const env = { DB: db, CACHE: fakeKv(), FILES: r2, SITE_URL: 'http://localhost' };
    const cache = new Cache(env as never, db as never);
    const n = await seoRebuildRenamed({ db: db as never, cache, env: env as never }, 10);
    expect(n).toBe(1); // 只剩 tid=21
    expect(r2.store.has(seoKey(21))).toBe(true);
    const write = calls.find((c) => /REPLACE INTO bbs_kv/.test(c.sql) && String(c.params[0]) === QUEUE_KEY);
    expect(JSON.parse(String(write?.params[1] ?? '[]'))).toEqual([]);
  });

  it('rebuild：未过审主题（generate=false）→ 删除旧产物而非重生成', async () => {
    const { db } = fakeD1Sql(queueRules({ queue: [{ uid: 5, cursor: 0 }], tids: [11], threadOk: 0 }));
    const r2 = fakeR2();
    r2.store.set(seoKey(11), { value: '<html>old</html>' }); // 预置改名前旧产物
    const env = { DB: db, CACHE: fakeKv(), FILES: r2, SITE_URL: 'http://localhost' };
    const cache = new Cache(env as never, db as never);
    const n = await seoRebuildRenamed({ db: db as never, cache, env: env as never }, 10);
    expect(n).toBe(1);
    expect(r2.store.has(seoKey(11))).toBe(false);
  });

  it('rebuild：空队列 / 无 R2 → 零处理', async () => {
    const { db } = fakeD1Sql(queueRules({ queue: [] }));
    const env = { DB: db, CACHE: fakeKv(), FILES: fakeR2(), SITE_URL: 'http://localhost' };
    const cache = new Cache(env as never, db as never);
    expect(await seoRebuildRenamed({ db: db as never, cache, env: env as never })).toBe(0);

    const e2 = { DB: db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost' };
    const c2 = new Cache(e2 as never, db as never);
    expect(await seoRebuildRenamed({ db: db as never, cache: c2, env: e2 as never })).toBe(0);
  });
});
