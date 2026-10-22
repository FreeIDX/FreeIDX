/**
 * 站点地址解析（多域名部署）：把「请求域」与「主域名」分开。
 *
 * 一个 Worker 可在 Cloudflare 绑定多个域名（www/裸域/备用域…），部署时 GitHub Variable 又可能没配。
 * 因此运行时行为与对外地址必须按两套口径取值：
 *  - 请求域（requestOrigin / isHttpsRequest）：Cookie Secure、CORS 同源判定等**必须跟当前请求走**，
 *    否则备用域或 workers.dev 预览域会出现「站点是 https、Cookie 却不带 Secure」的错配。
 *  - 主域名（canonicalBase）：邮件链接、SEO canonical/sitemap/llms.txt、支付回跳等**对外绝对地址**
 *    一律用后台「站点网址」(setting.url) 优先，部署变量 SITE_URL 仅兜底，两者皆空才回落当前请求域。
 * 登录态保持 host-only（不共享），页面导航落到非主域名时由 middleware/canonical-host 301 收敛。
 */
import type { SiteSetting } from '@freeidx/shared';

/** 取运行时 env 的能力（Hono Context 结构兼容；cron 等无请求上下文只取 SITE_URL） */
interface EnvLike {
  SITE_URL?: string;
}
/** 取请求 URL 的能力（Hono Context 结构兼容） */
interface ReqLike {
  req: { url: string };
}

/** 当前请求的 origin（Host + 协议，不读 SITE_URL） */
export function requestOrigin(c: ReqLike): string {
  return new URL(c.req.url).origin;
}

/** 当前请求是否 HTTPS（Cookie Secure 等运行时属性按此判定，而非站点配置） */
export function isHttpsRequest(c: ReqLike): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

/** 归一化站点地址：仅接受 http(s)，取 origin（丢弃路径/查询/尾斜杠）；非法或空返回 '' */
export function normalizeSiteUrl(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.origin;
  } catch {
    return '';
  }
}

/** 主域名（无请求上下文：cron / 后台任务）：setting.url 优先，SITE_URL 兜底；都没配返回 '' */
export function canonicalBaseFromSetting(
  setting?: SiteSetting | null,
  env?: EnvLike,
): string {
  return normalizeSiteUrl(setting?.url) || normalizeSiteUrl(env?.SITE_URL);
}

/** 主域名（请求上下文）：setting.url 优先，SITE_URL 兜底，最后回落当前请求 origin（保证绝对地址可用） */
export function canonicalBase(c: ReqLike & { env?: EnvLike }, setting?: SiteSetting | null): string {
  return canonicalBaseFromSetting(setting, c.env) || requestOrigin(c);
}

/**
 * 是否浏览器页面导航（只有这类请求做域名 301，API/静态资源/爬虫抓取文档一律不跳）。
 * 优先看 Sec-Fetch-Dest；不支持的浏览器回落 Accept 是否含 text/html；两者都没有则不动。
 */
export function isDocumentNavigation(c: {
  req: { method: string; header: (name: string) => string | undefined };
}): boolean {
  const m = c.req.method.toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  const dest = c.req.header('sec-fetch-dest');
  if (dest) return dest === 'document';
  return (c.req.header('accept') ?? '').toLowerCase().includes('text/html');
}
