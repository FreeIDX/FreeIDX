/**
 * T5-1 积分账本单测：
 *  - applyPointChange：余额相对更新 + 流水同批、biz_key 幂等冲突回滚跳过
 *  - grantForPost：后台可配数值驱动发放、未配置零查询跳过、每日首帖幂等键
 *  - GET /api/me/points：余额 + 分页流水（需登录）
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/index';
import { Cache, l0Clear } from '../src/core/cache';
import { D1b } from '../src/core/db';
import { applyPointChange, dayNo, grantForPost, postCreditGate, type PointChange } from '../src/core/points';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';

const now = () => Math.floor(Date.now() / 1000);

function makeCore(rules: SqlRule[]) {
  const { db, calls } = fakeD1Sql(rules);
  const d1b = new D1b(db as never);
  const cache = new Cache({ DB: db, CACHE: fakeKv(), SITE_URL: '' } as never, d1b);
  return { core: { db: d1b, cache }, calls };
}

const UPDATE_CREDITS: SqlRule = { test: /UPDATE bbs_user SET credits = credits \+ \? WHERE uid/, rows: [] };
const UPDATE_BALANCE: SqlRule = { test: /UPDATE bbs_user SET (credits|golds|rmbs) = (credits|golds|rmbs) \+ \?/, rows: [] };
const INSERT_LOG: SqlRule = { test: /INSERT INTO bbs_point_log/, rows: [] };
/** 每日加分上限统计（grantForPost 正向发放前） */
const COUNT_POSTS: SqlRule = { test: /SELECT COUNT\(\*\) AS c FROM bbs_post WHERE uid/, first: { c: 1 } };

beforeEach(() => l0Clear());

describe('applyPointChange（余额+流水同批事务）', () => {
  it('相对更新 credits + ?，流水 balance 取更新后值，同批提交', async () => {
    const { core, calls } = makeCore([UPDATE_CREDITS, INSERT_LOG]);
    const p: PointChange = { uid: 7, change: 5, reason: 'thread', bizKey: 'post:100', ts: 1700000000 };
    const granted = await applyPointChange(core, p);
    expect(granted).toBe(true);
    const sqls = calls.map((c) => c.sql).join('\n');
    expect(sqls).toMatch(/credits = credits \+ \?/); // 非读改写，防并发丢账
    expect(sqls).toMatch(/SELECT uid, \?, credits, \?, \?, \? FROM bbs_user WHERE uid = \?/); // balance 读更新后 credits
    expect(sqls).toMatch(/INSERT INTO bbs_point_log/);
  });

  it('biz_key 唯一冲突 → 幂等跳过（granted=false），整批由 D1 原子回滚', async () => {
    const throwDup: SqlRule = {
      test: /INSERT INTO bbs_point_log/,
      rows: () => {
        throw new Error('UNIQUE constraint failed: bbs_point_log.uid, bbs_point_log.biz_key');
      },
    };
    const { core } = makeCore([UPDATE_CREDITS, throwDup]);
    const granted = await applyPointChange(core, { uid: 7, change: 5, reason: 'thread', bizKey: 'post:100', ts: 1 });
    expect(granted).toBe(false);
  });

  it('change=0 → 不发起任何查询', async () => {
    const { core, calls } = makeCore([UPDATE_CREDITS, INSERT_LOG]);
    const granted = await applyPointChange(core, { uid: 7, change: 0, reason: 'admin', bizKey: '', ts: 1 });
    expect(granted).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('dayNo：同日同序号，跨日不同', () => {
    expect(dayNo(1700000000)).toBe(dayNo(1700000000 + 3600));
    expect(dayNo(1700000000)).not.toBe(dayNo(1700000000 + 86400));
  });
});

describe('grantForPost（后台可配数值驱动发放）', () => {
  const settingRule = (setting: Record<string, unknown>): SqlRule => ({
    test: /SELECT v FROM bbs_kv WHERE k = \?/,
    first: (params: readonly unknown[]) => (params[0] === 'setting' ? { v: JSON.stringify(setting) } : null),
  });
  /** tt_credits 规则源（插件规则矩阵；未返回时 loadCreditsRules 会镜像 setting 的经验两项） */
  const creditsRule = (rules: Record<string, unknown>): SqlRule => ({
    test: /SELECT v FROM bbs_kv WHERE k = \?/,
    first: (params: readonly unknown[]) => (params[0] === 'tt_credits' ? { v: JSON.stringify(rules) } : null),
  });

  it('发帖发放 thread 分 + 每日首帖分（两条流水，幂等键不同）', async () => {
    const { core, calls } = makeCore([
      settingRule({ credit_thread: 2, credit_reply: 1, credit_daily_first: 5 }),
      COUNT_POSTS,
      UPDATE_CREDITS,
      INSERT_LOG,
    ]);
    await grantForPost(core, { uid: 7, isfirst: 1, pid: 100, ts: 1700000000 });
    const inserts = calls.filter((c) => /INSERT INTO bbs_point_log/.test(c.sql));
    expect(inserts.length).toBe(2);
    const keys = inserts.map((c) => String(c.params[2])); // biz_key 参数位
    expect(keys).toContain('post:100');
    expect(keys).toContain(`daily:7:${dayNo(1700000000)}`);
    const changes = inserts.map((c) => Number(c.params[0]));
    expect(changes.sort((a, b) => a - b)).toEqual([2, 5]);
  });

  it('回帖发放用 credit_reply 数值', async () => {
    const { core, calls } = makeCore([
      settingRule({ credit_thread: 2, credit_reply: 1, credit_daily_first: 0 }),
      COUNT_POSTS,
      UPDATE_CREDITS,
      INSERT_LOG,
    ]);
    await grantForPost(core, { uid: 7, isfirst: 0, pid: 200, ts: 1700000000 });
    const inserts = calls.filter((c) => /INSERT INTO bbs_point_log/.test(c.sql));
    expect(inserts.length).toBe(1);
    expect(Number(inserts[0]!.params[0])).toBe(1);
    expect(String(inserts[0]!.params[2])).toBe('post:200');
  });

  it('未配置积分（全 0）→ 仅读 setting，零发放查询', async () => {
    const { core, calls } = makeCore([settingRule({}), UPDATE_CREDITS, INSERT_LOG]);
    await grantForPost(core, { uid: 7, isfirst: 1, pid: 100, ts: 1 });
    expect(calls.filter((c) => /bbs_point_log|UPDATE bbs_user SET credits/.test(c.sql)).length).toBe(0);
  });

  it('tt_credits 规则：金币/人民币直接入余额，不写 point_log 账本', async () => {
    const { core, calls } = makeCore([
      creditsRule({ thread_gold: 3, thread_rmb: 100 }),
      COUNT_POSTS,
      UPDATE_BALANCE,
      INSERT_LOG,
    ]);
    await grantForPost(core, { uid: 7, isfirst: 1, pid: 100, ts: 1700000000 });
    const gold = calls.filter((c) => /SET golds = golds \+ \?/.test(c.sql));
    const rmb = calls.filter((c) => /SET rmbs = rmbs \+ \?/.test(c.sql));
    expect(gold.length).toBe(1);
    expect(Number(gold[0]!.params[0])).toBe(3);
    expect(rmb.length).toBe(1);
    expect(Number(rmb[0]!.params[0])).toBe(100);
    expect(calls.filter((c) => /bbs_point_log/.test(c.sql)).length).toBe(0);
  });

  it('每日加分上限：当日同类帖数超 limit → 正向规则全部停发', async () => {
    const { core, calls } = makeCore([
      creditsRule({ thread_exp: 2, thread_gold: 1, limit: 3 }),
      { test: /SELECT COUNT\(\*\) AS c FROM bbs_post WHERE uid/, first: { c: 4 } },
      UPDATE_BALANCE,
      INSERT_LOG,
    ]);
    await grantForPost(core, { uid: 7, isfirst: 1, pid: 100, ts: 1700000000 });
    expect(calls.filter((c) => /bbs_point_log|SET (credits|golds|rmbs) =/.test(c.sql)).length).toBe(0);
  });

  it('负向规则（发帖扣分）余额不足 → 闸门返回提示文案；余额足够放行', async () => {
    const rules: SqlRule[] = [
      creditsRule({ thread_exp: -5 }),
      { test: /SELECT credits,golds,rmbs FROM bbs_user WHERE uid = \?/, first: { credits: 3, golds: 0, rmbs: 0 } },
    ];
    const { core } = makeCore(rules);
    expect(await postCreditGate(core, 7, 1)).toBe('您的积分不足，无法执行此操作!');

    l0Clear();
    const { core: core2 } = makeCore([
      creditsRule({ thread_exp: -5 }),
      { test: /SELECT credits,golds,rmbs FROM bbs_user WHERE uid = \?/, first: { credits: 10, golds: 0, rmbs: 0 } },
    ]);
    expect(await postCreditGate(core2, 7, 1)).toBeNull();
  });
});

describe('GET /api/me/points（余额 + 分页流水）', () => {
  const SETTING = JSON.stringify({ runlevel: 5, sitename: 'S' });
  function rules(): SqlRule[] {
    return [
      { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: (p: readonly unknown[]) => (p[0] === 'setting' ? { v: SETTING } : null) },
      { test: /FROM bbs_session WHERE sid/, first: { uid: 1, last_date: now() } },
      { test: /SELECT v FROM bbs_cache/, first: null },
      { test: /REPLACE INTO bbs_cache/, rows: [] },
      { test: /token_version FROM bbs_user WHERE uid = \?/, first: { uid: 1, gid: 1, username: 'admin', token_version: 0 } },
      { test: /SELECT credits FROM bbs_user WHERE uid = \?/, first: { credits: 42 } },
      { test: /SELECT COUNT\(\*\) AS c FROM bbs_point_log/, first: { c: 25 } },
      {
        test: /SELECT id,change,balance,reason,biz_key,create_date FROM bbs_point_log/,
        rows: [
          { id: 3, change: 5, balance: 42, reason: 'daily_first', biz_key: 'daily:1:19000', create_date: 1700000000 },
          { id: 2, change: 2, balance: 37, reason: 'thread', biz_key: 'post:100', create_date: 1699999000 },
        ],
      },
    ];
  }
  function envOf() {
    const { db } = fakeD1Sql(rules());
    return { DB: db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost' };
  }

  it('登录：返回余额、总数与分页元数据', async () => {
    const res = await app.request('/api/me/points?page=2&size=20', { headers: { cookie: 'sid=sessA' } }, envOf() as never);
    const body = (await res.json()) as { code: number; data: Record<string, unknown> };
    expect(body.code).toBe(0);
    const d = body.data as {
      credits: number; total: number; page: number; size: number; total_page: number;
      list: { id: number; change: number; balance: number; reason: string }[];
    };
    expect(d.credits).toBe(42);
    expect(d.total).toBe(25);
    expect(d.page).toBe(2);
    expect(d.total_page).toBe(2);
    expect(d.list.length).toBe(2);
    expect(d.list[0]!.reason).toBe('daily_first');
  });

  it('未登录 → NOT_LOGIN(-1)', async () => {
    const res = await app.request('/api/me/points', {}, envOf() as never);
    const body = (await res.json()) as { code: number };
    expect(body.code).toBe(-1);
  });

  it('size 上限钳制为 100', async () => {
    const { db, calls } = fakeD1Sql(rules());
    const res = await app.request(
      '/api/me/points?size=9999',
      { headers: { cookie: 'sid=sessA' } },
      { DB: db, CACHE: fakeKv(), FILES: {}, SITE_URL: 'http://localhost' } as never,
    );
    await res.json();
    const listCall = calls.find((c) => /FROM bbs_point_log WHERE uid = \? ORDER BY id DESC LIMIT/.test(c.sql));
    expect(Number(listCall?.params[1])).toBe(100);
  });
});
