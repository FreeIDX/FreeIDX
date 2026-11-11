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

/**
 * 资源 id 严格解析（/thread/:tid、/forum/:fid、/user/:uid…）：
 * 只接受纯数字且 >=1，非法返回 null。**不要**对 id 用 posInt 的 fallback=1 ——
 * 那会把 /thread/abc 变成 1 号帖，向用户展示「有效但错误」的内容，且 404 分支永远不命中。
 * 调用方约定：`const tid = idParam(params.tid) ?? 0`，让后端返回 NOT_FOUND（页面已有 404 态）。
 */
export function idParam(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}
