/**
 * 扩展装配入口（T1-8）：插件工厂目录 + per-request 运行时构建（启停热插拔）。
 * 官方后续消费者：seo（T1-9）、ads（T3-9）、geo（T4-5）、支付四通道（§15.5）。
 */
import type { Cache } from '../cache';
import type { D1b } from '../db';
import type { ExtSchema } from '@freeidx/shared';
import type { Env } from '../../types/env';
import { loadExtConfig } from '../ext-store';
import {
  buildRuntime,
  isEnabled,
  loadExtensionsState,
  type ExtensionModule,
  type ExtensionsRuntime,
} from './registry';
import { seoPlugin } from '../../extensions/seo';
import { geoPlugin } from '../../extensions/geo';
import { adsPlugin } from '../../extensions/ads';
import { checkinPlugin } from '../../extensions/checkin';
import { lightPlugin } from '../../extensions/light';
import { cardExtensionModule } from '../../extensions/card';
import { stripeExtensionModule } from '../../extensions/stripe';
import { paypalExtensionModule } from '../../extensions/paypal';
import { idxViewBoostModule, idxQuickReplyModule, idxInsertCodeModule } from '../../extensions/legacy-extensions';

/** seo/geo 出厂启用（§16.4，后台可独立停用）；ads 出厂停用（§17 默认无广告）；light 出厂启用（前台主题配置面）。
 *  仅列参与 per-request 运行时装配的插件（贡献 bootstrap/事件/路由，且预载 config）——支付通道不在此列。 */
export const EXTENSION_MODULES: ExtensionModule[] = [seoPlugin, geoPlugin, adsPlugin, checkinPlugin, lightPlugin];

/**
 * 后台扩展目录（§15.4 支付通道启停/配置走 /api/admin/extensions/{id}）：
 * = 运行时插件 + 支付通道（card/stripe/paypal，manifest 仅供后台可见）+ 三个遗留功能扩展
 *   （idx_view_boost / idx_quick_reply / idx_insert_code，行为接在核心路由与公开端点）。
 * 通道与三件套不进入 EXTENSION_MODULES，避免热读路径预载其 config / 计入 enabledIds（铁律 3 预算）；
 * 通道运行时启停由 payment-core providerLifecycle 依 kv 'extensions' 独立门控，装卸由 registerProvider 决定；
 * 三件套由核心路由经 isEnabled(manifest, state) 判定。
 */
export const ADMIN_CATALOG: ExtensionModule[] = [
  ...EXTENSION_MODULES,
  cardExtensionModule,
  stripeExtensionModule,
  paypalExtensionModule,
  idxViewBoostModule,
  idxQuickReplyModule,
  idxInsertCodeModule,
];

/**
 * 插件自声明 schema 的下发视图：补全 target 缺省规则（password→secret，其余→config），
 * 使前端拿到的字段 target 恒有值；无 schema 的插件返回 undefined（降级裸 JSON 高级模式）。
 * 仅作用于响应，不触碰存储数据。
 */
export function extSchemaOf(mod: ExtensionModule): ExtSchema | undefined {
  const s = mod.schema;
  if (!s) return undefined;
  return {
    ...s,
    fields: s.fields.map((f) => ({ ...f, target: f.target ?? (f.type === 'password' ? 'secret' : 'config') })),
  };
}

const EMPTY_RUNTIME: ExtensionsRuntime = buildRuntime([], {});

export async function getExtensions(
  cache: Cache,
  db: D1b,
  env?: Env,
  opts?: { preloadConfigs?: boolean },
): Promise<ExtensionsRuntime> {
  // 请求级去重：Cache 实例随请求创建，故同一请求内多次调用复用同一次装配结果。
  // 批量版务等路径会「先取一次发事件、再取一次取路由」；buildRuntime 会对每个启用插件重跑 setup，
  // 并可能重复 loadExtConfig —— 去重后这些开销每请求只付一次（零行为差异：同一请求内装配结果本就一致）。
  const memoKey = opts?.preloadConfigs === false ? 'ext_rt:light' : 'ext_rt:full';
  if (cache.hasLoaded(memoKey)) return cache.getLoaded<ExtensionsRuntime>(memoKey);
  const state = await loadExtensionsState(cache, db);
  const hasDefaultOn = EXTENSION_MODULES.some((m) => m.manifest.enable === 1);
  if (!Object.keys(state).length && !hasDefaultOn) return EMPTY_RUNTIME;
  // 预载启用插件的非敏感配置（ext:{id}:config，经三层缓存），供同步贡献点（robots/registerRoute/render:head）读取。
  // 纯事件发射路径（写接口版务广播）无同步配置消费者，传 preloadConfigs:false 省预算（铁律 3）。
  const configs: Record<string, Record<string, unknown>> = {};
  if (opts?.preloadConfigs !== false) {
    const enabled = EXTENSION_MODULES.filter((m) => isEnabled(m.manifest, state));
    await Promise.all(enabled.map(async (m) => {
      configs[m.manifest.id] = await loadExtConfig(cache, db, m.manifest.id);
    }));
  }
  const rt = buildRuntime(EXTENSION_MODULES, state, { db, cache, env }, configs);
  cache.putLoaded(memoKey, rt);
  return rt;
}
