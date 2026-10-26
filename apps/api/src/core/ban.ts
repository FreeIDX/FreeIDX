/**
 * 小黑屋服务端原语（0025）：
 *  - banMessage：按范围 / 到期 / 理由拼用户可见文案（10 语言走 ApiT，缺省 zh-cn 兼容单测直调）
 *  - liftExpiredBans：每小时 cron 兜底（读路径的 effectiveBanScope 惰性判定才是主口径，
 *    cron 只负责「清列 + 失效 user:{uid} 缓存 + 回填历史解封时间」，允许最坏晚 1h 才反映到库）
 *
 * 注意：封禁态**不引入每请求额外查询**——ban_scope/ban_until/ban_reason 就放在 bbs_user 行上，
 * loadViewer 本来就要 SELECT 这一行；独立表 bbs_user_ban 只承担历史留痕（后台低频读）。
 */
import { BanScope, banMaskOf } from '@freeidx/shared';
import type { Cache } from './cache';
import type { D1b } from './db';
import { t0, type ApiT } from './i18n';

/** 解封时间展示（UTC，避免 Workers 无本地时区导致的误导） */
export function banDate(until: number): string {
  if (!until) return '';
  return new Date(until * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/**
 * 用户可见的封禁文案：主句按最重维度取（禁登 > 禁访 > 禁言），再拼到期与理由。
 * 用于三处：banGuard 拒绝、登录闸门拒绝、登录成功响应里的提示（可选）。
 */
export function banMessage(scope: number, until: number, reason: string, t: ApiT = t0): string {
  const mask = banMaskOf(scope);
  const head =
    mask & BanScope.LOGIN ? t('ban.loginDenied') : mask & BanScope.READ ? t('ban.suspended') : t('ban.muted');
  const tail = until > 0 ? t('ban.until', { date: banDate(until) }) : `(${t('ban.permanent')})`;
  const why = reason ? ` ${t('ban.reason', { reason })}` : '';
  return `${head} ${tail}${why}`;
}

/**
 * 到期解封兜底（每小时档）：一批最多 200 行，先查 uid 清缓存再批量更新。
 * 部分索引 bbs_user_ban_until（WHERE ban_scope > 0）使无封禁时本查询近零成本。
 */
export async function liftExpiredBans(core: { db: D1b; cache: Cache }, now: number): Promise<number> {
  const rows = await core.db
    .prepare<{ uid: number }>('SELECT uid FROM bbs_user WHERE ban_scope > 0 AND ban_until > 0 AND ban_until <= ? LIMIT 200')
    .bind(now)
    .all();
  const uids = rows.results.map((r) => Number(r.uid)).filter((n) => n > 0);
  if (!uids.length) return 0;
  await core.db.batch([
    core.db
      .prepare(
        'UPDATE bbs_user SET ban_scope = 0, ban_until = 0, ban_reason = \'\', ban_at = 0, ban_by = 0 WHERE ban_scope > 0 AND ban_until > 0 AND ban_until <= ?',
      )
      .bind(now),
    core.db
      .prepare('UPDATE bbs_user_ban SET lifted_at = ? WHERE lifted_at = 0 AND expire_date > 0 AND expire_date <= ?')
      .bind(now, now),
  ]);
  // 缓存失效必须逐条：L2 是按 key 的 DELETE，不能一次 IN
  for (const uid of uids) await core.cache.del(`user:${uid}`);
  return uids.length;
}
