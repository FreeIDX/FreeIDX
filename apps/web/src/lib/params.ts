/**
 * URL / 路由参数解析（唯一实现）：
 * `Math.max(1, Number(x))` 在 x 非数字时得到 NaN（Math.max 不会把 NaN 变成 1），
 * 会把 `/thread/abc`、`?page=abc` 这类地址变成 `/api/threads/NaN` 请求。
 * 这里的守卫保证返回值恒为「≥ min 的有限整数」。
 */
export function posInt(v: string | number | null | undefined, fallback = 1, min = 1): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** 非负整数（fid 允许 0 = 未指定版块） */
export function nonNegInt(v: string | number | null | undefined, fallback = 0): number {
  return posInt(v, fallback, 0);
}
