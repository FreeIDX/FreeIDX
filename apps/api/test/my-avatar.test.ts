/** T2-9 头像上传：R2 key 规则 + ≤40K + 时间戳缓存串 + 反规范化回写 */
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, fakeR2, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';
import { avatarKey } from '../src/modules/my/routes';

const now = () => Math.floor(Date.now() / 1000);
const b64 = (n: number): string => btoa('x'.repeat(n));
const AUTHOR = { uid: 1, gid: 1, username: 'admin', avatar: 7, password: 'x', salt: '', token_version: 0, email: 'a@b.c', threads: 2, posts: 5 };
const GROUP_ADMIN = { gid: 1, allowattach: 1 };

function rules(): SqlRule[] {
  return [
    { test: /FROM bbs_session WHERE sid/, first: (p: readonly unknown[]) => ({ uid: Number(p[0]) === 0 ? 0 : 1, last_date: now() }) },
    { test: /FROM bbs_user WHERE uid = \?/, first: () => AUTHOR },
    { test: /FROM bbs_group/, rows: [GROUP_ADMIN] },
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: JSON.stringify({ runlevel: 5, lang: 'zh-cn' }) } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /UPDATE bbs_user SET avatar/, rows: [] },
    { test: /UPDATE bbs_thread SET avatar/, rows: [] },
  ];
}

function env(over: SqlRule[] = []) {
  const { db, calls } = fakeD1Sql([...over, ...rules()]);
  const r2 = fakeR2();
  return { env: { DB: db, CACHE: fakeKv(), FILES: r2, SITE_URL: 'http://localhost' }, r2, calls };
}

const headers = (): HeadersInit => ({ 'content-type': 'application/json', cookie: 'sid=sessA; csrf=tok123', 'x-csrf-token': 'tok123' });

beforeEach(() => l0Clear());

describe('POST /api/me/avatar', () => {
  it('key 规则：avatar/{uid补9位前3段}/{uid}.png', () => {
    expect(avatarKey(1)).toBe('avatar/000/1.png');
    expect(avatarKey(1234567)).toBe('avatar/001/1234567.png');
  });

  it('未登录 → NOT_LOGIN', async () => {
    const e = env([{ test: /FROM bbs_session WHERE sid/, first: () => ({ uid: 0, last_date: now() }) }]);
    const res = await app.request('/api/me/avatar', { method: 'POST', headers: headers(), body: JSON.stringify({ data: b64(10) }) }, e.env as never);
    expect(((await res.json()) as { code: number }).code).toBe(Code.NOT_LOGIN);
  });

  it('超 40K → FORM_FILE_TOO_LARGE', async () => {
    const e = env();
    const res = await app.request('/api/me/avatar', { method: 'POST', headers: headers(), body: JSON.stringify({ data: b64(50000) }) }, e.env as never);
    expect(((await res.json()) as { code: number }).code).toBe(Code.FORM_FILE_TOO_LARGE);
  });

  it('multipart file 分支同样受 ≤40K 上限（不得绕过 base64 路径校验）', async () => {
    const e = env();
    const fd = new FormData();
    fd.append('file', new Blob(['x'.repeat(50_000)], { type: 'image/png' }), 'big.png');
    const res = await app.request(
      '/api/me/avatar',
      { method: 'POST', headers: { cookie: 'sid=sessA; csrf=tok123', 'x-csrf-token': 'tok123' }, body: fd },
      e.env as never,
    );
    expect(((await res.json()) as { code: number }).code).toBe(Code.FORM_FILE_TOO_LARGE);
    expect(e.r2.store.has('avatar/000/1.png')).toBe(false);
  });

  it('成功 → 写 R2 + user.avatar 时间戳（并清 avatar_auto 互斥）+ 反规范化回写 + url 带 ?v=', async () => {
    const e = env();
    const res = await app.request('/api/me/avatar', { method: 'POST', headers: headers(), body: JSON.stringify({ data: b64(60) }) }, e.env as never);
    const body = (await res.json()) as { code: number; data: { url: string; avatar: number } };
    expect(body.code).toBe(Code.OK);
    expect(body.data.url).toMatch(/^\/files\/avatar\/000\/1\.png\?v=\d{10}$/);
    expect(e.r2.store.has('avatar/000/1.png')).toBe(true);
    expect(e.calls.some((c) => /UPDATE bbs_user SET avatar = \?, avatar_auto = '0' WHERE uid = \?/.test(c.sql))).toBe(true);
    expect(e.calls.some((c) => /UPDATE bbs_thread SET avatar = \? WHERE uid = \?/.test(c.sql))).toBe(true);
  });
});

describe('POST /api/my/avatar/preset', () => {
  it('未登录 → NOT_LOGIN', async () => {
    const e = env([{ test: /FROM bbs_session WHERE sid/, first: () => ({ uid: 0, last_date: now() }) }]);
    const res = await app.request('/api/my/avatar/preset', { method: 'POST', headers: headers(), body: JSON.stringify({ imgsrc: '/avatars/1.png' }) }, e.env as never);
    expect(((await res.json()) as { code: number }).code).toBe(Code.NOT_LOGIN);
  });

  it('白名单外（形态不对 / 超 56）→ VALIDATION_ERROR', async () => {
    for (const imgsrc of ['/other/1.png', '/avatars/a.png', '/avatars/57.png', '../../../etc/passwd']) {
      const e = env([
        { test: /UPDATE bbs_user SET avatar_auto = \?, avatar = 0 WHERE uid = \?/, rows: [] },
        { test: /UPDATE bbs_thread SET avatar = \? WHERE uid = \?/, rows: [] },
      ]);
      const res = await app.request('/api/my/avatar/preset', { method: 'POST', headers: headers(), body: JSON.stringify({ imgsrc }) }, e.env as never);
      expect(((await res.json()) as { code: number }).code).toBe(Code.VALIDATION_ERROR);
    }
  });

  it('设置预设 → avatar_auto=imgsrc + avatar=0 + 删 R2 旧头像 + 反规范化回写 0', async () => {
    const e = env([
      { test: /UPDATE bbs_user SET avatar_auto = \?, avatar = 0 WHERE uid = \?/, rows: [] },
      { test: /UPDATE bbs_thread SET avatar = \? WHERE uid = \?/, rows: [] },
    ]);
    e.r2.store.set('avatar/000/1.png', { data: new Uint8Array([1]) });
    const res = await app.request('/api/my/avatar/preset', { method: 'POST', headers: headers(), body: JSON.stringify({ imgsrc: '/avatars/7.png' }) }, e.env as never);
    const body = (await res.json()) as { code: number; message: string; data: { avatar_auto: string } };
    expect(body.code).toBe(Code.OK);
    expect(body.message).toBe('修改头像成功');
    expect(body.data.avatar_auto).toBe('/avatars/7.png');
    expect(e.calls.some((c) => /UPDATE bbs_user SET avatar_auto = \?, avatar = 0 WHERE uid = \?/.test(c.sql))).toBe(true);
    expect(e.calls.some((c) => /UPDATE bbs_thread SET avatar = \? WHERE uid = \?/.test(c.sql))).toBe(true);
    expect(e.r2.store.has('avatar/000/1.png')).toBe(false); // 与自定义头像互斥：旧文件删除
  });

  it('imgsrc 为空 → 仅清 avatar_auto（不动 avatar）', async () => {
    const e = env([{ test: /UPDATE bbs_user SET avatar_auto = '0' WHERE uid = \?/, rows: [] }]);
    const res = await app.request('/api/my/avatar/preset', { method: 'POST', headers: headers(), body: JSON.stringify({}) }, e.env as never);
    const body = (await res.json()) as { code: number; data: { avatar_auto: string } };
    expect(body.code).toBe(Code.OK);
    expect(body.data.avatar_auto).toBe('0');
    expect(e.calls.some((c) => /UPDATE bbs_user SET avatar_auto = '0' WHERE uid = \?/.test(c.sql))).toBe(true);
    expect(e.calls.some((c) => /UPDATE bbs_thread SET avatar/.test(c.sql))).toBe(false);
  });
});
