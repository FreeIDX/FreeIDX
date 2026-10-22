/**
 * T5-7 单测：收银台聚合 GET /api/payment-providers + 后台支付管理（计划 CRUD/订单退款补单/卡密生成）+ 掉单对账 cron 分派。
 * 离线：以 fakeD1Sql 脚本化 SQL；stripe 无出网（仅 manifest/生命周期参与聚合）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { l0Clear } from '../src/core/cache';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { handleScheduled } from '../src/core/cron';
import { CRON_HOURLY } from '../src/core/cron-schedule';
import { issueAdminToken } from '../src/core/auth/admin';

const ADMIN_SECRET = 'admin-jwt-secret';

const SETTING = JSON.stringify({ runlevel: 5, sitename: 'S', lang: 'zh-cn' });
const PLAN = { id: 3, name: '年费', duration_days: 365, price_cents: 1900, currency: 'CNY', perks: '{}', enabled: 1, sort: 0 };

function orderRow(status: string): Record<string, unknown> {
  return { order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status, provider: 'card', provider_ref: '', created_date: 1, paid_date: 0, fulfilled_date: 0 };
}
function scriptedOrder(statuses: string[]): SqlRule {
  let i = 0;
  return { test: /FROM bbs_order WHERE order_no = \?/, first: () => orderRow(statuses[Math.min(i++, statuses.length - 1)]!) };
}

function env(extStateJson: string, rules: SqlRule[]): Record<string, unknown> {
  const base: SqlRule[] = [
    {
      test: /SELECT v FROM bbs_kv WHERE k = \?/,
      first: (p: readonly unknown[]) => (p[0] === 'extensions' ? { v: extStateJson } : p[0] === 'setting' ? { v: SETTING } : { v: '{}' }),
    },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /SELECT gid,token_version FROM bbs_user/, first: { gid: 1, token_version: 0 } },
    ...rules,
  ];
  const { db } = fakeD1Sql(base);
  return { DB: db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost', JWT_SECRET: ADMIN_SECRET };
}

async function adminCookie(): Promise<Record<string, string>> {
  const at = await issueAdminToken(ADMIN_SECRET, 1, 0);
  return { 'content-type': 'application/json', cookie: `admin_at=${at}; csrf=t`, 'x-csrf-token': 't' };
}
async function json(res: Response): Promise<{ code: number; data: unknown }> {
  return (await res.json()) as { code: number; data: unknown };
}

beforeEach(() => l0Clear());

describe('GET /api/payment-providers（收银台聚合 + 币种过滤 + 卡密置前）', () => {
  it('默认：仅 card 启用（stripe 出厂停用），列表只含 card', async () => {
    const res = await app.request('/api/payment-providers?currency=USD', {}, env('{}', []) as never);
    const body = await json(res);
    expect(body.code).toBe(Code.OK);
    const list = (body.data as { list: { id: string }[] }).list;
    expect(list.map((x) => x.id)).toEqual(['card']);
  });

  it('启用 stripe 后：card 与 stripe 均在（USD），redeem 通道置前', async () => {
    const res = await app.request('/api/payment-providers?currency=USD', {}, env(JSON.stringify({ stripe: { installed: 1, enable: 1 } }), []) as never);
    const list = ((await json(res)).data as { list: { id: string }[] }).list;
    expect(list[0]!.id).toBe('card');
    expect(list.map((x) => x.id)).toContain('stripe');
  });

  it('币种过滤：CNY 下 stripe 不收 → 隐藏，仅剩任意币种的 card', async () => {
    const res = await app.request('/api/payment-providers?currency=CNY', {}, env(JSON.stringify({ stripe: { installed: 1, enable: 1 } }), []) as never);
    const list = ((await json(res)).data as { list: { id: string }[] }).list;
    expect(list.map((x) => x.id)).toEqual(['card']);
  });

  it('停用 card（enable=0）→ 列表不含 card', async () => {
    const res = await app.request('/api/payment-providers', {}, env(JSON.stringify({ card: { installed: 1, enable: 0 } }), []) as never);
    const list = ((await json(res)).data as { list: { id: string }[] }).list;
    expect(list.map((x) => x.id)).not.toContain('card');
  });
});

describe('后台计划 CRUD（/api/admin/vip/plans）', () => {
  it('GET 列表含下架位', async () => {
    const res = await app.request('/api/admin/vip/plans', { headers: await adminCookie() }, env('{}', [{ test: /FROM bbs_vip_plan ORDER BY/, rows: [PLAN] }]) as never);
    const body = await json(res);
    expect(body.code).toBe(Code.OK);
    expect((body.data as { list: unknown[] }).list.length).toBe(1);
  });

  it('POST 新建 → 回显计划', async () => {
    const res = await app.request(
      '/api/admin/vip/plans',
      { method: 'POST', headers: await adminCookie(), body: JSON.stringify({ name: '月费', duration_days: 30, price_cents: 990, currency: 'cny', perks: { credits: 10 }, gid: 101 }) },
      env('{}', [
        { test: /SELECT gid FROM bbs_group WHERE gid = \?/, first: { gid: 101 } },
        { test: /INSERT INTO bbs_vip_plan/, rows: [] },
        { test: /FROM bbs_vip_plan ORDER BY id DESC/, first: { id: 4, name: '月费', duration_days: 30, price_cents: 990, currency: 'CNY', perks: '{"credits":10}', enabled: 1, sort: 0 } },
      ]) as never,
    );
    const body = await json(res);
    expect(body.code).toBe(Code.OK);
    expect((body.data as { id: number }).id).toBe(4);
  });

  it('POST 校验：空 name → VALIDATION_ERROR', async () => {
    const res = await app.request('/api/admin/vip/plans', { method: 'POST', headers: await adminCookie(), body: JSON.stringify({ name: ' ' }) }, env('{}', []) as never);
    expect((await json(res)).code).toBe(Code.VALIDATION_ERROR);
  });

  it('PUT 更新：存在则回写', async () => {
    const res = await app.request(
      '/api/admin/vip/plans/3',
      { method: 'PUT', headers: await adminCookie(), body: JSON.stringify({ name: '年费', duration_days: 365, price_cents: 1900, gid: 101 }) },
      env('{}', [
        { test: /SELECT gid FROM bbs_group WHERE gid = \?/, first: { gid: 101 } },
        { test: /SELECT id FROM bbs_vip_plan WHERE id = \?/, first: { id: 3 } },
        { test: /UPDATE bbs_vip_plan SET/, rows: [] },
        { test: /FROM bbs_vip_plan WHERE id = \?/, first: PLAN },
      ]) as never,
    );
    expect((await json(res)).code).toBe(Code.OK);
  });

  it('DELETE：不存在 → NOT_FOUND(-4)', async () => {
    const res = await app.request('/api/admin/vip/plans/9', { method: 'DELETE', headers: await adminCookie() }, env('{}', [{ test: /SELECT id FROM bbs_vip_plan WHERE id = \?/, first: null }]) as never);
    expect((await json(res)).code).toBe(Code.NOT_FOUND);
  });
});

describe('后台订单查询/退款/补单（/api/admin/orders）', () => {
  it('GET 列表分页 + 状态过滤', async () => {
    const res = await app.request('/api/admin/orders?status=pending&page=1&size=20', { headers: await adminCookie() }, env('{}', [{ test: /FROM bbs_order.*ORDER BY id DESC LIMIT/, rows: [orderRow('pending')] }]) as never);
    const body = await json(res);
    expect(body.code).toBe(Code.OK);
    expect((body.data as { list: unknown[] }).list.length).toBe(1);
  });

  it('GET 非法 status → VALIDATION_ERROR', async () => {
    const res = await app.request('/api/admin/orders?status=nope', { headers: await adminCookie() }, env('{}', []) as never);
    expect((await json(res)).code).toBe(Code.VALIDATION_ERROR);
  });

  it('退款：card 无通道退款 → 直接回写 refunded', async () => {
    const res = await app.request(
      '/api/admin/orders/FI1/refund',
      { method: 'POST', headers: await adminCookie() },
      env('{}', [
        scriptedOrder(['fulfilled', 'refunded']),
        { test: /UPDATE bbs_order SET status = \? WHERE order_no = \? AND status IN/, rows: [] },
      ]) as never,
    );
    const body = await json(res);
    expect(body.code).toBe(Code.OK);
    expect((body.data as { status: string }).status).toBe('refunded');
  });

  it('补单：pending → paid → fulfilled', async () => {
    const res = await app.request(
      '/api/admin/orders/FI1/settle',
      { method: 'POST', headers: await adminCookie() },
      env('{}', [
        scriptedOrder(['pending', 'paid', 'paid', 'fulfilled']),
        { test: /FROM bbs_vip_plan WHERE id = \?/, first: PLAN },
        { test: /UPDATE bbs_order/, rows: [], changes: 1 },
        { test: /UPDATE bbs_user SET vip_expire_at/, rows: [] },
      ]) as never,
    );
    const body = await json(res);
    expect(body.code).toBe(Code.OK);
    expect((body.data as { status: string }).status).toBe('fulfilled');
  });
});

describe('后台卡密批量生成/列表（/api/admin/cards）', () => {
  it('POST 生成 N 张 → 回显码文与批次', async () => {
    const res = await app.request(
      '/api/admin/cards',
      { method: 'POST', headers: await adminCookie(), body: JSON.stringify({ plan_id: 3, count: 3 }) },
      env('{}', [
        { test: /FROM bbs_vip_plan WHERE id = \?/, first: PLAN },
        { test: /INSERT INTO bbs_card/, first: (p: readonly unknown[]) => ({ id: String(p[0]) }) },
      ]) as never,
    );
    const body = await json(res);
    expect(body.code).toBe(Code.OK);
    const d = body.data as { count: number; cards: { code: string }[] };
    expect(d.count).toBe(3);
    expect(d.cards[0]!.code).toMatch(/^C/);
  });

  it('POST count 越界 → VALIDATION_ERROR', async () => {
    const res = await app.request('/api/admin/cards', { method: 'POST', headers: await adminCookie(), body: JSON.stringify({ plan_id: 3, count: 999 }) }, env('{}', [{ test: /FROM bbs_vip_plan WHERE id = \?/, first: PLAN }]) as never);
    expect((await json(res)).code).toBe(Code.VALIDATION_ERROR);
  });

  it('GET 列表按批次过滤', async () => {
    const res = await app.request('/api/admin/cards?batch=B1', { headers: await adminCookie() }, env('{}', [{ test: /FROM bbs_card.*LIMIT/, rows: [] }]) as never);
    expect((await json(res)).code).toBe(Code.OK);
  });

  it('POST 作废：status=0 的卡置 2，回告实际张数', async () => {
    const res = await app.request(
      '/api/admin/cards/void',
      { method: 'POST', headers: await adminCookie(), body: JSON.stringify({ ids: [1, 2] }) },
      env('{}', [{ test: /UPDATE bbs_card SET status = 2 WHERE status = 0 AND id IN/, rows: [], changes: 2 }]) as never,
    );
    const body = await json(res);
    expect(body.code).toBe(Code.OK);
    expect((body.data as { voided: number }).voided).toBe(2);
  });

  it('POST 作废：ids 为空 → VALIDATION_ERROR', async () => {
    const res = await app.request('/api/admin/cards/void', { method: 'POST', headers: await adminCookie(), body: JSON.stringify({ ids: [] }) }, env('{}', []) as never);
    expect((await json(res)).code).toBe(Code.VALIDATION_ERROR);
  });

  it('POST 删除：仅删未使用/已作废（status IN (0,2)），回告实际张数', async () => {
    const res = await app.request(
      '/api/admin/cards/delete',
      { method: 'POST', headers: await adminCookie(), body: JSON.stringify({ ids: [5] }) },
      env('{}', [{ test: /DELETE FROM bbs_card WHERE status IN \(0,2\) AND id IN/, rows: [], changes: 1 }]) as never,
    );
    const body = await json(res);
    expect(body.code).toBe(Code.OK);
    expect((body.data as { deleted: number }).deleted).toBe(1);
  });
});

describe('掉单对账 cron 分派（handleScheduled → reconcilePending）', () => {
  it('每小时档触发对账：扫描 pending 外部单，不抛错（附件 GC 同档执行）', async () => {
    let scheduled = '';
    const rules: SqlRule[] = [
      { test: /FROM bbs_order WHERE status = \? AND provider/, rows: [] },
      // 每小时档同时跑临时附件 GC（批量≤子请求预算、先删对象再删行）；无过期对象时不产生删除
      { test: /SELECT aid,filename FROM bbs_attach WHERE status = 0 AND create_date < \? LIMIT \?/, rows: () => [] },
    ];
    const { db, calls } = fakeD1Sql([
      { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: (p: readonly unknown[]) => (p[0] === 'setting' ? { v: SETTING } : { v: '{}' }) },
      { test: /SELECT v FROM bbs_cache/, first: null },
      { test: /REPLACE INTO bbs_cache/, rows: [] },
      ...rules,
    ]);
    const envCron = { DB: db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost', SECRETS_MASTER_KEY: '' } as never;
    const controller = { cron: CRON_HOURLY } as unknown as ScheduledController;
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
    await handleScheduled(controller, envCron, ctx);
    scheduled = controller.cron;
    expect(scheduled).toBe(CRON_HOURLY);
    expect(calls.some((c) => /FROM bbs_attach WHERE status = 0/.test(c.sql))).toBe(true);
  });
});
