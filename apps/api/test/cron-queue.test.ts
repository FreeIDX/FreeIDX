import { describe, it, expect, beforeEach } from 'vitest';
import { D1b } from '../src/core/db';
import { Cache, l0Clear } from '../src/core/cache';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { cronFiveMin, cronDaily, attachGc, ONLINE_HOLD_TIME_DEFAULT } from '../src/core/cron';
import { queueGc } from '../src/core/queue';

const NOW = 1_700_000_000;

function deps(rs: SqlRule[], files?: { delete?: (k: string) => unknown }) {
  const { db, calls } = fakeD1Sql(rs);
  const d1 = D1b.of(db as unknown as D1Database);
  const kv = fakeKv();
  const cache = new Cache({ CACHE: kv, DB: db } as never, d1);
  return { d1, cache, calls, kv, cron: { db: d1, cache, files, now: NOW } };
}

const common: SqlRule[] = [
  { test: /SELECT v FROM bbs_cache/, first: null },
  { test: /REPLACE INTO bbs_cache/, rows: [] },
  { test: /DELETE FROM bbs_cache/, rows: [] },
  { test: /DELETE FROM bbs_email_code WHERE expiry/, rows: [] },
];

describe('cron 每 5 分钟档（§11.1：sess_gc + 在线数刷新）', () => {
  it('清过期 session 并回写 runtime.onlines', async () => {
    const rs: SqlRule[] = [
      { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: JSON.stringify({ online_hold_time: 120 }) } },
      { test: /DELETE FROM bbs_session WHERE last_date <= \?/, rows: [] },
      { test: /SELECT COUNT\(\*\) AS c FROM bbs_session/, first: { c: 4 } },
      ...common,
    ];
    const d = deps(rs);
    const r = await cronFiveMin(d.cron);
    expect(r.sessExpiry).toBe(NOW - 120);
    expect(r.onlines).toBe(4);
    expect(d.calls.find((c) => /DELETE FROM bbs_session/.test(c.sql))?.params[0]).toBe(NOW - 120);
    // runtime 刷新写入缓存（L2 bbs_cache）
    expect(d.calls.some((c) => /REPLACE INTO bbs_cache/.test(c.sql))).toBe(true);
  });

  it('缺省 online_hold_time=300；零 session → onlines 下限 1', async () => {
    const rs: SqlRule[] = [
      { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: '{}' } },
      { test: /DELETE FROM bbs_session WHERE last_date <= \?/, rows: [] },
      { test: /SELECT COUNT\(\*\) AS c FROM bbs_session/, first: { c: 0 } },
      ...common,
    ];
    const d = deps(rs);
    const r = await cronFiveMin(d.cron);
    expect(r.sessExpiry).toBe(NOW - ONLINE_HOLD_TIME_DEFAULT);
    expect(r.onlines).toBe(1);
  });
});

describe('cron 每日凌晨档（§11.1：计数校准 + today 清零 + queue GC）', () => {
  /** 计数校准五条重算语句（含 lastusername 自愈）+ 全站总数查询，cronDaily 每日执行 */
  const calibrateRules: SqlRule[] = [
    { test: /UPDATE bbs_forum SET threads = \(SELECT/, rows: [] },
    { test: /UPDATE bbs_thread SET posts = \(SELECT/, rows: [] },
    { test: /UPDATE bbs_thread SET lastusername = \(SELECT/, rows: [] },
    { test: /UPDATE bbs_user SET/, rows: [] },
    { test: /SELECT \(SELECT COUNT\(\*\) FROM bbs_thread\) AS threads/, first: { threads: 10, posts: 25 } },
  ];

  it('只重算漂移行（WHERE 现值 <> 重算值），再清零今日数并把校准结果写回 runtime', async () => {
    const rs: SqlRule[] = [
      { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: '{}' } },
      ...calibrateRules,
      { test: /UPDATE bbs_forum SET todayposts = 0, todaythreads = 0/, rows: [] },
      { test: /DELETE FROM bbs_queue WHERE expiry > 0/, rows: [] },
      ...common,
    ];
    const d = deps(rs);
    const r = await cronDaily(d.cron);
    expect(r.forumReset).toBe(true);
    expect(r.calibrated).toEqual({ threads: 10, posts: 25 });
    expect(r.driftRows).toBe(0);
    // 四类反规范化列重算，且每条都必须带 `WHERE 现值 <> 重算值`：
    // SQLite 按「被更新行数」计 D1 rows_written（值不变也计），全量重算在 10 万主题的库上
    // 单晚就写掉 10 万+ 行 → 吃光免费层「10 万行写/天」，当天发帖/积分/会话落库全部失败。
    for (const re of [
      /UPDATE bbs_forum SET threads = \(SELECT COUNT\(\*\) FROM bbs_thread WHERE bbs_thread\.fid = bbs_forum\.fid\) WHERE threads <> \(SELECT COUNT\(\*\) FROM bbs_thread WHERE bbs_thread\.fid = bbs_forum\.fid\)/,
      /UPDATE bbs_thread SET posts = \(SELECT COUNT\(\*\) FROM bbs_post WHERE bbs_post\.tid = bbs_thread\.tid AND bbs_post\.isfirst = 0\) WHERE posts <> \(SELECT COUNT\(\*\) FROM bbs_post WHERE bbs_post\.tid = bbs_thread\.tid AND bbs_post\.isfirst = 0\)/,
      /UPDATE bbs_user SET threads = \(SELECT COUNT\(\*\) FROM bbs_thread WHERE bbs_thread\.uid = bbs_user\.uid\) WHERE threads <> \(SELECT COUNT\(\*\) FROM bbs_thread WHERE bbs_thread\.uid = bbs_user\.uid\)/,
      /UPDATE bbs_user SET posts = \(SELECT COUNT\(\*\) FROM bbs_post WHERE bbs_post\.uid = bbs_user\.uid AND bbs_post\.isfirst = 0\) WHERE posts <> \(SELECT COUNT\(\*\) FROM bbs_post WHERE bbs_post\.uid = bbs_user\.uid AND bbs_post\.isfirst = 0\)/,
      // §20.2 lastusername 自愈：与计数校准同口径（正常 0 行写）；lastuid 用户不存在时三值逻辑不命中
      /UPDATE bbs_thread SET lastusername = \(SELECT username FROM bbs_user WHERE uid = bbs_thread\.lastuid\) WHERE lastusername <> \(SELECT username FROM bbs_user WHERE uid = bbs_thread\.lastuid\)/,
    ]) {
      expect(d.calls.some((c) => re.test(c.sql))).toBe(true);
    }
    expect(d.calls.some((c) => /UPDATE bbs_forum SET todayposts = 0/.test(c.sql))).toBe(true);
    // 校准后的全站数与 today 清零一起写回 runtime（L2 bbs_cache）
    const runtimeWrite = d.calls.find((c) => /REPLACE INTO bbs_cache/.test(c.sql));
    expect(runtimeWrite).toBeTruthy();
    expect(String(runtimeWrite?.params[1] ?? runtimeWrite?.params.at(-1))).toContain('"threads":10');
    expect(d.calls.some((c) => /DELETE FROM bbs_queue WHERE expiry > 0/.test(c.sql))).toBe(true);
    // 临时附件 GC 已挪到每小时档（子请求预算约束），每日档不得再触碰 bbs_attach
    expect(d.calls.some((c) => /bbs_attach/.test(c.sql))).toBe(false);
    // email_code 过期行 GC：验证码/重置 token 表此前只增不减，每日档按 expiry 物理清理
    const emailGc = d.calls.find((c) => /DELETE FROM bbs_email_code WHERE expiry > 0 AND expiry < \?/.test(c.sql));
    expect(emailGc?.params[0]).toBe(NOW - 86400);
  });

  it('检出漂移 → driftRows 汇总各语句实际改写行数', async () => {
    const rs: SqlRule[] = [
      { test: /SELECT v FROM bbs_kv WHERE k = \?/, first: { v: '{}' } },
      { test: /UPDATE bbs_forum SET threads = \(SELECT/, rows: [], changes: 1 },
      { test: /UPDATE bbs_thread SET posts = \(SELECT/, rows: [], changes: 3 },
      { test: /UPDATE bbs_thread SET lastusername = \(SELECT/, rows: [], changes: 0 },
      { test: /UPDATE bbs_user SET/, rows: [], changes: 0 },
      { test: /SELECT \(SELECT COUNT\(\*\) FROM bbs_thread\) AS threads/, first: { threads: 10, posts: 25 } },
      { test: /UPDATE bbs_forum SET todayposts = 0, todaythreads = 0/, rows: [] },
      { test: /DELETE FROM bbs_queue WHERE expiry > 0/, rows: [] },
      ...common,
    ];
    const d = deps(rs);
    const r = await cronDaily(d.cron);
    expect(r.driftRows).toBe(4);
  });

  it('子任务错误隔离：校准抛错不阻断 today* 清零 / queue GC / cache GC（本档一天仅触发一次）', async () => {
    const rs: SqlRule[] = [
      { test: /UPDATE bbs_forum SET threads = \(SELECT/, rows: [], throws: 'D1 down' },
      { test: /UPDATE bbs_thread SET posts = \(SELECT/, rows: [] },
      { test: /UPDATE bbs_thread SET lastusername = \(SELECT/, rows: [] },
      { test: /UPDATE bbs_user SET/, rows: [] },
      { test: /SELECT \(SELECT COUNT\(\*\) FROM bbs_thread\) AS threads/, first: { threads: 10, posts: 25 } },
      { test: /UPDATE bbs_forum SET todayposts = 0, todaythreads = 0/, rows: [] },
      { test: /DELETE FROM bbs_queue WHERE expiry > 0/, rows: [] },
      ...common,
    ];
    const d = deps(rs);
    const r = await cronDaily(d.cron);
    expect(r.forumReset).toBe(true);
    expect(r.calibrated).toEqual({ threads: 0, posts: 0 });
    expect(r.driftRows).toBe(0);
    expect(d.calls.some((c) => /UPDATE bbs_forum SET todayposts = 0/.test(c.sql))).toBe(true);
    expect(d.calls.some((c) => /DELETE FROM bbs_queue/.test(c.sql))).toBe(true);
    expect(d.calls.some((c) => /DELETE FROM bbs_cache WHERE expiry > 0 AND expiry <= \?/.test(c.sql))).toBe(true);
    // 校准失败 → runtime 保留现值（不把 0 写回全站数），仅清零 today*
    const runtimeWrite = d.calls.find((c) => /REPLACE INTO bbs_cache/.test(c.sql));
    expect(String(runtimeWrite?.params[1] ?? runtimeWrite?.params.at(-1))).not.toContain('"threads":10');
  });
});

describe('临时附件 GC（每小时档：先删对象再删行，批量对齐子请求预算）', () => {
  const staleRules = (rows: { aid: number; filename: string }[]): SqlRule[] => [
    { test: /SELECT aid,filename FROM bbs_attach WHERE status = 0 AND create_date < \? LIMIT \?/, rows: () => rows },
    { test: /DELETE FROM bbs_attach WHERE aid IN/, rows: [] },
  ];

  it('先删 R2 对象、再删 D1 行；返回实际删除条数', async () => {
    const deleted: string[] = [];
    const files = { delete: (k: string) => void deleted.push(k) };
    const rows = [1, 2, 3].map((i) => ({ aid: i, filename: `tmp/${i}.png` }));
    const d = deps([...staleRules(rows), ...common], files);
    const n = await attachGc(d.cron, NOW);
    expect(n).toBe(3);
    // 每个对象都被尝试删除（时间窗与批量生效）
    expect(deleted).toEqual(['tmp/1.png', 'tmp/2.png', 'tmp/3.png']);
    const del = d.calls.find((c) => /DELETE FROM bbs_attach WHERE aid IN/.test(c.sql));
    expect(del?.params).toEqual([1, 2, 3]);
    expect(d.calls.find((c) => /FROM bbs_attach WHERE status = 0/.test(c.sql))?.params[1]).toBe(40);
  });

  it('对象删除失败 → 保留该行 D1 元数据（下轮重试），不产生 R2 孤儿', async () => {
    const files = {
      delete: (k: string) => {
        if (k.endsWith('2.png')) throw new Error('r2 unavailable');
      },
    };
    const rows = [1, 2, 3].map((i) => ({ aid: i, filename: `tmp/${i}.png` }));
    const d = deps([...staleRules(rows), ...common], files);
    const n = await attachGc(d.cron, NOW);
    expect(n).toBe(2);
    const del = d.calls.find((c) => /DELETE FROM bbs_attach WHERE aid IN/.test(c.sql));
    expect(del?.params).toEqual([1, 3]); // 失败行 aid=2 不在删除列表
  });

  it('无过期附件 → 不发任何 R2/D1 操作', async () => {
    let r2Calls = 0;
    const files = { delete: () => void r2Calls++ };
    const d = deps([...staleRules([]), ...common], files);
    expect(await attachGc(d.cron, NOW)).toBe(0);
    expect(r2Calls).toBe(0);
    expect(d.calls.some((c) => /DELETE FROM bbs_attach/.test(c.sql))).toBe(false);
  });

  it('未绑定 R2（无 files）时仍清理 D1 元数据行', async () => {
    const rows = [{ aid: 9, filename: 'tmp/9.png' }];
    const d = deps([...staleRules(rows), ...common]);
    expect(await attachGc(d.cron, NOW)).toBe(1);
    expect(d.calls.find((c) => /DELETE FROM bbs_attach WHERE aid IN/.test(c.sql))?.params).toEqual([9]);
  });
});

describe('cron 每日凌晨档 queue GC 直测（§11.2：仅保留过期清理）', () => {
  it('gc→删过期', async () => {
    const rs: SqlRule[] = [{ test: /DELETE FROM bbs_queue WHERE expiry > 0/, rows: [] }];
    const d = deps(rs);
    await queueGc(d.d1, NOW);
    expect(d.calls.some((c) => /DELETE FROM bbs_queue WHERE expiry > 0 AND expiry < \?/.test(c.sql))).toBe(true);
  });
});

beforeEach(() => l0Clear());
