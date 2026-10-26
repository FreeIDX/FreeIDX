/**
 * 小黑屋闸门（banGuard）：全站统一封禁收口，挂在 runlevel 之后、csrf 之前。
 *
 * 为什么不逐个 handler 加判断：登录态判定散落在 18 个文件的 loadViewer 调用点
 * （write/attach/my/credits/notice/v/points/order…），逐处加必然漏。这里按「方法」统一判定：
 *   - 1 MUTE  禁言：放行 GET/HEAD（浏览），拒绝其余写请求
 *   - 2 READ  禁访：读写全拒
 *   - 4 LOGIN 禁登：已登录态一律拒绝（正常路径下会话已被 destroyUserSessions 吊销，这里兜底）
 *
 * 豁免：
 *   - /api/health（不查库）
 *   - /api/auth/*（登录/注册/找回/登出/admin-token 必须可达，否则被封用户无法退出或查看原因；
 *     登录接口自身在 grant 前判定 LOGIN 位）
 *   - /api/admin/*（adminGuard 独立轨；管理员 gid=1 亦直通，服务端还禁止封禁管理员）
 *   - 游客（uid=0）
 *
 * 成本：loadViewer 带请求级记忆（core/loaders.ts），同请求内 handler 再调不会重复查 bbs_session。
 */
import { createMiddleware } from 'hono/factory';
import { BanScope, Code, GroupId, effectiveBanScope } from '@freeidx/shared';
import type { ReadEnv } from '../modules/shared';
import { AppError } from './envelope';
import { banMessage } from '../core/ban';
import { loadViewer } from '../core/loaders';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function banGuard() {
  return createMiddleware<ReadEnv>(async (c, next) => {
    const path = c.req.path;
    // 非 API（页面/静态/爬虫预渲染）不在此拦：页面可见性由 bootstrap 的下发字段决定
    if (!path.startsWith('/api/')) return next();
    if (path === '/api/health') return next();
    if (path.startsWith('/api/auth/')) return next();
    if (path.startsWith('/api/admin/')) return next();
    /**
     * 读请求不在本层装载 viewer：/api/online 等接口刻意跳过 viewer 解析以省 D1，
     * 全局强装会破坏其预算承诺（my-online 测试对此有断言）。禁访/禁登的读侧拦截
     * 放在 loadViewer（core/loaders.ts enforceBanOnRead）——凡是读用户身份的接口都已装载，零额外查询。
     */
    if (READ_METHODS.has(c.req.method)) return next();

    const viewer = await loadViewer(c.get('cache'), c.get('db'), c);
    if (viewer.uid <= 0) return next();
    if (viewer.gid === GroupId.ADMIN) return next();

    const now = Math.floor(Date.now() / 1000);
    const scope = effectiveBanScope(viewer.banScope, viewer.banUntil, now);
    if (!scope) return next();

    const reason = String(viewer.banReason ?? '');
    const until = Number(viewer.banUntil ?? 0);
    // 禁访 / 禁登：读写全拒；禁言：只拒写
    if (scope & (BanScope.READ | BanScope.LOGIN)) {
      throw new AppError(Code.BANNED, banMessage(scope, until, reason, c.get('t')), { banScope: scope, banUntil: until });
    }
    if (scope & BanScope.MUTE && !READ_METHODS.has(c.req.method)) {
      throw new AppError(Code.BANNED, banMessage(scope, until, reason, c.get('t')), { banScope: scope, banUntil: until });
    }
    return next();
  });
}
