import { describe, it, expect, beforeEach } from 'vitest';
import { D1b } from '../src/core/db';
import { Cache, l0Clear } from '../src/core/cache';
import { fakeD1Sql, fakeKv, type SqlRule } from './helpers/fake-d1';
import { cronFiveMin, cronDaily, attachGc, ONLINE_HOLD_TIME_DEFAULT } from '../src/core/cron';
import { queueGc } from '../src/core/queue';

const NOW = 1_700_000_000;

function deps(rs: SqlRule[], files?: { delete?: (k: string | string[]) => unknown }) {
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
    // runtime 刷新落 bbs_runtime 表（只覆盖 onlines 键）
    const rt = d.calls.find((c) => /INSERT INTO bbs_runtime/.test(c.sql));
    expect(rt?.params).toEqual(['onlines', 4]);
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
    // 校准后的全站数与 today 清零一起落 bbs_runtime（逐键 UPSERT，不做整对象覆盖）
    const writes = d.calls.filter((c) => /INSERT INTO bbs_runtime/.test(c.sql));
    expect(writes.some((c) => c.params[0] === 'threads' && c.params[1] === 10)).toBe(true);
    expect(writes.some((c) => c.params[0] === 'posts' && c.params[1] === 25)).toBe(true);
    expect(writes.some((c) => c.params[0] === 'todayposts' && c.params[1] === 0)).toBe(true);
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
    // 校准失败 → 不写 threads/posts（不把 0 覆盖全站数），仅清零 today*
    const writes = d.calls.filter((c) => /INSERT INTO bbs_runtime/.test(c.sql));
    expect(writes.some((c) => c.params[0] === 'threads')).toBe(false);
    expect(writes.some((c) => c.params[0] === 'posts')).toBe(false);
    expect(writes.some((c) => c.params[0] === 'todaythreads')).toBe(true);
  });
});

describe('临时附件 GC（每小时档：条件删行成功后才删对象，避免误删已发布附件）', () => {
  const staleRules = (rows: { aid: number; filename: string }[], changes: number | ((p: readonly unknown[]) => number) = 1): SqlRule[] => [
    { test: /SELECT aid,filename FROM bbs_attach WHERE status = 0 AND create_date < \? LIMIT \?/, rows: () => rows },
    { test: /DELETE FROM bbs_attach WHERE aid = \? AND status = 0/, rows: [], changes },
  ];

  it('先条件删 D1 行、成功后再删 R2 对象；返回实际删除条数', async () => {
    const deleted: string[] = [];
    const files = { delete: (k: string | string[]) => void (Array.isArray(k) ? deleted.push(...k) : deleted.push(k)) };
    const rows = [1, 2, 3].map((i) => ({ aid: i, filename: `tmp/${i}.png` }));
    const d = deps([...staleRules(rows), ...common], files);
    const n = await attachGc(d.cron, NOW);
    expect(n).toBe(3);
    // 每个对象都被尝试删除；缩略图按 aid 推导，与原件一并批删
    expect(deleted).toEqual([
      'tmp/1.png',
      'attach/thumb/1.webp',
      'tmp/2.png',
      'attach/thumb/2.webp',
      'tmp/3.png',
      'attach/thumb/3.webp',
    ]);
    const dels = d.calls.filter((c) => /DELETE FROM bbs_attach WHERE aid = \?/.test(c.sql));
    expect(dels.map((c) => c.params[0])).toEqual([1, 2, 3]);
    // 时间窗条件下推，SELECT 与 DELETE 之间被发帖关联（status→1）也不会删行
    expect(dels[0]?.params[1]).toBe(NOW - 86400);
    expect(d.calls.find((c) => /FROM bbs_attach WHERE status = 0/.test(c.sql))?.params[1]).toBe(40);
  });

  it('窗口内附件被发帖关联（changes=0）→ 跳过该行且不删 R2 对象', async () => {
    const deleted: string[] = [];
    const files = { delete: (k: string | string[]) => void (Array.isArray(k) ? deleted.push(...k) : deleted.push(k)) };
    const rows = [1, 2, 3].map((i) => ({ aid: i, filename: `tmp/${i}.png` }));
    // aid=2 在 SELECT 与 DELETE 之间被关联（status→1）→ 条件删除 changes=0
    const d = deps([...staleRules(rows, (p) => (Number(p[0]) === 2 ? 0 : 1)), ...common], files);
    const n = await attachGc(d.cron, NOW);
    expect(n).toBe(2);
    expect(deleted).not.toContain('tmp/2.png');
    expect(deleted).toEqual(['tmp/1.png', 'attach/thumb/1.webp', 'tmp/3.png', 'attach/thumb/3.webp']);
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
    expect(d.calls.find((c) => /DELETE FROM bbs_attach WHERE aid = \?/.test(c.sql))?.params[0]).toBe(9);
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
