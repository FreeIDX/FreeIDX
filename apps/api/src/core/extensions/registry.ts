/**
 * 扩展注册表运行时（T1-8，§12 八项契约的装配侧）：
 *  插件工厂静态编译进 Worker（Workers 无文件系统热加载），
 *  启停只改 kv 表 `extensions` 键（L0+L2 缓存，零部署）——启用即接线，停用即整体绕过。
 */
import type {
  CronRegistration,
  ExtSchema,
  ExtensionManifest,
  ExtensionState,
  PageMeta,
  RobotsContribution,
  RouteRegistration,
} from '@freeidx/shared';
import type { D1b } from '../db';
import type { Cache } from '../cache';
import { remember } from '../cache';
import type { Env } from '../../types/env';
import { EventBus } from './bus';

/** 契约 ③：handler 以 Hono Context 调用，返回值即响应 */
type ExtRouteHandler = (c: unknown) => unknown;

/** 请求态数据访问（装配期注入）：DB 背书的贡献者（如 ads 读广告位/配置）经此取用，契约 fn 签名不变 */
export interface ExtensionCtx {
  db: D1b;
  cache: Cache;
  env?: Env;
}

export interface ExtensionApi {
  /** 请求态 db/cache/env（缺省表示无请求上下文，贡献者须自行短路） */
  readonly ctx?: ExtensionCtx;
  /**
   * 本插件的非敏感配置（`ext:{id}:config`，装配期由 getExtensions 预载注入）。
   * 供同步贡献点（如 robots:contribute）读取以支持开关即时生效；未配置为 {}。
   */
  readonly config: Record<string, unknown>;
  /** 契约 ②：生命周期事件订阅 */
  readonly bus: EventBus;
  /** 契约 ③：Worker 路由（sitemap/llms.txt/验证文件/301 层） */
  registerRoute(method: RouteRegistration['method'], path: string, handler: ExtRouteHandler): void;
  /** 契约 ④：定时任务 */
  registerCron(c: CronRegistration): void;
  /** 契约 ①：中间件注册（按插件启用顺序合并） */
  useMiddleware(mw: (c: unknown, next: () => Promise<void>) => Promise<void>): void;
  /** 契约 ⑤：render:head(PageMeta) 贡献 */
  contributeHead(fn: (meta: PageMeta) => void | Promise<void>): void;
  /** 契约 ⑥：robots.txt 片段贡献（核心装配引擎有序合并+去重） */
  contributeRobots(order: number, lines: string[]): void;
  /** 契约 ⑦：/api/bootstrap 聚合贡献（随核心一次下发） */
  contributeBootstrap(fn: (ext: Record<string, unknown>) => void | Promise<void>): void;
}

export interface ExtensionModule {
  manifest: ExtensionManifest;
  /** 后台配置表单 schema（插件自声明，经 /api/admin/extensions 下发；缺省 = 无结构化表单，降级裸 JSON） */
  schema?: ExtSchema;
  setup(api: ExtensionApi): void;
}

export interface ExtensionsRuntime {
  bus: EventBus;
  routes: { method: RouteRegistration['method']; path: string; handler: ExtRouteHandler }[];
  crons: CronRegistration[];
  middlewares: ((c: unknown, next: () => Promise<void>) => Promise<void>)[];
  robots: RobotsContribution[];
  enabledIds: string[];
}

function isEnabled(manifest: ExtensionManifest, state: Record<string, ExtensionState>): boolean {
  const s = state[manifest.id];
  const installed = s?.installed ?? manifest.installed;
  const enable = s?.enable ?? manifest.enable;
  return installed === 1 && enable === 1;
}
export { isEnabled };

export function buildRuntime(
  modules: ExtensionModule[],
  state: Record<string, ExtensionState>,
  ctx?: ExtensionCtx,
  configs?: Record<string, Record<string, unknown>>,
): ExtensionsRuntime {
  const bus = new EventBus();
  const rt: ExtensionsRuntime = { bus, routes: [], crons: [], middlewares: [], robots: [], enabledIds: [] };

  for (const m of modules) {
    if (!isEnabled(m.manifest, state)) continue;
    rt.enabledIds.push(m.manifest.id);
    const api: ExtensionApi = {
      ctx,
      config: configs?.[m.manifest.id] ?? {},
      bus,
      registerRoute: (method, path, handler) => {
        rt.routes.push({ method, path, handler });
      },
      registerCron: (c) => {
        rt.crons.push(c);
      },
      useMiddleware: (mw) => {
        rt.middlewares.push(mw);
      },
      contributeHead: (fn) => {
        bus.on('render:head', (meta) => fn(meta));
      },
      contributeRobots: (order, lines) => {
        rt.robots.push({ order, lines });
      },
      contributeBootstrap: (fn) => {
        bus.on('bootstrap:contribute', (p) => fn(p.payload));
      },
    };
    try {
      m.setup(api);
    } catch (err) {
      console.warn(`[extensions] setup failed for ${m.manifest.id}:`, err);
    }
  }
  return rt;
}

/** kv 表 extensions 键（§12 开关语义），经三层缓存读穿 */
export async function loadExtensionsState(cache: Cache, db: D1b): Promise<Record<string, ExtensionState>> {
  return remember(cache, 'extensions', async () => {
    const row = await db
      .prepare<{ v: string }>('SELECT v FROM bbs_kv WHERE k = ?')
      .bind('extensions')
      .first<{ v: string }>();
    try {
      const parsed = JSON.parse(row?.v ?? '{}') as unknown;
      // 合法 JSON 但非对象（null/数字/字符串）也会打穿调用方：Object.keys(null) 直接抛 TypeError，
      // 会让全站扩展相关路径 500。故非对象一律回落空表（等同「无扩展状态」）。
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed as Record<string, ExtensionState>;
    } catch {
      return {};
    }
  });
}
