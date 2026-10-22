/**
 * T5-5 card 卡密插件单测（§15.5；DoD：下单→兑换→开通闭环跑通、契约够用性验证）。
 * 覆盖：兑换码归一、原子认领（并发/重复/错配拒绝）、兑换路由端到端开通、幂等、越权/未登录、checkout 渲染 redeem 态。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { Code, type PayOrder } from '@freeidx/shared';
import { Cache, l0Clear } from '../src/core/cache';
import { D1b } from '../src/core/db';
import { registerCard, cardProvider, normalizeCardCode } from '../src/extensions/card';
import { resetProviders } from '../src/core/payment/registry';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';

const CARD: PayOrder = { orderNo: 'FI1', uid: 7, planId: 3, amountCents: 1900, currency: 'CNY', status: 'pending' };

function makeCore(rules: SqlRule[]) {
  const { db, calls } = fakeD1Sql([{ test: /FROM bbs_cache/, first: null }, { test: /REPLACE INTO bbs_cache/, rows: [] }, { test: /DELETE FROM bbs_cache/, rows: [] }, ...rules]);
  const d1b = new D1b(db as never);
  const cache = new Cache({ DB: db, CACHE: fakeKv(), SITE_URL: '' } as never, d1b);
  return { core: { db: d1b, cache }, calls };
}

beforeEach(() => {
  l0Clear();
  resetProviders();
  registerCard();
});

describe('卡密归一 + 原子认领', () => {
  it('normalizeCardCode：去除所有空白并转大写', () => {
    expect(normalizeCardCode('  ab-cd 12 ')).toBe('AB-CD12');
    expect(normalizeCardCode('ab cd')).toBe('ABCD');
  });

  it('有效卡：changes=1 → ok 且 providerRef=card:CODE', async () => {
    const cardUpdate: SqlRule = { test: /UPDATE bbs_card SET status = 1/, rows: [], changes: 1 };
    const { core, calls } = makeCore([cardUpdate]);
    const r = await cardProvider.redeem(CARD, 'ab cd', { db: core.db, cache: core.cache, config: {}, ts: 1700000000 });
    expect(r).toEqual({ ok: true, providerRef: 'card:ABCD' });
    // 认领语句同时约束 status=0 + plan_id + 未过期
    expect(calls[0]!.sql).toMatch(/status = 0 AND plan_id = \? AND \(expire_date = 0 OR expire_date > \?\)/);
    expect(calls[0]!.params).toEqual([7, 1700000000, 'ABCD', 3, 1700000000]);
  });

  it('重复/错配卡：changes=0 → 拒绝（不消费）', async () => {
    const cardUpdate: SqlRule = { test: /UPDATE bbs_card SET status = 1/, rows: [], changes: 0 };
    const { core } = makeCore([cardUpdate]);
    const r = await cardProvider.redeem(CARD, 'ABCD', { db: core.db, cache: core.cache, config: {}, ts: 1 });
    expect(r.ok).toBe(false);
  });

  it('空码：零查询直接拒绝', async () => {
    const { core, calls } = makeCore([{ test: /UPDATE bbs_card/, rows: [], changes: 1 }]);
    const r = await cardProvider.redeem(CARD, '   ', { db: core.db, cache: core.cache, config: {}, ts: 1 });
    expect(r.ok).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('createCheckout→redeem；verifyWebhook→null（无异步回调）', async () => {
    expect(await cardProvider.createCheckout(CARD, {})).toEqual({ mode: 'redeem' });
    expect(await cardProvider.verifyWebhook(new Request('https://x'), {})).toBeNull();
  });
});

// —— 兑换路由端到端：下单(pending,provider=card)→兑换→开通 ——
const SETTING = JSON.stringify({ runlevel: 5, sitename: 'S', lang: 'zh-cn' });
const FORUM1 = { fid: 1, name: 'f', rank: 1, threads: 0, todayposts: 0, todaythreads: 0, brief: '', announcement: '', accesson: 0, orderby: 0, icon: 0, moduids: '', seo_title: '', seo_keywords: '' };
const GROUP = { gid: 1, name: 'a', creditsfrom: 0, creditsto: 0, allowread: 1, allowthread: 1, allowpost: 1, allowattach: 1, allowdown: 1, allowtop: 1, allowupdate: 1, allowdelete: 1, allowmove: 1, allowbanuser: 1, allowdeleteuser: 1, allowviewip: 1 };
const PLAN = { id: 3, name: '年费', duration_days: 365, price_cents: 1900, currency: 'CNY', perks: '{}', enabled: 1, sort: 0 };

function orderRow(status: string): Record<string, unknown> {
  return { order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status, provider: 'card', provider_ref: '', created_date: 1, paid_date: 0, fulfilled_date: 0 };
}
function scriptedOrder(statuses: string[]): SqlRule {
  let i = 0;
  return { test: /FROM bbs_order WHERE order_no = \?/, first: () => orderRow(statuses[Math.min(i++, statuses.length - 1)]!) };
}
function envFor(rules: SqlRule[]) {
  const { db } = fakeD1Sql([
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: (p: readonly unknown[]) => (p[0] === 'extensions' ? { v: '{}' } : p[0] === 'setting' ? { v: SETTING } : { v: '{}' }) },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /FROM bbs_forum ORDER BY/, rows: [FORUM1] },
    { test: /bbs_forum_access/, rows: [] },
    { test: /FROM bbs_group/, rows: [GROUP] },
    { test: /FROM bbs_session WHERE sid/, first: (p: readonly unknown[]) => (Number(p[0]) === 0 ? null : { uid: 7, last_date: Math.floor(Date.now() / 1000) }) },
    { test: /token_version FROM bbs_user WHERE uid = \?/, first: { uid: 7, gid: 1, username: 'u7', token_version: 0 } },
    ...rules,
  ]);
  return { DB: db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost' };
}
function authed(): Record<string, string> {
  const csrf = 'tok123';
  return { 'content-type': 'application/json', cookie: `sid=sessA; csrf=${csrf}`, 'x-csrf-token': csrf };
}

describe('POST /api/orders/:no/redeem（兑换→开通闭环）', () => {
  it('有效卡 → markPaid + fulfillOrder（延长 VIP），返回 fulfilled', async () => {
    const rules: SqlRule[] = [
      scriptedOrder(['pending', 'pending', 'paid', 'paid', 'fulfilled']),
      { test: /UPDATE bbs_card SET status = 1/, rows: [], changes: 1 },
      { test: /FROM bbs_vip_plan WHERE id = \?/, first: PLAN },
      { test: /UPDATE bbs_order/, rows: [], changes: 1 },
      { test: /UPDATE bbs_user SET vip_expire_at/, rows: [] },
    ];
    const res = await app.request('/api/orders/FI1/redeem', { method: 'POST', headers: authed(), body: JSON.stringify({ code: 'AB-CD' }) }, envFor(rules) as never);
    const body = (await res.json()) as { code: number; data: { status: string } };
    expect(body.code).toBe(0);
    expect(body.data.status).toBe('fulfilled');
  });

  it('无效卡（changes=0）→ 校验失败，订单不落账', async () => {
    const res = await app.request(
      '/api/orders/FI1/redeem',
      { method: 'POST', headers: authed(), body: JSON.stringify({ code: 'BAD' }) },
      envFor([
        scriptedOrder(['pending']),
        // 订单级互斥占位（claimPendingOrder）成功；卡密认领失败后占位释放（亦命中本规则）
        { test: /UPDATE bbs_order SET provider_ref = \?/, rows: [], changes: 1 },
        { test: /UPDATE bbs_card SET status = 1/, rows: [], changes: 0 },
      ]) as never,
    );
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(Code.VALIDATION_ERROR);
  });

  it('非 pending 订单（已开通）→ 幂等返回当前态，不再消费卡', async () => {
    const res = await app.request(
      '/api/orders/FI1/redeem',
      { method: 'POST', headers: authed(), body: JSON.stringify({ code: 'X' }) },
      envFor([scriptedOrder(['fulfilled'])]) as never,
    );
    const body = (await res.json()) as { code: number; data: { status: string } };
    expect(body.code).toBe(0);
    expect(body.data.status).toBe('fulfilled');
  });

  it('他人订单 → NO_PERMISSION(-3)', async () => {
    const res = await app.request(
      '/api/orders/FI1/redeem',
      { method: 'POST', headers: authed(), body: JSON.stringify({ code: 'X' }) },
      envFor([{ test: /FROM bbs_order WHERE order_no = \?/, first: () => ({ ...orderRow('pending'), uid: 999 }) }]) as never,
    );
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(-3);
  });

  it('未登录 → NOT_LOGIN(-1)', async () => {
    const res = await app.request(
      '/api/orders/FI1/redeem',
      { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'csrf=t', 'x-csrf-token': 't' }, body: JSON.stringify({ code: 'X' }) },
      envFor([scriptedOrder(['pending'])]) as never,
    );
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(-1);
  });
});

describe('POST /api/orders/:no/checkout（卡密态渲染）', () => {
  it('card 通道 → mode=redeem（收银台展示兑换码输入）', async () => {
    const res = await app.request(
      '/api/orders/FI1/checkout',
      { method: 'POST', headers: authed() },
      envFor([scriptedOrder(['pending'])]) as never,
    );
    const body = (await res.json()) as { code: number; data: { mode: string } };
    expect(body.code).toBe(0);
    expect(body.data.mode).toBe('redeem');
  });

  it('已终结订单 → 不再创建会话（返回当前状态，mode=pending）', async () => {
    const res = await app.request(
      '/api/orders/FI1/checkout',
      { method: 'POST', headers: authed() },
      envFor([scriptedOrder(['paid'])]) as never,
    );
    const body = (await res.json()) as { code: number; data: { mode: string; status: string } };
    expect(body.code).toBe(0);
    expect(body.data.mode).toBe('pending');
    expect(body.data.status).toBe('paid');
  });

  it('pending 单已有外部会话引用且结果未缓存 → 不另开会话（mode=pending）', async () => {
    const row = { ...orderRow('pending'), provider_ref: 'cs_test_existing' };
    const res = await app.request(
      '/api/orders/FI1/checkout',
      { method: 'POST', headers: authed() },
      envFor([{ test: /FROM bbs_order WHERE order_no = \?/, first: row }]) as never,
    );
    const body = (await res.json()) as { code: number; data: { mode: string } };
    expect(body.code).toBe(0);
    expect(body.data.mode).toBe('pending');
  });
});
