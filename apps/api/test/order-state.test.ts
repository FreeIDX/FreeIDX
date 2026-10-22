/**
 * T5-3 订单状态机单测（§15.1/§15.3，DoD：状态迁移单测全覆盖）：
 *  - canTransit：所有 (from,to) 组合的合法/非法判定
 *  - createOrder / markPaid（幂等 + provider_ref 唯一冲突）/ fulfillOrder（续期 + perks.credits）
 *    / refundOrder / closeOrder；非法迁移抛 VALIDATION_ERROR
 *  - 契约端点：GET /api/vip/plans、POST /api/orders、GET /api/orders/:no（本人校验）
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { Code, OrderStatus, type OrderStatusValue } from '@freeidx/shared';
import { Cache, l0Clear } from '../src/core/cache';
import { D1b } from '../src/core/db';
import {
  canTransit,
  closeOrder,
  createOrder,
  demoteExpiredVip,
  fulfillOrder,
  markPaid,
  newOrderNo,
  perksCredits,
  refundOrder,
  type VipPlanRow,
} from '../src/core/order';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';

const ALL: OrderStatusValue[] = ['pending', 'paid', 'fulfilled', 'refunded', 'closed'];
const LEGAL: Record<OrderStatusValue, OrderStatusValue[]> = {
  pending: ['paid', 'closed'],
  paid: ['fulfilled', 'refunded'],
  fulfilled: ['refunded'],
  refunded: [],
  closed: [],
};

function makeCore(rules: SqlRule[]) {
  const { db, calls } = fakeD1Sql(rules);
  const d1b = new D1b(db as never);
  const cache = new Cache({ DB: db, CACHE: fakeKv(), SITE_URL: '' } as never, d1b);
  return { core: { db: d1b, cache }, calls };
}

function orderRow(status: OrderStatusValue, over: Partial<Record<string, number | string>> = {}) {
  return {
    order_no: 'FI-TEST',
    uid: 7,
    plan_id: 3,
    amount_cents: 1900,
    currency: 'CNY',
    status,
    provider: 'card',
    provider_ref: '',
    created_date: 1700000000,
    paid_date: 0,
    fulfilled_date: 0,
    ...over,
  };
}

const GET_ORDER = (status: OrderStatusValue): SqlRule => ({
  test: /FROM bbs_order WHERE order_no = \?/,
  first: () => orderRow(status),
});

const PLAN: VipPlanRow = {
  id: 3,
  name: 'Year',
  duration_days: 365,
  price_cents: 1900,
  currency: 'CNY',
  perks: JSON.stringify({ credits: 50 }),
  enabled: 1,
  sort: 0,
  gid: 0,
};

const UPDATE_ORDER = { test: /UPDATE bbs_order SET/, rows: [], changes: 1 } as SqlRule;
const INSERT_ORDER = { test: /INSERT INTO bbs_order/, rows: [] } as SqlRule;
const FIND_PLAN = { test: /FROM bbs_vip_plan WHERE id = \?/, first: PLAN } as SqlRule;
const UPDATE_VIP = { test: /UPDATE bbs_user SET vip_expire_at/, rows: [] } as SqlRule;
const UPDATE_CREDITS = { test: /UPDATE bbs_user SET credits = credits \+ \?/, rows: [] } as SqlRule;
const UPDATE_GID_BACK = { test: /UPDATE bbs_user SET gid = vip_from_gid/, rows: [] } as SqlRule;
const INSERT_LOG = { test: /INSERT INTO bbs_point_log/, rows: [] } as SqlRule;
/** 履约后 user:{uid} 缓存失效（core/order.fulfillOrder 的 cache.del） */
const DELETE_CACHE = { test: /DELETE FROM bbs_cache WHERE k = \?/, rows: [] } as SqlRule;

beforeEach(() => l0Clear());

describe('canTransit（纯状态机，全组合覆盖）', () => {
  it('仅 ORDER_TRANSITIONS 声明的迁移合法', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect(canTransit(from, to)).toBe(LEGAL[from].includes(to));
      }
    }
  });
});

describe('newOrderNo / perksCredits', () => {
  it('FI 前缀 + 大写 + 每次随机不同', () => {
    const a = newOrderNo(1700000000000);
    const b = newOrderNo(1700000000000);
    expect(a).toMatch(/^FI[0-9A-Z]+$/);
    expect(a).not.toBe(b);
  });
  it('perksCredits：合法取正整数、非法/缺失回落 0', () => {
    expect(perksCredits('{"credits":50}')).toBe(50);
    expect(perksCredits('{"credits":-3}')).toBe(0);
    expect(perksCredits('not-json')).toBe(0);
    expect(perksCredits(undefined)).toBe(0);
  });
});

describe('createOrder', () => {
  it('按 plan 定价落 pending 订单', async () => {
    const { core, calls } = makeCore([INSERT_ORDER]);
    const o = await createOrder(core, { uid: 7, plan: PLAN, provider: 'card', ts: 1700000000 });
    expect(o.status).toBe(OrderStatus.PENDING);
    expect(o.amountCents).toBe(1900);
    expect(o.currency).toBe('CNY');
    expect(o.providerRef).toBe('');
    const insert = calls.find((c) => /INSERT INTO bbs_order/.test(c.sql));
    expect(insert?.params).toContain(OrderStatus.PENDING);
    expect(Number(insert?.params[2])).toBe(3);
    expect(Number(insert?.params[3])).toBe(1900);
  });
});

describe('markPaid', () => {
  it('pending→paid：写入 provider_ref 与 paid_date', async () => {
    const { core, calls } = makeCore([GET_ORDER(OrderStatus.PENDING), UPDATE_ORDER]);
    const o = await markPaid(core.db, 'FI-TEST', 'PAY-1', 1700000100);
    expect(o.uid).toBe(7);
    const upd = calls.find((c) => /UPDATE bbs_order SET status/.test(c.sql));
    expect(upd?.params).toContain(OrderStatus.PAID);
    expect(upd?.params).toContain('PAY-1');
  });

  it('非 pending 态 → 幂等直接返回，不更新', async () => {
    const { core, calls } = makeCore([GET_ORDER(OrderStatus.PAID), UPDATE_ORDER]);
    const o = await markPaid(core.db, 'FI-TEST', 'PAY-1', 1);
    expect(o.status).toBe(OrderStatus.PAID);
    expect(calls.some((c) => /UPDATE bbs_order/.test(c.sql))).toBe(false);
  });

  it('provider_ref 唯一冲突 → 视为重复回调返回当前订单', async () => {
    const dupUpdate: SqlRule = {
      test: /UPDATE bbs_order SET status/,
      rows: () => {
        throw new Error('UNIQUE constraint failed: bbs_order.provider_ref');
      },
    };
    const { core } = makeCore([GET_ORDER(OrderStatus.PAID), dupUpdate]);
    const o = await markPaid(core.db, 'FI-TEST', 'PAY-dup', 1);
    expect(o.status).toBe(OrderStatus.PAID);
  });
});

describe('fulfillOrder', () => {
  it('paid→fulfilled：续期基于 MAX(vip_expire_at,now)+duration，发放 perks.credits', async () => {
    const { core, calls } = makeCore([
      GET_ORDER(OrderStatus.PAID),
      FIND_PLAN,
      UPDATE_ORDER,
      UPDATE_VIP,
      UPDATE_CREDITS,
      INSERT_LOG,
      DELETE_CACHE,
    ]);
    await fulfillOrder(core, 'FI-TEST', 1700000200);
    const vip = calls.find((c) => /UPDATE bbs_user SET vip_expire_at = MAX\(vip_expire_at, \?\)/.test(c.sql));
    expect(vip).toBeTruthy();
    expect(Number(vip?.params[0])).toBe(1700000200);
    expect(Number(vip?.params[1])).toBe(365 * 86400);
    const log = calls.find((c) => /INSERT INTO bbs_point_log/.test(c.sql));
    expect(log).toBeTruthy();
    // applyPointChange 的 bizKey 参数位（INSERT-SELECT: change,reason,biz_key,ts,uid）
    expect(log?.params).toContain('order:FI-TEST');
  });

  it('已 fulfilled → 幂等，不续期不发放', async () => {
    const { core, calls } = makeCore([GET_ORDER(OrderStatus.FULFILLED)]);
    const o = await fulfillOrder(core, 'FI-TEST', 1);
    expect(o.status).toBe(OrderStatus.FULFILLED);
    expect(calls.some((c) => /bbs_user/.test(c.sql))).toBe(false);
  });

  it('并发/重复 paid 事件：状态翻转未命中(changes=0) → 不二次延长 VIP', async () => {
    const { core, calls } = makeCore([
      GET_ORDER(OrderStatus.PAID),
      FIND_PLAN,
      { test: /UPDATE bbs_order SET/, rows: [], changes: 0 } as SqlRule,
    ]);
    await fulfillOrder(core, 'FI-TEST', 1700000200);
    expect(calls.some((c) => /UPDATE bbs_user SET vip_expire_at/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /INSERT INTO bbs_point_log/.test(c.sql))).toBe(false);
  });

  it('pending 直接履约 → 非法迁移抛 VALIDATION_ERROR', async () => {
    const { core } = makeCore([GET_ORDER(OrderStatus.PENDING), FIND_PLAN, UPDATE_ORDER, UPDATE_CREDITS, INSERT_LOG]);
    await expect(fulfillOrder(core, 'FI-TEST', 1)).rejects.toMatchObject({ code: Code.VALIDATION_ERROR });
  });
});

describe('会员挂组/到期回落（0004/0005：会员体系与用户组合一）', () => {
  it('计划关联组(gid=106)：履约挂组，首次记 vip_from_gid，管理组守卫 bind LEVEL_GROUP_MIN', async () => {
    const PLAN_VIP: VipPlanRow = { ...PLAN, gid: 106 };
    const { core, calls } = makeCore([
      GET_ORDER(OrderStatus.PAID),
      { test: /FROM bbs_vip_plan WHERE id = \?/, first: PLAN_VIP } as SqlRule,
      UPDATE_ORDER,
      UPDATE_VIP,
      { test: /UPDATE bbs_user SET gid = \?, vip_from_gid = CASE/, rows: [], changes: 1 } as SqlRule,
      UPDATE_CREDITS,
      INSERT_LOG,
      DELETE_CACHE,
    ]);
    await fulfillOrder(core, 'FI-TEST', 1700000200);
    const mount = calls.find((c) => /UPDATE bbs_user SET gid = \?, vip_from_gid = CASE/.test(c.sql));
    expect(mount).toBeTruthy();
    expect(Number(mount?.params[0])).toBe(106);
    expect(Number(mount?.params[2])).toBe(100);
  });

  it('demoteExpiredVip：过期挂组降回 vip_from_gid 并清标记', async () => {
    const { core, calls } = makeCore([
      { test: /SELECT uid, vip_from_gid FROM bbs_user/, rows: [{ uid: 9, vip_from_gid: 101 }] } as SqlRule,
      { test: /UPDATE bbs_user SET gid = \?, vip_from_gid = 0/, rows: [], changes: 1 } as SqlRule,
    ]);
    const rows = await demoteExpiredVip(core.db, 1700000200);
    expect(rows).toEqual([{ uid: 9, fromGid: 101 }]);
    const upd = calls.find((c) => /UPDATE bbs_user SET gid = \?, vip_from_gid = 0/.test(c.sql));
    // UPDATE 复查 SELECT 全部条件（TOCTOU 防护）：fromGid, uid, ts, LEVEL_GROUP_MIN
    expect(upd?.params).toEqual([101, 9, 1700000200, 100]);
  });

  it('demoteExpiredVip：无到期候选 → 空数组不写库', async () => {
    const { core, calls } = makeCore([{ test: /SELECT uid, vip_from_gid FROM bbs_user/, rows: [] }]);
    expect(await demoteExpiredVip(core.db, 1700000200)).toEqual([]);
    expect(calls.some((c) => /UPDATE bbs_user/.test(c.sql))).toBe(false);
  });
});

describe('refundOrder / closeOrder', () => {
  it('refund：paid→refunded 并回收积分/时长', async () => {
    const { core, calls } = makeCore([
      GET_ORDER(OrderStatus.PAID),
      UPDATE_ORDER,
      FIND_PLAN,
      UPDATE_VIP,
      INSERT_LOG,
      UPDATE_CREDITS,
      UPDATE_GID_BACK,
    ]);
    const o = await refundOrder(core.db, 'FI-TEST', 1);
    expect(o.uid).toBe(7);
    expect(calls.some((c) => /vip_expire_at = MAX\(0, vip_expire_at - \?\)/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /INSERT INTO bbs_point_log/.test(c.sql))).toBe(true);
  });
  it('refund：fulfilled→refunded 合法', async () => {
    const { core } = makeCore([
      GET_ORDER(OrderStatus.FULFILLED),
      UPDATE_ORDER,
      FIND_PLAN,
      UPDATE_VIP,
      INSERT_LOG,
      UPDATE_CREDITS,
      UPDATE_GID_BACK,
    ]);
    await refundOrder(core.db, 'FI-TEST', 1);
  });
  it('refund：pending→refunded 非法', async () => {
    const { core } = makeCore([GET_ORDER(OrderStatus.PENDING)]);
    await expect(refundOrder(core.db, 'FI-TEST', 1)).rejects.toMatchObject({ code: Code.VALIDATION_ERROR });
  });
  it('close：pending→closed', async () => {
    const { core } = makeCore([GET_ORDER(OrderStatus.PENDING), UPDATE_ORDER]);
    await closeOrder(core.db, 'FI-TEST');
  });
  it('close：paid→closed 非法', async () => {
    const { core } = makeCore([GET_ORDER(OrderStatus.PAID)]);
    await expect(closeOrder(core.db, 'FI-TEST')).rejects.toMatchObject({ code: Code.VALIDATION_ERROR });
  });
});

// —— 契约端点集成 ——
const SETTING = JSON.stringify({ runlevel: 5, sitename: 'S', lang: 'zh-cn' });
const GROUP_ADMIN = {
  gid: 1, name: '管理员', creditsfrom: 0, creditsto: 0,
  allowread: 1, allowthread: 1, allowpost: 1, allowattach: 1, allowdown: 1,
  allowtop: 1, allowupdate: 1, allowdelete: 1, allowmove: 1, allowbanuser: 1, allowdeleteuser: 1, allowviewip: 1,
};
const FORUM1 = { fid: 1, name: '默认版块', rank: 1, threads: 2, todayposts: 0, todaythreads: 0, brief: '', announcement: '', accesson: 0, orderby: 0, icon: 0, moduids: '', seo_title: '', seo_keywords: '' };

// 全局中间件（runlevel/setting/grouplist/forumlist）+ 会话读取所需的基础规则
function baseRules(): SqlRule[] {
  return [
    { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: SETTING } },
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    { test: /FROM bbs_forum ORDER BY/, rows: [FORUM1] },
    { test: /bbs_forum_access/, rows: [] },
    { test: /FROM bbs_group/, rows: [GROUP_ADMIN] },
    { test: /FROM bbs_session WHERE sid/, first: (p: readonly unknown[]) => (Number(p[0]) === 0 ? null : { uid: 7, last_date: Math.floor(Date.now() / 1000) }) },
    { test: /token_version FROM bbs_user WHERE uid = \?/, first: { uid: 7, gid: 1, username: 'u7', token_version: 0 } },
  ];
}
function envFor(rules: SqlRule[]) {
  const { db } = fakeD1Sql([...baseRules(), ...rules]);
  return { DB: db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost' };
}
function authed(): Record<string, string> {
  const csrf = 'tok123';
  return { 'content-type': 'application/json', cookie: `sid=sessA; csrf=${csrf}`, 'x-csrf-token': csrf };
}

describe('GET /api/vip/plans（公开）', () => {
  it('返回已启用计划，perks 解析为对象', async () => {
    const listRule: SqlRule = { test: /FROM bbs_vip_plan WHERE enabled = 1/, rows: [PLAN] };
    const res = await app.request('/api/vip/plans', {}, envFor([listRule]) as never);
    const body = (await res.json()) as { code: number; data: { list: Record<string, unknown>[] } };
    expect(body.code).toBe(0);
    expect(body.data.list[0]).toMatchObject({ id: 3, price_cents: 1900, perks: { credits: 50 } });
  });
});

describe('POST /api/orders（登录下单）', () => {
  it('启用计划 → 落 pending 订单', async () => {
    const res = await app.request(
      '/api/orders',
      { method: 'POST', headers: authed(), body: JSON.stringify({ planId: 3, provider: 'card' }) },
      envFor([FIND_PLAN, INSERT_ORDER]) as never,
    );
    const body = (await res.json()) as { code: number; data: { status: string; provider: string } };
    expect(body.code).toBe(0);
    expect(body.data.status).toBe(OrderStatus.PENDING);
    expect(body.data.provider).toBe('card');
  });

  it('未登录 → NOT_LOGIN(-1)', async () => {
    const csrf = 'tok123';
    const res = await app.request(
      '/api/orders',
      { method: 'POST', headers: { 'content-type': 'application/json', cookie: `csrf=${csrf}`, 'x-csrf-token': csrf }, body: JSON.stringify({ planId: 3 }) },
      envFor([]) as never,
    );
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(-1);
  });

  it('计划不存在/下架 → NOT_FOUND(-4)', async () => {
    const disabled: SqlRule = { test: /FROM bbs_vip_plan WHERE id = \?/, first: { ...PLAN, enabled: 0 } };
    const res = await app.request(
      '/api/orders',
      { method: 'POST', headers: authed(), body: JSON.stringify({ planId: 3 }) },
      envFor([disabled]) as never,
    );
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(-4);
  });
});

describe('GET /api/orders/:no（本人查单）', () => {
  it('本人订单 → 返回状态与时间戳', async () => {
    const res = await app.request(
      '/api/orders/FI-TEST',
      { headers: { cookie: 'sid=sessA' } },
      envFor([GET_ORDER(OrderStatus.PENDING)]) as never,
    );
    const body = (await res.json()) as { code: number; data: { order_no: string; status: string } };
    expect(body.code).toBe(0);
    expect(body.data.order_no).toBe('FI-TEST');
    expect(body.data.status).toBe(OrderStatus.PENDING);
  });

  it('非本人订单 → NO_PERMISSION(-3)', async () => {
    const rule: SqlRule = { test: /FROM bbs_order WHERE order_no = \?/, first: () => orderRow(OrderStatus.PENDING, { uid: 999 }) };
    const res = await app.request(
      '/api/orders/FI-TEST',
      { headers: { cookie: 'sid=sessA' } },
      envFor([rule]) as never,
    );
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(-3);
  });
});
