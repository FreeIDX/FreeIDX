/** 3F：credits 模块三个资金写路径的路由级测试（exchange / transfer / payThread，此前零路由覆盖） */
import { describe, it, expect, beforeEach } from 'vitest';
import { app } from '../src/index';
import { Code } from '@freeidx/shared';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { l0Clear } from '../src/core/cache';

const now = () => Math.floor(Date.now() / 1000);
const SETTING = JSON.stringify({ runlevel: 5, lang: 'zh-cn' });
const RULES = JSON.stringify({ exchange_n: 100, exchange_c: 100, min: 1000, convert_exchange: 0 });

const BUYER = { uid: 2, gid: 1, username: 'buyer', avatar: 0, password: 'x', salt: '', token_version: 0, email: 'b@x.c', threads: 0, posts: 0, credits: 1000, golds: 500, rmbs: 20000 };
const GROUP_ADMIN = { gid: 1, name: '管理员', creditsfrom: 0, creditsto: 0, allowread: 1, allowthread: 1, allowpost: 1, allowattach: 1, allowdown: 1 };

/**
 * 规则顺序约定：资金写语句（INSERT/UPDATE）必须排在宽 SELECT 规则之前——
 * payThread/transfer 的锚行 INSERT 含 `FROM bbs_user WHERE uid = ?` 子句，
 * 会被 viewer 宽正则截胡（meta.changes 丢失 → 误判余额不足）。SELECT 类一律 ^ 锚定语句开头。
 */
function rules(over: Record<string, Partial<SqlRule>> = {}): SqlRule[] {
  const base: SqlRule[] = [
    // —— 资金写语句（锚行 changes 可覆盖为 0 模拟余额不足/未成交）——
    { test: /INSERT INTO bbs_paylist/, rows: [], changes: 1 },
    { test: /INSERT INTO bbs_user_pay/, rows: [], changes: 1 },
    { test: /INSERT INTO bbs_point_log/, rows: [], changes: 1 },
    { test: /UPDATE bbs_user SET/, rows: [], changes: 1 },
    // —— 精确 SELECT（^ 锚定，先于 viewer 宽规则）——
    { test: /^SELECT v FROM bbs_kv WHERE k = \?/, first: (p: readonly unknown[]) => ({ v: String(p[0]) === 'tt_credits' ? RULES : SETTING }) },
    { test: /^SELECT gid,credits FROM bbs_user WHERE uid = \?/, first: { gid: 1, credits: BUYER.credits } },
    { test: /^SELECT golds,rmbs FROM bbs_user WHERE uid = \?/, first: { golds: BUYER.golds, rmbs: BUYER.rmbs } },
    { test: /^SELECT (credits|golds|rmbs) AS balance FROM bbs_user WHERE uid = \?/, first: { balance: BUYER.credits } },
    { test: /^SELECT uid FROM bbs_user WHERE username = \?/, first: (p: readonly unknown[]) => (String(p[0]) === 'nobody' ? null : { uid: 3 }) },
    { test: /^SELECT plid FROM bbs_paylist WHERE tid = \? AND uid = \? AND type = 1/, first: null },
    { test: /^SELECT time FROM bbs_user_pay WHERE uid = \? AND type = 6 ORDER BY time DESC LIMIT 1/, first: null },
    // —— 读路径（②b）：面板 / 流水 / 已购 ——
    { test: /^SELECT COUNT\(\*\) AS c FROM bbs_user_pay WHERE uid = \?/, first: { c: 1 } },
    {
      test: /SELECT cid,status,num,type,credit_type,code,time FROM bbs_user_pay WHERE uid = \? ORDER BY/,
      rows: [{ cid: 9, status: 1, num: 1050, type: 6, credit_type: 3, code: '', time: 1700000000 }],
    },
    { test: /SELECT COUNT\(\*\) AS c FROM bbs_paylist p JOIN bbs_thread t ON t\.tid = p\.tid WHERE p\.uid = \? AND p\.type = 1/, first: { c: 1 } },
    { test: /FROM bbs_paylist p JOIN bbs_thread t ON t\.tid = p\.tid[\s\S]*ORDER BY p\.paytime DESC/, rows: () => [{ tid: 9, fid: 1, uid: 7, subject: '付费主题', posts: 0, top: 0, closed: 0, digest: 0, create_date: 1700000000, last_date: 1700000000, views: 1, username: 'seller', lastusername: 'seller', avatar: 0, lastpid: 1, ok: 1 }] },
    // —— viewer / 装配 ——
    { test: /FROM bbs_session WHERE sid/, first: (p: readonly unknown[]) => ({ uid: Number(p[0]) === 0 ? 0 : 2, last_date: now() }) },
    { test: /FROM bbs_user WHERE uid = \?/, first: () => BUYER },
    { test: /FROM bbs_group/, rows: [GROUP_ADMIN] },
    { test: /FROM bbs_forum ORDER BY/, rows: [] },
    { test: /bbs_forum_access/, rows: [] },
    // —— 缓存层 ——
    { test: /SELECT v FROM bbs_cache/, first: null },
    { test: /REPLACE INTO bbs_cache/, rows: [] },
    { test: /DELETE FROM bbs_cache/, rows: [] },
    // —— payThread 主题读取（content_buy=500 经验币种）——
    { test: /SELECT tid,uid,subject,content_buy,content_buy_type FROM bbs_thread WHERE tid = \?/, first: { tid: 9, uid: 7, subject: '付费主题', content_buy: 500, content_buy_type: 1 } },
  ];
  if (!Object.keys(over).length) return base;
  return base.map((r) => {
    const patch = over[r.test.source];
    return patch ? ({ ...r, ...patch } as SqlRule) : r;
  });
}

function makeEnv(rs: SqlRule[]) {
  const { db, calls } = fakeD1Sql(rs);
  return { env: { DB: db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost' } as never, calls };
}

const headers = (): HeadersInit => ({ 'content-type': 'application/json', cookie: 'sid=sessB; csrf=tok123', 'x-csrf-token': 'tok123' });
const jsonOf = async (res: Response) => (await res.json()) as { code: number } & Record<string, unknown>;

beforeEach(() => l0Clear());

describe('POST /api/threads/:tid/pay（付费主题购买）', () => {
  it('未登录（session uid=0）→ NOT_LOGIN', async () => {
    const r = makeEnv(rules({ 'FROM bbs_session WHERE sid': { first: () => ({ uid: 0, last_date: now() }) } }));
    const res = await app.request('/api/threads/9/pay', { method: 'POST', headers: headers() }, r.env);
    expect((await jsonOf(res)).code).toBe(Code.NOT_LOGIN);
  });

  it('免费主题（content_buy=0）→ VALIDATION_ERROR 且零写入（不污染购买清单）', async () => {
    const r = makeEnv(rules({ 'SELECT tid,uid,subject,content_buy,content_buy_type FROM bbs_thread WHERE tid = \\?': { first: { tid: 9, uid: 7, subject: '免费主题', content_buy: 0, content_buy_type: 1 } } }));
    const res = await app.request('/api/threads/9/pay', { method: 'POST', headers: headers() }, r.env);
    expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
    expect(r.calls.some((c) => /INSERT INTO bbs_paylist/.test(c.sql))).toBe(false);
    expect(r.calls.some((c) => /INSERT INTO bbs_user_pay/.test(c.sql))).toBe(false);
  });

  it('已购 → OK 幂等返回，不重复扣款', async () => {
    const r = makeEnv(rules({ '^SELECT plid FROM bbs_paylist WHERE tid = \\? AND uid = \\? AND type = 1': { first: { plid: 1 } } }));
    const res = await app.request('/api/threads/9/pay', { method: 'POST', headers: headers() }, r.env);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    expect(r.calls.some((c) => /UPDATE bbs_user SET credits = credits - \?/.test(c.sql))).toBe(false);
  });

  it('余额不足（锚行未落 changes=0）→ FORM_INSUFFICIENT_CREDITS', async () => {
    const r = makeEnv(rules({ 'INSERT INTO bbs_paylist': { rows: [], changes: 0 } }));
    const res = await app.request('/api/threads/9/pay', { method: 'POST', headers: headers() }, r.env);
    expect((await jsonOf(res)).code).toBe(Code.FORM_INSUFFICIENT_CREDITS);
  });

  it('成功（credits 币种）：paylist 锚行 + 双向扣转入账 + point_log 双写 + user_pay type=4', async () => {
    const r = makeEnv(rules());
    const res = await app.request('/api/threads/9/pay', { method: 'POST', headers: headers() }, r.env);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    const sqls = r.calls.map((c) => c.sql).join('\n');
    expect(sqls).toMatch(/INSERT INTO bbs_paylist[\s\S]*WHERE uid = \? AND credits >= \?/);
    expect(sqls).toMatch(/UPDATE bbs_user SET credits = credits - \? WHERE uid = \?/);
    expect(sqls).toMatch(/UPDATE bbs_user SET credits = credits \+ \? WHERE uid = \?/);
    expect(sqls).toMatch(/'thread_purchase'/);
    expect(sqls).toMatch(/'thread_income'/);
    expect(sqls).toMatch(/INSERT INTO bbs_user_pay[\s\S]*SELECT \?,1,\?,4,/);
    expect((body.data as { purchased: boolean }).purchased).toBe(true);
  });
});

describe('POST /api/me/credits/exchange（人民币↔金币兑换）', () => {
  it('10 分钟频控 → RATE_LIMITED（验额前拦截）', async () => {
    const r = makeEnv(rules({ '^SELECT time FROM bbs_user_pay WHERE uid = \\? AND type = 6 ORDER BY time DESC LIMIT 1': { first: { time: now() - 100 } } }));
    const res = await app.request('/api/me/credits/exchange', { method: 'POST', headers: headers(), body: JSON.stringify({ op: 'n', e_rmb: 10 }) }, r.env);
    expect((await jsonOf(res)).code).toBe(Code.RATE_LIMITED);
    expect(r.calls.some((c) => /INSERT INTO bbs_user_pay/.test(c.sql))).toBe(false);
  });

  it('op 非法 → VALIDATION_ERROR', async () => {
    const r = makeEnv(rules());
    const res = await app.request('/api/me/credits/exchange', { method: 'POST', headers: headers(), body: JSON.stringify({ op: 'x' }) }, r.env);
    expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
  });

  it('op=c 未开启 convert_exchange → NO_PERMISSION', async () => {
    const r = makeEnv(rules());
    const res = await app.request('/api/me/credits/exchange', { method: 'POST', headers: headers(), body: JSON.stringify({ op: 'c', e_golds_c: 1000 }) }, r.env);
    expect((await jsonOf(res)).code).toBe(Code.NO_PERMISSION);
  });

  it('op=n 成功：type=6 锚行 + rmbs 扣减 + golds 入账，回传实读余额', async () => {
    const r = makeEnv(rules());
    const res = await app.request('/api/me/credits/exchange', { method: 'POST', headers: headers(), body: JSON.stringify({ op: 'n', e_rmb: 10 }) }, r.env);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    const sqls = r.calls.map((c) => c.sql).join('\n');
    expect(sqls).toMatch(/INSERT INTO bbs_user_pay[\s\S]*SELECT \?,1,\?,6,/);
    expect(sqls).toMatch(/UPDATE bbs_user SET rmbs = rmbs - \?/);
    expect(sqls).toMatch(/UPDATE bbs_user SET golds = golds \+ \?/);
    expect((body.data as { golds: number }).golds).toBe(BUYER.golds);
  });

  it('余额不足 → FORM_INSUFFICIENT_CREDITS', async () => {
    const r = makeEnv(rules({ '^SELECT golds,rmbs FROM bbs_user WHERE uid = \\?': { first: { golds: 0, rmbs: 100 } } }));
    const res = await app.request('/api/me/credits/exchange', { method: 'POST', headers: headers(), body: JSON.stringify({ op: 'n', e_rmb: 10 }) }, r.env);
    expect((await jsonOf(res)).code).toBe(Code.FORM_INSUFFICIENT_CREDITS);
    expect(r.calls.some((c) => /INSERT INTO bbs_user_pay/.test(c.sql))).toBe(false);
  });
});

describe('POST /api/me/credits/transfer（三币种转账）', () => {
  it('未登录（session uid=0）→ NOT_LOGIN', async () => {
    const r = makeEnv(rules({ 'FROM bbs_session WHERE sid': { first: () => ({ uid: 0, last_date: now() }) } }));
    const res = await app.request('/api/me/credits/transfer', { method: 'POST', headers: headers(), body: '{}' }, r.env);
    expect((await jsonOf(res)).code).toBe(Code.NOT_LOGIN);
  });

  it('金额非正 → VALIDATION_ERROR', async () => {
    const r = makeEnv(rules());
    const res = await app.request('/api/me/credits/transfer', { method: 'POST', headers: headers(), body: JSON.stringify({ username: 'seller', num: 0, creditType: 1 }) }, r.env);
    expect((await jsonOf(res)).code).toBe(Code.VALIDATION_ERROR);
  });

  it('收款人不存在 → NOT_FOUND；转给自己 → VALIDATION_ERROR', async () => {
    const r1 = makeEnv(rules());
    const res1 = await app.request('/api/me/credits/transfer', { method: 'POST', headers: headers(), body: JSON.stringify({ username: 'nobody', num: 10, creditType: 1 }) }, r1.env);
    expect((await jsonOf(res1)).code).toBe(Code.NOT_FOUND);

    const r2 = makeEnv(rules({ '^SELECT uid FROM bbs_user WHERE username = \\?': { first: () => ({ uid: 2 }) } }));
    const res2 = await app.request('/api/me/credits/transfer', { method: 'POST', headers: headers(), body: JSON.stringify({ username: 'buyer', num: 10, creditType: 1 }) }, r2.env);
    expect((await jsonOf(res2)).code).toBe(Code.VALIDATION_ERROR);
  });

  it('余额不足 → FORM_INSUFFICIENT_CREDITS（不落任何流水）', async () => {
    const r = makeEnv(rules({ '^SELECT (credits|golds|rmbs) AS balance FROM bbs_user WHERE uid = \\?': { first: { balance: 5 } } }));
    const res = await app.request('/api/me/credits/transfer', { method: 'POST', headers: headers(), body: JSON.stringify({ username: 'seller', num: 100, creditType: 1 }) }, r.env);
    expect((await jsonOf(res)).code).toBe(Code.FORM_INSUFFICIENT_CREDITS);
    expect(r.calls.some((c) => /INSERT INTO bbs_user_pay/.test(c.sql))).toBe(false);
  });

  it('成功（credits 币种）：type=12/13 双流水 + point_log transfer_out/in 双写（铁律：credits 变动必留账本）', async () => {
    const r = makeEnv(rules());
    const res = await app.request('/api/me/credits/transfer', { method: 'POST', headers: headers(), body: JSON.stringify({ username: 'seller', num: 100, creditType: 1 }) }, r.env);
    expect((await jsonOf(res)).code).toBe(Code.OK);
    const sqls = r.calls.map((c) => c.sql).join('\n');
    expect(sqls).toMatch(/INSERT INTO bbs_user_pay[\s\S]*SELECT \?,1,\?,12,/);
    expect(sqls).toMatch(/INSERT INTO bbs_user_pay[\s\S]*SELECT \?,1,\?,13,/);
    expect(sqls).toMatch(/UPDATE bbs_user SET credits = credits - \? WHERE uid = \?/);
    expect(sqls).toMatch(/UPDATE bbs_user SET credits = credits \+ \? WHERE uid = \?/);
    expect(sqls).toMatch(/'transfer_out'/);
    expect(sqls).toMatch(/'transfer_in'/);
  });
});
describe('读路径（②b：myCredits / record / purchased）', () => {
  it('GET /api/me/credits：未登录 → NOT_LOGIN', async () => {
    const r = makeEnv(rules({ 'FROM bbs_session WHERE sid': { first: () => ({ uid: 0, last_date: now() }) } }));
    const res = await app.request('/api/me/credits', { headers: headers() }, r.env);
    expect((await jsonOf(res)).code).toBe(Code.NOT_LOGIN);
  });

  it('GET /api/me/credits：面板返回三币余额 + 兑换参数（trade）', async () => {
    const r = makeEnv(rules());
    const res = await app.request('/api/me/credits', { headers: headers() }, r.env);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    const d = body.data as { uid: number; credits: number; golds: number; rmbs: number; progress: number; trade: { exchangeN: number; min: number } };
    expect(d.uid).toBe(BUYER.uid);
    expect(d.credits).toBe(BUYER.credits);
    expect(d.golds).toBe(BUYER.golds);
    expect(d.rmbs).toBe(BUYER.rmbs);
    expect(d.progress).toBe(100); // gid=1 管理组不参与等级进度
    expect(d.trade.exchangeN).toBe(100); // tt_credits 规则装载
    expect(d.trade.min).toBe(1000);
  });

  it('GET /api/me/credits/record：流水分页 + 人民币分→元折算 + typeName/statusName 落位', async () => {
    const r = makeEnv(rules());
    const res = await app.request('/api/me/credits/record?page=1', { headers: headers() }, r.env);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    const d = body.data as { total: number; totalPage: number; list: { cid: number; num: number; displayNum: number; creditType: number; typeName: string; statusName: string }[] };
    expect(d.total).toBe(1);
    expect(d.totalPage).toBe(1);
    const row = d.list[0]!;
    expect(row.cid).toBe(9);
    expect(row.num).toBe(1050);
    expect(row.displayNum).toBe(10.5); // credit_type=3 人民币：1050 分 → ¥10.5
    expect(row.creditType).toBe(3);
    expect(row.typeName).toBeTruthy();
    expect(row.statusName).toBeTruthy();
  });

  it('GET /api/me/credits/purchased：已购清单走 paylist JOIN thread（type=1 过滤）', async () => {
    const r = makeEnv(rules());
    const res = await app.request('/api/me/credits/purchased?page=1', { headers: headers() }, r.env);
    const body = await jsonOf(res);
    expect(body.code).toBe(Code.OK);
    const d = body.data as { total: number; list: { tid: number; subject: string }[] };
    expect(d.total).toBe(1);
    expect(d.list[0]?.tid).toBe(9);
    expect(d.list[0]?.subject).toBe('付费主题');
    // 列表查询必须带 type=1 过滤（已购语义），不得泄露其他 paylist 类型
    const listCall = r.calls.find((c) => /FROM bbs_paylist p JOIN bbs_thread t ON t\.tid = p\.tid[\s\S]*ORDER BY p\.paytime DESC/.test(c.sql));
    expect(listCall?.sql).toContain('p.type = 1');
  });
});