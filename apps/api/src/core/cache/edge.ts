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
 * 覆盖范围：匿名只读 API（API_TTL）+ 公共二进制直链（FILES_PUBLIC 前缀白名单 / BINARY_PUBLIC）
 * + 爬虫预渲染 HTML。
 *
 * 安全性前提：只缓存"游客可判定"的响应——带 Authorization 或登录轨 Cookie（sid/at/admin_at）的请求
 * 一律绕开。首访（尚无 csrf Cookie）同样参与读取**与回填**：游客副本的响应体不含任何 token/个人数据，
 * 命中时在 HIT 响应上补发随机 csrf Cookie（与 csrf 中间件 GET 分支同口径）。
 * 写入门槛为 200 + Set-Cookie 仅限 csrf 签发 + 未声明 no-store：
 * 此前「任何 Set-Cookie 都不写」看似安全，实际让**每个新访客**的 /api/bootstrap 与列表都冷穿透整条
 * D1 链路，且这次 MISS 的产物也不回填——低流量时段边缘命中率因此接近 0。现在缓存副本会剥掉这条
 * csrf 头（HIT 分支按需补签），只有真正下发登录轨 Cookie 的响应才继续拒绝写入。
 * Hono 会把路由抛出的 AppError 在链路内转成响应（实测中间件 post-next 仍能拿到），因此错误信封的
 * 不可缓存性由 envelope.ts 统一打 `Cache-Control: no-store` 来保证，而不是靠异常传播。
 */
import { createMiddleware } from 'hono/factory';
import { setCookie } from 'hono/cookie';
import { AVAILABLE_LOCALES, RunLevel } from '@freeidx/shared';
import { acceptLangOf } from '../i18n';
import { isHttpsRequest } from '../site';
import type { Env } from '../../types/env';
import type { D1b } from '../db';
import type { Cache } from './index';
import { classifyUserAgent, type UaClass } from '../crawler';

type Bucket = typeof caches.default;

/**
 * 匿名只读接口 → 边缘 TTL（§7 口径：列表 60s，详情 120s）。
 *
 * 首屏三类接口（bootstrap / 列表 / 详情）的 TTL 从 30/30/60 提到 30/60/120：Cache API 副本按机柜
 * 独立存放，低频站点在 30s 窗口内往往等不到第二个请求，写的副本还没被读到就过期了。60s 的内容陈旧
 * 对论坛列表可接受（发帖后作者本人刷新会看到旧列表，属既有取舍），换来的是命中率与 TTL 近似线性增长。
 */
/** 匿名只读 API 的缓存白名单与 TTL（导出供测试断言「哪些接口必须被缓存、正则不互相抢占」） */
export const API_TTL: ReadonlyArray<readonly [RegExp, number]> = [
  [/^\/api\/bootstrap$/, 30],
  [/^\/api\/threads$/, 60],
  [/^\/api\/forums\/\d+\/threads$/, 60],
  /* 版块简介多语言：发现页按需拉取（bootstrap 已不再背这 15KB gzip）。站点结构低频变更，300s 足够 */
  [/^\/api\/forums\/briefs$/, 300],
  [/^\/api\/users\/\d+\/(?:threads|posts)$/, 30],
  [/^\/api\/threads\/\d+$/, 120],
  [/^\/api\/users\/\d+$/, 60],
  /* 右栏/聚合类匿名只读端点：游客每次 PV 都会真打 Worker + D1，扩容前完全没吃到边缘缓存。
   * 全部以 `$` 锚定，避免 /api/threads/\d+ 与 /api/threads/hot-favorites、/:tid/hot-posts 互相抢占；
   * 付费/写侧（/api/threads/:tid/paylist、/api/orders、/api/my/*）必须仍然不在列。 */
  [/^\/api\/online$/, 30],
  [/^\/api\/posts\/latest$/, 30],
  [/^\/api\/rank\/users$/, 600],
  [/^\/api\/rank\/threads$/, 3600],
  [/^\/api\/rank\/forum$/, 300],
  [/^\/api\/rank\/list$/, 300],
  [/^\/api\/threads\/hot-favorites$/, 300],
  [/^\/api\/threads\/\d+\/hot-posts$/, 60],
  [/^\/api\/insert-codes$/, 60],
  [/^\/api\/quick-reply-message$/, 300],
  /* 价格/通道是资金相关的高变更数据：后台改价、下架计划、停用通道后无法全网络主动 purge，
   * 600s 边缘副本会让游客按旧价下单（placeOrder 实时读库按新价扣款）或落到已停用通道。
   * 与 /api/forums/:fid/threads 同档 30s，把不一致窗口压到可控范围。 */
  [/^\/api\/vip\/plans$/, 30],
  [/^\/api\/payment-providers$/, 30],
  [/^\/api\/checkin$/, 30],
  /* 相关帖子（related 插件）：游客可判定（仅 ok=1 + 可读版块），与 hot-posts 同档 60s；
   * 插件启停/配置变更最多 60s 内跟上，与详情页 60s 副本同一陈旧窗口。 */
  [/^\/api\/related-threads$/, 60],
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

/**
 * 走 R2 的**公共图片**接口：附件预览（`?t=1` 为 400px WebP 缩略图）。
 *
 * 与 `/files/*` 一样是二进制、与语言无关、URL 即内容：因此共用同一套「共享键 + 保留源头
 * Cache-Control」的二进制处理（不编 fi-lang / fi-ua，命中时也不剥 max-age，否则浏览器每次都重取图）。
 * 安全性由接口自身把关：受限期件（待审/付费未购）返回 `private, no-store` 或直接抛错，
 * `storeEligible()` 一律拒绝；且本路径要求无登录轨 Cookie（`isFileCacheEligible`），
 * 已购用户的副本不会写进游客缓存。
 * `/api/attachments/:aid/download` 必须继续在列外：它带扣费与权限语义。
 */
const BINARY_PUBLIC: ReadonlyArray<RegExp> = [/^\/api\/attachments\/\d+\/preview$/];

/** 请求里登记了 Set-Cookie 的全部值（Workers 与 Node 均有 getSetCookie；老环境回退单值读取） */
function setCookieList(h: Headers): string[] {
  const maybe = h as unknown as { getSetCookie?: () => string[] };
  if (typeof maybe.getSetCookie === 'function') return maybe.getSetCookie();
  const single = h.get('set-cookie');
  return single ? [single] : [];
}

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

/**
 * 请求的语言维度（缓存键用）：cookie 偏好 > Accept-Language 匹配 > 缺省（undefined）。
 * 与 i18n 中间件协商的前两档逐项一致 —— 第三档站点语言不参与分键（无 cookie 且浏览器语言
 * 未命中时全站同一份副本）。两处必须共用 acceptLangOf，否则协商结果与缓存键会漂移。
 */
function reqLangOf(cookie: string | null, acceptLanguage: string | null): string | undefined {
  return langCookieOf(cookie) ?? acceptLangOf(acceptLanguage) ?? undefined;
}

function bucket(): Bucket | null {
  return typeof caches === 'undefined' ? null : caches.default;
}

/**
 * 键 URL：把 UA 分类塞进查询串参数 `fi-ua`（原查询保留）。
 * Cloudflare 缓存键只认 URL，不认 Vary，这是浏览器/爬虫共用一个 URL 时唯一的隔离手段。
 * `fi-lang`：API 响应内容会随语言协商而不同（i18n 中间件：cookie 偏好 > 浏览器 Accept-Language），
 * 故把协商出的语言编进键，避免不同语言用户互串缓存副本；两者都未命中共用缺省键。
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
 * 写入门槛：200、Set-Cookie **只允许 csrf 签发**、且响应未声明不可缓存（错误信封由 envelope 统一打 no-store）。
 *
 * 为什么放宽：csrf 中间件对每个「还没有 csrf Cookie」的 GET 都会签发一条，而此前「有 Set-Cookie 就不写」
 * 让新访客的响应连回填资格都没有（每个真首访都要冷穿透 D1）。缓存副本会剥掉这条头（见 cachedCopy），
 * 命中 HIT 时按需补签，语义与 csrf 中间件一致。登录轨 Cookie（sid/at/admin_at）仍一律拒绝——
 * 被缓存吞掉就是认证态丢失。
 */
function storeEligible(res: Response): boolean {
  if (res.status !== 200) return false;
  for (const cookie of setCookieList(res.headers)) {
    if (!/^\s*csrf=/.test(cookie)) return false;
  }
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
  /* Set-Cookie 不进副本：唯一被放行的 Set-Cookie 是 csrf 签发，而 HIT 分支会给缺 Cookie 的访客
   * 现场补签一条新的（随机值），因此副本里那条既无用又会让「同一份副本发给所有人」变成隐患。 */
  headers.delete('set-cookie');
  // keepCacheControl（/files/* 与公共图片）：保留源头的 public max-age（含 immutable），仅剥命中标记
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
 * 「与访问者无关」的只读端点白名单：即使请求携带登录轨 Cookie 也允许命中/回填边缘缓存。
 *
 * 依据：这些响应体里没有任何按 uid/gid 定制的字段（排行榜只有 tid/subject 或 uid/username/avatar；
 * 注入位/快捷回复是站点级配置；在线数是一个数字），游客副本与登录副本逐字节等价。
 *
 * 为什么必须单独开一档：PERSONAL_COOKIE 是「响应可能按用户定制」的保守近似，代价是**登录用户
 * （含站长）每一次刷新都要冷穿透整条链路**——首页右栏的排行卡各有 1 次 Worker 调用 + 1 次
 * session 查询 + 1 次 D1，明明数据是全网同值的。放开这一档后，登录用户的右栏聚合接口可直接
 * 200ms 内从边缘 HIT（TTL 600s/3600s），这是右栏显示速度最直接的改善。
 *
 * 边界：**不放**任何做版块可读性过滤的端点（如 /api/threads/hot-favorites、/api/related-threads）——
 * 它们的结果随 viewer 的 gid 变化，置入本白名单会让登录用户看到游客副本（漏内容）。
 */
const PUBLIC_READONLY: ReadonlyArray<RegExp> = [
  /^\/api\/rank\/(?:threads|users|forum)$/,
  /^\/api\/insert-codes$/,
  /^\/api\/quick-reply-message$/,
  /^\/api\/online$/,
];

/**
 * 参与资格判定：无 Authorization，且（无登录轨 Cookie（sid/at/admin_at）或命中公共只读白名单）即可。
 * 旧口径额外要求「已持有 csrf Cookie」，等价于把所有真首访挡在边缘缓存之外——每个新访客的
 * /api/bootstrap 都要冷穿透整条 D1 链路（实测首访 TTFB 2~3s 的主要来源）。csrf 门禁的存在意义
 * 只是保证 Set-Cookie 签发不被缓存吞掉，现改为 HIT 分支主动补签（见 edgeCache 内注释），
 * 该前提不再需要。
 */
function isCacheEligible(req: { headers: Headers }, path: string): boolean {
  if (req.headers.has('authorization')) return false;
  if (!PERSONAL_COOKIE.test(req.headers.get('cookie') ?? '')) return true;
  return PUBLIC_READONLY.some((re) => re.test(path));
}

/** csrf Cookie 名（与 middleware/csrf.ts 同口径） */
const CSRF_COOKIE = /(?:^|;\s*)csrf=/;

/**
 * 随机 csrf token（16 字节 hex）：镜像 middleware/csrf.ts 的 randomToken。
 * 不直接反向 import middleware（core 层不依赖 middleware），两处改动需同步。
 */
function randomToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
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
      /* 二进制类（R2 直链图片 + 附件预览）与 JSON 接口的处理差异见 BINARY_PUBLIC 注释 */
      const binary = filePrefix || BINARY_PUBLIC.some((re) => re.test(c.req.path));
      const ttl = API_TTL.find(([re]) => re.test(c.req.path))?.[1];
      if (!ttl && !binary) return next();
      // 资格口径分三档（见各函数注释）：/files 公共直链最宽；API 默认绕过登录轨；
      // PUBLIC_READONLY 里的公共只读端点对登录轨也放开（响应体与访问者无关）
      if (!(binary ? isFileCacheEligible(raw) : isCacheEligible(raw, c.req.path))) return next();
      const b = bucket();
      if (!b) return next();

      // 二进制对象与 UA/语言无关 → 人类/爬虫、各语言共用一个键（SHARED_UA、不编 fi-lang），命中率最高。
      // JSON 接口仍按 fi-ua 分键隔离爬虫与人类，并编入 lang cookie（合法 locale 才编），
      // 防止语言协商后不同语言用户命中同一份缓存副本。
      const ua = binary ? SHARED_UA : (classifyUserAgent(c.req.header('user-agent') ?? '') as UaClass);
      const lang = binary
        ? undefined
        : reqLangOf(raw.headers.get('cookie'), raw.headers.get('accept-language'));
      const key = keyRequest(raw.url, ua, lang);
      const hit = await b.match(key);
      if (hit) {
        const out = withState(hit, 'HIT');
        /* 缓存副本上的 max-age 只为让 Cloudflare 判定可缓存与 Edge TTL，不能随 HIT 下发给浏览器：
         * HTTP 缓存键不含 Cookie，游客在 30s 窗口内登录后重新拉 /api/bootstrap 会被浏览器喂回
         * 「游客版」（登录成功但顶栏仍是游客）。二进制类例外——图片的 max-age/immutable 必须保留，
         * 否则命中边缘的图片每次刷新都会被浏览器重新取一次。 */
        if (!binary) {
          out.headers.delete('cache-control');
          /* 首访补签 csrf Cookie（镜像 csrf 中间件的 GET 分支：随机 32 hex + SameSite=Lax + Secure 跟随协议）。
           * 游客副本的响应体不含任何 token 或个人数据，补签只影响 Set-Cookie 头；不补的话，
           * 真首访就永远吃不到边缘缓存——每个新访客都得冷穿透整条 D1 链路。 */
          if (!CSRF_COOKIE.test(raw.headers.get('cookie') ?? '')) {
            c.res = out;
            setCookie(c, 'csrf', randomToken(), { path: '/', sameSite: 'Lax', secure: isHttpsRequest(c), httpOnly: false });
            return;
          }
        }
        c.res = out;
        return;
      }
      await next();
      const res = c.res;
      if (!storeEligible(res)) return;
      const copy = cachedCopy(res.clone(), ttl, binary);
      c.res = withState(res, 'MISS');
      wait(b.put(key, copy), maybeCtx(c));
    },
  );
}

/* ==================== SPA 壳 HTML 的边缘缓存 ==================== */

/**
 * 壳 HTML 的 TTL（秒）。
 *
 * 壳页只承载「启用主题 id + 站点语言 + 站点标题/描述」——全是**全站同值**的信息，
 * 与请求路径、访客身份都无关（注入逻辑见 apps/api/src/index.ts 的 injectShell）。
 * 因此整个站点只占**一条**缓存条目、所有深链共用（见 shellKeyRequest），
 * 命中率不随长尾 URL 摊薄 —— 这是 HTML 缓存最容易做砸的地方。
 *
 * 代价：后台改设置 / 切主题后最长 120s（边缘）+ 120s（浏览器，见下方 max-age 注释）的陈旧窗口。
 * 站长轨（admin_at）跳过读缓存；硬刷新可同时绕过浏览器缓存，自查即时。
 *
 * 取值从 60 提到 120：壳内容变化只由「改设置/切主题/发版」驱动，属低频事件，而每个副本站位都要在
 * 窗口内被读到才算赚回回源（低频站点 60s 常常等不到第二个请求）。发版后旧壳引用已删 hash 的情况由
 * 前端 chunk 自愈重载兜底（窗口 120s，可接受；再长就要按发布节奏重新评估）。
 */
export const SHELL_TTL = 120;

/** 站长轨 Cookie：改完设置、切完主题当场可见，不被 TTL 挡住 */
const ADMIN_TRACK = /(?:^|;\s*)admin_at=/;

/**
 * 壳页路径判定：只接「干净路径」（无扩展名）的人类页面导航。
 * 排除 /api、/files、/mcp 与一切带扩展名的路径（/assets/*.js、/robots.txt、/sitemap.xml…）：
 * 后者各自有专门的直出/缓存路径，不能被壳缓存抢在前面。
 */
function isShellPath(path: string): boolean {
  if (path === '/api' || path.startsWith('/api/')) return false;
  if (path === '/files' || path.startsWith('/files/')) return false;
  if (path === '/mcp' || path.startsWith('/mcp/')) return false;
  return !/\/[^/]*\.[^/.]+$/.test(path);
}

/**
 * 壳缓存键：**每个 origin 一条固定 URL**，与请求路径无关。
 * 依据：notFound 对任何干净深链都取同一份 /index.html，再注入同一组全站同值信息，
 * 所以深链之间可以共用一份副本（键里也不需要语言维度 —— 站点语言只有一种）。
 * `/__fi/spa-shell` 是纯键名，不对应任何真实资源，永远不会被请求。
 */
function shellKeyRequest(origin: string): Request {
  return new Request(`${origin}/__fi/spa-shell`, { method: 'GET' });
}

/**
 * 壳缓存中间件（注册在 runlevel 之后）：
 * 命中即返回，省掉「ASSETS.fetch 取 index.html」子请求 + 主题/设置装载 + 字符串注入；
 * 未命中则照常走完整链路，并把产物回填。
 *
 * 不接爬虫：它们的正文 HTML 由 prerender() 产出并有自己的边缘条目（键按 fi-ua 隔离）。
 * 不接非正常档位：壳页 200 会让访客以为站点正常，而所有接口都在报错。
 */
export function shellCache() {
  return createMiddleware<{ Bindings: Env; Variables: { db: D1b; cache: Cache; runlevel: number } }>(
    async (c, next) => {
      if (c.req.method !== 'GET') return next();
      if (!isShellPath(c.req.path)) return next();
      if (classifyUserAgent(c.req.header('user-agent') ?? '') !== 'human') return next();
      if (Number(c.get('runlevel') ?? RunLevel.NORMAL) !== RunLevel.NORMAL) return next();
      const b = bucket();
      if (!b) return next();

      const key = shellKeyRequest(new URL(c.req.url).origin);
      if (!ADMIN_TRACK.test(c.req.header('cookie') ?? '')) {
        const cached = await b.match(key);
        if (cached) {
          const out = withState(cached, 'HIT');
          /* 浏览器侧短缓存与 SHELL_TTL 同值：壳内容全站同值（标题/语言/主题/预载清单），站点已接受
           * 同级边缘陈旧窗口，浏览器再吃一次即可把 F5/回访的整次回源 RTT（跨境 ~0.5s+）直接省掉。
           * 发版后旧壳引用已删除 asset hash 的白屏由前端 chunk 自愈重载兜底（与边缘副本同一路径），
           * 最坏窗口 = 2×SHELL_TTL；站长硬刷新（Ctrl/Cmd+R）不受 max-age 影响，仍即时可见。 */
          out.headers.set('cache-control', `public, max-age=${SHELL_TTL}`);
          c.res = out;
          return;
        }
      }

      await next();
      const res = c.res;
      if (res.status !== 200) return;
      if (res.headers.has('set-cookie')) return;
      if (!(res.headers.get('content-type') ?? '').includes('text/html')) return;
      /* 浏览器缓存 HIT/MISS 同口径：MISS 也下发 max-age，否则首次访问不缓存、60s 内刷新又变回回源，
       * 与 HIT 行为不对称（浏览器在两次导航间无法区分边缘是否命中）。 */
      res.headers.set('cache-control', `public, max-age=${SHELL_TTL}`);
      const copy = cachedCopy(res.clone(), SHELL_TTL);
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
