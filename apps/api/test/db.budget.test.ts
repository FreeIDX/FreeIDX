import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { Code } from '@freeidx/shared';
import { D1b } from '../src/core/db';
import { BudgetError, BUDGET, assertBudget } from '../src/core/db/budget';
import { cursorCond } from '../src/core/db/paginate';
import { handleError } from '../src/middleware/envelope';
import { fakeD1 } from './helpers/fake-d1';

describe('budget guard (§7 / 铁律 3)', () => {
  it('超出 50 条 D1 查询硬上限时抛 BudgetError', async () => {
    const { db } = fakeD1();
    const d = new D1b(db);
    for (let i = 0; i < BUDGET.HARD_D1_QUERIES; i++) {
      await d.prepare('SELECT 1').first();
    }
    expect(d.stats.d1Queries).toBe(BUDGET.HARD_D1_QUERIES);
    await expect(d.prepare('SELECT 1').first()).rejects.toThrow(BudgetError);
  });

  it('CI 断言：子请求 >40 失败', () => {
    expect(() =>
      assertBudget({ d1Queries: 41, subrequests: 41, rowsReadEstimate: 0, cpuMsEstimate: 0 }),
    ).toThrow(BudgetError);
  });

  it('CI 断言：mock CPU >8ms 失败', () => {
    expect(() =>
      assertBudget({ d1Queries: 1, subrequests: 1, rowsReadEstimate: 1, cpuMsEstimate: 8.5 }),
    ).toThrow(/cpuMsEstimate/);
  });

  it('CI 断言：rows_read 超限失败', () => {
    expect(() =>
      assertBudget({
        d1Queries: 1,
        subrequests: 1,
        rowsReadEstimate: BUDGET.CI_ROWS_READ_MAX + 1,
        cpuMsEstimate: 1,
      }),
    ).toThrow(/rowsReadEstimate/);
  });

  it('batch 计 1 子请求、N 条查询（DB.batch 合并语义）', async () => {
    const { db } = fakeD1();
    const d = new D1b(db);
    const stmts = Array.from({ length: 8 }, () => d.prepare('SELECT tid FROM bbs_thread'));
    await d.batch(stmts);
    expect(d.stats.d1Queries).toBe(8);
    expect(d.stats.subrequests).toBe(1);
  });

  it('CPU 打点累计', () => {
    const d = new D1b(fakeD1().db);
    d.addCpu(2.5);
    d.addCpu(3);
    expect(d.stats.cpuMsEstimate).toBeCloseTo(5.5);
  });

  it('预算耗尽按「可重试」降级：友好文案 + Retry-After，而不是通用服务器错误', async () => {
    const app = new Hono();
    app.get('/boom', () => {
      throw new BudgetError('D1 query budget exhausted: 50 >= 50 per invocation');
    });
    app.onError(handleError);
    const res = await app.request('/boom');
    // 信封语义：业务错误保持 HTTP 200 + code（与项目其余错误一致），靠 message 提示重试
    expect(res.status).toBe(200);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { code: number; message: string };
    expect(body.code).toBe(Code.SYSTEM_ERROR);
    expect(body.message).toBe('系统繁忙，请稍后再试'); // 未挂 i18n 中间件时回落 zh-cn
  });
});

describe('cursor pagination (§7 禁 OFFSET)', () => {
  it('倒序游标生成 WHERE col < ?', () => {
    const c = cursorCond({ column: 'tid', size: 30, before: 1000, desc: true });
    expect(c.where).toBe('AND tid < ?');
    expect(c.params).toEqual([1000]);
    expect(c.order).toBe('ORDER BY tid DESC');
  });

  it('首页无游标不产生 WHERE 片段', () => {
    const c = cursorCond({ column: 'tid', size: 30 });
    expect(c.where).toBe('');
    expect(c.params).toEqual([]);
  });
});
