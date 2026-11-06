/**
 * 路径 → 主题页面名（首屏预取与站内预取共用）。
 *
 * 口径与 App.tsx 的路由表逐条对齐：`/thread/:tid/paylist` 必须先于 `/thread/:tid` 命中，
 * `/forum/:fid/new` 必须先于 `/forum/:fid` 命中，否则会预取到错误的页面 chunk。
 * 只用于「提前下载 chunk」这类纯优化，判错最多多下一次 chunk，不影响任何路由行为。
 */
import type { ThemePageName } from './types';

export function pageNameOfPath(pathname: string): ThemePageName {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/' || /^\/page\/\d+$/.test(p)) return 'home';
  if (/^\/thread\/\d+\/paylist(\/p\/\d+)?$/.test(p)) return 'paylist';
  if (/^\/thread\/\d+(\/p\/\d+)?$/.test(p)) return 'thread';
  if (/^\/forum\/\d+\/new$/.test(p)) return 'compose';
  if (/^\/forum\/\d+$/.test(p)) return 'forum';
  if (/^\/user\/\d+$/.test(p)) return 'user';
  if (p === '/login') return 'login';
  if (p === '/register') return 'register';
  /* 后台重置入口（/reset-password）与旧链（/resetpw）同页 */
  if (p === '/resetpw' || p === '/reset-password') return 'resetpw';
  if (p === '/me') return 'me';
  if (p === '/new') return 'compose';
  if (p === '/search') return 'search';
  if (p === '/discovery') return 'discovery';
  if (p === '/rank') return 'rank';
  if (/^\/mod\/\d+$/.test(p)) return 'mod';
  if (p === '/vip') return 'vip';
  if (/^\/order\/[^/]+$/.test(p)) return 'order';
  return 'notfound';
}
