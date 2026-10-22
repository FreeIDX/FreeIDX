/**
 * 统一响应信封（§6.1）：
 * { code, message, ...data }；code<0 全局错误、=0 成功、>0 表单级业务错误。
 */
import type { Context } from 'hono';
import { Code } from '@freeidx/shared';
import { BudgetError } from '../core/db/budget';
import { t0, type ApiT } from '../core/i18n';

/** 翻译器兜底：i18n 中间件之前的异常（t 未挂载）按 zh-cn 取词 */
const tOf = (c: Context): ApiT => ((c as unknown as { get: (k: string) => unknown }).get('t') as ApiT | undefined) ?? t0;

export class AppError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly extra: Record<string, unknown> = {},
    /** 业务错误保持 HTTP 200 + code 字段（ajax 语义），仅路由级异常用 4xx */
    public readonly status: number = 200,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** 成功响应（extra 平铺进信封） */
export function ok(c: Context, message = 'ok', extra: Record<string, unknown> = {}) {
  return c.json({ code: Code.OK, message, ...extra });
}

export function handleError(err: Error, c: Context) {
  // 抛出的 AppError 会被 Hono 在链路内消化成响应（中间件拿得到），故显式声明不可缓存，
  // 防止 NOT_FOUND/NO_PERMISSION/系统异常 信封被边缘缓存在 TTL 窗口内放大成全站故障
  c.header('Cache-Control', 'no-store');
  // 免费层预算耗尽（D1 单次 50 条查询 / 单次 50 子请求）：属「容量瞬时打满」而不是代码缺陷，
  // 是可自愈的（下次请求通常就恢复），故给专门的告警 + Retry-After + 友好文案，
  // 而不是通用「服务器错误」——后者既误导用户，也让运维无法从日志定位是哪条热点路径。
  if (err instanceof BudgetError) {
    console.warn(`[envelope] budget exhausted: ${err.message} <- ${c.req.method} ${c.req.path}`);
    c.header('Retry-After', '5');
    return c.json({ code: Code.SYSTEM_ERROR, message: tOf(c)('common.systemBusy') });
  }
  if (err instanceof AppError) {
    const body = { code: err.code, message: err.message, ...err.extra };
    return err.status === 200 ? c.json(body) : c.json(body, err.status as 400);
  }
  console.error('[envelope] unhandled error:', err);
  return c.json({ code: Code.SYSTEM_ERROR, message: tOf(c)('common.serverError') });
}

export function handleNotFound(c: Context) {
  return c.json({ code: Code.NOT_FOUND, message: tOf(c)('common.routeNotFound') }, 404);
}
