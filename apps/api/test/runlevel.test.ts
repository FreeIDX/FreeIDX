import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code, RunLevel } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';

function rulesFor(level: number, member: 'guest' | 'admin' | 'vip'): SqlRule[] {
  const sess = member === 'guest' ? null : member === 'admin' ? { uid: 1 } : { uid: 5 };
  return [
    { test: /FROM bbs_kv/, first: { v: JSON.stringify({ runlevel: level, sitename: 'x' }) } },
    { test: /FROM bbs_session/, first: sess },
    { test: /FROM bbs_user WHERE uid = \?/, first: member === 'guest' ? null : member === 'admin' ? { uid: 1, gid: 1, username: 'admin', token_version: 0 } : { uid: 5, gid: 101, username: 'vip', token_version: 0 } },
    { test: /FROM bbs_group/, rows: [{ gid: 0, name: '游客组', allowread: 1, allowpost: 1 }] },
    { test: /FROM bbs_forum ORDER BY/, rows: [] },
    { test: /bbs_forum_access/, rows: [] },
    { test: /bbs_thread_top/, rows: [] },
    { test: /FROM bbs_thread WHERE fid IN/, rows: [] },
    { test: /bbs_cache/, first: null },
  ];
}

function envFor(rules: SqlRule[]) {
  return { env: { DB: fakeD1Sql(rules).db, CACHE: fakeKv(), FILES: {}, SITE_URL: '' }, kv: fakeKv() };
}

const cookie = (member: 'admin' | 'vip') => ({ Cookie: `sid=${member}` });

async function code(res: Response): Promise<number> {
  return ((await res.json()) as { code: number }).code;
}

beforeEach(() => l0Clear());

describe('runlevel 0-5 档位矩阵（T1-2 DoD：档位行为符合规格）', () => {
  for (const level of [0, 1, 2, 3, 4, 5] as const) {
    it(`档位 ${level}：健康检查恒通`, async () => {
      const { env } = envFor(rulesFor(level, 'guest'));
      expect(await code(await app.request('/api/health', {}, env as never))).toBe(Code.OK);
    });
  }

  it('0 站点关闭：游客读写皆拒；登录白名单放行；管理员直通', async () => {
    const { env } = envFor(rulesFor(RunLevel.CLOSED_SITE, 'guest'));
    expect(await code(await app.request('/api/threads', {}, env as never))).toBe(Code.RUNLEVEL_CLOSED);
    expect(await code(await app.request('/api/threads', { method: 'POST' }, env as never))).toBe(Code.RUNLEVEL_CLOSED);
    // 白名单穿过闸门：进入 login 路由（空账号 → 1003 表单错）而非 -5 拒站
    expect(
      await code(
        await app.request(
          '/api/auth/login',
          { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
          env as never,
        ),
      ),
    ).toBe(Code.FORM_INVALID_EMAIL);
    const admin = envFor(rulesFor(RunLevel.CLOSED_SITE, 'admin'));
    const res = await app.request('/api/threads', { headers: cookie('admin') }, admin.env as never);
    expect(await code(res)).toBe(Code.OK);
  });

  it('1 管理员可读写：VIP 读也拒', async () => {
    const vip = envFor(rulesFor(RunLevel.ADMIN_ONLY, 'vip'));
    expect(await code(await app.request('/api/threads', { headers: cookie('vip') }, vip.env as never))).toBe(Code.RUNLEVEL_CLOSED);
  });

  it('2 会员只读：游客读引导登录(-1)；会员读通、写拒', async () => {
    const guest = envFor(rulesFor(RunLevel.MEMBER_READ_ONLY, 'guest'));
    expect(await code(await app.request('/api/threads', {}, guest.env as never))).toBe(Code.NOT_LOGIN);
    const vip = envFor(rulesFor(RunLevel.MEMBER_READ_ONLY, 'vip'));
    expect(await code(await app.request('/api/threads', { headers: cookie('vip') }, vip.env as never))).toBe(Code.OK);
    expect(await code(await app.request('/api/threads', { method: 'POST', headers: cookie('vip') }, vip.env as never))).toBe(Code.RUNLEVEL_CLOSED);
  });

  it('3 会员可读写：仅拒游客；会员读写通', async () => {
    const guest = envFor(rulesFor(RunLevel.MEMBER_READ_WRITE, 'guest'));
    expect(await code(await app.request('/api/threads', {}, guest.env as never))).toBe(Code.NOT_LOGIN);
    const vip = envFor(rulesFor(RunLevel.MEMBER_READ_WRITE, 'vip'));
    expect(await code(await app.request('/api/threads', { headers: cookie('vip') }, vip.env as never))).toBe(Code.OK);
    // 写路由 M2 已挂载：穿过闸门+CSRF → 进入 createThread（空 body → 参数校验错），非 -5 拒站
    expect(
      await code(
        await app.request(
          '/api/threads',
          { method: 'POST', headers: { Cookie: `sid=vip; csrf=t0k0n`, 'X-CSRF-Token': 't0k0n' } },
          vip.env as never,
        ),
      ),
    ).toBe(Code.VALIDATION_ERROR);
  });

  it('4 所有人只读：GET 通、非 GET 拒', async () => {
    const { env } = envFor(rulesFor(RunLevel.ALL_READ_ONLY, 'guest'));
    expect(await code(await app.request('/api/threads', {}, env as never))).toBe(Code.OK);
    expect(await code(await app.request('/api/threads', { method: 'POST' }, env as never))).toBe(Code.RUNLEVEL_CLOSED);
  });

  it('5 正常：游客读写皆达路由（写路由已挂载 → 未登录 -1，非拒站）', async () => {
    const { env } = envFor(rulesFor(RunLevel.NORMAL, 'guest'));
    expect(await code(await app.request('/api/threads', {}, env as never))).toBe(Code.OK);
    expect(
      await code(
        await app.request('/api/threads', { method: 'POST', headers: { Cookie: 'csrf=t0k0n', 'X-CSRF-Token': 't0k0n' } }, env as never),
      ),
    ).toBe(Code.NOT_LOGIN);
  });
});
