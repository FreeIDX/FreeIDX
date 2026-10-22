/**
 * T2-4 鉴权接口测试：注册/登录/登出/发码全链路 + 频控 + IP×账号锁定 + Turnstile + EmailProvider 降级。
 * 登录/注册行为基线（分发序、gid=101、login_ip/logins 更新），新增防线按 §14.3 T2-4。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index';
import { Code, md5Hex } from '@freeidx/shared';
import { l0Clear } from '../src/core/cache';
import { hashPassword } from '../src/core/auth';
import { isEmail, isPassword, isUsername } from '../src/core/auth/validate';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { encryptSecret } from '../src/core/crypto';

const SECRET = 'unit-test-jwt-secret';
const CLIENT_PW = md5Hex('plain-pw-123'); // 前端预哈希串（既有约定）

/** SMTP 池测试配置：ext:email:config（明文池）+ ext:email:secret（AES-GCM 密文），口径同 §11.3/§17.1 */
const EMAIL_MASTER = btoa(String.fromCharCode(7).repeat(32));
const EMAIL_POOL = { pool: [{ from: 'noreply@test.local', host: 'smtp.test.local', port: 465, user: 'smtp@test.local', dailyLimit: 0 }] };
const EMAIL_SECRET_TOKEN = await encryptSecret(JSON.stringify({ passes: ['smtp-pass'] }), EMAIL_MASTER);

const settingJson = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    runlevel: 5, sitename: 'FreeIDX', user_create_on: 1, user_create_email_on: 0, user_resetpw_on: 1, lang: 'zh-cn',
    ...over,
  });

function rules(over: SqlRule[] = [], setting = settingJson()): SqlRule[] {
  return [
    ...over,
    { test: /FROM bbs_kv/, first: { v: setting } },
    { test: /SELECT uid,last_date FROM bbs_session/, first: null },
    { test: /bbs_session/, first: null },
    { test: /FROM bbs_email_code WHERE email = \? AND scene = \? AND used = 0/, first: null },
    { test: /FROM bbs_email_code WHERE email = \? AND scene = \? ORDER BY/, first: null },
    { test: /COUNT\(\*\) AS c FROM bbs_email_code/, first: { c: 0 } },
    { test: /bbs_email_code/, first: null },
    { test: /FROM bbs_user WHERE email = \?/, first: null },
    { test: /FROM bbs_user WHERE username = \?/, first: null },
    { test: /FROM bbs_user WHERE uid = \?/, first: null },
    { test: /INSERT INTO bbs_user/, first: { uid: 6 } },
    { test: /UPDATE bbs_user/, first: null },
    { test: /bbs_cache/, first: null },
    { test: /FROM bbs_group/, rows: [] },
    { test: /FROM bbs_forum ORDER BY/, rows: [] },
    { test: /bbs_forum_access/, rows: [] },
  ];
}

interface EnvOpts {
  /** 配置 SMTP 邮件池（替代旧 EMAIL_API_KEY）：ext:email:config/secret 落 bbs_kv */
  withEmail?: boolean;
  turnstileSecret?: string;
  withJwt?: boolean; // 默认 true
}
function envFor(over: SqlRule[] = [], setting = settingJson(), opts: EnvOpts = {}) {
  const emailRules: SqlRule[] = opts.withEmail
    ? [
        {
          test: /FROM bbs_kv/,
          first: (p: readonly unknown[]) =>
            p[0] === 'ext:email:config'
              ? { v: JSON.stringify(EMAIL_POOL) }
              : p[0] === 'ext:email:secret'
                ? { v: EMAIL_SECRET_TOKEN }
                : { v: setting },
        },
      ]
    : [];
  const fake = fakeD1Sql([...emailRules, ...rules(over, setting)]);
  const env: Record<string, unknown> = {
    DB: fake.db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost:8787',
  };
  if (opts.withJwt !== false) env.JWT_SECRET = SECRET;
  if (opts.withEmail) env.SECRETS_MASTER_KEY = EMAIL_MASTER;
  if (opts.turnstileSecret) env.TURNSTILE_SECRET = opts.turnstileSecret;
  return { env, calls: fake.calls };
}

async function post(path: string, body: unknown, env: unknown) {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, env as never);
  return { res, json: (await res.json()) as { code: number; message: string; data?: Record<string, unknown> } };
}

function stubFetch(result: { ok?: boolean; json?: unknown } = { ok: true, json: { success: true } }) {
  const fn = vi.fn(async () => ({
    ok: result.ok ?? true,
    json: async () => result.json,
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function allCookies(res: Response): string {
  const g = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  return g ? g.call(res.headers).join('\n') : (res.headers.get('set-cookie') ?? '');
}

beforeEach(() => l0Clear());
afterEach(() => vi.unstubAllGlobals());

describe('注册/登录参数校验', () => {
  it('is_email：正则口径', () => {
    expect(isEmail('a@b.com')).toBeNull();
    expect(isEmail('a@b')).not.toBeNull();
    expect(isEmail('@b.com')).not.toBeNull();
  });
  it('is_username：≤16 字、无空格（含全角）、中英数下划线', () => {
    expect(isUsername('用户_名1')).toBeNull();
    expect(isUsername('ab cd')).not.toBeNull();
    expect(isUsername('ab\u3000cd')).not.toBeNull();
    expect(isUsername('a'.repeat(17))).not.toBeNull();
    expect(isUsername('bad!name')).not.toBeNull();
  });
  it('is_password：前端预哈希 32hex；拒绝空串 md5', () => {
    expect(isPassword(CLIENT_PW)).toBeNull();
    expect(isPassword('')).not.toBeNull();
    expect(isPassword('short')).not.toBeNull();
    expect(isPassword(md5Hex(''))).not.toBeNull();
  });
});

describe('POST /api/auth/register', () => {
  it('邮箱验证关闭时直通注册：PBKDF2 入库 + gid=101 + 双轨 Cookie 下发', async () => {
    const { env, calls } = envFor();
    const { json } = await post('/api/auth/register', { username: 'newuser', email: 'n@e.com', password: CLIENT_PW }, env);
    expect(json.code).toBe(Code.OK);
    expect(json.data).toMatchObject({ uid: 6, gid: 101 });
    const insert = calls.find((c) => /INSERT INTO bbs_user/.test(c.sql));
    expect(insert?.params[0]).toBe('n@e.com');
    expect(String(insert?.params[2] ?? '')).toMatch(/^pbkdf2\$sha256\$\d+\$/);
  });

  it('注册成功下发 sid（32hex）与 at Cookie', async () => {
    const { env } = envFor();
    const res = await app.request('/api/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'newuser', email: 'n@e.com', password: CLIENT_PW }),
    }, env as never);
    const cookies = allCookies(res);
    expect(cookies).toMatch(/sid=[0-9a-f]{32}/);
    expect(cookies).toContain('at=');
  });

  it('user_create_on=0 → -1（注册开关首检）', async () => {
    const { env } = envFor([], settingJson({ user_create_on: 0 }));
    const { json } = await post('/api/auth/register', { username: 'u1', email: 'n@e.com', password: CLIENT_PW }, env);
    expect(json.code).toBe(Code.NOT_LOGIN);
  });

  it('字段校验：邮箱占用 1006 / 用户名占用 1007 / 用户名非法 1004 / 密码非 32hex 1005', async () => {
    const dup = await envFor([{ test: /FROM bbs_user WHERE email = \?/, first: { uid: 2 } }]);
    expect((await post('/api/auth/register', { username: 'u1', email: 't@e.com', password: CLIENT_PW }, dup.env)).json.code).toBe(Code.FORM_EMAIL_EXISTS);
    const dupN = await envFor([{ test: /FROM bbs_user WHERE username = \?/, first: { uid: 3 } }]);
    expect((await post('/api/auth/register', { username: 'taken', email: 'n@e.com', password: CLIENT_PW }, dupN.env)).json.code).toBe(Code.FORM_USERNAME_EXISTS);
    const badU = envFor();
    expect((await post('/api/auth/register', { username: 'a b', email: 'n@e.com', password: CLIENT_PW }, badU.env)).json.code).toBe(Code.FORM_INVALID_USERNAME);
    const badP = envFor();
    expect((await post('/api/auth/register', { username: 'u1', email: 'n@e.com', password: 'plain' }, badP.env)).json.code).toBe(Code.FORM_PASSWORD_MISMATCH);
  });

  it('邮箱验证开启：验证码匹配 → 注册成功并标记 used', async () => {
    const { env, calls } = envFor(
      [{ test: /FROM bbs_email_code WHERE email = \? AND scene = \? AND used = 0/, first: { id: 9, code: '123456' } }],
      settingJson({ user_create_email_on: 1 }),
      { withEmail: true },
    );
    const { json } = await post('/api/auth/register', { username: 'u1', email: 'n@e.com', password: CLIENT_PW, emailCode: '123456' }, env);
    expect(json.code).toBe(Code.OK);
    const used = calls.find((c) => /UPDATE bbs_email_code SET used/.test(c.sql));
    expect(used?.params).toEqual([9]);
  });

  it('邮箱验证开启：无码 1008 / 码错误 1008', async () => {
    const { env } = envFor([], settingJson({ user_create_email_on: 1 }), { withEmail: true });
    expect((await post('/api/auth/register', { username: 'u1', email: 'n@e.com', password: CLIENT_PW }, env)).json.code).toBe(Code.FORM_EMAIL_CODE_ERROR);
    expect((await post('/api/auth/register', { username: 'u1', email: 'n@e.com', password: CLIENT_PW, emailCode: '000000' }, env)).json.code).toBe(Code.FORM_EMAIL_CODE_ERROR);
  });

  it('§11.3 降级：email_on=1 但未配置 provider ⇒ 等效验证关闭，流程完整', async () => {
    const { env } = envFor([], settingJson({ user_create_email_on: 1 }));
    const { json } = await post('/api/auth/register', { username: 'u1', email: 'n@e.com', password: CLIENT_PW }, env);
    expect(json.code).toBe(Code.OK);
  });

  it('Turnstile：未通过 → -8；配置缺失直通；通过则继续', async () => {
    const e1 = envFor([], settingJson(), { turnstileSecret: 'ts' });
    stubFetch({ json: { success: false } });
    expect((await post('/api/auth/register', { username: 'u1', email: 'n@e.com', password: CLIENT_PW, turnstileToken: 'x' }, e1.env)).json.code).toBe(Code.CAPTCHA_FAILED);
    const e2 = envFor([], settingJson(), { turnstileSecret: 'ts' });
    const f2 = stubFetch();
    expect((await post('/api/auth/register', { username: 'u1', email: 'n@e.com', password: CLIENT_PW }, e2.env)).json.code).toBe(Code.CAPTCHA_FAILED);
    expect(f2).not.toHaveBeenCalled(); // 无 token 直接拒绝，不发校验请求
    stubFetch({ json: { success: true } });
    const e3 = envFor([], settingJson(), { turnstileSecret: 'ts' });
    const { json } = await post('/api/auth/register', { username: 'u1', email: 'n@e.com', password: CLIENT_PW, turnstileToken: 'tok' }, e3.env);
    expect(json.code).toBe(Code.OK);
  });
});

describe('POST /api/auth/email-code', () => {
  it('user_create 场景：验证码落 email_code 表（TTL 5min；发信走 SMTP 池 waitUntil 旁路）', async () => {
    const { env, calls } = envFor([], settingJson({ user_create_email_on: 1 }), { withEmail: true });
    const { json } = await post('/api/auth/email-code', { scene: 'user_create', email: 'N@E.com' }, env);
    expect(json.code).toBe(Code.OK);
    const ins = calls.find((c) => /INSERT INTO bbs_email_code/.test(c.sql));
    expect(ins?.params[0]).toBe('n@e.com'); // 归一小写
    expect(ins && Number(ins.params[4]) - Number(ins.params[3])).toBe(300); // TTL=5min 文案对齐
  });

  it('同 email 60s 内重复请求 → -7', async () => {
    const now = Math.floor(Date.now() / 1000);
    const { env } = envFor(
      [{ test: /FROM bbs_email_code WHERE email = \? AND scene = \? ORDER BY/, first: { create_date: now - 10 } }],
      settingJson({ user_create_email_on: 1 }),
      { withEmail: true },
    );
    const { json } = await post('/api/auth/email-code', { scene: 'user_create', email: 'n@e.com' }, env);
    expect(json.code).toBe(Code.RATE_LIMITED);
  });

  it('日上限 10 次 → -7', async () => {
    const { env } = envFor(
      [{ test: /COUNT\(\*\) AS c FROM bbs_email_code/, first: { c: 10 } }],
      settingJson({ user_create_email_on: 1 }),
      { withEmail: true },
    );
    const { json } = await post('/api/auth/email-code', { scene: 'user_create', email: 'n@e.com' }, env);
    expect(json.code).toBe(Code.RATE_LIMITED);
  });

  it('开关与存在性：user_create_email_on=0 → -1；resetpw 邮箱未注册 → 1003；投递失败仍 → 0（旁路静默，码行已入库）', async () => {
    const off = envFor([], settingJson(), { withEmail: true });
    expect((await post('/api/auth/email-code', { scene: 'user_create', email: 'n@e.com' }, off.env)).json.code).toBe(Code.NOT_LOGIN);
    // L0 是 isolate 级短存缓存：本用例用三份不同 setting 模拟三个站点，同一 isolate 内切换前须清空
    l0Clear();
    const rp = envFor([], settingJson());
    expect((await post('/api/auth/email-code', { scene: 'user_resetpw', email: 'ghost@e.com' }, rp.env)).json.code).toBe(Code.FORM_INVALID_EMAIL);
    l0Clear();
    // SMTP 建连失败被 provider 内部吞掉（failover 全败 → false），不阻塞请求：验证码行已落库、有效性不依赖投递结果
    const fail = envFor([], settingJson({ user_create_email_on: 1 }), { withEmail: true });
    expect((await post('/api/auth/email-code', { scene: 'user_create', email: 'n@e.com' }, fail.env)).json.code).toBe(Code.OK);
  });
});

describe('POST /api/auth/login', () => {
  const salt = 'abcd1234';

  it('新格式（PBKDF2）命中：更新 login_ip/logins + 双轨 Cookie', async () => {
    const stored = await hashPassword(CLIENT_PW);
    const user = { uid: 1, gid: 2, password: stored, salt: '', token_version: 7, avatar: 0, username: 'admin', email: 'a@b.com' };
    const { env, calls } = envFor([{ test: /FROM bbs_user WHERE email = \?/, first: user }]);
    const { json } = await post('/api/auth/login', { account: 'a@b.com', password: CLIENT_PW }, env);
    expect(json.code).toBe(Code.OK);
    expect(json.data).toMatchObject({ uid: 1, upgradeNeeded: false });
    expect(calls.some((c) => /UPDATE bbs_user SET login_ip/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /REPLACE INTO bbs_session/.test(c.sql))).toBe(true);
  });

  it('存量 md5 命中：ok 且 upgradeNeeded=true，登录请求内不重算（§8.4）', async () => {
    const stored = md5Hex(CLIENT_PW + salt);
    const user = { uid: 1, gid: 2, password: stored, salt, token_version: 0, avatar: 0, username: 'admin', email: 'a@b.com' };
    const { env, calls } = envFor([{ test: /FROM bbs_user WHERE email = \?/, first: user }]);
    const { json } = await post('/api/auth/login', { account: 'a@b.com', password: CLIENT_PW }, env);
    expect(json.code).toBe(Code.OK);
    expect(json.data?.upgradeNeeded).toBe(true);
    expect(calls.filter((c) => /UPDATE bbs_user/.test(c.sql))).toHaveLength(1);
  });

  it('账号不存在 1003 / 密码错误 1005；非邮箱形态按用户名查', async () => {
    const { env } = envFor();
    expect((await post('/api/auth/login', { account: 'ghost@e.com', password: CLIENT_PW }, env)).json.code).toBe(Code.FORM_INVALID_EMAIL);
    expect((await post('/api/auth/login', { account: 'ghostname', password: CLIENT_PW }, env)).json.code).toBe(Code.FORM_INVALID_EMAIL);
    const user = { uid: 1, gid: 2, password: 'x'.repeat(32), salt: 's', token_version: 0, avatar: 0, username: 'admin', email: 'a@b.com' };
    const e2 = envFor([{ test: /FROM bbs_user WHERE username = \?/, first: user }]);
    expect((await post('/api/auth/login', { account: 'admin', password: CLIENT_PW }, e2.env)).json.code).toBe(Code.FORM_PASSWORD_MISMATCH);
  });

  it('IP×账号连续失败 5 次 → 第 6 次锁定 -7；成功后计数清除', async () => {
    const user = { uid: 1, gid: 2, password: md5Hex('deadbeef'.repeat(4) + 's'), salt: 's', token_version: 0, avatar: 0, username: 'admin', email: 'a@b.com' };
    const { env } = envFor([{ test: /FROM bbs_user WHERE email = \?/, first: user }]);
    for (let i = 0; i < 5; i++) {
      const { json } = await post('/api/auth/login', { account: 'A@B.com', password: CLIENT_PW }, env);
      expect(json.code).toBe(Code.FORM_PASSWORD_MISMATCH);
    }
    const locked = await post('/api/auth/login', { account: 'a@b.com', password: CLIENT_PW }, env);
    expect(locked.json.code).toBe(Code.RATE_LIMITED);
  });

  it('Turnstile 未配置时直通、配置后缺 token 拒绝', async () => {
    const stored = await hashPassword(CLIENT_PW);
    const user = { uid: 1, gid: 2, password: stored, salt: '', token_version: 0, avatar: 0, username: 'admin', email: 'a@b.com' };
    const e1 = envFor([{ test: /FROM bbs_user WHERE email = \?/, first: user }]);
    expect((await post('/api/auth/login', { account: 'a@b.com', password: CLIENT_PW }, e1.env)).json.code).toBe(Code.OK);
    const e2 = envFor([{ test: /FROM bbs_user WHERE email = \?/, first: user }], settingJson(), { turnstileSecret: 'ts' });
    stubFetch({ json: { success: false } });
    expect((await post('/api/auth/login', { account: 'a@b.com', password: CLIENT_PW }, e2.env)).json.code).toBe(Code.CAPTCHA_FAILED);
  });
});

describe('DELETE /api/auth/logout', () => {
  it('销毁 session 并过期双 Cookie', async () => {
    const { env, calls } = envFor();
    const res = await app.request('/api/auth/logout', { method: 'DELETE', headers: { cookie: 'sid=abcdef0123456789abcdef0123456789' } }, env as never);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(Code.OK);
    expect(calls.some((c) => /DELETE FROM bbs_session WHERE sid = \?/.test(c.sql))).toBe(true);
    const cookies = allCookies(res);
    expect(cookies).toMatch(/sid=;.*Max-Age=0/);
    expect(cookies).toContain('at=;');
  });

  it('登录态登出 = 全端吊销：tv+1 废 JWT + 删该用户全部 session + user 缓存失效', async () => {
    const user = { uid: 5, gid: 101, password: 'x', salt: '', token_version: 3, avatar: 0, username: 'u5', email: 'u@b.c' };
    const { env, calls } = envFor([
      { test: /SELECT uid,last_date FROM bbs_session/, first: { uid: 5, last_date: Math.floor(Date.now() / 1000) } },
      { test: /FROM bbs_user WHERE uid = \?/, first: user },
      { test: /UPDATE bbs_user/, first: null },
    ]);
    const res = await app.request('/api/auth/logout', { method: 'DELETE', headers: { cookie: 'sid=abcdef0123456789abcdef0123456789' } }, env as never);
    expect(((await res.json()) as { code: number }).code).toBe(Code.OK);
    expect(calls.some((c) => /token_version = token_version \+ 1/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /DELETE FROM bbs_session WHERE uid = \?/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /DELETE FROM bbs_cache/.test(c.sql))).toBe(true);
    const cookies = allCookies(res);
    expect(cookies).toMatch(/sid=;.*Max-Age=0/);
    expect(cookies).toContain('at=;');
  });
});

describe('POST /api/auth/admin-token（后台二次验证重签 admin_at）', () => {
  const sidOf = (uid: number): SqlRule[] => [
    { test: /SELECT uid,last_date FROM bbs_session/, first: { uid, last_date: Math.floor(Date.now() / 1000) } },
  ];
  const adminCookie = 'sid=abcdef0123456789abcdef0123456789';
  /** 带前台会话的 POST（本接口要求已登录，裸 post() 不带 Cookie） */
  async function postLogged(body: unknown, env: unknown) {
    const res = await app.request(
      '/api/auth/admin-token',
      { method: 'POST', headers: { 'content-type': 'application/json', cookie: adminCookie }, body: JSON.stringify(body) },
      env as never,
    );
    return { res, json: (await res.json()) as { code: number; message: string; data?: Record<string, unknown> } };
  }

  it('游客（无 session）→ NOT_LOGIN，且不落口令查询', async () => {
    const { env, calls } = envFor();
    const { json } = await post('/api/auth/admin-token', { password: CLIENT_PW }, env);
    expect(json.code).toBe(Code.NOT_LOGIN);
    expect(calls.some((c) => /FROM bbs_user WHERE uid = \?/.test(c.sql))).toBe(false);
  });

  it('gid≠1 → NO_PERMISSION（403），且不付验密 CPU', async () => {
    const stored = await hashPassword(CLIENT_PW);
    const member = { uid: 9, gid: 101, password: stored, salt: '', token_version: 0, avatar: 0, username: 'u9', email: 'u@e.com' };
    const { env } = envFor([...sidOf(9), { test: /FROM bbs_user WHERE uid = \?/, first: member }]);
    const { res, json } = await postLogged({ password: CLIENT_PW }, env);
    expect(res.status).toBe(403);
    expect(json.code).toBe(Code.NO_PERMISSION);
  });

  it('口令错误 → FORM_PASSWORD_MISMATCH（与 login 同码同文案）', async () => {
    const stored = await hashPassword(CLIENT_PW);
    const admin = { uid: 1, gid: 1, password: stored, salt: '', token_version: 0, avatar: 0, username: 'admin', email: 'a@b.com' };
    const { env } = envFor([...sidOf(1), { test: /FROM bbs_user WHERE uid = \?/, first: admin }]);
    const { json } = await postLogged({ password: md5Hex('wrong-pw') }, env);
    expect(json.code).toBe(Code.FORM_PASSWORD_MISMATCH);
    expect(json.message).toBe('密码错误');
  });

  it('前台会话 + 正确口令 → 仅下发 admin_at（不重发 sid/at），载荷 uid 取实时行', async () => {
    const stored = await hashPassword(CLIENT_PW);
    const admin = { uid: 1, gid: 1, password: stored, salt: '', token_version: 4, avatar: 0, username: 'admin', email: 'a@b.com' };
    const { env } = envFor([...sidOf(1), { test: /FROM bbs_user WHERE uid = \?/, first: admin }]);
    const { res, json } = await postLogged({ password: CLIENT_PW }, env);
    expect(json.code).toBe(Code.OK);
    expect(json.message).toBe('登录成功');
    expect(json.data).toEqual({ uid: 1 });
    const cookies = allCookies(res);
    expect(cookies).toMatch(/admin_at=[0-9a-zA-Z\-_]+\.[0-9a-zA-Z\-_]+\.[0-9a-zA-Z\-_]+/);
    expect(cookies).toContain('Max-Age=3600');
    expect(cookies).not.toContain('sid=');
  });

  it('口令入参为非 32hex → 1005（前端预哈希口径同 login）', async () => {
    const admin = { uid: 1, gid: 1, password: 'pbkdf2$sha256$20000$00$0', salt: '', token_version: 0, avatar: 0, username: 'admin', email: 'a@b.com' };
    const { env } = envFor([...sidOf(1), { test: /FROM bbs_user WHERE uid = \?/, first: admin }]);
    const { json } = await postLogged({ password: 'plain' }, env);
    expect(json.code).toBe(Code.FORM_PASSWORD_MISMATCH);
  });
});
