/**
 * T3-9 广告位 CRUD + 预览模式（§17.5）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';
import { issueAdminToken } from '../src/core/auth/admin';

const SECRET = 'admin-secret';

function slotRows(all: boolean): unknown[] {
  const one = { id: 3, position: 'header', type: 'html', config: '{"html":"<b>x</b>"}', enabled: 1, sort: 10, start_date: 0, end_date: 0, create_date: 1 };
  const draft = { id: 4, position: 'footer', type: 'image', config: '{"url":"http://i/y.png"}', enabled: 0, sort: 5, start_date: 0, end_date: 0, create_date: 1 };
  return all ? [one, draft] : [one];
}

function rules(): SqlRule[] {
  return [
    { test: /SELECT gid,token_version FROM bbs_user/, first: { gid: 1, token_version: 0 } },
    { test: /SELECT v FROM bbs_kv/, first: { v: JSON.stringify({ runlevel: 5 }) } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /FROM bbs_ad_slot WHERE enabled = 1/, rows: () => slotRows(false) },
    { test: /FROM bbs_ad_slot ORDER BY sort/, rows: () => slotRows(true) },
    { test: /SELECT id FROM bbs_ad_slot WHERE id = \?/, first: { id: 3 } },
    { test: /INSERT INTO bbs_ad_slot/, first: { id: 9 } },
    { test: /UPDATE bbs_ad_slot SET/, rows: [] },
    { test: /DELETE FROM bbs_ad_slot/, rows: [] },
  ];
}

function makeEnv() {
  const { db, calls } = fakeD1Sql(rules());
  return { env: { JWT_SECRET: SECRET, SITE_URL: 'http://localhost', DB: db, CACHE: fakeKv(), FILES: {} } as never, calls };
}
const cookie = async () => `admin_at=${await issueAdminToken(SECRET, 1, 0)}`;
const writeHeaders = async () => ({ cookie: `${await cookie()}; csrf=t`, 'content-type': 'application/json', 'x-csrf-token': 't' });
async function jsonOf(res: Response) {
  return (await res.json()) as { code: number; data?: Record<string, unknown> };
}

beforeEach(() => l0Clear());

describe('广告位管理（T3-9）', () => {
  it('GET：默认仅启用位', async () => {
    const { env, calls } = makeEnv();
    const body = await jsonOf(await app.request('/api/admin/ad-slots', { headers: { cookie: await cookie() } }, env));
    expect(body.code).toBe(Code.OK);
    const slots = (body.data as { slots: { id: number }[] }).slots;
    expect(slots.map((s) => s.id)).toEqual([3]);
    expect(calls.some((c) => /WHERE enabled = 1/.test(c.sql))).toBe(true);
  });

  it('GET ?ad_preview=1：含草稿位', async () => {
    const { env } = makeEnv();
    const body = await jsonOf(await app.request('/api/admin/ad-slots?ad_preview=1', { headers: { cookie: await cookie() } }, env));
    const slots = (body.data as { slots: unknown[] }).slots;
    expect(slots.length).toBe(2);
  });

  it('POST：创建广告位返回 id，config 序列化', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/admin/ad-slots', {
      method: 'POST',
      headers: await writeHeaders(),
      body: JSON.stringify({ position: 'thread_bottom', type: 'adsense', config: { slot: '123' }, enabled: 1, sort: 8 }),
    }, env);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    expect(body.data).toEqual({ id: 9 });
    const ins = calls.find((c) => /INSERT INTO bbs_ad_slot/.test(c.sql));
    expect(ins!.params).toEqual(['thread_bottom', 'adsense', '{"slot":"123"}', 1, 8, 0, 0, expect.any(Number)]);
  });

  it('POST：type 非法 → 校验失败', async () => {
    const { env } = makeEnv();
    const res = await app.request('/api/admin/ad-slots', { method: 'POST', headers: await writeHeaders(), body: JSON.stringify({ position: 'header', type: 'video' }) }, env);
    expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
  });

  it('PUT：仅更新传入字段', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/admin/ad-slots/3', { method: 'PUT', headers: await writeHeaders(), body: JSON.stringify({ enabled: 0 }) }, env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const upd = calls.find((c) => /UPDATE bbs_ad_slot SET/.test(c.sql));
    expect(upd!.sql).toContain('enabled = ?');
    expect(upd!.sql).not.toContain('position = ?');
  });

  it('DELETE：按 id 删除', async () => {
    const { env, calls } = makeEnv();
    const res = await app.request('/api/admin/ad-slots/3', { method: 'DELETE', headers: await writeHeaders() }, env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    expect(calls.some((c) => /DELETE FROM bbs_ad_slot WHERE id = \?/.test(c.sql))).toBe(true);
  });
});
