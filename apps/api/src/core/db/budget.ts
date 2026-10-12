/**
 * 三预算守卫（§7 / 铁律 3）：免费层单 invocation ≤50 条 D1 查询、≤10ms CPU、账户级 ≤5M rows_read/天。
 * 开发期计数器 + CI 断言：子请求 >40、mock CPU >8ms、rows_read 超单请求上限 → 直接失败。
 */

/**
 * 免费层单 invocation 子请求硬上限（Workers 平台限额）：D1 调用 / KV 读写 / R2 操作 / fetch 各计 1。
 * 与 D1 的「50 条查询」同档；外呼密集的路径（如 seo 推送 cron）用它推导自身可用的推送条数上限。
 */
export const SUBREQUEST_HARD_LIMIT = 50;

export const BUDGET = {
  /** D1 免费层硬上限：单 Worker invocation 50 条查询，超出运行时报错 */
  HARD_D1_QUERIES: 50,
  /** CI 断言阈值：留 10 条余量 */
  CI_D1_QUERIES_MAX: 40,
  /** CI 断言：子请求（D1 batch/KV/R2 各计 1）上限 */
  CI_SUBREQUESTS_MAX: 40,
  /** CI 断言：免费层 CPU 10ms 墙，mock 估算上限 8ms（留 20% 余量，§8.4 同源策略） */
  CI_CPU_MS_MAX: 8,
  /** CI 断言：单请求 rows_read 估算上限（≈2 页列表规模） */
  CI_ROWS_READ_MAX: 220,
} as const;

export interface BudgetStats {
  /** 已执行 D1 语句数（batch 内每条语句计数，D1 按语句限额） */
  d1Queries: number;
  /** 子请求估算：每次 D1 调用/batch 计 1，KV get 计 1 */
  subrequests: number;
  /** rows_read 估算 = 全部结果行数之和（D1 不回报真实值，取返回行上界） */
  rowsReadEstimate: number;
  /** 纯计算路径手动打点估算 CPU（哈希/sanitize 等，§8.4） */
  cpuMsEstimate: number;
}

export class BudgetError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'BudgetError';
  }
}

export function newStats(): BudgetStats {
  return { d1Queries: 0, subrequests: 0, rowsReadEstimate: 0, cpuMsEstimate: 0 };
}

/** 执行前守卫：贴到硬上限直接抛，防免费层静默失败（§7 查询计数器） */
export function guardBeforeQuery(stats: BudgetStats): void {
  if (stats.d1Queries >= BUDGET.HARD_D1_QUERIES) {
    throw new BudgetError(
      `D1 query budget exhausted: ${stats.d1Queries} >= ${BUDGET.HARD_D1_QUERIES} per invocation`,
    );
  }
  if (stats.d1Queries === BUDGET.CI_D1_QUERIES_MAX) {
    console.warn(`[budget] D1 queries hit warn threshold ${BUDGET.CI_D1_QUERIES_MAX}`);
  }
}

/** 请求收尾断言（CI/单测用）：任一预算超限即失败，防回归（§7 CI 三预算断言） */
export function assertBudget(stats: BudgetStats): void {
  const v: string[] = [];
  if (stats.d1Queries > BUDGET.CI_D1_QUERIES_MAX)
    v.push(`d1Queries ${stats.d1Queries} > ${BUDGET.CI_D1_QUERIES_MAX}`);
  if (stats.subrequests > BUDGET.CI_SUBREQUESTS_MAX)
    v.push(`subrequests ${stats.subrequests} > ${BUDGET.CI_SUBREQUESTS_MAX}`);
  if (stats.cpuMsEstimate > BUDGET.CI_CPU_MS_MAX)
    v.push(`cpuMsEstimate ${stats.cpuMsEstimate.toFixed(2)} > ${BUDGET.CI_CPU_MS_MAX}`);
  if (stats.rowsReadEstimate > BUDGET.CI_ROWS_READ_MAX)
    v.push(`rowsReadEstimate ${stats.rowsReadEstimate} > ${BUDGET.CI_ROWS_READ_MAX}`);
  if (v.length) throw new BudgetError(`budget violations: ${v.join('; ')}`);
}
