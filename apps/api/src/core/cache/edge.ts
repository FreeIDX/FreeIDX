/**
 * Cache API 边缘响应缓存（§7 读取屏障的执行层）。
 *
 * 定位：L0 Isolate / L1 KV / L2 D1 之上再叠一层 Cloudflare 边缘缓存（`caches.default`），
 * 命中即在 Worker 内直接返回响应体，不进入 runlevel/csrf/路由，对 D1 零查询、KV 零读。
 *
 * 三条实测边界（决定本层的形状，见 docs/开发架构文档.md §7）：
 *  1. 缓存键只有 URL（含查询串），不支持 Vary → UA 分类写进键 URL，爬虫 HTML 与人类响应永不互串。
 *  2. 仅在站点绑定自定义域（走 Cloudflare zone）后真正生效；workers.dev 直访与 dashboard/Playground
 *     预览为 no-op（读永远 miss、写静默丢弃）→ 本层 miss 时直通原链路，不产生任何行为差异。
 *  3. stale-while-revalidate / stale-if-error 对 cache.match/put 无效 → 只用 max-age，
 *     TTL 即最大陈旧窗口；Workers 内无全网络主动失效（cache.delete 只清本机柜），故不承诺写后即时刷新。
 *
 * 覆盖范围：匿名只读 API（API_TTL）+ `/files/*` 公共直链（FILES_PUBLIC 前缀白名单）+ 爬虫预渲染 HTML。
 *
 * 安全性前提：只缓存"游客可判定"的响应——带 Authorization 或登录轨 Cookie（sid/at/admin_at）的请求
 * 一律绕开，未持有 csrf Cookie 的首访请求也绕开。写入门槛为 200 + 无 Set-Cookie + 未声明 no-store：
 * Hono 会把路由抛出的 AppError 在链路内转成响应（实测中间件 post-next 仍能拿到），因此错误信封的
 * 不可缓存性由 envelope.ts 统一打 `Cache-Control: no-store` 来保证，而不是靠异常传播。
 */
import { createMiddleware } from 'hono/factory';
import { AVAILABLE_LOCALES } from '@freeidx/shared';
import type { Env } from '../../types/env';
import type { D1b } from '../db';
import type { Cache } from './index';
import { classifyUserAgent, type UaClass } from '../crawler';

type Bucket = typeof caches.default;

/**
 * 匿名只读接口 → 边缘 TTL（§7 口径：列表 30s，详情 60s）。
 *
 * 收入标准（三条同时满足才可加入）：
 *  1. 响应体对「gid=0 的游客」是常量——不随 uid/sid 变化（带登录轨 Cookie 的请求本层直接绕开）；
 *  2. 无 Set-Cookie（门槛已有），且写操作后不要求「立刻可见」（写方都是登录态，本层不参与）；
 *  3. 敏感度可接受：返回的是站点公开数据，游客原本就能看到。
 *
 * TTL 约束：不超过该端点服务端缓存（L0/L2）的 TTL，否则边缘会比数据库层更陈旧。
 */
export const API_TTL: ReadonlyArray<readonly [RegExp, number]> = [
  [/^\/api\/bootstrap$/, 30],
  // 启用主题 id：随 SPA 壳/首屏引导读取，后台切换后 30s 内边缘即更新
  [/^\/api\/theme\/active$/, 30],
  [/^\/api\/threads$/, 30],
  [/^\/api\/forums\/\d+\/threads$/, 30],
  [/^\/api\/users\/\d+\/(?:threads|posts)$/, 30],
  [/^\/api\/threads\/\d+$/, 60],
  [/^\/api\/users\/\d+$/, 60],

  /* ---- 首页/版块页右栏与聚合读 ----
   * 这一组此前完全没有边缘缓存：游客每次 PV 都要真打 Worker + D1（首页一次 PV 5~8 个请求，
   * 其中只有 bootstrap 与 /api/threads 命中）。它们都是「匿名同值」的只读聚合，加进来只花配置。
   * 逐条说明为什么匿名副本可共享：
   *  - /api/online：IP 字段仅对 gid 1/2 下发，其余字段（fid/url/last_date/用户名）与访客无关；
   *  - /api/rank/*：ok=1 的公开榜单，无访问者参数；版块热门沿用同一口径；
   *  - /api/posts/latest、/api/threads/hot-favorites：版块可读性过滤对 gid=0 恒定；
   *  - /api/threads/:tid/hot-posts：liked 标记仅在登录态生成，审核位过滤对 gid=0 恒定。 */
  [/^\/api\/online$/, 30],
  [/^\/api\/posts\/latest$/, 30],
  [/^\/api\/rank\/users$/, 600], // 服务端 new 档 600s / 其余 86400s，取最小值
  [/^\/api\/rank\/threads$/, 3600], // 服务端 all 档 86400s / week 档 3600s
  [/^\/api\/rank\/forum$/, 300], // 服务端无缓存，且版块页每次访问都查
  [/^\/api\/rank\/list$/, 300], // 服务端无缓存（COUNT + 排序）
  [/^\/api\/threads\/hot-favorites$/, 300],
  [/^\/api\/threads\/\d+\/hot-posts$/, 60],

  /* ---- 站点级配置类 ----
   * 后台改完想立刻自查的站长带 admin_at Cookie，本层直接绕开（PERSONAL_COOKIE）；
   * 但「管理员改完开无痕窗口看效果」是常见动作，故 TTL 不取小时级：
   * insert-codes 每个页面都会拉（省请求的大头），给 60s 已足够把重复请求压掉。 */
  [/^\/api\/insert-codes$/, 60],
  [/^\/api\/quick-reply-message$/, 300],
  [/^\/api\/vip\/plans$/, 600],
  [/^\/api\/payment-providers$/, 600],
  [/^\/api\/checkin$/, 30], // 仅 GET；签到写操作走 POST 且登录态绕开本层
];

/** 爬虫预渲染 HTML 的 TTL（与 §16.1 R2 产物同步，1h） */
export const BOT_HTML_TTL = 3600;

/**
 * `/files/*` 公共直链的**前缀白名单**（§7 读取屏障的 R2 读取挡板）。
 *
 * 只放行「可证明与请求方无关」的对象：avatar（key 已由 `?v=<avatar 时间戳>` 版本化，内容不可变）、
 * forum/site（图标/站点图）。命中边缘即不再触达 R2（省 1 次 Class B + 1 次出站连接）。
 * `attach/`（付费/权限附件）**永不在列**：直链已在 filesProxy 关闭，必须走 /api 端点受
 * allowdown + 付费主题未购 + 付费附件扣分三重校验；此处用白名单而非黑名单，防止将来
 * 给 filesProxy 加新前缀时被顺手变成公共缓存。
 */
const FILES_PUBLIC: ReadonlyArray<RegExp> = [/^\/files\/avatar\//, /^\/files\/forum\//, /^\/files\/site\//];

/** 登录轨 Cookie：出现任一即说明响应可能按用户定制，必须绕开边缘缓存 */
const PERSONAL_COOKIE = /(?:^|;\s*)(?:sid|at|admin_at)=/;

/** 语言协商 cookie：合法 locale 才参与缓存键（与 i18n 中间件 cookieLangOf 同口径） */
function langCookieOf(cookie: string | null): string | undefined {
  const m = /(?:^|;\s*)lang=([^;]+)/.exec(cookie ?? '');
  if (!m?.[1]) return undefined;
  try {
    const v = decodeURIComponent(m[1]).toLowerCase();
    return AVAILABLE_LOCALES.includes(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

function bucket(): Bucket | null {
  return typeof caches === 'undefined' ? null : caches.default;
}

/**
 * 键 URL：把 UA 分类塞进查询串参数 `fi-ua`（原查询保留）。
 * Cloudflare 缓存键只认 URL，不认 Vary，这是浏览器/爬虫共用一个 URL 时唯一的隔离手段。
 * `fi-lang`：API 响应内容可能随语言 cookie 协商而不同（i18n 中间件），带 `lang` cookie 的
 * 请求把语言值也编进键，避免不同语言用户互串缓存副本；无 cookie（或非法值）共用缺省键。
 */
function keyUrl(url: string, ua: UaClass, lang?: string): string {
  const u = new URL(url);
  u.searchParams.set('fi-ua', ua);
  if (lang) u.searchParams.set('fi-lang', lang);
  return u.toString();
}

function keyRequest(url: string, ua: UaClass, lang?: string): Request {
  return new Request(keyUrl(url, ua, lang), { method: 'GET' });
}

function withState(res: Response, state: 'HIT' | 'MISS'): Response {
  const headers = new Headers(res.headers);
  headers.set('x-edge-cache', state);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * API 命中下发：剥掉副本上的 Cache-Control（`/files/*` 不走这里，见调用点）。
 *
 * 副本上的 `public, max-age` 只有一个用途——向 Cloudflare 声明 Edge TTL。若原样下发给浏览器，
 * 浏览器会按 URL 缓存 30~60s，而 HTTP 缓存键**不含 Cookie**：游客在该窗口内登录后重新拉
 * /api/bootstrap，浏览器可能直接给出「游客版」响应 → 认证态串扰（表现为登录成功但顶栏仍是游客，
 * 最长 30~60s 自愈）。这与本文件顶部「客户端响应不带 TTL」的口径也相违。
 *
 * 保留浏览器缓存并无收益：TanStack staleTime 已是 30s，窗口内不会重复请求；窗口外的重复请求
 * 恰恰需要新数据。故与 MISS 口径对齐——TTL 只归边缘，不污染浏览器缓存。
 */
function apiHit(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.delete('cache-control');
  headers.set('x-edge-cache', 'HIT');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** 写入门槛：200、未带 Set-Cookie、且响应未声明不可缓存（错误信封由 envelope 统一打 no-store） */
function storeEligible(res: Response): boolean {
  if (res.status !== 200 || res.headers.has('set-cookie')) return false;
  return !/(?:no-store|no-cache|private|max-age=0)/.test((res.headers.get('cache-control') ?? '').toLowerCase());
}

/**
 * 写缓存副本：补 max-age（Cloudflare 依据 Cache-Control 判定可缓存性与 Edge TTL），并剥掉命中标记。
 * `keepCacheControl`（/files/* 用）：保留源头的 Cache-Control —— avatar 直链是
 * `public, max-age=31536000, immutable`（key 已 ?v= 版本化），forum/site 是 86400；
 * 覆盖掉会把 immutable 洗掉，浏览器在边缘 HIT 后反而退化成无版本化缓存。
 */
function cachedCopy(res: Response, ttl: number | undefined, keepCacheControl = false): Response {
  const headers = new Headers(res.headers);
  headers.delete('x-edge-cache');
  // keepCacheControl（/files/*）：保留源头的 public max-age（含 immutable），仅剥命中标记
  if (!keepCacheControl && ttl !== undefined) headers.set('cache-control', `public, max-age=${ttl}`);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

type Waiter = { waitUntil?: (p: Promise<unknown>) => void };

function wait(promise: Promise<unknown>, ctx: Waiter | undefined): void {
  const job = promise.catch(() => undefined); // 缓存写失败（超限/不可缓存）不得拖垮响应
  if (ctx?.waitUntil) ctx.waitUntil(job);
  else void job;
}

/**
 * Hono 的 `c.executionCtx` 是抛错型 getter：没有 ExecutionContext 的环境（单测裸 `app.request`）
 * 直接读会抛，把旁路的缓存写变成主链路故障。缓存写本就是 opt-in 优化 → 取不到就 fire-and-forget。
 */
export function maybeCtx(c: unknown): Waiter | undefined {
  try {
    return (c as { executionCtx?: Waiter }).executionCtx;
  } catch {
    return undefined;
  }
}

/**
 * 参与资格判定：无 Authorization、无登录轨 Cookie（sid/at/admin_at），且已持有 csrf Cookie。
 * 要求 csrf Cookie 是刻意的——它等价于"该访客已完成过一次首访"：
 * 首访响应带 Set-Cookie，按下面的写入门槛必然穿透并签发 csrf Cookie；
 * 此后第二次请求才可能吃到 HIT，于是边缘缓存永远不会吞掉 csrf Cookie 的签发（写链路不受影响）。
 */
function isCacheEligible(req: { headers: Headers }): boolean {
  if (req.headers.has('authorization')) return false;
  const cookie = req.headers.get('cookie') ?? '';
  return !PERSONAL_COOKIE.test(cookie) && /(?:^|;\s*)csrf=/.test(cookie);
}

/**
 * `/files/*` 公共直链的参与资格：无 Authorization、无登录轨 Cookie 即可。
 * 刻意**不要求 csrf Cookie**（与上面的 API 口径不同）：那里要求 csrf 是为了不吞掉首访的
 * Set-Cookie 签发；本路径响应永不带 Set-Cookie、也不按访客定制，要求 csrf 只会让每个新访客
 * 的图片都多穿一次边缘（R2 照读），纯浪费。
 */
function isFileCacheEligible(req: { headers: Headers }): boolean {
  if (req.headers.has('authorization')) return false;
  return !PERSONAL_COOKIE.test(req.headers.get('cookie') ?? '');
}

export function edgeCache() {
  return createMiddleware<{ Bindings: Env; Variables: { db: D1b; cache: Cache; runlevel: number } }>(
    async (c, next) => {
      if (c.req.method !== 'GET') return next();
      const raw = c.req.raw;
      const filePrefix = FILES_PUBLIC.some((re) => re.test(c.req.path));
      const ttl = API_TTL.find(([re]) => re.test(c.req.path))?.[1];
      if (!ttl && !filePrefix) return next();
      // 资格口径分两档（见各函数注释）：API 要求已持有 csrf Cookie；/files 公共直链不要求
      if (!(filePrefix ? isFileCacheEligible(raw) : isCacheEligible(raw))) return next();
      const b = bucket();
      if (!b) return next();

      // /files/* 与 UA 无关 → 人类/爬虫共用一个键（SHARED_UA），命中率最高；API 仍按 fi-ua 分键隔离。
      // /files/* 与语言无关（二进制对象）不编 fi-lang；API 键编入 lang cookie（合法 locale 才编），
      // 防止语言协商后不同语言用户命中同一份缓存副本。
      const ua = filePrefix ? SHARED_UA : (classifyUserAgent(c.req.header('user-agent') ?? '') as UaClass);
      const lang = filePrefix ? undefined : langCookieOf(raw.headers.get('cookie'));
      const key = keyRequest(raw.url, ua, lang);
      const hit = await b.match(key);
      if (hit) {
        // /files/* 的副本带 `public, max-age=<很长>, immutable`（key 已 ?v= 版本化），必须原样下发，
        // 否则浏览器每次都要重取图片；API 副本的 max-age 只服务 Edge TTL，需在下发时剥掉。
        c.res = filePrefix ? withState(hit, 'HIT') : apiHit(hit);
        return;
      }
      await next();
      const res = c.res;
      if (!storeEligible(res)) return;
      const copy = cachedCopy(res.clone(), ttl, filePrefix);
      c.res = withState(res, 'MISS');
      wait(b.put(key, copy), maybeCtx(c));
    },
  );
}

/**
 * 预渲染读路径（§16.1 Cache API 前置）：命中直接给爬虫 HTML，零 D1/KV/R2 子请求。
 * 无 Cache API 环境（本地测试、workers.dev）返回 null，调用方按原链路继续。
 */
export async function edgeLookup(url: string, ua: UaClass): Promise<Response | null> {
  const b = bucket();
  if (!b) return null;
  const hit = await b.match(keyRequest(url, ua));
  return hit ? withState(hit, 'HIT') : null;
}

/**
 * 个人化请求判定（登录轨 Cookie）。
 * 「全站同值」产物（sitemap / robots.txt / llms.txt）的读路径对这类请求跳过边缘缓存：
 * 站长改完配置后当场打开页面自查，看到的必须是新值，不能被 TTL 挡住；写路径照常回填供游客与爬虫使用。
 */
export function isPersonalRequest(headers: { get: (name: string) => string | null }): boolean {
  return PERSONAL_COOKIE.test(headers.get('cookie') ?? '');
}

/**
 * 「与请求方无关」的共享产物统一使用的缓存键分类。
 * fi-ua 分键的本意是隔离爬虫 HTML 与人类响应；sitemap 这类全站同值文档无需区分请求方，
 * 统一落同一个键命中率最高（人类与爬虫共用一份，与内容本身的语义一致）。
 */
export const SHARED_UA: UaClass = 'human';

/**
 * 预渲染写路径：产物写边缘，后续同机柜请求命中即不再触达 R2/D1。
 * contentType 供非 HTML 产物（如 sitemap.xml 的 application/xml）使用。
 */
export function edgeStore(
  url: string,
  ua: UaClass,
  body: string,
  ttl: number,
  ctx: Waiter | undefined,
  contentType = 'text/html; charset=utf-8',
): void {
  const b = bucket();
  if (!b) return;
  const res = new Response(body, {
    headers: { 'content-type': contentType, 'cache-control': `public, max-age=${ttl}` },
  });
  wait(b.put(keyRequest(url, ua), res), ctx);
}
