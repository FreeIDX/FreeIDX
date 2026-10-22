/**
 * 模块间共享工具：分页/排序/关键词高亮等纯函数 + runtime 计数与执行上下文读取。
 * 后两者原先在 mod/check/write/admin 四处各有一份完全相同的实现，统一收敛到此（唯一事实源）。
 */
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { Code } from '@freeidx/shared';
import type { D1b } from '../core/db';
import type { Cache } from '../core/cache';
import type { Env } from '../types/env';
import { AppError } from '../middleware/envelope';
import { readAdminToken } from '../core/auth/admin';
import type { ApiT } from '../core/i18n';

export type ReadEnv = { Bindings: Env; Variables: { db: D1b; cache: Cache; runlevel: number; t: ApiT } };

export function core(c: Context<ReadEnv>): { db: D1b; cache: Cache } {
  return { db: c.get('db'), cache: c.get('cache') };
}

/** 操作者 uid：admin_at token payload（adminGuard 已校验有效），用于 modlog/审计归属 */
export async function adminUidOf(c: Context<ReadEnv>): Promise<number> {
  const secret = c.env.ADMIN_JWT_SECRET ?? c.env.JWT_SECRET ?? '';
  const p = await readAdminToken(getCookie(c, 'admin_at'), secret);
  return Number(p?.uid ?? 0);
}

/** 请求体 JSON（解析失败统一 INVALID_JSON）；形状由调用方按需断言 */
export async function readJson<T = Record<string, unknown>>(c: Context<ReadEnv>): Promise<T> {
  const t = c.get('t');
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
  }
}

/** 请求体必须是 JSON 对象（数组/标量/空体一律 INVALID_JSON_OBJECT） */
export async function readJsonObject(c: Context<ReadEnv>): Promise<Record<string, unknown>> {
  const t = c.get('t');
  try {
    const v = (await c.req.json()) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJsonObject'));
  }
}

/** 表单布尔位落库：1/true/'1'/'true' → 1，其余 → 0 */
export const as01 = (v: unknown): number => (v === 1 || v === true || v === '1' || v === 'true' ? 1 : 0);

/** data URL / 裸 base64 → 字节 */
export function decodeBase64(raw: string, t: ApiT): Uint8Array {
  const b64 = raw.includes(',') && raw.slice(0, 5).toLowerCase() === 'data:' ? raw.slice(raw.indexOf(',') + 1) : raw;
  try {
    const bin = atob(b64.trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    throw new AppError(Code.VALIDATION_ERROR, t('common.invalidBase64'));
  }
}

/**
 * Hono 的 `c.executionCtx` 是抛错型 getter：没有 ExecutionContext 的环境（本地 wrangler 直调、
 * 单测裸 `app.request`）直接读会抛，把旁路任务变成主链路故障。取不到就返回 undefined。
 */
export async function getExecCtx(c: Context<ReadEnv>): Promise<{ waitUntil?: (pr: Promise<unknown>) => void } | undefined> {
  try {
    return (c as unknown as { executionCtx?: { waitUntil?: (pr: Promise<unknown>) => void } }).executionCtx;
  } catch {
    return undefined;
  }
}

/** 站点级 runtime 计数键（§7：无 bbs_runtime 表，统计走缓存键 'runtime'）——首写补齐 0 初值 */
const RUNTIME_ZERO = { threads: 0, todaythreads: 0, posts: 0, todayposts: 0 } as const;

/** runtime 计数键（含由 cron/删用户维护的 users/todayusers/onlines） */
export type RuntimePatch = Partial<Record<keyof typeof RUNTIME_ZERO | 'users' | 'todayusers' | 'onlines', number>>;

/**
 * runtime 计数增量写（全仓唯一实现）：读穿缓存 → 按 key 累加并夹到非负 → 写回。
 * 只传增量（如 { threads: -1 }），绝对赋值（cron 的 onlines/today* 清零）仍由调用方自行 set。
 */
export async function patchRuntime(cache: Cache, patch: RuntimePatch): Promise<void> {
  const cur = (await cache.get<Record<string, number>>('runtime')) ?? {};
  const next: Record<string, number> = { ...RUNTIME_ZERO, ...cur };
  for (const [k, d] of Object.entries(patch)) next[k] = Math.max(0, (next[k] ?? 0) + (d ?? 0));
  await cache.set('runtime', next);
}

export function intParam(v: string | undefined, dflt = 0): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : dflt;
}

/** 列表排序列（首页 tid；版块 forum.orderby 0=lastpid 1=tid；接口显式 orderby 优先） */
export function orderCol(orderby: string | undefined, forumOrderby: number): 'tid' | 'lastpid' {
  if (orderby === 'tid' || orderby === 'lastpid') return orderby;
  return forumOrderby === 1 ? 'tid' : 'lastpid';
}

export function totalPageOf(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

/**
 * 预设头像解析：avatar 为空（0）且
 * avatar_auto 非 '0'/非空时头像取预设路径，否则返回 ''（沿用自定义头像时间戳口径）。
 */
export function avatarAutoOf(avatar: number | string | undefined | null, avatarAuto: string | number | undefined | null): string {
  const a = String(avatarAuto ?? '').trim();
  return Number(avatar ?? 0) === 0 && a && a !== '0' ? a : '';
}

/** 站内预设头像张数（apps/web/public/avatars/0.png … 56.png，与 my/routes.ts 白名单一致） */
const AVATAR_PRESET_COUNT = 57;

/** 新用户默认头像：随机预设图 /avatars/0..56.png（随 avatar=0 + avatar_auto 落库，解析口径同 avatarAutoOf） */
export function randomPresetAvatar(): string {
  return `/avatars/${Math.floor(Math.random() * AVATAR_PRESET_COUNT)}.png`;
}

/**
 * 付费段（[ttPay]…[/ttPay]）服务端脱敏：**正文绝不随未购响应下发**，付费墙不能只靠前台隐藏。
 * keepMarkers=true 保留空标记（前台据此渲染价格/购买按钮）；false 连标记一起移除（SEO 静态页/搜索摘要）。
 */
export function redactPaidBlocks(fmt: string, keepMarkers = false): string {
  return fmt.replace(/\[ttPay\][\s\S]*?\[\/ttPay\]/gi, keepMarkers ? '[ttPay][/ttPay]' : '');
}

/** 仅去掉付费标记、保留正文（content_buy=0 的免费主题，历史数据可能残留标记） */
export function stripPaidMarkers(fmt: string): string {
  return fmt.replace(/\[\/?ttPay\]/gi, '');
}

/** 关键词高亮（fmt 结果内包裹 <mark>，跳过标签体属性区） */
export function highlight(fmt: string, keyword: string): string {
  if (!keyword) return fmt;
  const esc = keyword.replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]!,
  );
  const re = new RegExp(esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  // 仅在标签外文本替换：按标签切分，只处理偶数段
  return fmt
    .split(/(<[^>]*>)/g)
    .map((seg, i) => (i % 2 === 0 ? seg.replace(re, (m) => `<mark>${m}</mark>`) : seg))
    .join('');
}
