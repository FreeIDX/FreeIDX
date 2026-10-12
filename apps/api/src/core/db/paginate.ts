/**
 * 游标分页原语（§7/§18.3#6：深分页禁 OFFSET——OFFSET 跳过行仍计 rows_read）。
 */
interface CursorOpts {
  /** 游标列：tid / pid / logid 等单调列 */
  column: string;
  size: number;
  /** 上一页末位游标值 */
  before?: number;
  /** true=倒序（tid DESC，配 `column < before`）；false=正序 */
  desc?: boolean;
}

interface CursorSql {
  where: string;
  order: string;
  limit: number;
  params: number[];
}

export function cursorCond(o: CursorOpts): CursorSql {
  const desc = o.desc ?? true;
  const op = desc ? '<' : '>';
  if (o.before != null && o.before > 0) {
    return {
      where: `AND ${o.column} ${op} ?`,
      order: `ORDER BY ${o.column} ${desc ? 'DESC' : 'ASC'}`,
      limit: o.size,
      params: [o.before],
    };
  }
  return {
    where: '',
    order: `ORDER BY ${o.column} ${desc ? 'DESC' : 'ASC'}`,
    limit: o.size,
    params: [],
  };
}

/** 浅分页 OFFSET 片段（仅 page<=100 级浅页允许，深页必须走 cursorCond） */
export function shallowOffset(page: number, size: number): { sql: string; params: number[] } {
  const p = Math.max(1, page);
  return { sql: 'LIMIT ? OFFSET ?', params: [size, (p - 1) * size] };
}
