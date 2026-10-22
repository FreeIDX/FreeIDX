/**
 * 多域名收敛（canonical host）：Cloudflare 可为同一 Worker 绑定多个域名，登录态为 host-only 不共享。
 * 页面导航落在非主域名时 301 到主域名同名路径，避免 SEO 重复内容，也避免「在 A 域登录、B 域仍是游客」的困惑。
 *
 * 主域名 = 后台「站点网址」(setting.url) 优先，部署变量 SITE_URL 兜底（见 core/site.ts）。
 * 只作用于浏览器页面导航（GET/HEAD + Sec-Fetch-Dest: document）；API、文件、静态资源、SEO 文档、
 * 站点验证文件、.htm 旧链、workers.dev 预览域与本地/内网直访一律不跳，POST/PUT 等写请求永不跳。
 */
import { createMiddleware } from 'hono/factory';
import type { Env } from '../types/env';
import type { D1b } from '../core/db';
import type { Cache } from '../core/cache';
import { loadSetting } from '../core/loaders';
import { canonicalBase, isDocumentNavigation } from '../core/site';

type CtxEnv = { Bindings: Env; Variables: { db: D1b; cache: Cache; runlevel: number } };

/** 不参与域名收敛的路径前缀（API / 附件直链 / 构建产物与 public 静态资源） */
const SKIP_PREFIX = ['/api/', '/files/', '/assets/', '/emoicon/', '/avatars/', '/theme-light/', '/fonts/'];
/** 不参与域名收敛的固定路径：SEO 文档自身产出主域名绝对地址，301 只会给爬虫添乱 */
const SKIP_PATHS = new Set(['/api', '/files', '/robots.txt', '/sitemap.xml', '/llms.txt']);

/** 本地/预览域：不做收敛，避免开发环境或 workers.dev 预览被跳到线上主域名 */
function isLocalOrPreviewHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.workers.dev') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  );
}

export function canonicalHostRedirect() {
  return createMiddleware<CtxEnv>(async (c, next) => {
    if (!isDocumentNavigation(c)) return next();
    const p = c.req.path;
    if (SKIP_PATHS.has(p) || SKIP_PREFIX.some((prefix) => p.startsWith(prefix))) return next();
    // 带扩展名的路径：真实静态文件 / 站点验证文件 / .htm 旧链（旧链由 seo 插件自己按主域名 301）
    if (/\/[^/]*\.[^/.]+$/.test(p)) return next();

    const u = new URL(c.req.url);
    const host = u.hostname.toLowerCase();
    if (isLocalOrPreviewHost(host)) return next();

    const canonical = canonicalBase(c, await loadSetting(c.get('cache'), c.get('db')));
    let target: URL;
    try {
      target = new URL(canonical);
    } catch {
      return next();
    }
    if (target.hostname.toLowerCase() === host) {
      // 同主机：仅当主域名声明为 https 时把 http 升级（绝不降级）
      if (u.protocol === 'http:' && target.protocol === 'https:') {
        return c.redirect(`${target.origin}${u.pathname}${u.search}`, 301);
      }
      return next();
    }
    return c.redirect(`${target.origin}${u.pathname}${u.search}`, 301);
  });
}
