/**
 * Hono 入口（§D.0 Workers 映射）。
 * T0-6：错误信封 {code,message,...} + CORS + runlevel 占位 + GET /api/health。
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE, localizedSetting, siteDescriptionOf, siteTitleOf } from '@freeidx/shared';
import type { Env } from './types/env';
import { D1b } from './core/db';
import { Cache } from './core/cache';
import { edgeCache, shellCache } from './core/cache/edge';
import { ok, handleError, handleNotFound } from './middleware/envelope';
import { runlevel } from './middleware/runlevel';
import { csrf } from './middleware/csrf';
import { banGuard } from './middleware/ban';
import { adminGuard } from './middleware/admin';
import { canonicalHostRedirect } from './middleware/canonical-host';
import { requestOrigin } from './core/site';
import { handleScheduled } from './core/cron';
import { getExtensions } from './core/extensions';
import { classifyUserAgent, matchRegisteredPath } from './core/crawler';
import { prerender, seoCoreRoutes } from './modules/seo/core';
import { loadSetting } from './core/loaders';
import { loadPreloadMap, shellPreloadTags } from './core/preload-map';
import { loadThemeId } from './core/theme';
import { escAttr } from './core/fmt';
import { acceptLangOf, createApiT, t0, type ApiT } from './core/i18n';
import { threadRoutes } from './modules/thread/routes';
import { bootstrapRoutes } from './modules/bootstrap/routes';
import { userRoutes } from './modules/user/routes';
import { authRoutes } from './modules/auth/routes';
import { writeRoutes } from './modules/write/routes';
import { attachRoutes } from './modules/attach/routes';
import { myRoutes } from './modules/my/routes';
import { noticeRoutes } from './modules/notice/routes';
import { pointsRoutes } from './modules/points/routes';
import { creditsRoutes } from './modules/credits/routes';
import { orderRoutes } from './modules/order/routes';
import { paymentRoutes } from './modules/payment/routes';
import { modRoutes } from './modules/mod/routes';
import { checkRoutes } from './modules/check/routes';
import { rankRoutes } from './modules/rank/routes';
import { vRoutes } from './modules/v/routes';
import { pluginsRoutes } from './modules/plugins/routes';
import { themeRoutes } from './modules/theme/routes';
import { adminRoutes } from './modules/admin/routes';
import { adminForumRoutes } from './modules/admin/forums';
import { adminUserRoutes } from './modules/admin/users';
import { adminBanRoutes } from './modules/admin/ban';
import { adminRuntimeRoutes } from './modules/admin/runtime';
import { adminMaintenanceRoutes } from './modules/admin/maintenance';
import { adminExtensionsRoutes } from './modules/admin/extensions';
import { adminCheckRoutes } from './modules/admin/check';
import { adminEmailRoutes } from './modules/admin/email';
import { adminPaymentRoutes } from './modules/admin/payment';
import { adminPointRoutes } from './modules/admin/points';
import { adminNoticeRoutes } from './modules/admin/notices';
import { adminVRoutes } from './modules/admin/v';
import { adminMcpRoutes } from './modules/admin/mcp';
import { registerCard } from './extensions/card';
import { registerStripe } from './extensions/stripe';
import { registerPaypal } from './extensions/paypal';

// L1 支付通道编译期装配（§15.5）：核心 payment/registry 无通道代码，通道插件在组合根登记自身。
// card 出厂启用（零依赖兜底）；stripe / paypal 出厂安装但停用（后台填密钥即热启用）。
// alipay 依 §19 决策 + 商户资质（G5 门禁）与证书/RSA2 联调环境，属外部阻塞项；凭证就绪后以同形态 register* 接入。
registerCard();
registerStripe();
registerPaypal();

type AppEnv = { Bindings: Env; Variables: { db: D1b; cache: Cache; runlevel: number; t: ApiT; lang?: string } };

const app = new Hono<AppEnv>();

// per-request D1 封装挂载（查询计数器随请求生命周期，§7 预算守卫）
app.use('*', async (c, next) => {
  c.set('db', D1b.of(c.env.DB));
  c.set('cache', new Cache(c.env, c.get('db')));
  await next();
  const stats = c.get('db').stats;
  if (stats.d1Queries > 40) c.res.headers.set('X-Db-Queries-Warn', String(stats.d1Queries));
});

/**
 * CORS 只挂 /api（历史上是 `'*'`）：壳页与静态资源都是同源访问，跨域头对它们毫无意义，
 * 却会带来两个真实副作用 ——
 *   ① `Vary: Origin` 让 CDN/浏览器把壳页视为按 Origin 变化，直接挡掉壳页的边缘缓存；
 *   ② 每个 HTML 响应白背 ~200 字节的 ACAO/ACEH/expose 头。
 * 收窄后壳页响应只剩内容协商本身的头，可被 shellCache() 正常缓存。
 */
const corsMiddleware = cors({
  // 白名单化（§20.4 安全项）：credentials:true 下反射任意 Origin = 任意外站可携 Cookie 跨域读响应。
  // 多域名部署下「站点自身域」按请求 Host 动态判定（各绑定域名各自同源），另放行本地 dev（vite 5173，
  // dev proxy /api→8787 为同源请求）；白名单外一律回落请求域——ACAO 与请求 Origin 不符 → 浏览器直接
  // 拒绝跨域读取，不产生暴露。不读 SITE_URL：部署变量可能未配置或与实际绑定域名不一致。
  origin: (origin, c) => {
    const self = requestOrigin(c);
    if (!origin) return self; // 同源/curl：不构成跨域暴露
    const allow = new Set([self, 'http://localhost:5173', 'http://127.0.0.1:5173']);
    return allow.has(origin) ? origin : self;
  },
  credentials: true,
  // Authorization：MCP 端点（/mcp）用 Bearer 令牌鉴权，浏览器型 MCP 客户端会带它做 preflight；
  // Mcp-Protocol-Version / MCP-Protocol-Version：客户端协商协议版本用，不放行会被预检拦掉
  allowHeaders: ['Content-Type', 'X-CSRF-Token', 'Authorization', 'Mcp-Protocol-Version', 'MCP-Protocol-Version'],
  exposeHeaders: ['X-Db-Queries-Warn', 'X-Edge-Cache', 'MCP-Protocol-Version'],
});
/**
 * 只对 /api（含裸 `/api`）生效。用显式判断而不是 `app.use('/api/*')`：
 * Hono 的 cors 用 `headers.append('Vary', 'Origin')`，同一请求命中两条挂载会写成
 * "Origin, Origin"，比不收窄还脏。
 */
app.use('*', async (c, next) => {
  if (c.req.path !== '/api' && !c.req.path.startsWith('/api/')) return next();
  return corsMiddleware(c, next);
});
// 多域名收敛（canonical host）：页面导航落到非主域名时 301 到后台「站点网址」。
// 先于 edgeCache / shellCache（避免备用域命中缓存后无法收敛）；两个缓存都以 origin 为键，
// 收敛必须在它们之前发生。
app.use('*', canonicalHostRedirect());

// 边缘响应缓存（§7 读取屏障）：游客匿名只读接口命中即返回，不走 runlevel 的 setting 查询。
// 必须挂在 cors 之后（命中响应同样要带跨域头）、runlevel 之前（否则省不掉 D1 读）。
app.use('*', edgeCache());
// 词条翻译器（i18n 基建）：语言协商挂 c.set('t')（读穿缓存，命中零 D1）；
// 挂在 edgeCache 之后——边缘缓存命中时响应已定稿，不执行；/api/health 与 runlevel 同口径跳过（不查库）；
// setting 装载失败（如 kv 损坏/缓存绑定缺失）回落 zh-cn 缺省翻译器，不阻断请求。
// 协商优先级（前台语言 = 用户偏好 > 浏览器语言 > 站点语言，与 lib/i18n 的 useLang 逐项一致）：
//  - /api/admin/*：adminLang（后台界面语言独立于前台，不受用户 cookie 与浏览器影响）；
//  - 其余前台接口：cookie `lang`（LangSwitch setPref 写入，非 httpOnly，同域自动携带；
//    值必须在 AVAILABLE_LOCALES 内，非法值忽略）> Accept-Language 匹配到的可选 locale > setting.lang。
// SEO 产物（sitemap/prerender）是全站性内容，仍按 setting.lang 生成，不参与用户协商。
//
// ⚠️ 审计结论（别再尝试「给静态路径收窄本中间件以省 KV/读」）：
//  - 本中间件的 loadSetting 与 runlevel（紧随其后，除 /api/health 与 /mcp 外所有路径都要查档位）、
//    notFound 的壳注入共用同一次装载（remember 的请求级去重，见 core/cache/index.ts 的 loaded），
//    即一次请求只有 1 次真实读；
//  - 因此「跳过 i18n」既不省 KV 读也不省 D1 读——省下的只有一次 Map 查找，而档位闸门仍要读同一个 key；
//    真正决定读数速率的是 core/cache/index.ts 的 L0_MAX_TTL（30s）：它决定「每 isolate 每 30s 最多
//    1 次 KV 读」，调大等于放大后台设置的跨 isolate 生效延迟，属产品参数而非代码优化；
//  - 兜底已就位：envelope 的 tOf 与 runlevel 的 `?? t0` 都按 zh-cn 取词，缺 t 不会变成 500。
function cookieLangOf(header: string | undefined): string | null {
  const m = /(?:^|;\s*)lang=([^;]+)/.exec(header ?? '');
  if (!m?.[1]) return null;
  try {
    const v = decodeURIComponent(m[1]).toLowerCase();
    return AVAILABLE_LOCALES.includes(v) ? v : null;
  } catch {
    return null;
  }
}
app.use('*', async (c, next) => {
  if (c.req.path !== '/api/health') {
    try {
      const setting = await loadSetting(c.get('cache'), c.get('db'));
      const lang = c.req.path.startsWith('/api/admin/')
        ? setting.adminLang || setting.lang
        : (cookieLangOf(c.req.header('cookie')) ??
           acceptLangOf(c.req.header('accept-language')) ??
           setting.lang);
      c.set('t', createApiT(lang));
      /* 供 runlevel 等后续中间件按同一口径取用（如站点关闭原因的多语言文案） */
      c.set('lang', lang);
    } catch {
      c.set('t', t0);
    }
  }
  await next();
});
app.use('*', runlevel);
/**
 * 壳页（SPA HTML）边缘缓存：必须挂在 runlevel **之后** ——
 * 关闭/只读档位不缓存壳，否则访客会看到「正常打开」的页面而接口全在报错。
 * 命中即省掉「ASSETS.fetch 取 index.html + 主题/设置装载 + 注入」整段；
 * 键与请求路径无关，全站深链共用一条副本（见 core/cache/edge.ts 的 shellCache）。
 */
app.use('*', shellCache());
// 小黑屋闸门（0025）：禁言/禁访/禁登按位拦截，须在 runlevel 之后（借其 setting 装载）、csrf 之前
// （被封用户的写请求无需再付一次 CSRF 校验）。/api/auth/* 与 /api/admin/* 在中间件内豁免。
app.use('*', banGuard());
// CSRF 双提交（T2-3）：非 GET /api 写请求校验 X-CSRF-Token
app.use('*', csrf);
// 后台守卫（T3-3）：/api/admin/* 需 admin_at 且回查 gid=1，非授权一律 403（后续 admin 路由挂在此后）
app.use('/api/admin/*', adminGuard());

// 爬虫预渲染分发（§16.1 核心管线：searchbot UA + 页面路径 → R2/兜底 HTML；人类 UA 直通）
app.use('*', prerender());

// 契约 ③ registerRoute：插件路由分发。仅在核心路由未命中（404）且为非 /api 路径时接管，
// 核心 /api 预算与 404/405 语义完全不变
app.use('*', async (c, next) => {
  await next();
  if (c.req.path.startsWith('/api/')) return;
  if (c.finalized && c.res.status !== 404) return;
  const rt = await getExtensions(c.get('cache'), c.get('db'));
  const hit = rt.routes.find(
    (r) => (r.method === 'ALL' || r.method === c.req.method) && matchRegisteredPath(r.path, c.req.path),
  );
  if (hit) {
    const res = await (hit.handler as (ctx: unknown) => unknown)(c);
    if (res instanceof Response) c.res = res;
  }
});

app.get('/api/health', (c) => {
  const db = c.get('db');
  return ok(c, 'ok', { data: { status: 'ok', version: '0.1.0', queries: db.stats.d1Queries } });
});

// M1 只读接口（T1-4）；写接口/鉴权在 M2 挂载
app.route('/', bootstrapRoutes());
app.route('/', threadRoutes());
app.route('/', userRoutes());
// M2 鉴权接口（T2-4）：/api/auth/* CSRF 豁免（Turnstile+频控覆盖），双轨签发在路由内完成
app.route('/', authRoutes());
// M2 内容写接口（T2-6）：发帖/回帖/编辑/删除，写时定稿 + DB.batch 事务 + 事件发射
app.route('/', writeRoutes());
// M2 附件（T2-8）：R2 上传/预览/下载/删除 + /files 流式直链 + 发帖关联
app.route('/', attachRoutes());
// M2 会员自助（T2-9）：头像上传（R2 + 时间戳缓存串）
app.route('/', myRoutes());
// 消息系统（huux_notice）：我的消息列表/已读/删除
app.route('/', noticeRoutes());
// M5 会员积分（T5-1）：GET /api/me/points 余额+流水分页
app.route('/', pointsRoutes());
// 积分交易（tt_credits）：付费主题购买/购买记录/积分面板/兑换/转账/变动记录/已购
app.route('/', creditsRoutes());
// M5 会员订单（T5-3）：计划/下单/查单状态机
app.route('/', orderRoutes());
// M5 支付核心（T5-4）：webhook 分发 + 订单 checkout 装配（通道无关，插件提供 Provider）
app.route('/', paymentRoutes());
// M3 版务批量（T3-1）：置顶/关闭/删除/移动/精华 + modlog
app.route('/', modRoutes());
// 内容审核（tt_check）：前台审核/回收站操作（后台审核按钮复用同一路由）
app.route('/', checkRoutes());
// 排行榜：首页右栏主题榜/用户榜、版块热门、个人中心排行榜单
app.route('/', rankRoutes());
// 加V认证：申请/重新提交 + 收费扣费（后台审核接口在 admin/v）
app.route('/', vRoutes());
// 遗留功能扩展公开读取端点（idx_quick_reply 快速回复下拉数据 / idx_insert_code 八注入位 HTML）
app.route('/', pluginsRoutes());
// 主题管理：GET /api/theme/active（公开）+ GET/PUT /api/admin/theme（切启用主题，只写 kv theme）
app.route('/', themeRoutes());
// M3 后台（T3-4）：站点设置读写（adminGuard 已在上方注册覆盖 /api/admin/*）
app.route('/', adminRoutes());
// M3 后台（T3-5）：版块 CRUD + access 矩阵、主题管理列表、计数校准
app.route('/', adminForumRoutes());
// M3 后台（T3-6）：用户 CRUD + 用户组 12 项权限矩阵（§D.8#5 版务位仅 gid 1-5）
app.route('/', adminUserRoutes());
// 后台小黑屋（0025）：封禁/解封/生效列表/历史/批量（adminGuard 已覆盖 /api/admin/*）
app.route('/', adminBanRoutes());
// M3 后台（T3-7）：modlog 面板、runtime 统计面板（三预算实测）、缓存一键清空
app.route('/', adminRuntimeRoutes());
// M3 后台（T3-11）：运行维护 —— 数据库孤儿/失效清理（分批）+ R2 未使用对象扫描与删除
app.route('/', adminMaintenanceRoutes());
// M3 后台（T3-9）：扩展启停/配置 + ads 广告位 CRUD（§17.5）
app.route('/', adminExtensionsRoutes());
// 邮箱设置（§11.3）：HTTP 邮件 API 账号池的后台配置端点
app.route('/', adminEmailRoutes());
// M5 后台（T5-7）：VIP 计划 CRUD + 订单查询/退款/补单 + 卡密批量生成（§15.4，通道启停/密钥走通用 extensions）
app.route('/', adminPaymentRoutes());
// 积分管理（本项目新增）：用户积分台账 + 手工调整 + 流水查询（奖励三键走 setting 白名单）
app.route('/', adminPointRoutes());
// 消息管理（huux_notice 后台）：全部消息列表 + 发送系统通知 + 删除
app.route('/', adminNoticeRoutes());
// 内容审核后台（tt_check）：三道审核队列 + 回收站 + 矩阵设置 + 清空回收站
app.route('/', adminCheckRoutes());
// 加V认证后台：审核两列表 + 通过/拒绝 + 手动加V + 收费参数
app.route('/', adminVRoutes());
// MCP 服务（插件 id=mcp）后台：个人访问令牌 CRUD（明文只在创建响应出现一次）
app.route('/', adminMcpRoutes());
// SEO 核心保底（robots.txt 装配引擎，§16.4 不可停用）
app.route('/', seoCoreRoutes());
// 后续模块逐个挂载（forum/post/my/mod/attach/admin/kv）

app.onError(handleError);

/**
 * 中文字体「第 00 片」路径（完整分片清单见 apps/web/src/styles/font-faces.generated.css，
 * 改分片参数须同步本处文件名 —— 两边对不上就是白下一个 404）。
 *
 * 只预载第 00 片：它是 UI 文案 + 最常用汉字，任何中文页面都会用到（约 123KB）；
 * 其余 11 片由浏览器按 unicode-range 在真实渲染到片内字符时才取，提前预载等于白下。
 * 仅中文界面预载：非中文界面根本不引用这套字体（见 globals.css 的 --font-app）。
 */
const CJK_FONT_URL = '/fonts/HarmonyOS_Sans_SC_Medium.subset.v2-00.woff2';

/**
 * SPA 壳引导注入：在业务脚本之前写死「启用主题 id + 前台语言」，前端首帧即可用。
 *
 *  - `window.__FI_THEME__`：省掉一次 /api/theme/active 引导请求，也避免「先默认主题再换肤」的闪烁；
 *  - `window.__FI_LANG__`：**站点语言**。前端据此直接拉对应语言包——此前首帧只能按
 *    localStorage/DEFAULT_LOCALE(en-us) 猜，中文站点首访会先下 en-us 包、渲染一帧英文，
 *    bootstrap 到达后再补下 zh-cn 包（实测同一页面下载两个词典 chunk）。
 *  - `<html lang>`：落 CSS 用的语言标记，让 --font-app 从一开始就选中正确字体。按完整协商链取值：
 *    用户偏好（localStorage）> 浏览器语言（navigator.languages）> 站点语言 —— 与 lib/i18n 的
 *    initialLocale 同序，避免首帧先按站点语言下字体、挂载后再换（中文站点的英文浏览器访客同理）。
 *  - 中文界面顺带预载字体第 00 片：该片是 UI 文案用字，任何中文页面必然用到；
 *    等 CSS 解析到 @font-face 才发起太晚，而其余分片按 unicode-range 按需取，不该预载。
 *
 *  - `<title>` / `<meta description>` / OG：壳页本身带有站点级语义，见下方 metaHtml。
 *  - 首屏预载（`preloadHtml`）：词条包的 modulepreload + `/api/bootstrap` 的 fetch preload。
 *    这两项原本都要等入口 chunk 执行后才发起，写进 HTML 就能与入口 chunk 并行下载，
 *    少一个 RTT（生成与匹配见 core/preload-map.ts）。
 *
 * 注入失败（读壳失败/无 </head>）一律原样返回，前端会回落到「同名接口 + 默认主题 + 默认语言」。
 */
async function injectShell(
  res: Response,
  themeId: string,
  siteLang: string,
  site: { title: string; description: string; favicon?: string } | null = null,
  preloadHtml = '',
): Promise<Response> {
  try {
    const html = await res.text();
    /**
     * 内联脚本无法 import，语言匹配规则是 shared/i18n/locales.ts 的 matchBrowserLocale 的**镜像**
     * （完全一致 → 中文按 hant/tw/hk/mo 分流 → 同主语言），改动必须同步两处。
     * 语言清单直接由服务端序列化下发，避免第三处硬编码 AVAILABLE_LOCALES。
     */
    const script =
      `<script>window.__FI_THEME__=${JSON.stringify(themeId)};` +
      `window.__FI_LANG__=${JSON.stringify(siteLang)};` +
      `var FI_L=${JSON.stringify(AVAILABLE_LOCALES)};` +
      `function fiM(a){for(var i=0;i<a.length;i++){var t=String(a[i]||"").toLowerCase().replace(/_/g,"-");` +
      `if(!t)continue;if(FI_L.indexOf(t)>=0)return t;var b=t.split("-")[0];` +
      `if(b==="zh")return /(?:hant|tw|hk|mo)/.test(t)?"zh-tw":"zh-cn";` +
      `for(var j=0;j<FI_L.length;j++)if(FI_L[j].split("-")[0]===b)return FI_L[j]}return null}` +
      `var fiG=null;try{fiG=localStorage.getItem("freeidx.lang")}catch(e){}` +
      `if(!fiG||FI_L.indexOf(fiG)<0)fiG=fiM(navigator.languages||[navigator.language])||${JSON.stringify(siteLang)};` +
      `document.documentElement.lang=fiG;` +
      `try{if(/^zh/.test(fiG)){var k=document.createElement("link");` +
      `k.rel="preload";k.as="font";k.type="font/woff2";k.crossOrigin="";` +
      `k.href=${JSON.stringify(CJK_FONT_URL)};document.head.appendChild(k)}}catch(e){}</script>`;
    /**
     * 壳页语义标签：`index.html` 的 `<title>` 是构建期占位（构建时读不到后台设置），
     * 这里替换为「站点名 + 一句话定位」，并补 description / OG。
     * 只对人类请求生效——爬虫在 prerender() 就被预渲染正文接管，不走这条分支。
     * 内页标题在 JS 就绪后由前端路由覆写，两边都用 shared/site-text 的口径，不会前后不一致。
     * 注意**不给** canonical：壳页服务的是任意深链，写死首页地址会让搜索引擎把深链都收敛到首页。
     */
    const metaHtml = site
      ? [
          /* 站点图标前置注入（后台 favicon_url，R2 site/ 直链）：浏览器解析到 link[rel=icon] 后
           * 不会再盲请求 /favicon.ico（那会白付一次 Worker 全链路再 404）；图标随 HTML 即时出现，
           * 不必等 JS 启动后由 App.tsx 再设。爬虫侧 prerender 早已注入同一字段（seo/core.ts）。 */
          site.favicon ? `<link rel="icon" href="${escAttr(site.favicon)}">` : '',
          site.description ? `<meta name="description" content="${escAttr(site.description)}">` : '',
          `<meta property="og:type" content="website">`,
          `<meta property="og:title" content="${escAttr(site.title)}">`,
          site.description ? `<meta property="og:description" content="${escAttr(site.description)}">` : '',
        ].join('')
      : '';
    const shell =
      site && /<title>[\s\S]*?<\/title>/i.test(html)
        ? html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${escAttr(site.title)}</title>`)
        : html;
    // 优先注入 </head>（脚本在任何业务脚本之前求值）；无 head 时退化到 </body>；都没有则原样返回文本
    const out = shell.includes('</head>')
      ? shell.replace('</head>', `${preloadHtml}${metaHtml}${script}</head>`)
      : shell.includes('</body>')
        ? shell.replace('</body>', `${preloadHtml}${metaHtml}${script}</body>`)
        : null;
    if (out === null) return new Response(html, res);
    const headers = new Headers(res.headers);
    // 文本已解码重写，长度/校验头与编码头全部失效，交给运行时重新编码
    headers.delete('content-length');
    headers.delete('etag');
    headers.delete('content-encoding');
    return new Response(out, { status: res.status, statusText: res.statusText, headers });
  } catch {
    return res;
  }
}

// 合并部署：run_worker_first 让所有请求先进 Worker，未匹配路由必须自己兜底，
// 否则 BrowserRouter 深链直访会拿到 JSON 404。/api、/files 保持 JSON；
// 干净路径由本函数显式取 index.html 壳（爬虫分支已在 prerender() 处理），
// 带扩展名的路径一律 404 —— 静态层是 not_found_handling="none"，不会拿 HTML 顶替缺失的 .js。
app.notFound(async (c) => {
  const p = c.req.path;
  if (p === '/api' || p === '/files' || p.startsWith('/api/') || p.startsWith('/files/')) {
    return handleNotFound(c);
  }
  /**
   * MCP 端点必须是 JSON：插件停用 / 方法不匹配（GET）/ 路径写错时，
   * 若落进下面的 SPA 壳分支会返回 text/html 200，MCP 客户端只会报「响应无法解析」，
   * 排查成本极高。这里固定回 404 JSON，并给出明确原因。
   */
  if (p === '/mcp' || p.startsWith('/mcp/')) {
    return c.json(
      {
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32601,
          message: c.req.method === 'POST' ? 'MCP endpoint is disabled' : 'MCP endpoint accepts POST only',
        },
      },
      404,
    );
  }
  /**
   * 带扩展名的路径（/favicon.ico、/sitemap.xml、/xxx.htm、/assets/xxx.js）：
   * 先按**真实静态文件**取一次 —— public/ 根级文件没有前缀路由，只能落到这里；
   * 命中就原样返回（未命中时资产层是 not_found_handling="none"，回真 404）。
   * 拿到 HTML 一律改回 JSON 404：回壳页不仅误导爬虫，还会让浏览器把 HTML 当 JS 模块加载
   * （发版后旧 hash 的经典表现），前端就只剩「系统繁忙」看不出是资产版本问题。
   */
  const fileLike = /\/[^/]*\.[^/.]+$/.test(p);
  if (fileLike) {
    const asset = await c.env.ASSETS.fetch(c.req.raw);
    if (asset.status >= 400 || asset.headers.get('content-type')?.includes('text/html')) return handleNotFound(c);
    return asset;
  }
  // 爬虫拿壳页 200 会被当正文收录（§16.1）：干净路径也只给人类浏览器
  if (classifyUserAgent(c.req.header('user-agent') ?? '') === 'searchbot') return handleNotFound(c);
  /**
   * 干净路径 = SPA 深链（BrowserRouter）：显式取壳，不依赖资产层 not_found_handling。
   * wrangler.toml 已改为 "none"：静态资源未命中一律真 404，`/assets/*.js` 不会再被 index.html 顶替，
   * 前端据此识别「chunk 不存在」并整页刷新取新版本（见 web 的 lib/chunk-reload）。
   */
  const res = await c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url)));
  if (!res.ok || !res.headers.get('content-type')?.includes('text/html')) return handleNotFound(c);
  const themeId = await loadThemeId(c.get('cache'), c.get('db'));
  // 站点语言：非法/读取失败回落 DEFAULT_LOCALE（与改版前「无注入」时的行为一致）
  const setting = await loadSetting(c.get('cache'), c.get('db')).catch(() => null);
  const siteLang = setting && AVAILABLE_LOCALES.includes(setting.lang) ? setting.lang : DEFAULT_LOCALE;
  /* 站点级语义按站点语言取词（与 newPageMeta 的爬虫产物同一口径，不随访客界面语言变） */
  const site = setting ? localizedSetting(setting, siteLang) : null;
  /**
   * 首屏预载：词条包（`main.tsx` 里唯一阻塞 createRoot 的动态 import）+ bootstrap 请求。
   * 清单读不到（本地 dev / 旧产物）时仍会给出 bootstrap 那一条纯静态标签，功能不受影响。
   */
  const preloadHtml = shellPreloadTags(await loadPreloadMap(c.env, c.req.url), siteLang);
  return injectShell(
    res,
    themeId,
    siteLang,
    site
      ? {
          title: siteTitleOf(site),
          description: siteDescriptionOf(site),
          /* localizedSetting 原样透传非文本字段，favicon_url 可直接取 */
          favicon: site.favicon_url ? String(site.favicon_url) : '',
        }
      : null,
    preloadHtml,
  );
});

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};

export { app };
