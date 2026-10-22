/**
 * T2-8 附件全流程：核心纯函数（白名单/改名/分类/R2 key）+ 路由集成（上传/预览/下载/删除/直链/关联）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeAssets, fakeCaches, fakeD1Sql, fakeKv, fakeR2, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';
import { fileExt, storageExt, attachType, isAllowedExt, ymDir } from '../src/modules/attach/core';

const now = () => Math.floor(Date.now() / 1000);
const b64 = (s: string): string => btoa(s);

const GROUP_ADMIN = {
  gid: 1, name: '管理员', creditsfrom: 0, creditsto: 0,
  allowread: 1, allowthread: 1, allowpost: 1, allowattach: 1, allowdown: 1,
  allowtop: 1, allowupdate: 1, allowdelete: 1, allowmove: 1, allowbanuser: 1, allowdeleteuser: 1, allowviewip: 1,
};
const GROUP_GUEST = { ...GROUP_ADMIN, gid: 0, allowattach: 0, allowdown: 0 };
const FORUM1 = { fid: 1, name: '默认版块', rank: 1, threads: 2, todayposts: 0, todaythreads: 0, brief: '', announcement: '', accesson: 0, orderby: 0, icon: 0, moduids: '', seo_title: '', seo_keywords: '' };
const AUTHOR = { uid: 1, gid: 1, username: 'admin', avatar: 7, password: 'x', salt: '', token_version: 0, email: 'a@b.c', threads: 2, posts: 5 };

interface AttachRow { aid: number; uid: number; tid: number; filename: string; orgfilename: string; filesize: number; isimage: number; status: number }
function defaultAttach(over: Partial<AttachRow> = {}): AttachRow {
  return { aid: 42, uid: 1, tid: 9, filename: 'attach/202410/x.png', orgfilename: 'pic.png', filesize: 5, isimage: 1, status: 1, ...over };
}

interface Res { env: unknown; r2: ReturnType<typeof fakeR2>; calls: { sql: string; params: readonly unknown[] }[] }
function makeEnv(rules: SqlRule[]): Res {
  const { db, calls } = fakeD1Sql(rules);
  const r2 = fakeR2();
  return { env: { DB: db, CACHE: fakeKv(), FILES: r2, ASSETS: fakeAssets(), SITE_URL: 'http://localhost' }, r2, calls };
}

function baseRules(attach = defaultAttach()): SqlRule[] {
  return [
    { test: /SELECT aid,filename,isimage FROM bbs_attach WHERE uid/, rows: [] },
    { test: /SELECT aid,uid,tid,filename,orgfilename,filesize,isimage,status,credits FROM bbs_attach WHERE aid/, first: () => ({ ...attach }) },
    { test: /INSERT INTO bbs_attach/, first: { aid: 42 }, rows: [{ aid: 42 }] },
    { test: /SELECT fid,content_buy,uid,ok FROM bbs_thread WHERE tid/, first: { fid: 1, content_buy: 0, uid: 1, ok: 1 } },
    { test: /SELECT fid FROM bbs_thread WHERE tid/, first: { fid: 1 } }, // DELETE 附件路径仍用单列查询
    { test: /FROM bbs_forum ORDER BY/, rows: [FORUM1] },
    { test: /bbs_forum_access/, rows: [] },
    { test: /FROM bbs_group/, rows: [GROUP_ADMIN, GROUP_GUEST] },
    { test: /FROM bbs_session WHERE sid/, first: (p: readonly unknown[]) => ({ uid: Number(p[0]) === 0 ? 0 : 1, last_date: now() }) },
    { test: /FROM bbs_user WHERE uid = \?/, first: () => AUTHOR },
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: '{}' } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_attach/, rows: [] },
    { test: /UPDATE bbs_attach/, rows: [] },
  ];
}

const authHeaders = (): HeadersInit => ({ cookie: 'sid=sessA; csrf=tok123', 'x-csrf-token': 'tok123' });

beforeEach(() => l0Clear());

describe('附件核心纯函数', () => {
  it('fileExt：末段小写、去非法字符、截断 7', () => {
    expect(fileExt('a.b.PDF')).toBe('pdf');
    expect(fileExt('no_ext')).toBe('');
    expect(fileExt('x.torrent')).toBe('torrent'.slice(0, 7));
  });
  it('白名单 + 名单外改名 `_ext` 防执行', () => {
    expect(isAllowedExt('png')).toBe(true);
    expect(storageExt('png')).toBe('png');
    expect(isAllowedExt('php')).toBe(false);
    expect(storageExt('php')).toBe('_php');
  });
  it('attachType 分类对齐附件类型配置', () => {
    expect(attachType('png')).toBe('image');
    expect(attachType('mp3')).toBe('music');
    expect(attachType('zip')).toBe('zip');
    expect(attachType('zzz')).toBe('other');
  });
  it('ymDir = YYYYMM（UTC）', () => {
    expect(ymDir(Date.UTC(2026, 9, 6) / 1000)).toBe('202610');
  });
});

describe('POST /api/attachments（base64）', () => {
  it('未登录 → NOT_LOGIN', async () => {
    const r = makeEnv(baseRules());
    const res = await app.request('/api/attachments', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'csrf=t', 'x-csrf-token': 't' },
      body: JSON.stringify({ name: 'a.png', data: b64('hello'), is_image: 1 }),
    }, r.env as never);
    expect(((await res.json()) as { code: number }).code).toBe(Code.NOT_LOGIN);
  });

  it('空 data → VALIDATION_ERROR', async () => {
    const r = makeEnv(baseRules());
    const res = await app.request('/api/attachments', {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name: 'a.png', data: '' }),
    }, r.env as never);
    expect(((await res.json()) as { code: number }).code).toBe(Code.VALIDATION_ERROR);
  });

  it('合法上传 → 写 R2 tmp/ + INSERT(status=0) + 预览 URL', async () => {
    const r = makeEnv(baseRules());
    const res = await app.request('/api/attachments', {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name: 'a.png', data: b64('hello'), is_image: 1, width: 8, height: 6 }),
    }, r.env as never);
    const body = (await res.json()) as { code: number; data: { aid: number; url: string; status: number } };
    expect(body.code).toBe(Code.OK);
    expect(body.data.aid).toBe(42);
    expect(body.data.url).toBe('/api/attachments/42/preview');
    expect(body.data.status).toBe(0);
    const tmpKeys = [...r.r2.store.keys()].filter((k) => /^tmp\/1_.+\.png$/.test(k));
    expect(tmpKeys.length).toBe(1);
  });

  it('名单外扩展名 → R2 key 前缀 `_ext` 防执行', async () => {
    const r = makeEnv(baseRules());
    const res = await app.request('/api/attachments', {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ name: 'evil.php', data: b64('<?php system($_GET[0]);') }),
    }, r.env as never);
    expect(((await res.json()) as { code: number }).code).toBe(Code.OK);
    const keys = [...r.r2.store.keys()];
    expect(keys.some((k) => /\.php$/.test(k))).toBe(false);
    expect(keys.some((k) => /_php$/.test(k))).toBe(true);
  });
});

describe('GET /api/attachments/:aid/preview', () => {
  it('入库图片 → 内联 + image MIME', async () => {
    const r = makeEnv(baseRules(defaultAttach({ filename: 'attach/202410/x.png', isimage: 1 })));
    r.r2.store.set('attach/202410/x.png', { data: new TextEncoder().encode('binary'), contentType: 'image/png' });
    const res = await app.request('/api/attachments/42/preview', { headers: { cookie: 'sid=sessA' } }, r.env as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toContain('inline');
  });

  it('临时件非本人 → NO_PERMISSION', async () => {
    const r = makeEnv(baseRules(defaultAttach({ status: 0, uid: 99 })));
    const res = await app.request('/api/attachments/42/preview', { headers: { cookie: 'sid=sessA' } }, r.env as never);
    // 非信封：抛错走 onError 仍返回 code
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(Code.NO_PERMISSION);
  });
});

describe('GET /api/attachments/:aid/download', () => {
  it('allowdown → 200 + attachment 原名 + downloads+1', async () => {
    const r = makeEnv(baseRules(defaultAttach({ orgfilename: '报告.pdf', filename: 'attach/202410/y.pdf', isimage: 0 })));
    r.r2.store.set('attach/202410/y.pdf', { data: new TextEncoder().encode('%PDF'), contentType: 'application/octet-stream' });
    const waited: Promise<unknown>[] = [];
    const res = await app.request('/api/attachments/42/download', { headers: { cookie: 'sid=sessA' } }, r.env as never, {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    } as never);
    expect(res.status).toBe(200);
    const disp = res.headers.get('content-disposition') ?? '';
    expect(disp).toContain('attachment');
    expect(disp).toContain("filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf");
    await Promise.all(waited);
    expect(r.calls.some((c) => /UPDATE bbs_attach SET downloads/.test(c.sql))).toBe(true);
  });

  it('组无 allowdown → NO_PERMISSION', async () => {
    // viewer gid0（guest）无 allowdown：改 session 返回 uid 0
    const rules = baseRules();
    const sess = rules.find((x) => /FROM bbs_session WHERE sid/.test(x.test.source));
    if (sess) sess.first = () => ({ uid: 0, last_date: now() });
    const user = rules.find((x) => /bbs_user WHERE uid/.test(x.test.source));
    if (user) user.first = () => ({ uid: 0, gid: 0, username: '', avatar: 0, token_version: 0 });
    const r = makeEnv(rules);
    r.r2.store.set('attach/202410/x.png', { data: new TextEncoder().encode('x') });
    const res = await app.request('/api/attachments/42/download', { headers: { cookie: 'sid=sessA' } }, r.env as never);
    expect(((await res.json()) as { code: number }).code).toBe(Code.NO_PERMISSION);
  });
});

describe('DELETE /api/attachments/:aid', () => {
  it('临时件本人 → 删行 + 删 R2', async () => {
    const r = makeEnv(baseRules(defaultAttach({ status: 0, uid: 1, filename: 'tmp/1_abc.png' })));
    r.r2.store.set('tmp/1_abc.png', { data: new TextEncoder().encode('x') });
    const res = await app.request('/api/attachments/42', { method: 'DELETE', headers: authHeaders() }, r.env as never);
    expect(((await res.json()) as { code: number }).code).toBe(Code.OK);
    expect(r.calls.some((c) => /DELETE FROM bbs_attach WHERE aid/.test(c.sql))).toBe(true);
    expect(r.r2.store.has('tmp/1_abc.png')).toBe(false);
  });

  it('正式件非本人非版主 → NO_PERMISSION', async () => {
    const rules = baseRules(defaultAttach({ status: 1, uid: 99 }));
    const g = rules.find((x) => /FROM bbs_group/.test(x.test.source));
    if (g) g.rows = [{ ...GROUP_ADMIN, gid: 101, allowdelete: 0 }];
    const user = rules.find((x) => /bbs_user WHERE uid/.test(x.test.source));
    if (user) user.first = () => ({ ...AUTHOR, gid: 101 });
    const r = makeEnv(rules);
    const res = await app.request('/api/attachments/42', { method: 'DELETE', headers: authHeaders() }, r.env as never);
    expect(((await res.json()) as { code: number }).code).toBe(Code.NO_PERMISSION);
  });
});

describe('GET /files/*（流式直链护栏）', () => {
  it('avatar/ 前缀放行 + 长缓存', async () => {
    const r = makeEnv(baseRules());
    r.r2.store.set('avatar/000000001/1.png', { data: new TextEncoder().encode('IMG'), contentType: 'image/png' });
    const res = await app.request('/files/avatar/000000001/1.png', {}, r.env as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });
  it('attach/ 前缀拒绝 404（正式附件不下发 R2 key，匿名直取必须走 /api 端点受 allowdown/付费校验）', async () => {
    const r = makeEnv(baseRules());
    r.r2.store.set('attach/202410/x.png', { data: new TextEncoder().encode('IMG'), contentType: 'image/png' });
    const res = await app.request('/files/attach/202410/x.png', {}, r.env as never);
    expect(res.status).toBe(404);
  });
  it('tmp/ 私有前缀拒绝 404', async () => {
    const r = makeEnv(baseRules());
    const res = await app.request('/files/tmp/1_abc.png', {}, r.env as never);
    expect(res.status).toBe(404);
  });
  it('路径穿越拒绝 404', async () => {
    const r = makeEnv(baseRules());
    // 字面 `..` 段会被 URL 解析折叠掉（/files/attach/../../x → /x，根本进不了本路由），
    // 用能存活的 `..` 前缀段真正命中 filesProxy 的穿越护栏。
    const res = await app.request('/files/attach/..secret', {}, r.env as never);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/plain');
  });
});

describe('发帖关联 attachAids（§9.3 无 message 串替换）', () => {
  it('发帖带 aids → tmp→attach/YYYYmm 移动 + status=1 + images/files 计数', async () => {
    const rules = baseRules();
    // 命中两条待关联：1 图 1 文件
    const assoc = rules.find((x) => /SELECT aid,filename,isimage FROM bbs_attach WHERE uid/.test(x.test.source));
    if (assoc) assoc.rows = [{ aid: 7, filename: 'tmp/1_a.png', isimage: 1 }, { aid: 8, filename: 'tmp/1_b.txt', isimage: 0 }];
    // 主题创建链需要 INSERT bbs_thread/post RETURNING
    rules.unshift(
      { test: /INSERT INTO bbs_post/, first: { pid: 100 }, rows: [{ pid: 100 }] },
      { test: /INSERT INTO bbs_thread/, first: { tid: 500 }, rows: [{ tid: 500 }] },
      { test: /FROM bbs_thread WHERE tid = \?/, first: () => ({ fid: 1, closed: 0, top: 0, subject: '原标题', uid: 1, lastpid: 88 }) },
      { test: /UPDATE bbs_|DELETE FROM bbs_post|DELETE FROM bbs_thread|INSERT INTO bbs_my/, rows: [] },
    );
    const r = makeEnv(rules);
    r.r2.store.set('tmp/1_a.png', { data: new TextEncoder().encode('PNG') });
    r.r2.store.set('tmp/1_b.txt', { data: new TextEncoder().encode('TXT') });
    const res = await app.request('/api/threads', {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ fid: 1, subject: '带附件', message: '<p>x</p>', doctype: 0, attachAids: [7, 8] }),
    }, r.env as never);
    expect(((await res.json()) as { code: number }).code).toBe(Code.OK);
    // tmp 件移走
    expect(r.r2.store.has('tmp/1_a.png')).toBe(false);
    expect([...r.r2.store.keys()].some((k) => /^attach\/\d{6}\/.+\.png$/.test(k))).toBe(true);
    // 计数回写：本批 1 图 1 文件，累加式（编辑保历史）
    expect(r.calls.some((c) => /UPDATE bbs_post SET images = images \+ \?, files = files \+ \?/.test(c.sql))).toBe(true);
    expect(r.calls.some((c) => /UPDATE bbs_thread SET images = images \+ \?, files = files \+ \?/.test(c.sql))).toBe(true);
    const upd = r.calls.find((c) => /UPDATE bbs_post SET images/.test(c.sql));
    expect(upd?.params).toEqual([1, 1, 100]);
  });
});

describe('GET /files/* 公共直链边缘缓存（Cache API 写穿，§7 读取屏障的 R2 挡板）', () => {
  /** 隔离的 Cache API 替身：entries 供断言「写入条数 / 是否进入公共缓存」 */
  function installCaches() {
    const fc = fakeCaches();
    fc.install();
    return fc;
  }

  /**
   * 触发一次直链请求并等 `waitUntil` 旁路的缓存写落定。
   * 缓存写是 fire-and-forget（见 edge.ts 的 wait），不传 executionCtx 时写入与断言之间存在
   * 竞态——CI 上曾表现为「第二次请求 MISS / entries 少一条」。与 edge-cache.test.ts 同口径。
   */
  async function getFile(url: string, env: unknown, headers: Record<string, string> = {}) {
    const waited: Promise<unknown>[] = [];
    const res = await app.request(url, { headers }, env as never, {
      waitUntil: (p: Promise<unknown>) => waited.push(p),
      passThroughOnException: () => {},
    } as never);
    await Promise.all(waited); // put 存快照需读 body，必须等它落定再断言
    return res;
  }

  it('同一头像直链第二次命中边缘：R2 只读一次，命中副本保留 immutable', async () => {
    const fc = installCaches();
    const r = makeEnv(baseRules());
    let r2Gets = 0;
    const origGet = r.r2.get.bind(r.r2);
    r.r2.get = async (key: string) => {
      r2Gets++;
      return origGet(key);
    };
    await r.r2.put('avatar/000/1.png', 'PNG', { httpMetadata: { contentType: 'image/png' } });

    const url = '/files/avatar/000/1.png?v=1700000001';
    const res1 = await getFile(url, r.env);
    expect(res1.status).toBe(200);
    expect(res1.headers.get('x-edge-cache')).toBe('MISS');
    expect(r2Gets).toBe(1);

    const res2 = await getFile(url, r.env);
    expect(res2.headers.get('x-edge-cache')).toBe('HIT');
    expect(r2Gets).toBe(1); // 边缘命中不再触达 R2（省 1 次 Class B）
    // cachedCopy 保留源头的 immutable：avatar key 已 ?v= 版本化，洗掉会让浏览器退化成无版本化缓存
    expect(res2.headers.get('cache-control')).toContain('immutable');
    expect(fc.entries.size).toBe(1);
  });

  it('缓存键区分 ?v= 版本：换头像后新 URL 独立条目，不会读到旧图', async () => {
    const fc = installCaches();
    const r = makeEnv(baseRules());
    await r.r2.put('avatar/000/1.png', 'PNG', { httpMetadata: { contentType: 'image/png' } });
    await getFile('/files/avatar/000/1.png?v=100', r.env);
    await getFile('/files/avatar/000/1.png?v=200', r.env);
    expect(fc.entries.size).toBe(2);
  });

  it('带登录轨 Cookie（sid=）的请求绕开边缘缓存：每次直读 R2、不写公共条目', async () => {
    const fc = installCaches();
    const r = makeEnv(baseRules());
    await r.r2.put('avatar/000/1.png', 'PNG', { httpMetadata: { contentType: 'image/png' } });
    const url = '/files/avatar/000/1.png?v=1700000001';
    const h = { cookie: 'sid=sessA; csrf=t' };
    await getFile(url, r.env, h);
    const res2 = await getFile(url, r.env, h);
    expect(res2.headers.get('x-edge-cache')).toBeNull();
    expect(res2.status).toBe(200);
    expect(fc.entries.size).toBe(0);
  });

  it('白名单外前缀不缓存：attach/ 直链保持 404 且零条目（付费附件不可被公共缓存放大）', async () => {
    const fc = installCaches();
    const r = makeEnv(baseRules());
    await r.r2.put('attach/202410/x.png', 'DATA');
    const res = await getFile('/files/attach/202410/x.png', r.env);
    expect(res.status).toBe(404);
    expect(fc.entries.size).toBe(0);
  });

  it('forum/ 图标直链同样写穿（非图片 → 保留源头的 1 天 max-age）', async () => {
    const fc = installCaches();
    const r = makeEnv(baseRules());
    await r.r2.put('forum/8.png', 'ICON', { httpMetadata: { contentType: 'image/png' } });
    const url = '/files/forum/8.png';
    await getFile(url, r.env);
    const res2 = await getFile(url, r.env);
    expect(res2.headers.get('x-edge-cache')).toBe('HIT');
    // forum/ key 固定、会被覆盖重传 → filesProxy 对非 avatar 前缀只给 1 天，不得被洗成长缓存
    expect(res2.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(fc.entries.size).toBe(1);
  });
});
