/**
 * T4-1 找回密码两步（email_code 表存一次性 token，非 session）+ §11.3 未配置 provider 降级。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';
import { encryptSecret } from '../src/core/crypto';

const PW = 'deadbeefdeadbeefdeadbeefdeadbeef'; // 前端预哈希 32hex
const SETTING = { runlevel: 5, user_resetpw_on: 1, sitename: 'S', lang: 'zh-cn' };

/** SMTP 池测试配置（ext:email:config/secret，口径同 §11.3/§17.1） */
const EMAIL_MASTER = btoa(String.fromCharCode(7).repeat(32));
const EMAIL_POOL = { pool: [{ from: 'noreply@test.local', host: 'smtp.test.local', port: 465, user: 'smtp@test.local', dailyLimit: 0 }] };
const EMAIL_SECRET_TOKEN = await encryptSecret(JSON.stringify({ passes: ['smtp-pass'] }), EMAIL_MASTER);

function rules(overrides: SqlRule[] = []): SqlRule[] {
  return [
    ...overrides,
    { test: /SELECT v FROM bbs_kv/, first: { v: JSON.stringify(SETTING) } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /SELECT uid FROM bbs_user WHERE email = \?/, first: { uid: 1 } },
    { test: /SELECT create_date FROM bbs_email_code/, first: null },
    { test: /COUNT\(\*\) AS c FROM bbs_email_code/, first: { c: 0 } },
    { test: /UPDATE bbs_email_code SET used = 1 WHERE email/, rows: [] },
    { test: /INSERT INTO bbs_email_code/, rows: [] },
    { test: /UPDATE bbs_user SET password/, rows: [] },
    { test: /UPDATE bbs_email_code SET used = 1 WHERE id = \?/, rows: [] },
    { test: /DELETE FROM bbs_session WHERE uid = \?/, rows: [] },
  ];
}

function makeEnv(overrides: SqlRule[] = [], withEmail = true) {
  const emailRules: SqlRule[] = withEmail
    ? [
        {
          test: /SELECT v FROM bbs_kv/,
          first: (p: readonly unknown[]) =>
            p[0] === 'ext:email:config'
              ? { v: JSON.stringify(EMAIL_POOL) }
              : p[0] === 'ext:email:secret'
                ? { v: EMAIL_SECRET_TOKEN }
                : { v: JSON.stringify(SETTING) },
        },
      ]
    : [];
  const { db, calls } = fakeD1Sql([...emailRules, ...rules(overrides)]);
  const env = {
    DB: db,
    CACHE: fakeKv(),
    FILES: {},
    SITE_URL: 'https://x.test',
    ...(withEmail ? { SECRETS_MASTER_KEY: EMAIL_MASTER } : {}),
  } as never;
  return { env, calls };
}
const post = (path: string, body: unknown) =>
  ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) as const;
async function jsonOf(res: Response) {
  return (await res.json()) as { code: number };
}

beforeEach(() => {
  l0Clear();
});

describe('POST /api/auth/password-reset/request', () => {
  it('未配置 provider → 降级 NOT_LOGIN（§11.3）', async () => {
    const { env } = makeEnv([], false);
    const res = await app.request('/api/auth/password-reset/request', post('/x', { email: 'a@b.c' }), env);
    expect((await jsonOf(res)).code).toBe(Code.NOT_LOGIN);
  });

  it('已注册邮箱：发放一次性 token 落 email_code（单活作废旧 token；发信走 SMTP 池旁路）', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/auth/password-reset/request', post('/x', { email: 'a@b.c' }), env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    expect(calls.some((c) => /INSERT INTO bbs_email_code/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /UPDATE bbs_email_code SET used = 1 WHERE email/.test(c.sql))).toBe(true);
  });

  it('60s 内重复请求：仍回同构成功且不再发放 token（不暴露邮箱是否注册）', async () => {
    const last = Math.floor(Date.now() / 1000) - 5;
    const { env, calls } = makeEnv([{ test: /SELECT create_date FROM bbs_email_code/, first: { create_date: last } }]);
    const res = await app.request('/api/auth/password-reset/request', post('/x', { email: 'a@b.c' }), env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    expect(calls.some((c) => /INSERT INTO bbs_email_code/.test(c.sql))).toBe(false);
  });

  it('日上限 10 封：仍回同构成功、不落 token（找回密码不得成为不限量发信入口）', async () => {
    const { env, calls } = makeEnv([{ test: /COUNT\(\*\) AS c FROM bbs_email_code/, first: { c: 10 } }]);
    const res = await app.request('/api/auth/password-reset/request', post('/x', { email: 'a@b.c' }), env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    expect(calls.some((c) => /INSERT INTO bbs_email_code/.test(c.sql))).toBe(false);
  });

  it('未注册邮箱：同构成功、不发信、不落 token（防枚举）', async () => {
    const { env, calls } = makeEnv([{ test: /SELECT uid FROM bbs_user WHERE email = \?/, first: null }]);
    const res = await app.request('/api/auth/password-reset/request', post('/x', { email: 'ghost@b.c' }), env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    expect(calls.some((c) => /INSERT INTO bbs_email_code/.test(c.sql))).toBe(false);
  });
});

describe('POST /api/auth/password-reset/confirm', () => {
  it('有效 token：PBKDF2 入库 + token_version+1 吊销会话 + token 置已用', async () => {
    const { env, calls } = makeEnv([{ test: /SELECT id FROM bbs_email_code WHERE email/, first: { id: 5 } }]);
    const res = await app.request('/api/auth/password-reset/confirm', post('/x', { email: 'a@b.c', token: 'tok', password: PW }), env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const upd = calls.find((c) => /UPDATE bbs_user SET password/.test(c.sql));
    expect(upd!.sql).toContain('token_version = token_version + 1');
    expect(calls.some((c) => /UPDATE bbs_email_code SET used = 1 WHERE id = \?/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /DELETE FROM bbs_session WHERE uid = \?/.test(c.sql))).toBe(true);
  });

  it('无效/过期 token → 校验失败，不改密', async () => {
    const { env, calls } = makeEnv([{ test: /SELECT id FROM bbs_email_code WHERE email/, first: null }]);
    const res = await app.request('/api/auth/password-reset/confirm', post('/x', { email: 'a@b.c', token: 'bad', password: PW }), env);
    expect((await jsonOf(res)).code).toBe(Code.FORM_EMAIL_CODE_ERROR);
    expect(calls.some((c) => /UPDATE bbs_user SET password/.test(c.sql))).toBe(false);
  });

  it('口令格式非法 → 校验失败', async () => {
    const { env } = makeEnv([{ test: /SELECT id FROM bbs_email_code WHERE email/, first: { id: 5 } }]);
    const res = await app.request('/api/auth/password-reset/confirm', post('/x', { email: 'a@b.c', token: 'tok', password: 'short' }), env);
    expect((await jsonOf(res)).code).toBe(Code.FORM_PASSWORD_MISMATCH);
  });
});
