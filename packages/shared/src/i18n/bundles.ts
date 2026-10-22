/**
 * 语言包按需加载（前端专用，经子路径 `@freeidx/shared/i18n/bundles` 导出）。
 *
 * 两级按需（动机见源码注释，实测数据见 docs）：
 *  1. 按语言：10 个语言包各自成 chunk，首屏只下载当前语言（约 70~105KB 原始体积），切换语言时才拉取；
 *  2. 按命名空间：bbs（前台）与 admin（后台）分属不同 chunk —— 后台词条约占单语言体积一半，
 *     普通访客不再下载，进入 /admin 时才拉取（见 loadAdminBundle）。
 *
 * 词条来自构建期虚拟模块 `virtual:freeidx-i18n/{bbs,admin}/<locale>`，
 * 由 scripts/i18n-split.plugin.ts 从 gen/*.json ∪ override/*.json 现读现合并（override 覆盖 gen，
 * 口径与 scripts/lib/load-i18n.mjs 一致）。源词典文件布局不变，所有校验脚本照常工作。
 *
 * 该模块刻意不进 packages/shared 的根导出：后端只从根导出取类型与常量，
 * 避免无关词条被拉进 Worker 包。
 */
import type { LocaleBundles } from '../i18n';
import { AVAILABLE_LOCALES, DEFAULT_LOCALE } from './locales';

type LangDict = Record<string, string>;
type Namespace = 'bbs' | 'admin';
type PartLoader = () => Promise<{ default: LangDict }>;

/** 词条加载器（显式列出：新增语言时同步补两行，避免隐式 glob 解析失败后难以排查） */
const BBS_LOADERS: Record<string, PartLoader> = {
  'zh-cn': () => import('virtual:freeidx-i18n/bbs/zh-cn'),
  'zh-tw': () => import('virtual:freeidx-i18n/bbs/zh-tw'),
  'en-us': () => import('virtual:freeidx-i18n/bbs/en-us'),
  'ru-ru': () => import('virtual:freeidx-i18n/bbs/ru-ru'),
  'th-th': () => import('virtual:freeidx-i18n/bbs/th-th'),
  'de-de': () => import('virtual:freeidx-i18n/bbs/de-de'),
  'ja-jp': () => import('virtual:freeidx-i18n/bbs/ja-jp'),
  'ko-kr': () => import('virtual:freeidx-i18n/bbs/ko-kr'),
  'es-es': () => import('virtual:freeidx-i18n/bbs/es-es'),
  'fr-fr': () => import('virtual:freeidx-i18n/bbs/fr-fr'),
};

const ADMIN_LOADERS: Record<string, PartLoader> = {
  'zh-cn': () => import('virtual:freeidx-i18n/admin/zh-cn'),
  'zh-tw': () => import('virtual:freeidx-i18n/admin/zh-tw'),
  'en-us': () => import('virtual:freeidx-i18n/admin/en-us'),
  'ru-ru': () => import('virtual:freeidx-i18n/admin/ru-ru'),
  'th-th': () => import('virtual:freeidx-i18n/admin/th-th'),
  'de-de': () => import('virtual:freeidx-i18n/admin/de-de'),
  'ja-jp': () => import('virtual:freeidx-i18n/admin/ja-jp'),
  'ko-kr': () => import('virtual:freeidx-i18n/admin/ko-kr'),
  'es-es': () => import('virtual:freeidx-i18n/admin/es-es'),
  'fr-fr': () => import('virtual:freeidx-i18n/admin/fr-fr'),
};

const LOADERS: Record<Namespace, Record<string, PartLoader>> = { bbs: BBS_LOADERS, admin: ADMIN_LOADERS };

/** 空词典：所有语言包都未就绪时的占位（渲染期需同步可用） */
export const EMPTY_BUNDLES: LocaleBundles = { bbs: {}, admin: {} };

interface LoadedParts {
  bbs?: LangDict;
  admin?: LangDict;
}

/** 已加载的词条分区（bbs / admin 各自独立到位） */
const parts = new Map<string, LoadedParts>();
/**
 * 合并快照缓存：同一语言在「无新分区到达」期间返回同一对象，
 * 保证 useSyncExternalStore / useState 的引用比较不会每次渲染都判定为变化。
 */
const snapshots = new Map<string, LocaleBundles>();
/** 进行中的加载：同语言同分区并发只发一次请求，key = `${ns}:${lang}` */
const inflight = new Map<string, Promise<void>>();
/** 加载失败的分区：调用方据此降级（如后台词典拉取失败时照常渲染，退回词条 key / 中文兜底） */
const failed = new Set<string>();
/** 词典变更订阅（后台词典晚于 bbs 到达时通知已挂载的界面重取） */
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 订阅任意词典分区到位事件；返回取消订阅函数 */
export function subscribeBundles(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 合并快照：bbs 未到位视为「词典不可用」（调用方自行回落 DEFAULT_LOCALE） */
function snapshot(lang: string): LocaleBundles | undefined {
  const loaded = parts.get(lang);
  if (!loaded?.bbs) return undefined;
  const cached = snapshots.get(lang);
  if (cached) return cached;
  const built: LocaleBundles = { bbs: loaded.bbs, admin: loaded.admin ?? {} };
  snapshots.set(lang, built);
  return built;
}

function loadPart(lang: string, ns: Namespace): Promise<void> {
  const key = `${ns}:${lang}`;
  if (parts.get(lang)?.[ns]) return Promise.resolve();
  const running = inflight.get(key);
  if (running) return running;
  const loader = LOADERS[ns][lang];
  if (!loader) {
    failed.add(key);
    return Promise.resolve();
  }

  const pending = loader()
    .then((mod) => {
      const next = parts.get(lang) ?? {};
      next[ns] = mod.default ?? {};
      parts.set(lang, next);
      snapshots.delete(lang); // 有新分区到达 → 下次 snapshot 重建一次
      failed.delete(key);
      inflight.delete(key);
      emit();
    })
    .catch((err: unknown) => {
      inflight.delete(key);
      failed.add(key);
      console.warn(`[i18n] ${ns} bundle load failed: ${lang}`, err);
      emit(); // 失败也要通知：等待方据此降级渲染，而不是一直占位
    });
  inflight.set(key, pending);
  return pending;
}

/** 同步读取已加载词典；未加载返回 undefined（调用方自行回落 DEFAULT_LOCALE） */
export function getLoadedBundle(lang: string): LocaleBundles | undefined {
  return snapshot(lang);
}

/** 后台词典是否已到位（后台页据此决定「先占位再渲染」还是直接渲染） */
export function isAdminLoaded(lang: string): boolean {
  return parts.get(lang)?.admin !== undefined;
}

/** 后台词典是否已无望到位（语言未知或拉取失败）：调用方应降级渲染而不是继续占位 */
export function isAdminUnavailable(lang: string): boolean {
  return failed.has(`admin:${lang}`);
}

/** 按需加载前台词典（bbs）并缓存；语言未知或加载失败返回 undefined（不阻断界面） */
export function loadLocaleBundle(lang: string): Promise<LocaleBundles | undefined> {
  return loadPart(lang, 'bbs').then(() => snapshot(lang));
}

/** 按需加载后台词典（admin）并缓存；仅供 /admin 使用，前台永不触发 */
export function loadAdminBundle(lang: string): Promise<LangDict | undefined> {
  return loadPart(lang, 'admin').then(() => parts.get(lang)?.admin);
}

/** 预载全部语言的前后台词典（仅测试/工具用：词典完整性冒烟需要全量词典） */
export function loadAllLocaleBundles(): Promise<(LocaleBundles | undefined)[]> {
  return Promise.all(
    AVAILABLE_LOCALES.map(async (lang) => {
      await loadPart(lang, 'bbs');
      await loadPart(lang, 'admin');
      return snapshot(lang);
    }),
  );
}

export { DEFAULT_LOCALE };
