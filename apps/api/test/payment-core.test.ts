/**
 * T5-4 payment-core 单测（§15.5 契约装配 + webhook 分发 + 幂等/对账/退款编排；DoD：核心不含任何通道代码）。
 * 用内存 mock PaymentProvider 驱动核心，验证装配/门控/落账/降级；真实通道在 T5-5/T5-6 各自实现。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { Cache, l0Clear } from '../src/core/cache';
import { D1b } from '../src/core/db';
import type { PaymentConfig, PaymentProvider } from '@freeidx/shared';
import {
  listReadyProviders,
  providerLifecycle,
  registerProvider,
  resetProviders,
  resolveProviderConfig,
  runCheckout,
} from '../src/core/payment/registry';
import {
  applyProviderEvent,
  dispatchWebhook,
  issueRefund,
  linkProviderRef,
  reconcilePending,
  sweepStaleOrders,
} from '../src/core/payment/orchestrator';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';

interface MockOpts {
  checkout?: 'redirect' | 'qrcode' | 'redeem';
  webhook?: 'valid' | 'invalid' | 'none';
  query?: 'paid' | 'pending' | 'failed';
  refund?: { ok: boolean; reason?: string };
}
function mockProvider(id: string, o: MockOpts = {}): PaymentProvider {
  return {
    id,
    capabilities: { currencies: ['CNY'], modes: [o.checkout ?? 'redirect'], refund: !!o.refund },
    async createCheckout(order, cfg: PaymentConfig) {
      const c = cfg as Record<string, unknown>;
      if ((o.checkout ?? 'redirect') === 'qrcode') return { mode: 'qrcode' as const, content: `qr:${order.orderNo}:${String(c.url ?? '')}` };
      if (o.checkout === 'redeem') return { mode: 'redeem' as const };
      return { mode: 'redirect' as const, url: `https://pay.test/${order.orderNo}` };
    },
    async verifyWebhook(req) {
      if ((o.webhook ?? 'valid') === 'invalid') return null;
      if ((o.webhook ?? 'valid') === 'none') return null;
      const ref = req.headers.get('x-ref') ?? '';
      const status = (req.headers.get('x-status') ?? 'paid') as 'paid' | 'refunded' | 'failed';
      if (!ref) return null;
      return { providerRef: ref, status };
    },
    async queryOrder() {
      return o.query ?? 'pending';
    },
    async refund() {
      return o.refund ?? { ok: true };
    },
  };
}

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

const EXT_STATE = (state: Record<string, { installed: 0 | 1; enable: 0 | 1 }>): SqlRule => ({
  test: /SELECT v FROM bbs_kv WHERE k = \?/,
  first: (p: readonly unknown[]) => {
    if (p[0] === 'extensions') return { v: JSON.stringify(state) };
    if (p[0] === 'setting') return { v: JSON.stringify({ runlevel: 5, sitename: 'S' }) };
    if (typeof p[0] === 'string' && p[0].startsWith('ext:')) return { v: String(p[0]).endsWith(':config') ? JSON.stringify({ sig: 'good' }) : null };
    return null;
  },
});

beforeEach(() => {
  l0Clear();
  resetProviders();
});

describe('注册表 + 生命周期门控', () => {
  it('未注册→missing；注册且 enable=1→ready；enable=0→disabled', async () => {
    registerProvider(mockProvider('stripe', {}), { installed: 1, enable: 0 });
    const a = makeCore([EXT_STATE({})]);
    expect(await providerLifecycle(a.core.cache, a.core.db, 'stripe')).toBe('disabled'); // 出厂默认停用
    const g = makeCore([EXT_STATE({})]);
    expect(await providerLifecycle(g.core.cache, g.core.db, 'ghost')).toBe('missing'); // 无代码
  });

  it('kv extensions 覆盖启用 → ready', async () => {
    registerProvider(mockProvider('stripe', {}), { installed: 1, enable: 0 });
    const { core } = makeCore([EXT_STATE({ stripe: { installed: 1, enable: 1 } })]);
    expect(await providerLifecycle(core.cache, core.db, 'stripe')).toBe('ready');
  });

  it('kv extensions 卸载（installed=0）→ missing', async () => {
    registerProvider(mockProvider('stripe', {}), { installed: 1, enable: 1 });
    const { core } = makeCore([EXT_STATE({ stripe: { installed: 0, enable: 0 } })]);
    expect(await providerLifecycle(core.cache, core.db, 'stripe')).toBe('missing');
  });

  it('listReadyProviders 仅返回 ready 通道（收银台聚合基础）', async () => {
    registerProvider(mockProvider('card'), { installed: 1, enable: 1 });
    registerProvider(mockProvider('alipay'), { installed: 1, enable: 0 });
    const { core } = makeCore([EXT_STATE({})]);
    const ready = await listReadyProviders(core.cache, core.db);
    expect(ready.map((p) => p.id)).toEqual(['card']);
    expect(ready[0]!.capabilities.currencies).toContain('CNY');
  });

  it('resolveProviderConfig：明文 config 注入（master key 缺失时 secret 安全为空）', async () => {
    const { core } = makeCore([EXT_STATE({})]);
    const cfg = await resolveProviderConfig(core.cache, core.db, { } as never, 'stripe');
    expect(cfg).toMatchObject({ sig: 'good' });
  });
});

describe('checkout 装配（runCheckout）', () => {
  const order = { orderNo: 'FI1', uid: 7, planId: 3, amountCents: 1900, currency: 'CNY', status: 'pending' as const };
  it('未 ready 通道→null（收银台优雅降级 pending 轮询）', async () => {
    registerProvider(mockProvider('stripe'), { installed: 1, enable: 0 });
    const { core } = makeCore([EXT_STATE({})]);
    expect(await runCheckout(core.cache, core.db, undefined, 'stripe', order)).toBeNull();
  });
  it('ready 通道透传 redirect/qrcode 判别联合', async () => {
    registerProvider(mockProvider('stripe', { checkout: 'redirect' }));
    const { core } = makeCore([EXT_STATE({})]);
    const r = await runCheckout(core.cache, core.db, undefined, 'stripe', order);
    expect(r).toEqual({ mode: 'redirect', url: 'https://pay.test/FI1' });
  });
});

describe('provider_ref 反查回填', () => {
  it('linkProviderRef：仅 pending 且当前空 ref 时写入', async () => {
    const { core, calls } = makeCore([{ test: /UPDATE bbs_order SET provider_ref/, rows: [] }]);
    await linkProviderRef(core.db, 'FI1', 'REF-9');
    const sql = calls[0]!.sql;
    expect(sql).toMatch(/status = \? AND provider_ref = \?/);
    expect(calls[0]!.params).toEqual(['REF-9', 'FI1', 'pending', '']);
  });
});

describe('applyProviderEvent → 状态机落账', () => {
  const planRule: SqlRule = { test: /FROM bbs_vip_plan WHERE id/, first: { id: 3, name: 'Y', duration_days: 365, price_cents: 1900, currency: 'CNY', perks: '{}', enabled: 1, sort: 0 } };
  const updOrder: SqlRule = { test: /UPDATE bbs_order/, rows: [], changes: 1 };
  const updVip: SqlRule = { test: /UPDATE bbs_user SET vip_expire_at/, rows: [] };

  function orderSeq(statuses: string[]): SqlRule {
    let i = 0;
    return {
      test: /FROM bbs_order WHERE order_no = \?/,
      first: () => ({ order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: statuses[Math.min(i++, statuses.length - 1)], provider: 'stripe', provider_ref: 'REF-1', created_date: 1, paid_date: 0, fulfilled_date: 0 }),
    };
  }
  const byRef: SqlRule = { test: /FROM bbs_order WHERE provider_ref = \?/, first: () => ({ order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: 'pending', provider: 'stripe', provider_ref: 'REF-1', created_date: 1, paid_date: 0, fulfilled_date: 0 }) };

  it('paid：markPaid + fulfillOrder（pending→paid→fulfilled）', async () => {
    const { core, calls } = makeCore([byRef, orderSeq(['pending', 'paid', 'paid', 'fulfilled']), planRule, updOrder, updVip]);
    const out = await applyProviderEvent(core, { providerRef: 'REF-1', status: 'paid' }, 1700000000);
    expect(out).toMatchObject({ handled: true, action: 'paid', orderNo: 'FI1' });
    expect(calls.some((c) => /UPDATE bbs_user SET vip_expire_at = MAX/.test(c.sql))).toBe(true);
  });

  it('refunded：refundOrder', async () => {
    const paidByNo: SqlRule = { test: /FROM bbs_order WHERE order_no = \?/, first: () => ({ order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: 'paid', provider: 'stripe', provider_ref: 'REF-1', created_date: 1, paid_date: 1, fulfilled_date: 0 }) };
    // refundOrder 回滚权益要读计划（duration_days/perks）并回退 VIP 时长与组，规则需覆盖这两步
    const { core, calls } = makeCore([
      byRef,
      paidByNo,
      { ...paidByNo, first: () => ({ order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: 'refunded', provider: 'stripe', provider_ref: 'REF-1', created_date: 1, paid_date: 1, fulfilled_date: 0 }) },
      planRule,
      updOrder,
      updVip,
      { test: /UPDATE bbs_user SET gid = vip_from_gid/, rows: [] },
    ]);
    const out = await applyProviderEvent(core, { providerRef: 'REF-1', status: 'refunded' }, 1);
    expect(out).toMatchObject({ action: 'refunded' });
    expect(calls.some((c) => /UPDATE bbs_order SET status = \?/.test(c.sql))).toBe(true);
  });

  it('failed：closeOrder', async () => {
    const { core } = makeCore([byRef, { ...byRef, test: /FROM bbs_order WHERE order_no = \?/ }, updOrder]);
    const out = await applyProviderEvent(core, { providerRef: 'REF-1', status: 'failed' }, 1);
    expect(out).toMatchObject({ action: 'closed' });
  });

  it('未知单（provider_ref 反查无果）→ 不报错，ack 为 unknown-order', async () => {
    const { core } = makeCore([{ test: /FROM bbs_order WHERE provider_ref = \?/, first: null }]);
    const out = await applyProviderEvent(core, { providerRef: 'REF-X', status: 'paid' }, 1);
    expect(out).toEqual({ handled: false, reason: 'unknown-order' });
  });

  it('迟到 paid 落在已退款终态单 → ack=ignored，不抛错、不履约（避免 provider 重试风暴）', async () => {
    const refundedByNo: SqlRule = { test: /FROM bbs_order WHERE order_no = \?/, first: () => ({ order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: 'refunded', provider: 'stripe', provider_ref: 'REF-1', created_date: 1, paid_date: 1, fulfilled_date: 0 }) };
    const { core, calls } = makeCore([byRef, refundedByNo]);
    const out = await applyProviderEvent(core, { providerRef: 'REF-1', status: 'paid' }, 1);
    expect(out).toMatchObject({ handled: true, action: 'ignored', orderNo: 'FI1' });
    expect(calls.some((c) => /UPDATE bbs_user/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /FROM bbs_vip_plan/.test(c.sql))).toBe(false);
  });
});

describe('dispatchWebhook（门控 + 验签 + 落账 HTTP 语义）', () => {
  const planRule: SqlRule = { test: /FROM bbs_vip_plan WHERE id/, first: { id: 3, name: 'Y', duration_days: 0, price_cents: 1900, currency: 'CNY', perks: '{}', enabled: 1, sort: 0 } };
  function orderSeq(statuses: string[]): SqlRule {
    let i = 0;
    return { test: /FROM bbs_order WHERE order_no = \?/, first: () => ({ order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: statuses[Math.min(i++, statuses.length - 1)], provider: 'stripe', provider_ref: 'REF-1', created_date: 1, paid_date: 0, fulfilled_date: 0 }) };
  }
  const byRef: SqlRule = { test: /FROM bbs_order WHERE provider_ref = \?/, first: () => ({ order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: 'pending', provider: 'stripe', provider_ref: 'REF-1', created_date: 1, paid_date: 0, fulfilled_date: 0 }) };
  const req = (status: string) => new Request('https://x/cb', { method: 'POST', headers: { 'x-ref': 'REF-1', 'x-status': status } });

  it('未装→404；停用→410', async () => {
    registerProvider(mockProvider('stripe', { webhook: 'valid' }), { installed: 1, enable: 0 });
    const a = makeCore([EXT_STATE({})]);
    expect((await dispatchWebhook(a.core, undefined, 'stripe', req('paid'), 1)).status).toBe(410);
    const b = makeCore([EXT_STATE({})]);
    expect((await dispatchWebhook(b.core, undefined, 'ghost', req('paid'), 1)).status).toBe(404);
  });

  it('验签失败→400 拒绝落账', async () => {
    registerProvider(mockProvider('stripe', { webhook: 'invalid' }), { installed: 1, enable: 1 });
    const { core } = makeCore([EXT_STATE({})]);
    const r = await dispatchWebhook(core, undefined, 'stripe', req('paid'), 1);
    expect(r.status).toBe(400);
    expect(r.outcome).toEqual({ handled: false, reason: 'invalid-signature' });
  });

  it('验签通过 + paid→200 落账', async () => {
    registerProvider(mockProvider('stripe', { webhook: 'valid' }), { installed: 1, enable: 1 });
    const { core } = makeCore([EXT_STATE({}), byRef, orderSeq(['pending', 'paid', 'paid', 'fulfilled']), planRule, { test: /UPDATE bbs_order/, rows: [], changes: 1 }]);
    const r = await dispatchWebhook(core, undefined, 'stripe', req('paid'), 1);
    expect(r.status).toBe(200);
    expect(r.outcome).toMatchObject({ handled: true, action: 'paid' });
  });
});

describe('reconcilePending（掉单对账 cron 编排）', () => {
  it('外部 pending 单 → provider 复核 paid → 补款履约，计入 recovered', async () => {
    registerProvider(mockProvider('stripe', { query: 'paid' }), { installed: 1, enable: 1 });
    const listRule: SqlRule = {
      test: /FROM bbs_order WHERE status = \? AND provider/,
      rows: [{ order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: 'pending', provider: 'stripe', provider_ref: '', created_date: 1700000000, paid_date: 0, fulfilled_date: 0 }],
    };
    let reads = 0;
    const orderSeq: SqlRule = {
      test: /FROM bbs_order WHERE order_no = \?/,
      first: () => ({ order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: reads++ === 0 ? 'pending' : 'paid', provider: 'stripe', provider_ref: 'recon:FI1', created_date: 1, paid_date: 0, fulfilled_date: 0 }),
    };
    const { core, calls } = makeCore([
      EXT_STATE({ stripe: { installed: 1, enable: 1 } }),
      listRule, orderSeq,
      { test: /FROM bbs_order WHERE provider_ref = \?/, first: null },
      { test: /UPDATE bbs_order SET provider_ref/, rows: [] },
      { test: /UPDATE bbs_order/, rows: [], changes: 1 },
      { test: /FROM bbs_vip_plan WHERE id/, first: { id: 3, name: 'Y', duration_days: 0, price_cents: 1900, currency: 'CNY', perks: '{}', enabled: 1, sort: 0 } },
    ]);
    const report = await reconcilePending(core, undefined, 1700000000 + 3600);
    expect(report).toMatchObject({ scanned: 1, recovered: 1 });
    expect(calls.some((c) => /UPDATE bbs_order SET provider_ref/.test(c.sql))).toBe(true);
  });

  it('queryOrder=failed → 关单，计入 failed', async () => {
    registerProvider(mockProvider('stripe', { query: 'failed' }), { installed: 1, enable: 1 });
    const listRule: SqlRule = {
      test: /FROM bbs_order WHERE status = \? AND provider/,
      rows: [{ order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: 'pending', provider: 'stripe', provider_ref: '', created_date: 1700000000, paid_date: 0, fulfilled_date: 0 }],
    };
    let reads = 0;
    const orderSeq: SqlRule = {
      test: /FROM bbs_order WHERE order_no = \?/,
      first: () => ({ order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: reads++ === 0 ? 'pending' : 'closed', provider: 'stripe', provider_ref: '', created_date: 1, paid_date: 0, fulfilled_date: 0 }),
    };
    const { core } = makeCore([EXT_STATE({ stripe: { installed: 1, enable: 1 } }), listRule, orderSeq, { test: /UPDATE bbs_order/, rows: [], changes: 1 }]);
    const report = await reconcilePending(core, undefined, 1700000000 + 3600);
    expect(report).toMatchObject({ scanned: 1, recovered: 0, failed: 1 });
  });
});

describe('sweepStaleOrders（超期关单 cron 编排）', () => {
  const STALE_ORDER = { order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: 'pending', provider: 'stripe', provider_ref: '', created_date: 1700000000, paid_date: 0, fulfilled_date: 0 };
  const listRule: SqlRule = { test: /FROM bbs_order WHERE status = \? AND provider/, rows: [STALE_ORDER] };

  it('超期单 queryOrder=pending → closeOrder 关单，计入 closed', async () => {
    registerProvider(mockProvider('stripe', { query: 'pending' }), { installed: 1, enable: 1 });
    let reads = 0;
    const orderSeq: SqlRule = {
      test: /FROM bbs_order WHERE order_no = \?/,
      first: () => ({ ...STALE_ORDER, created_date: 1, status: reads++ === 0 ? 'pending' : 'closed' }),
    };
    const { core, calls } = makeCore([EXT_STATE({ stripe: { installed: 1, enable: 1 } }), listRule, orderSeq, { test: /UPDATE bbs_order/, rows: [], changes: 1 }]);
    const report = await sweepStaleOrders(core, undefined, 1700000000 + 72 * 3600 + 60);
    expect(report).toMatchObject({ scanned: 1, closed: 1, recovered: 0, failed: 0 });
    expect(calls.some((c) => /UPDATE bbs_order SET status = \?/.test(c.sql))).toBe(true);
  });

  it('超期单 queryOrder=paid → 补款履约，计入 recovered', async () => {
    registerProvider(mockProvider('stripe', { query: 'paid' }), { installed: 1, enable: 1 });
    let reads = 0;
    const orderSeq: SqlRule = {
      test: /FROM bbs_order WHERE order_no = \?/,
      first: () => ({ ...STALE_ORDER, provider_ref: reads > 0 ? 'recon:FI1' : '', created_date: 1, status: reads++ === 0 ? 'pending' : 'paid' }),
    };
    const { core } = makeCore([
      EXT_STATE({ stripe: { installed: 1, enable: 1 } }),
      listRule,
      orderSeq,
      { test: /FROM bbs_order WHERE provider_ref = \?/, first: null },
      { test: /UPDATE bbs_order SET provider_ref/, rows: [] },
      { test: /UPDATE bbs_order/, rows: [], changes: 1 },
      { test: /FROM bbs_vip_plan WHERE id/, first: { id: 3, name: 'Y', duration_days: 0, price_cents: 1900, currency: 'CNY', perks: '{}', enabled: 1, sort: 0 } },
    ]);
    const report = await sweepStaleOrders(core, undefined, 1700000000 + 72 * 3600 + 60);
    expect(report).toMatchObject({ scanned: 1, closed: 0, recovered: 1 });
  });

  it('queryOrder 抛错（通道故障）→ 不关单，保留 pending 待下轮，计入 failed', async () => {
    const broken: PaymentProvider = { ...mockProvider('stripe', {}), queryOrder: async () => { throw new Error('boom'); } };
    registerProvider(broken, { installed: 1, enable: 1 });
    const { core, calls } = makeCore([EXT_STATE({ stripe: { installed: 1, enable: 1 } }), listRule]);
    const report = await sweepStaleOrders(core, undefined, 1700000000 + 72 * 3600 + 60);
    expect(report).toMatchObject({ scanned: 1, closed: 0, recovered: 0, failed: 1 });
    expect(calls.some((c) => /UPDATE bbs_order SET status = \?/.test(c.sql))).toBe(false);
  });

  it('无 queryOrder 能力的通道 → 超期未付直接关单（防御分支）', async () => {
    const noQuery = { ...mockProvider('stripe', {}) } as Partial<PaymentProvider>;
    delete noQuery.queryOrder;
    registerProvider(noQuery as PaymentProvider, { installed: 1, enable: 1 });
    let reads = 0;
    const orderSeq: SqlRule = {
      test: /FROM bbs_order WHERE order_no = \?/,
      first: () => ({ ...STALE_ORDER, created_date: 1, status: reads++ === 0 ? 'pending' : 'closed' }),
    };
    const { core } = makeCore([EXT_STATE({ stripe: { installed: 1, enable: 1 } }), listRule, orderSeq, { test: /UPDATE bbs_order/, rows: [], changes: 1 }]);
    const report = await sweepStaleOrders(core, undefined, 1700000000 + 72 * 3600 + 60);
    expect(report).toMatchObject({ scanned: 1, closed: 1 });
  });
});

describe('issueRefund（后台退款编排）', () => {
  it('通道退款失败 → 不落 refunded', async () => {
    registerProvider(mockProvider('stripe', { refund: { ok: false, reason: '通道拒绝' } }), { installed: 1, enable: 1 });
    const { core, calls } = makeCore([
      { test: /FROM bbs_order WHERE order_no = \?/, first: () => ({ order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: 'paid', provider: 'stripe', provider_ref: 'REF-1', created_date: 1, paid_date: 1, fulfilled_date: 0 }) },
      { test: /SELECT v FROM bbs_kv/, first: null },
    ]);
    const r = await issueRefund(core, undefined, 'FI1', 1);
    expect(r.ok).toBe(false);
    expect(calls.some((c) => /UPDATE bbs_order SET status = \?/.test(c.sql))).toBe(false);
  });

  it('通道退款成功 → 状态机 refunded', async () => {
    registerProvider(mockProvider('stripe', { refund: { ok: true } }), { installed: 1, enable: 1 });
    let reads = 0;
    const { core } = makeCore([
      { test: /FROM bbs_order WHERE order_no = \?/, first: () => ({ order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: reads++ === 0 ? 'paid' : 'refunded', provider: 'stripe', provider_ref: 'REF-1', created_date: 1, paid_date: 1, fulfilled_date: 0 }) },
      { test: /UPDATE bbs_order/, rows: [], changes: 1 },
      { test: /SELECT v FROM bbs_kv/, first: null },
    ]);
    const r = await issueRefund(core, undefined, 'FI1', 1);
    expect(r.ok).toBe(true);
    expect(r.order?.status).toBe('refunded');
  });
});

describe('webhook HTTP 路由（POST /api/payments/webhook/:pluginId）', () => {
  const SETTING = JSON.stringify({ runlevel: 5, sitename: 'S', lang: 'zh-cn' });
  const FORUM1 = { fid: 1, name: 'f', rank: 1, threads: 0, todayposts: 0, todaythreads: 0, brief: '', announcement: '', accesson: 0, orderby: 0, icon: 0, moduids: '', seo_title: '', seo_keywords: '' };
  const GROUP = { gid: 1, name: 'a', creditsfrom: 0, creditsto: 0, allowread: 1, allowthread: 1, allowpost: 1, allowattach: 1, allowdown: 1, allowtop: 1, allowupdate: 1, allowdelete: 1, allowmove: 1, allowbanuser: 1, allowdeleteuser: 1, allowviewip: 1 };
  function envFor(rules: SqlRule[]) {
    const { db } = fakeD1Sql([
      { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: (p: readonly unknown[]) => (p[0] === 'extensions' ? { v: JSON.stringify({ stripe: { installed: 1, enable: 1 } }) } : p[0] === 'setting' ? { v: SETTING } : (String(p[0]).endsWith(':config') ? { v: '{}' } : null)) },
      { test: /SELECT v FROM bbs_cache/, first: null },
      { test: /REPLACE INTO bbs_cache/, rows: [] },
      { test: /DELETE FROM bbs_cache/, rows: [] },
      { test: /FROM bbs_forum ORDER BY/, rows: [FORUM1] },
      { test: /bbs_forum_access/, rows: [] },
      { test: /FROM bbs_group/, rows: [GROUP] },
      ...rules,
    ]);
    return { DB: db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost' };
  }

  it('已装启用通道回调 paid → 200', async () => {
    registerProvider(mockProvider('stripe', { webhook: 'valid' }), { installed: 1, enable: 1 });
    const byRef: SqlRule = { test: /FROM bbs_order WHERE provider_ref = \?/, first: () => ({ order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: 'pending', provider: 'stripe', provider_ref: 'REF-1', created_date: 1, paid_date: 0, fulfilled_date: 0 }) };
    let reads = 0;
    const orderSeq: SqlRule = { test: /FROM bbs_order WHERE order_no = \?/, first: () => ({ order_no: 'FI1', uid: 7, plan_id: 3, amount_cents: 1900, currency: 'CNY', status: ['pending', 'paid', 'paid', 'fulfilled'][Math.min(reads++, 3)], provider: 'stripe', provider_ref: 'REF-1', created_date: 1, paid_date: 0, fulfilled_date: 0 }) };
    const env = envFor([byRef, orderSeq, { test: /FROM bbs_vip_plan WHERE id/, first: { id: 3, name: 'Y', duration_days: 0, price_cents: 1900, currency: 'CNY', perks: '{}', enabled: 1, sort: 0 } }, { test: /UPDATE bbs_order/, rows: [], changes: 1 }]);
    const res = await app.request('/api/payments/webhook/stripe', { method: 'POST', headers: { 'x-ref': 'REF-1', 'x-status': 'paid' } }, env as never);
    const body = (await res.json()) as { code: number; outcome: { action?: string } };
    expect(res.status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.outcome.action).toBe('paid');
  });

  it('未知通道 → 404', async () => {
    const res = await app.request('/api/payments/webhook/ghost', { method: 'POST', headers: { 'x-ref': 'R', 'x-status': 'paid' } }, envFor([]) as never);
    expect(res.status).toBe(404);
  });
});
