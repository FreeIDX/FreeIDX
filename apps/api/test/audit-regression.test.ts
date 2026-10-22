/**
 * 全面审计修复的跨模块回归用例（按缺陷类型分组）：
 *  - 支付回调：金额不一致拒绝落账 / 非法状态迁移不抛错（ack + ignored）；
 *  - 履约：计划被硬删时阻断履约（不空履约、不翻转状态）；
 *  - 扩展状态：合法 JSON 但非对象 → 回落空表（不再 Object.keys(null) 打 500）。
 *
 * 说明：测试桩刻意不提供「写入类」SQL 规则（UPDATE/INSERT）——若被测代码越界写了库，
 * fakeD1Sql 会以 unmatched SQL 直接抛错，从而把「不该发生的副作用」变成硬失败。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Code } from '@freeidx/shared';
import { Cache, l0Clear } from '../src/core/cache';
import { D1b } from '../src/core/db';
import { loadExtensionsState } from '../src/core/extensions/registry';
import { fulfillOrder } from '../src/core/order';
import { applyProviderEvent } from '../src/core/payment/orchestrator';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';

const CACHE_RULES: SqlRule[] = [
  { test: /FROM bbs_cache/, first: null },
  { test: /REPLACE INTO bbs_cache/, rows: [] },
  { test: /DELETE FROM bbs_cache/, rows: [] },
];

function makeCore(rules: SqlRule[]) {
  const { db, calls } = fakeD1Sql([...CACHE_RULES, ...rules]);
  const d1b = new D1b(db as never);
  const cache = new Cache({ DB: db, CACHE: fakeKv(), SITE_URL: '' } as never, d1b);
  return { core: { db: d1b, cache }, calls };
}

/** 订单行（与 core/order.mapOrder 的投影列一一对应） */
const orderRow = (status: string, ref = 'cs_1') => ({
  order_no: 'FI1',
  uid: 7,
  plan_id: 3,
  amount_cents: 1900,
  currency: 'CNY',
  status,
  provider: 'stripe',
  provider_ref: ref,
  created_date: 1,
  paid_date: 0,
  fulfilled_date: 0,
});

beforeEach(() => l0Clear());

describe('支付回调（金额与状态机边界）', () => {
  it('实收金额与订单金额不一致 → 拒绝落账（ack + ignored，不翻转状态）', async () => {
    const { core, calls } = makeCore([{ test: /FROM bbs_order WHERE provider_ref = \?/, first: () => orderRow('pending') }]);
    const out = await applyProviderEvent(core, { providerRef: 'cs_1', status: 'paid', amountCents: 100 }, 1);
    expect(out).toMatchObject({ handled: true, action: 'ignored', orderNo: 'FI1' });
    // 未落账：全程不应出现任何写语句（桩未提供 UPDATE 规则，越界即 unmatched 抛错）
    expect(calls.some((c) => /UPDATE bbs_order/.test(c.sql))).toBe(false);
  });

  it('金额一致 → 正常推进 paid（markPaid 落账）', async () => {
    // 订单状态按读取次数推进：markPaid(pending→paid) → fulfillOrder(paid→fulfilled)
    const seq = ['pending', 'paid', 'paid', 'fulfilled'];
    let i = 0;
    const rules: SqlRule[] = [
      { test: /FROM bbs_order WHERE provider_ref = \?/, first: () => orderRow('pending') },
      { test: /FROM bbs_order WHERE order_no = \?/, first: () => orderRow(seq[Math.min(i++, seq.length - 1)]!) },
      { test: /UPDATE bbs_order SET status = \?, paid_date/, rows: [], changes: 1 },
      { test: /FROM bbs_vip_plan WHERE id = \?/, first: { id: 3, name: 'Y', duration_days: 30, price_cents: 1900, currency: 'CNY', perks: '{}', enabled: 1, sort: 0, gid: 0 } },
      { test: /UPDATE bbs_order SET status = \?, fulfilled_date/, rows: [], changes: 1 },
      { test: /UPDATE bbs_user SET vip_expire_at/, rows: [] },
    ];
    const { core } = makeCore(rules);
    const out = await applyProviderEvent(core, { providerRef: 'cs_1', status: 'paid', amountCents: 1900 }, 1);
    expect(out).toMatchObject({ handled: true, action: 'paid', orderNo: 'FI1' });
  });

  it('退款事件落在 pending 单（非法迁移）→ ack + ignored，不抛错（避免 provider 重试风暴）', async () => {
    const { core } = makeCore([
      { test: /FROM bbs_order WHERE provider_ref = \?/, first: null },
      { test: /FROM bbs_order WHERE order_no = \?/, first: () => orderRow('pending') },
    ]);
    const out = await applyProviderEvent(core, { providerRef: 'ch_1', status: 'refunded', orderNo: 'FI1' }, 1);
    expect(out).toMatchObject({ handled: true, action: 'ignored', orderNo: 'FI1' });
  });

  it('二级反查：provider_ref 命中不到（refund 事件对象是 ch_）时回落 orderNo 定位订单', async () => {
    const rules: SqlRule[] = [
      { test: /FROM bbs_order WHERE provider_ref = \?/, first: null },
      { test: /FROM bbs_order WHERE order_no = \?/, first: () => orderRow('fulfilled') },
      { test: /UPDATE bbs_order SET status = \? WHERE order_no = \? AND status IN/, rows: [], changes: 1 },
      { test: /FROM bbs_vip_plan WHERE id = \?/, first: null },
      { test: /UPDATE bbs_user SET gid = vip_from_gid/, rows: [] },
    ];
    const { core } = makeCore(rules);
    const out = await applyProviderEvent(core, { providerRef: 'ch_1', status: 'refunded', orderNo: 'FI1' }, 1);
    expect(out).toMatchObject({ handled: true, action: 'refunded', orderNo: 'FI1' });
  });
});

describe('履约（计划被硬删的边界）', () => {
  it('计划已被删除 → 阻断履约并抛 SYSTEM_ERROR（不空履约、不翻转 fulfilled）', async () => {
    const { core, calls } = makeCore([
      { test: /FROM bbs_order WHERE order_no = \?/, first: () => orderRow('paid') },
      { test: /FROM bbs_vip_plan WHERE id = \?/, first: null },
    ]);
    await expect(fulfillOrder(core, 'FI1', 1)).rejects.toMatchObject({ code: Code.SYSTEM_ERROR });
    expect(calls.some((c) => /UPDATE bbs_order/.test(c.sql))).toBe(false);
  });
});

describe('扩展状态读取（脏数据不放大成 500）', () => {
  it('kv extensions 是合法 JSON 但非对象（null）→ 回落空表', async () => {
    const { db } = fakeD1Sql([...CACHE_RULES, { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: 'null' } }]);
    const d1b = new D1b(db as never);
    const cache = new Cache({ DB: db, CACHE: fakeKv(), SITE_URL: '' } as never, d1b);
    await expect(loadExtensionsState(cache, d1b)).resolves.toEqual({});
  });

  it('kv extensions 是数组/字符串同样回落空表（Object.keys 不再抛 TypeError）', async () => {
    for (const blob of ['[1,2]', '"x"', '3']) {
      l0Clear();
      const { db } = fakeD1Sql([...CACHE_RULES, { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: blob } }]);
      const d1b = new D1b(db as never);
      const cache = new Cache({ DB: db, CACHE: fakeKv(), SITE_URL: '' } as never, d1b);
      await expect(loadExtensionsState(cache, d1b)).resolves.toEqual({});
    }
  });
});
