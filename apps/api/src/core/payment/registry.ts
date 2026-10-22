/**
 * payment-core：PaymentProvider 注册表 + 生命周期门控 + 配置装配（T5-4，§15.5）。
 * **核心不含任何通道代码**：通道插件（card/paypal/stripe/alipay）在各自模块 setup 时调用
 * registerProvider 把自己的 PaymentProvider 实现登记进来；本模块只做契约装配与启停判定。
 *  - 生命周期：installed/enable 与 §12 扩展机制同源（kv 'extensions'），未注册=未装 404、装而停用=410；
 *  - 配置隔离：cfg = ext:{id}:config(明文) ∪ ext:{id}:secret(AES-GCM)，插件只拿到核心注入的 cfg，绝不自取全局。
 */
import type { PayOrder, PaymentCapabilities, PaymentConfig, PaymentProvider } from '@freeidx/shared';
import type { Env } from '../../types/env';
import type { Cache } from '../cache';
import type { D1b } from '../db';
import { loadExtConfig, loadExtSecret } from '../ext-store';
import { loadExtensionsState } from '../extensions/registry';
import { loadSetting } from '../loaders';
import { canonicalBaseFromSetting } from '../site';

interface ProviderRegistration {
  provider: PaymentProvider;
  /** 出厂默认启停（无 kv 'extensions' 覆盖时生效）；外部通道默认 installed=1/enable=0，card=1/1 */
  defaults: { installed: 0 | 1; enable: 0 | 1 };
}

const providers = new Map<string, ProviderRegistration>();

/** 通道插件登记入口（幂等：同 id 覆盖） */
export function registerProvider(
  provider: PaymentProvider,
  defaults: { installed: 0 | 1; enable: 0 | 1 } = { installed: 1, enable: 1 },
): void {
  providers.set(provider.id, { provider, defaults });
}

export function getProvider(id: string): PaymentProvider | undefined {
  return providers.get(id)?.provider;
}

/** 测试/热重载用：清空注册表（Workers 进程内单次装配，运行期不调用） */
export function resetProviders(): void {
  providers.clear();
}

type Lifecycle = 'ready' | 'missing' | 'disabled';

/**
 * 判定某通道当前可用性：installed+enable 才 ready。
 * 未注册 → missing（无代码，等同未装 404）；注册但 enable≠1 → disabled（410）。
 */
export async function providerLifecycle(cache: Cache, db: D1b, id: string): Promise<Lifecycle> {
  const reg = providers.get(id);
  if (!reg) return 'missing';
  const state = await loadExtensionsState(cache, db);
  const s = state[id] ?? reg.defaults;
  const installed = (s.installed ?? reg.defaults.installed) === 1;
  const enable = (s.enable ?? reg.defaults.enable) === 1;
  if (!installed) return 'missing';
  if (!enable) return 'disabled';
  return 'ready';
}

interface ResolvedConfig extends PaymentConfig {
  [k: string]: unknown;
}

/** 装配 cfg：明文 config ∪ 解密 secret（secret 覆盖同名键；master key 缺失则 secret 为空，安全失败） */
export async function resolveProviderConfig(cache: Cache, db: D1b, env: Env | undefined, id: string): Promise<ResolvedConfig> {
  const [config, secret, setting] = await Promise.all([
    loadExtConfig(cache, db, id),
    loadExtSecret(db, id, env?.SECRETS_MASTER_KEY),
    loadSetting(cache, db),
  ]);
  const cfg = { ...config, ...secret } as ResolvedConfig;
  // 回跳地址默认注入主域名：通道内未配置时回落的是「支付网关 API 主机 + /done」
  // （如 api.stripe.com/done、api-m.paypal.com/done），付款成功会把买家丢在网关域名上。
  // 这里统一按后台文案「留空使用站点默认」的语义补站点首页；主域名取后台「站点网址」优先（多域名部署）。
  const origin = canonicalBaseFromSetting(setting, env);
  if (origin) {
    if (!cfg.successUrl) cfg.successUrl = `${origin}/`;
    if (!cfg.cancelUrl) cfg.cancelUrl = `${origin}/`;
  }
  return cfg;
}

export interface ProviderView {
  id: string;
  capabilities: PaymentCapabilities;
}

/**
 * 卡密式通道的可选能力（T5-5 暴露的契约扩展点）：
 * 冻结的 PaymentProvider 契约只覆盖 redirect/qrcode + webhook，卡密无跳转、无 webhook，靠"输入兑换码即时开通"。
 * 因此不改动 shared/payment.ts 既有签名，仅以"结构可选方法"表达：实现该接口的 Provider 额外提供 redeem。
 * 核心 redeem 路由通过 hasRedeem() 判定并调用，仍不含任何通道代码。
 */
export interface RedeemContext {
  db: D1b;
  cache: Cache;
  env?: Env;
  config: ResolvedConfig;
  ts: number;
}
export interface RedeemResult {
  ok: boolean;
  /** 成功时用于订单幂等的通道引用（如 card:{code}） */
  providerRef?: string;
  /** 失败原因：API_MESSAGES 词条键（如 'card.codeInvalid'），路由层 t() 按站点语言翻译后返回用户 */
  reason?: string;
}
export interface RedeemCapable extends PaymentProvider {
  redeem(order: PayOrder, code: string, ctx: RedeemContext): Promise<RedeemResult>;
}

/** 结构化探测：某 Provider 是否具备 redeem 能力 */
export function asRedeemable(provider: PaymentProvider | undefined): RedeemCapable | undefined {
  return provider && typeof (provider as RedeemCapable).redeem === 'function' ? (provider as RedeemCapable) : undefined;
}

/** 收银台聚合视图（仅 ready 通道；T5-7 在此基础上按地区/币种过滤排序） */
export async function listReadyProviders(cache: Cache, db: D1b): Promise<ProviderView[]> {
  const out: ProviderView[] = [];
  for (const { provider } of providers.values()) {
    if ((await providerLifecycle(cache, db, provider.id)) === 'ready') {
      out.push({ id: provider.id, capabilities: provider.capabilities });
    }
  }
  return out;
}

/** checkout 结果透传（保持契约判别联合） */
type CheckoutResult = Awaited<ReturnType<PaymentProvider['createCheckout']>>;

/** 下单后装配跳转/二维码/卡密态：未 ready 通道由调用侧降级为 pending 轮询（优雅降级，铁律 7 外部依赖并行） */
export async function runCheckout(
  cache: Cache,
  db: D1b,
  env: Env | undefined,
  id: string,
  order: PayOrder,
): Promise<CheckoutResult | null> {
  if (!id) return null;
  if ((await providerLifecycle(cache, db, id)) !== 'ready') return null;
  const provider = providers.get(id)!.provider;
  const cfg = await resolveProviderConfig(cache, db, env, id);
  return provider.createCheckout(order, cfg);
}
