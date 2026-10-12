/**
 * T2-3 CSRF 双提交：GET 发 cookie；非 GET 校验 X-CSRF-Token 一致性；/api/auth/* 豁免。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { l0Clear } from '../src/core/cache';
import { fakeD1Sql, fakeKv } from './helpers/fake-d1';

const SETTING = JSON.stringify({ runlevel: 5, sitename: 'S', brief: 'b', url: 'http://localhost' });

function envFor() {
  const fake = fakeD1Sql([
    { test: /FROM bbs_kv/, first: { v: SETTING } },
    { test: /bbs_cache/, first: null },
  ]);
  return { env: { DB: fake.db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost' }, calls: fake.calls };
}

async function code(res: Response): Promise<number> {
  return ((await res.json()) as { code: number }).code;
}

beforeEach(() => l0Clear());

describe('csrf double-submit', () => {
  it('GET /api 下发 csrf cookie（非 HttpOnly、SameSite=Lax）', async () => {
    const res = await app.request('/api/health', {}, envFor().env as never);
    expect(res.status).toBe(200);
    const sc = res.headers.get('set-cookie') ?? '';
    expect(sc).toMatch(/csrf=[0-9a-f]{32}/);
    expect(sc).toContain('SameSite=Lax');
    expect(sc).not.toContain('HttpOnly');
  });

  it('非 GET 无凭证 → CSRF_FAILED(-6)', async () => {
    const res = await app.request('/api/threads', { method: 'POST' }, envFor().env as never);
    expect(await code(res)).toBe(-6);
  });

  it('cookie 与头一致 → 放行（越过 CSRF，进入写路由后因未登录 -1）', async () => {
    const token = 'a'.repeat(32);
    const res = await app.request('/api/threads', {
      method: 'POST',
      headers: { cookie: `csrf=${token}`, 'X-CSRF-Token': token },
    }, envFor().env as never);
    expect(await code(res)).toBe(-1);
  });

  it('不一致 → -6', async () => {
    const res = await app.request('/api/posts/1', {
      method: 'PUT',
      headers: { cookie: 'csrf=aaaa', 'X-CSRF-Token': 'bbbb' },
    }, envFor().env as never);
    expect(await code(res)).toBe(-6);
  });

  it('有 cookie 但缺头 → -6（无头脚本请求被拒）', async () => {
    const res = await app.request('/api/posts/1', {
      method: 'DELETE',
      headers: { cookie: 'csrf=aaaa' },
    }, envFor().env as never);
    expect(await code(res)).toBe(-6);
  });

  it('/api/auth/* 豁免（游客登录链）', async () => {
    const res = await app.request(
      '/api/auth/login',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      envFor().env as never,
    );
    // 进入 login 路由（空账号 → 1003 表单错），证明未被 CSRF 闸门 -6 拦截
    expect(await code(res)).toBe(Code.FORM_INVALID_EMAIL);
  });
});
