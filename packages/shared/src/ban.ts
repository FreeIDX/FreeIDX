/**
 * 小黑屋（用户封禁）语义单一事实源。
 *
 * 能力模型 = 位掩码组合，不做成「只能封号」：
 *   1 MUTE  禁言：可登录、可浏览；拒绝一切写操作（发帖/回帖/编辑/上传/私信/积分转账/改资料）
 *   2 READ  禁访：可登录看提示页；读写全拒（站内小黑屋）
 *   4 LOGIN 禁登：禁止登录，并立即吊销会话（最重）
 *
 * 组合：3 = 禁言+禁访（能登录、不能看帖不能发帖，只能看提示）；7 = 传统封号。
 * 到期语义：ban_until = 0 表示永久；否则到期即视为自动解封（读路径惰性判定，
 * cron 每小时只做「清列 + 失效缓存 + 补历史留痕」的兜底，不依赖 cron 时效）。
 */

export const BanScope = {
  NONE: 0,
  /** 禁言 */
  MUTE: 1,
  /** 禁访（禁读，含写） */
  READ: 2,
  /** 禁登 */
  LOGIN: 4,
} as const;

/** 合法范围上界（三位全开） */
export const BAN_SCOPE_MAX = BanScope.MUTE | BanScope.READ | BanScope.LOGIN;

/** 封禁理由长度上限（服务端校验/前端计数共用） */
export const BAN_REASON_MAX = 200;

/** 位掩码归一：非整数/负数/超界一律按 0 处理（防手工改库写出非法值） */
export function banMaskOf(v: unknown): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n & BAN_SCOPE_MAX;
}

/**
 * 生效范围（读时判定，到期自动失效）：
 * ban_scope<=0 恒 0；ban_until>0 且 <=now 视为已解封。now 为 unix 秒。
 */
export function effectiveBanScope(scope: unknown, until: unknown, now: number): number {
  const mask = banMaskOf(scope);
  if (!mask) return 0;
  const exp = Math.trunc(Number(until));
  if (Number.isFinite(exp) && exp > 0 && exp <= now) return 0;
  return mask;
}

/** 是否处于任一维度的生效封禁 */
export function isBanned(scope: unknown, until: unknown, now: number): boolean {
  return effectiveBanScope(scope, until, now) !== 0;
}

/** 是否命中某维度（如 READ / LOGIN） */
export function banHits(scope: unknown, until: unknown, now: number, bit: number): boolean {
  return (effectiveBanScope(scope, until, now) & bit) !== 0;
}

/** 读过范围文案（后台/前台共用；顺序固定 MUTE→READ→LOGIN，用 '+' 连接组合） */
export function banScopeKeyList(scope: unknown): (keyof typeof BanScope)[] {
  const mask = banMaskOf(scope);
  const out: (keyof typeof BanScope)[] = [];
  if (mask & BanScope.MUTE) out.push('MUTE');
  if (mask & BanScope.READ) out.push('READ');
  if (mask & BanScope.LOGIN) out.push('LOGIN');
  return out;
}
