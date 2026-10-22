/**
 * 后台守卫（T3-3，DoD：非 gid=1 一律 403）：校验 admin_at（JWT）→ 回查 bbs_user.gid===1 且 token_version 匹配 → 每次续期滑动 1h。
 * 与前台会话解耦：仅凭 admin_at 独立密钥签名；缺密钥/缺 cookie/过期/降组/改密 → 清 cookie + 403（业务码 NO_PERMISSION，HTTP 403）。
 * 挂载方式：app.use('/api/admin/*', adminGuard())——先于 admin 路由；无 admin_at 时对任意 /api/admin/* 直接拒绝。
 */
import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { ADMIN_TOKEN_TTL, Code, GroupId } from '@freeidx/shared';
import { AppError } from './envelope';
import { issueAdminToken, readAdminToken } from '../core/auth/admin';
import { isHttpsRequest } from '../core/site';
import type { ReadEnv } from '../modules/shared';

const cookieAttrs = (secure: boolean) => ({ path: '/', httpOnly: true, sameSite: 'Lax' as const, secure });

export function adminGuard(): MiddlewareHandler<ReadEnv> {
  return async (c, next) => {
    const t = c.get('t');
    const secret = c.env.ADMIN_JWT_SECRET ?? c.env.JWT_SECRET ?? '';
    // Secure 跟随当前请求协议（多域名/预览域下 SITE_URL 可能与实际请求域不一致）
    const secure = isHttpsRequest(c);
    if (!secret) throw new AppError(Code.NO_PERMISSION, t('guard.secretMissing'), {}, 403);

    const reject = (message: string): never => {
      setCookie(c, 'admin_at', '', { ...cookieAttrs(secure), maxAge: 0 });
      throw new AppError(Code.NO_PERMISSION, message, {}, 403);
    };

    const p = await readAdminToken(getCookie(c, 'admin_at'), secret);
    if (!p) return reject(t('guard.loginRequired'));

    const u = await c
      .get('db')
      .prepare<{ gid: number; token_version: number }>('SELECT gid,token_version FROM bbs_user WHERE uid = ?')
      .bind(p.uid)
      .first<{ gid: number; token_version: number }>();
    if (!u || Number(u.gid) !== GroupId.ADMIN || Number(u.token_version) !== p.tv) return reject(t('guard.denied'));

    // 续期：滑动 1h，活跃后台不掉线、闲置超 1h 自然过期（3600s 滑动续期语义）
    const fresh = await issueAdminToken(secret, p.uid, Number(u.token_version));
    setCookie(c, 'admin_at', fresh, { ...cookieAttrs(secure), maxAge: ADMIN_TOKEN_TTL });
    await next();
  };
}
