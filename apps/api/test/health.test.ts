import { describe, it, expect } from 'vitest';
import { app } from '../src/index';
import { fakeD1 } from './helpers/fake-d1';
import { Code } from '@freeidx/shared';

const env = { DB: fakeD1().db, CACHE: {}, FILES: {}, SITE_URL: 'http://localhost' };

describe('GET /api/health (T0-6 DoD)', () => {
  it('200 且信封格式与 §6.1 一致：{code:0, message, ...}', async () => {
    const res = await app.request('/api/health', {}, env as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: number; message: string; data: { status: string } };
    expect(body.code).toBe(Code.OK);
    expect(body.message).toBe('ok');
    expect(body.data.status).toBe('ok');
  });

  it('系统错误走信封 code<0 而非抛 HTML 500', async () => {
    const broken = { DB: fakeD1({ failAt: 0 }).db, CACHE: {}, FILES: {}, SITE_URL: '' };
    const res = await app.request('/api/threads', {}, broken as never);
    const body = (await res.json()) as { code: number; message: string; data?: { status: string } };
    expect(body.code).toBe(Code.SYSTEM_ERROR);
  });

  it('未知路由返回 404 + NOT_FOUND 信封', async () => {
    const res = await app.request('/api/nope', {}, env as never);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: number; message: string; data?: { status: string } };
    expect(body.code).toBe(Code.NOT_FOUND);
  });
});
