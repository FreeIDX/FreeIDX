/**
 * D1 封装（铁律 3）：per-request 查询计数 + 显式投影 + 游标分页原语。
 * 禁止 SELECT *：列表查询绝不触碰 message/message_fmt（§7）。
 */
import type { BudgetStats } from './budget';
import { guardBeforeQuery, newStats } from './budget';

export class D1b {
  readonly stats: BudgetStats = newStats();
  constructor(private readonly db: D1Database) {}

  /** 包装一条语句；bind 保持链式 */
  prepare<T = unknown>(sql: string): Stmt<T> {
    return new Stmt<T>(this, this.db.prepare(sql));
  }

  /** 多语句单往返：计 1 子请求、N 条查询（D1 batch 语义，§7 DB.batch 合并） */
  async batch<T = unknown>(stmts: Stmt[]): Promise<D1Result<T>[]> {
    this.count(1, stmts.length);
    const inner = stmts.map((s) => s.inner());
    const results = (await this.db.batch<T>(inner)) as D1Result<T>[];
    for (const r of results) this.stats.rowsReadEstimate += r.results?.length ?? 0;
    return results;
  }

  /** 供中间件在响应头暴露实测计数（T3-7 runtime 面板数据源） */
  static of(db: D1Database): D1b {
    return new D1b(db);
  }

  count(sub: number, queries: number, rows = 0): void {
    guardBeforeQuery(this.stats);
    this.stats.d1Queries += queries;
    this.stats.subrequests += sub;
    this.stats.rowsReadEstimate += rows;
  }

  /** 手动 CPU 打点（哈希等纯计算，§8.4） */
  addCpu(ms: number): void {
    this.stats.cpuMsEstimate += ms;
  }
}

export class Stmt<T = unknown> {
  constructor(
    private readonly host: D1b,
    private readonly s: D1PreparedStatement,
    private readonly bound = false,
  ) {}

  bind(...values: unknown[]): Stmt<T> {
    return new Stmt<T>(this.host, this.s.bind(...values), true);
  }

  /** @internal */
  inner(): D1PreparedStatement {
    return this.s;
  }

  async first<C = T>(colName?: string): Promise<C | null> {
    this.host.count(1, 1, 1);
    return colName === undefined ? this.s.first<C>() : this.s.first<C>(colName);
  }

  async all(): Promise<D1Result<T>> {
    this.host.count(1, 1);
    const r = await this.s.all<T>();
    this.host.stats.rowsReadEstimate += r.results?.length ?? 0;
    return r;
  }

  async raw<R = T>(): Promise<R[]> {
    this.host.count(1, 1);
    const r = await this.s.raw<R>();
    this.host.stats.rowsReadEstimate += r.length;
    return r;
  }

  /** 写语句执行：返回行类型沿用语句泛型（写路径不消费 results，仅 meta 有用） */
  async run(): Promise<D1Result<T>> {
    this.host.count(1, 1);
    return this.s.run<T>();
  }
}
