/**
 * T5-6 stripe 通道插件单测（§15.5；DoD：redirect→回调验签→落账 通道侧、未启用收银台自动隐藏）。
 * 全程离线：webhook 用自算 HMAC-SHA256 测试向量验签；REST（checkout/query/refund）以 mock fetch 驱动。
 * 真实密钥/HTTPS 出网属 Cloudflare 账户 + Stripe 账户外部阻塞项，联调在凭证就绪后进行。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PayOrder } from '@freeidx/shared';
import { Cache, l0Clear } from '../src/core/cache';
import { D1b } from '../src/core/db';
import { stripeProvider, registerStripe } from '../src/extensions/stripe';
import { listReadyProviders, providerLifecycle, resetProviders, runCheckout } from '../src/core/payment/registry';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';

const te = new TextEncoder();
const SECRET = 'whsec_test123';
const ORDER: PayOrder = { orderNo: 'FI-STRIPE-1', uid: 7, planId: 3, amountCents: 1999, currency: 'USD', status: 'pending' };

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, te.encode(payload));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CACHE_RULES: SqlRule[] = [
  { test: /FROM bbs_cache/, first: null },
  { test: /REPLACE INTO bbs_cache/, rows: [] },
];
function makeCore(rules: SqlRule[]) {
  const { db } = fakeD1Sql([...CACHE_RULES, ...rules]);
  const d1b = new D1b(db as never);
  const cache = new Cache({ DB: db, CACHE: fakeKv(), SITE_URL: '' } as never, d1b);
  return { core: { db: d1b, cache } };
}
const KV = (extensions: unknown): SqlRule => ({
  test: /SELECT v FROM bbs_kv WHERE k = \?/,
  first: (p: readonly unknown[]) => {
    const k = String(p[0]);
    if (k === 'extensions') return { v: JSON.stringify(extensions) };
    if (k === 'setting') return { v: '{"runlevel":5}' };
    if (k.endsWith(':config')) return { v: JSON.stringify({ secretKey: 'sk_test', webhookSecret: SECRET }) };
    return { v: '{}' };
  },
});

let origFetch: typeof globalThis.fetch;
beforeEach(() => {
  l0Clear();
  resetProviders();
  registerStripe();
  origFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
});

describe('stripe 生命周期门控（未启用收银台隐藏）', () => {
  it('出厂 installed+disabled：不在 ready 列表', async () => {
    const { core } = makeCore([KV({})]);
    expect(await providerLifecycle(core.cache, core.db, 'stripe')).toBe('disabled');
    expect((await listReadyProviders(core.cache, core.db)).map((p) => p.id)).not.toContain('stripe');
  });
  it('后台启用（enable=1）后进入 ready 列表', async () => {
    const { core } = makeCore([KV({ stripe: { installed: 1, enable: 1 } })]);
    expect(await providerLifecycle(core.cache, core.db, 'stripe')).toBe('ready');
    expect((await listReadyProviders(core.cache, core.db)).map((p) => p.id)).toContain('stripe');
  });
});

describe('stripe createCheckout（REST 托管收银台，mock 出网）', () => {
  it('返回 redirect + providerRef=session id', async () => {
    let capturedUrl = '';
    let capturedBody = '';
    globalThis.fetch = (async (u: string, init?: { body?: string }) => {
      capturedUrl = String(u);
      capturedBody = String(init?.body ?? '');
      return { ok: true, json: async () => ({ id: 'cs_test_abc', url: 'https://checkout.stripe.com/cs_test_abc' }) };
    }) as never;
    const { core } = makeCore([KV({ stripe: { installed: 1, enable: 1 } })]);
    const r = await runCheckout(core.cache, core.db, undefined, 'stripe', { ...ORDER });
    expect(r).toMatchObject({ mode: 'redirect', url: 'https://checkout.stripe.com/cs_test_abc', providerRef: 'cs_test_abc' });
    expect(capturedUrl).toBe('https://api.stripe.com/v1/checkout/sessions');
    const decoded = decodeURIComponent(capturedBody);
    expect(decoded).toContain(`client_reference_id=${ORDER.orderNo}`);
    expect(decoded).toContain('[currency]=usd');
    expect(decoded).toContain('[unit_amount]=1999');
  });
});

describe('stripe verifyWebhook（HMAC-SHA256 验签）', () => {
  const eventBody = (id: string) =>
    JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id, client_reference_id: ORDER.orderNo, amount_total: 1999, payment_status: 'paid' } },
    });

  async function signedReq(secret: string | null, body: string, ts = String(Math.floor(Date.now() / 1000))): Promise<Request> {
    const sig = await hmacHex(secret ?? SECRET, `${ts}.${body}`);
    return new Request('https://api.test/cb', { method: 'POST', headers: { 'stripe-signature': `t=${ts},v1=${sig}` }, body });
  }

  it('合法签名 → paid 事件，providerRef=session id', async () => {
    const body = eventBody('cs_test_abc');
    const req = await signedReq(SECRET, body);
    const ev = await stripeProvider.verifyWebhook(req, { webhookSecret: SECRET });
    expect(ev).toMatchObject({ providerRef: 'cs_test_abc', status: 'paid', amountCents: 1999 });
  });

  it('错误密钥签名 → null（拒绝落账）', async () => {
    const body = eventBody('cs_test_abc');
    const req = await signedReq('whsec_wrong', body);
    expect(await stripeProvider.verifyWebhook(req, { webhookSecret: SECRET })).toBeNull();
  });

  it('缺失签名头 → null', async () => {
    const req = new Request('https://api.test/cb', { method: 'POST', body: eventBody('cs') });
    expect(await stripeProvider.verifyWebhook(req, { webhookSecret: SECRET })).toBeNull();
  });

  it('异步支付未到账（completed 且 payment_status=unpaid）→ ignored，不落账', async () => {
    const body = JSON.stringify({
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_async', client_reference_id: ORDER.orderNo, amount_total: 1999, payment_status: 'unpaid' } },
    });
    const req = await signedReq(SECRET, body);
    expect(await stripeProvider.verifyWebhook(req, { webhookSecret: SECRET })).toMatchObject({ status: 'ignored' });
  });

  it('refund 事件类型 → refunded', async () => {
    const body = JSON.stringify({ type: 'charge.refunded', data: { object: { id: 'ch_1' } } });
    const req = await signedReq(SECRET, body);
    expect(await stripeProvider.verifyWebhook(req, { webhookSecret: SECRET })).toMatchObject({ status: 'refunded' });
  });

  it('过期时间戳 → null（重放防护，签名体本身合法也拒绝）', async () => {
    const body = eventBody('cs_test_abc');
    const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
    const req = await signedReq(SECRET, body, staleTs);
    expect(await stripeProvider.verifyWebhook(req, { webhookSecret: SECRET })).toBeNull();
  });

  it('未知事件类型 → null（忽略，绝不回落 failed 误关已付订单）', async () => {
    const body = JSON.stringify({ type: 'customer.created', data: { object: { id: 'cs_test_abc' } } });
    const req = await signedReq(SECRET, body);
    expect(await stripeProvider.verifyWebhook(req, { webhookSecret: SECRET })).toBeNull();
  });

  it('charge.dispute.closed → null（争议关闭 ≠ 支付失败，绝不误关已履约单）', async () => {
    const body = JSON.stringify({ type: 'charge.dispute.closed', data: { object: { id: 'ch_1' } } });
    const req = await signedReq(SECRET, body);
    expect(await stripeProvider.verifyWebhook(req, { webhookSecret: SECRET })).toBeNull();
  });
});

describe('stripe queryOrder / refund（对账与退款编排的通道侧）', () => {
  it('queryOrder：payment_status=paid → paid', async () => {
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ payment_status: 'paid' }) })) as never;
    expect(await stripeProvider.queryOrder!('cs_test_abc', { secretKey: 'sk_test' })).toBe('paid');
  });
  it('queryOrder：非 2xx（限流/错误）→ pending，绝不判死', async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as never;
    expect(await stripeProvider.queryOrder!('cs_test_abc', { secretKey: 'sk_test' })).toBe('pending');
  });
  it('queryOrder：unpaid/无状态 → pending（未确认已付不关单）', async () => {
    globalThis.fetch = (async () => ({ ok: true, json: async () => ({ payment_status: 'unpaid' }) })) as never;
    expect(await stripeProvider.queryOrder!('cs_test_abc', { secretKey: 'sk_test' })).toBe('pending');
  });
  it('refund：解析会话 payment_intent 后退款，绝不用内部订单号', async () => {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = (async (u: string, init?: { body?: string }) => {
      calls.push({ url: String(u), body: String(init?.body ?? '') });
      if (String(u).includes('/v1/checkout/sessions/')) {
        return { ok: true, json: async () => ({ payment_intent: 'pi_999' }) };
      }
      return { ok: true, json: async () => ({ id: 're_1' }) };
    }) as never;
    const withRef = { ...ORDER, providerRef: 'cs_test_abc' } as PayOrder & { providerRef: string };
    expect(await stripeProvider.refund!(withRef, { secretKey: 'sk_test' })).toEqual({ ok: true });
    expect(calls[0]!.url).toContain('/v1/checkout/sessions/cs_test_abc');
    expect(calls[1]!.url).toContain('/v1/refunds');
    expect(decodeURIComponent(calls[1]!.body)).toContain('payment_intent=pi_999');
    expect(calls[1]!.body).not.toContain(ORDER.orderNo);
  });
  it('refund：缺少 provider_ref → 拒绝且不出网（绝不拿 FI 订单号冒充）', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return { ok: true, json: async () => ({}) };
    }) as never;
    expect(await stripeProvider.refund!(ORDER, { secretKey: 'sk_test' })).toMatchObject({ ok: false });
    expect(called).toBe(false);
  });
});
