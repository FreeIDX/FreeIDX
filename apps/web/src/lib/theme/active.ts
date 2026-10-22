/**
 * 启用主题的解析：优先读 Worker 注入的 `window.__FI_THEME__`（零请求），
 * 缺省时回落 `GET /api/theme/active`，最后回落 light。
 * 解析失败一律降级而不是中断首屏——主题只是外观层，不得影响可用性。
 *
 * 双层装配：`light` 是**基底主题**，自带整站布局与全部前台页面；其它主题只需声明差异
 * （layout 取启用主题优先、否则沿用基底；slots/pages 以基底为底、启用主题覆盖）。
 * 合并仅复制组件引用——`React.lazy` 未被渲染就不会 `import()`，基底页面 chunk 不会提前下载。
 */
import { FALLBACK_THEME_ID, getThemeMeta, hasTheme, loadTheme } from './registry';
import type { ResolvedTheme, ThemeModule } from './types';

declare global {
  interface Window {
    /** Worker 在 SPA 壳中注入的启用主题 id（见 apps/api 的 notFound 壳注入） */
    __FI_THEME__?: string;
  }
}

async function fetchActiveThemeId(): Promise<string | null> {
  try {
    const res = await fetch('/api/theme/active', { credentials: 'include', headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: unknown } };
    const id = body?.data?.id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** 基底主题（light）模块；加载失败给空模块，此时整站只剩裸路由（不中断首屏） */
async function loadBaseTheme(): Promise<ThemeModule> {
  try {
    return await loadTheme(FALLBACK_THEME_ID);
  } catch (e) {
    console.warn(`[theme] base "${FALLBACK_THEME_ID}" load failed:`, e);
    return {};
  }
}

/** 基底打底 + 启用主题覆盖（只复制引用，不触发懒加载下载） */
function mergeTheme(base: ThemeModule, theme: ThemeModule): ThemeModule {
  return {
    layout: theme.layout ?? base.layout,
    slots: { ...base.slots, ...theme.slots },
    pages: { ...base.pages, ...theme.pages },
  };
}

/** 解析并加载启用主题（main.tsx 在首屏渲染前调用一次） */
export async function resolveActiveTheme(): Promise<ResolvedTheme> {
  const base = await loadBaseTheme();
  const injected = typeof window === 'undefined' ? undefined : window.__FI_THEME__;
  const id = injected || (await fetchActiveThemeId()) || FALLBACK_THEME_ID;
  /** 启用基底主题本身：无需二次加载，直接复用 */
  if (id === FALLBACK_THEME_ID) {
    return { id, meta: getThemeMeta(id), module: base, fallback: false };
  }
  if (hasTheme(id)) {
    try {
      const module = mergeTheme(base, await loadTheme(id));
      return { id, meta: getThemeMeta(id), module, fallback: false };
    } catch (e) {
      console.warn(`[theme] load "${id}" failed, fallback to ${FALLBACK_THEME_ID}:`, e);
    }
  }
  return { id: FALLBACK_THEME_ID, meta: getThemeMeta(FALLBACK_THEME_ID), module: base, fallback: true };
}
