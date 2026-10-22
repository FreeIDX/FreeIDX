/** 回帖过审（POST /api/check act=1 opt=1）：尾列补写含 lastusername 标量子查询（§20.2 结构性修复） */
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';

const now = () => Math.floor(Date.now() / 1000);
const SETTING = JSON.stringify({ runlevel: 5, lang: 'zh-cn' });
const MODERATOR = { uid: 3, gid: 3, username: 'mod', avatar: 0, password: 'x', salt: '', token_version: 0, email: 'm@b.c', threads: 0, posts: 0 };
const GROUP_SEECHECK = {
  gid: 3, name: '版主', creditsfrom: 0, creditsto: 0,
  allowread: 1, allowthread: 1, allowpost: 1, allowattach: 1, allowdown: 1,
  allowtop: 1, allowupdate: 1, allowdelete: 1, allowmove: 1, allowbanuser: 0, allowdeleteuser: 0, allowviewip: 1,
  see_check: 1,
};

function rules(): SqlRule[] {
  return [
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: SETTING } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /FROM bbs_session WHERE sid/, first: (p: readonly unknown[]) => ({ uid: Number(p[0]) === 0 ? 0 : 3, last_date: now() }) },
    { test: /FROM bbs_user WHERE uid = \?/, first: () => MODERATOR },
    { test: /FROM bbs_group/, rows: [GROUP_SEECHECK] },
    { test: /FROM bbs_forum ORDER BY/, rows: [] },
    { test: /bbs_forum_access/, rows: [] },
    { test: /SELECT tid,uid,ok,create_date FROM bbs_post WHERE pid = \? AND isfirst = 0/, first: { tid: 9, uid: 7, ok: 0, create_date: 1700000000 } },
    { test: /UPDATE bbs_post|UPDATE bbs_thread/, rows: [] },
  ];
}

function makeEnv(rs = rules()) {
  const { db, calls } = fakeD1Sql(rs);
  return { env: { DB: db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost' } as never, calls };
}
const headers = (): HeadersInit => ({ 'content-type': 'application/json', cookie: 'sid=sessM; csrf=tok123', 'x-csrf-token': 'tok123' });

beforeEach(() => l0Clear());

describe('POST /api/check（回帖过审补列）', () => {
  it('act=1 opt=1：尾列补写含 lastusername 标量子查询（取回帖者当前用户名）', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/check', { method: 'POST', headers: headers(), body: JSON.stringify({ act: 1, id: 100, opt: 1 }) }, env);
    expect(((await res.json()) as { code: number }).code).toBe(Code.OK);
    const tail = calls.find((c) =>
      /UPDATE bbs_thread SET lastpid = \?, lastuid = \?, last_date = \?, lastusername = \(SELECT username FROM bbs_user WHERE uid = \?\) WHERE tid = \? AND lastpid < \?/.test(c.sql),
    );
    expect(tail).toBeTruthy();
    expect(tail?.params).toEqual([100, 7, 1700000000, 7, 9, 100]);
  });

  it('act=0 opt=-2：see_check 但无目标版块 allowdelete → 拒绝真删（不执行任何删除）', async () => {
    const rs = rules();
    rs.push(
      { test: /SELECT tid,fid,uid FROM bbs_thread WHERE tid/, first: { tid: 9, fid: 1, uid: 7 } },
      { test: /DELETE FROM bbs_thread|DELETE FROM bbs_post/, rows: [] },
    );
    const { env, calls } = makeEnv(rs);
    const res = await app.request('/api/check', { method: 'POST', headers: headers(), body: JSON.stringify({ act: 0, id: 9, opt: -2 }) }, env);
    expect(((await res.json()) as { code: number }).code).toBe(Code.NO_PERMISSION);
    expect(calls.some((c) => /DELETE FROM bbs_thread|DELETE FROM bbs_post/.test(c.sql))).toBe(false);
  });
});