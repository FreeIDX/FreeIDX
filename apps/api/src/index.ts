/**
 * Hono 入口（§D.0 Workers 映射）。
 * T0-6：错误信封 {code,message,...} + CORS + runlevel 占位 + GET /api/health。
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { AVAILABLE_LOCALES } from '@freeidx/shared';
import type { Env } from './types/env';
import { D1b } from './core/db';
import { Cache } from './core/cache';
import { edgeCache } from './core/cache/edge';
import { ok, handleError, handleNotFound } from './middleware/envelope';
import { runlevel } from './middleware/runlevel';
import { csrf } from './middleware/csrf';
import { adminGuard } from './middleware/admin';
import { canonicalHostRedirect } from './middleware/canonical-host';
import { requestOrigin } from './core/site';
import { handleScheduled } from './core/cron';
import { getExtensions } from './core/extensions';
import { classifyUserAgent, matchRegisteredPath } from './core/crawler';
import { prerender, seoCoreRoutes } from './modules/seo/core';
import { loadSetting } from './core/loaders';
import { loadThemeId } from './core/theme';
import { createApiT, t0, type ApiT } from './core/i18n';
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
import { adminRuntimeRoutes } from './modules/admin/runtime';
import { adminMaintenanceRoutes } from './modules/admin/maintenance';
import { adminExtensionsRoutes } from './modules/admin/extensions';
import { adminCheckRoutes } from './modules/admin/check';
import { adminEmailRoutes } from './modules/admin/email';
import { adminPaymentRoutes } from './modules/admin/payment';
import { adminPointRoutes } from './modules/admin/points';
import { adminNoticeRoutes } from './modules/admin/notices';
import { adminVRoutes } from './modules/admin/v';
import { registerCard } from './extensions/card';
import { registerStripe } from './extensions/stripe';
import { registerPaypal } from './extensions/paypal';

// L1 支付通道编译期装配（§15.5）：核心 payment/registry 无通道代码，通道插件在组合根登记自身。
// card 出厂启用（零依赖兜底）；stripe / paypal 出厂安装但停用（后台填密钥即热启用）。
// alipay 依 §19 决策 + 商户资质（G5 门禁）与证书/RSA2 联调环境，属外部阻塞项；凭证就绪后以同形态 register* 接入。
registerCard();
registerStripe();
registerPaypal();

type AppEnv = { Bindings: Env; Variables: { db: D1b; cache: Cache; runlevel: number; t: ApiT } };

const app = new Hono<AppEnv>();

// per-request D1 封装挂载（查询计数器随请求生命周期，§7 预算守卫）
app.use('*', async (c, next) => {
  c.set('db', D1b.of(c.env.DB));
  c.set('cache', new Cache(c.env, c.get('db')));
  await next();
  const stats = c.get('db').stats;
  if (stats.d1Queries > 40) c.res.headers.set('X-Db-Queries-Warn', String(stats.d1Queries));
});

app.use(
  '*',
  cors({
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
    allowHeaders: ['Content-Type', 'X-CSRF-Token'],
    exposeHeaders: ['X-Db-Queries-Warn', 'X-Edge-Cache'],
  }),
);
// 多域名收敛（canonical host）：页面导航落到非主域名时 301 到后台「站点网址」。
// 必须紧跟 cors（跳转响应同样要带跨域头），先于 edgeCache（避免备用域命中缓存后无法收敛）。
app.use('*', canonicalHostRedirect());

// 边缘响应缓存（§7 读取屏障）：游客匿名只读接口命中即返回，不走 runlevel 的 setting 查询。
// 必须挂在 cors 之后（命中响应同样要带跨域头）、runlevel 之前（否则省不掉 D1 读）。
app.use('*', edgeCache());
// 词条翻译器（i18n 基建）：语言协商挂 c.set('t')（读穿缓存，命中零 D1）；
// 挂在 edgeCache 之后——边缘缓存命中时响应已定稿，不执行；/api/health 与 runlevel 同口径跳过（不查库）；
// setting 装载失败（如 kv 损坏/缓存绑定缺失）回落 zh-cn 缺省翻译器，不阻断请求。
// 协商优先级（§10.3 前台语言 = 用户偏好 > 站点语言，此前仅界面成立、API 消息断链）：
//  - /api/admin/*：adminLang（后台界面语言独立于前台，不受用户 cookie 影响）；
//  - 其余前台接口：cookie `lang`（LangSwitch setPref 写入，非 httpOnly，同域自动携带；
//    值必须在 AVAILABLE_LOCALES 内，非法值忽略）> setting.lang。
// SEO 产物（sitemap/prerender）是全站性内容，仍按 setting.lang 生成，不参与用户协商。
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
        : (cookieLangOf(c.req.header('cookie')) ?? setting.lang);
      c.set('t', createApiT(lang));
    } catch {
      c.set('t', t0);
    }
  }
  await next();
});
app.use('*', runlevel);
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
// M3 后台（T3-7）：modlog 面板、runtime 统计面板（三预算实测）、缓存一键清空
app.route('/', adminRuntimeRoutes());
// M3 后台（T3-11）：运行维护 —— 数据库孤儿/失效清理（分批）+ R2 未使用对象扫描与删除
app.route('/', adminMaintenanceRoutes());
// M3 后台（T3-9）：扩展启停/配置 + ads 广告位 CRUD（§17.5）
app.route('/', adminExtensionsRoutes());
// 邮箱设置（§11.3）：EmailProvider 的后台配置端点（SMTP 的 Workers 等价物）
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
// SEO 核心保底（robots.txt 装配引擎，§16.4 不可停用）
app.route('/', seoCoreRoutes());
// 后续模块逐个挂载（forum/post/my/mod/attach/admin/kv）

app.onError(handleError);

/**
 * SPA 壳的主题注入：把启用主题 id 写进 `window.__FI_THEME__`，前端在首屏渲染前读取，
 * 避免「先渲染默认主题再换肤」的闪烁，同时省掉一次 /api/theme/active 引导请求。
 * 注入失败（读壳失败/无 </head>）一律原样返回，主题引导会回落同名接口，不影响可用性。
 */
async function injectThemeId(res: Response, themeId: string): Promise<Response> {
  try {
    const html = await res.text();
    const script = `<script>window.__FI_THEME__=${JSON.stringify(themeId)}</script>`;
    // 优先注入 </head>（脚本在任何业务脚本之前求值）；无 head 时退化到 </body>；都没有则原样返回文本
    const out = html.includes('</head>')
      ? html.replace('</head>', `${script}</head>`)
      : html.includes('</body>')
        ? html.replace('</body>', `${script}</body>`)
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
// 否则 BrowserRouter 深链直访会拿到 JSON 404。/api、/files 保持 JSON，其余转交静态资源，
// 由 not_found_handling="single-page-application" 回退 index.html（爬虫分支已在 prerender() 处理）。
app.notFound(async (c) => {
  const p = c.req.path;
  if (p === '/api' || p === '/files' || p.startsWith('/api/') || p.startsWith('/files/')) {
    return handleNotFound(c);
  }
  const res = await c.env.ASSETS.fetch(c.req.raw);
  // 拿到的是 SPA 壳（而非真实文件）时，只有人类浏览器的干净路径才允许回退到壳：
  // 爬虫拿到壳页 200 会被当正文收录（§16.1），带扩展名的路径（/sitemap.xml、/xxx.htm）
  // 拿到壳页则意味着插件路由未注册，同样必须 404。
  const fileLike = /\/[^/]*\.[^/.]+$/.test(p);
  const bot = classifyUserAgent(c.req.header('user-agent') ?? '') === 'searchbot';
  if (!res.headers.get('content-type')?.includes('text/html')) return res;
  if (fileLike || bot) return handleNotFound(c);
  const themeId = await loadThemeId(c.get('cache'), c.get('db'));
  return injectThemeId(res, themeId);
});

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};

export { app };
