/**
 * 语言包按需加载（前端专用，经子路径 `@freeidx/shared/i18n/bundles` 导出）。
 *
 * 动机：10 个语言包的合并词典约 740KB 源码体积，此前静态打进前端主包，所有访客都要下载全部语言。
 * 改为按语言动态导入后，首屏只下载当前语言的词条（约 70~105KB 原始体积），
 * 其余语言包各自成 chunk，切换语言时才拉取。产物落在 /assets/*，由静态资源层直接应答，不计 Worker 请求。
 *
 * 该模块刻意不进 packages/shared 的根导出：它含 20 个动态 import 目标，
 * 而后端只从根导出取类型与常量，避免无关的 JSON 被拉进 Worker 包。
 */
import type { LocaleBundles } from '../i18n';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from './locales';

/**
 * 合并两层词典：
 *  - gen/*.json：基础词典（随代码维护）；
 *  - override/*.json：本项目新增词条（如后台新增模块 textKey），优先级更高。
 * 两层都由 CI 的 i18n:check 校验完整性；禁止在组件里硬编码文案。
 * 口径与 scripts/lib/load-i18n.mjs 完全一致（over 覆盖 gen）。
 */
function merge(gen: unknown, override: unknown): LocaleBundles {
  const g = gen as LocaleBundles;
  const o = override as LocaleBundles;
  return { bbs: { ...g.bbs, ...o.bbs }, admin: { ...g.admin, ...o.admin } };
}

/** 逐语言动态导入器（显式列出：新增语言时同步补一行，避免隐式 glob 解析失败后难以排查） */
const LOADERS: Record<string, () => Promise<LocaleBundles>> = {
  'zh-cn': async () => merge((await import('./gen/zh-cn.json')).default, (await import('./override/zh-cn.json')).default),
  'zh-tw': async () => merge((await import('./gen/zh-tw.json')).default, (await import('./override/zh-tw.json')).default),
  'en-us': async () => merge((await import('./gen/en-us.json')).default, (await import('./override/en-us.json')).default),
  'ru-ru': async () => merge((await import('./gen/ru-ru.json')).default, (await import('./override/ru-ru.json')).default),
  'th-th': async () => merge((await import('./gen/th-th.json')).default, (await import('./override/th-th.json')).default),
  'de-de': async () => merge((await import('./gen/de-de.json')).default, (await import('./override/de-de.json')).default),
  'ja-jp': async () => merge((await import('./gen/ja-jp.json')).default, (await import('./override/ja-jp.json')).default),
  'ko-kr': async () => merge((await import('./gen/ko-kr.json')).default, (await import('./override/ko-kr.json')).default),
  'es-es': async () => merge((await import('./gen/es-es.json')).default, (await import('./override/es-es.json')).default),
  'fr-fr': async () => merge((await import('./gen/fr-fr.json')).default, (await import('./override/fr-fr.json')).default),
};

/** 空词典：所有语言包都未就绪时的占位（渲染期需同步可用） */
export const EMPTY_BUNDLES: LocaleBundles = { bbs: {}, admin: {} };

/** 已加载词典（同步读取：渲染期必须同步可用） */
const loaded = new Map<string, LocaleBundles>();
/** 进行中的加载：同语言并发只发一次请求 */
const inflight = new Map<string, Promise<LocaleBundles | undefined>>();

/** 同步读取已加载词典；未加载返回 undefined（调用方自行回落 DEFAULT_LOCALE） */
export function getLoadedBundle(lang: string): LocaleBundles | undefined {
  return loaded.get(lang);
}

/** 按需加载语言包并缓存；语言未知或加载失败返回 undefined（不阻断界面，调用方回落） */
export function loadLocaleBundle(lang: string): Promise<LocaleBundles | undefined> {
  const hit = loaded.get(lang);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(lang);
  if (running) return running;
  const loader = LOADERS[lang];
  if (!loader) return Promise.resolve(undefined);
  const pending = loader()
    .then((b) => {
      loaded.set(lang, b);
      inflight.delete(lang);
      return b;
    })
    .catch((err: unknown) => {
      inflight.delete(lang);
      console.warn(`[i18n] locale bundle load failed: ${lang}`, err);
      return undefined;
    });
  inflight.set(lang, pending);
  return pending;
}

/** 预载全部语言包（仅测试/工具用：词典完整性冒烟需要全量词典） */
export function loadAllLocaleBundles(): Promise<(LocaleBundles | undefined)[]> {
  return Promise.all(AVAILABLE_LOCALES.map((l) => loadLocaleBundle(l)));
}

export { DEFAULT_LOCALE };
