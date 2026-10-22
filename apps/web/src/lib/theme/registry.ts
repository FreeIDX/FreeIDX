/**
 * 主题自动发现（构建期静态收集，零手工注册）。
 *
 * Vite 的 `import.meta.glob` 在构建时把 `themes/*` 下命中的文件登记为模块：
 *  - theme.json  eager 同步取元信息（后台列表用，占用极小）；
 *  - index.tsx   懒加载，仅当该主题被启用时才拉取对应 chunk；
 *  - theme.css   懒加载，同上（未启用主题的样式不进首屏）。
 * 因此「新建一个主题文件夹」即完成注册，无需改动本文件或任何清单。
 *
 * 例外：基底主题（light）改为**静态引入**——它自带整站布局与全部前台页面，任何主题下都必须
 * 在场（其它主题以它为底合并）。静态引入让它随入口 chunk 一起到达，避免首屏多一次往返，
 * 也避免其 chunk 拉取失败时整站无壳可渲染。
 */
import baseTheme from '../../themes/light';
import type { ThemeMeta, ThemeModule } from './types';

/** 兜底主题 id：主题 id 非法/加载失败时回落，与后端 DEFAULT_THEME_ID 保持一致 */
export const FALLBACK_THEME_ID = 'light';

const metaModules = import.meta.glob<{ default: ThemeMeta }>('../../themes/*/theme.json', { eager: true });
/** 基底主题已静态引入，从懒加载清单中排除，避免产出重复 chunk */
const moduleLoaders = import.meta.glob<{ default: ThemeModule }>(['../../themes/*/index.tsx', '!../../themes/light/index.tsx']);
const cssLoaders = import.meta.glob('../../themes/*/theme.css');

/** `../../themes/<id>/theme.json` → `<id>` */
function idOf(key: string): string {
  const m = /\/([^/]+)\/[^/]+$/.exec(key);
  return m?.[1] ?? '';
}

/** 全部已内置主题的元信息（按 order 升序、id 升序稳定排序） */
export function listThemes(): ThemeMeta[] {
  const out: ThemeMeta[] = [];
  for (const [key, mod] of Object.entries(metaModules)) {
    const id = idOf(key);
    if (!id || !mod?.default) continue;
    out.push({ ...mod.default, id });
  }
  return out.sort((a, b) => (a.order ?? 100) - (b.order ?? 100) || a.id.localeCompare(b.id));
}

export function getThemeMeta(id: string): ThemeMeta | null {
  return listThemes().find((m) => m.id === id) ?? null;
}

/** 主题是否存在（后台启用请求做白名单校验，杜绝写入未知 id） */
export function hasTheme(id: string): boolean {
  return listThemes().some((m) => m.id === id);
}

/**
 * 加载主题模块与其样式。id 不存在或模块加载失败时抛错，由调用方回落 FALLBACK_THEME_ID。
 * CSS 先于组件求值（无副作用依赖，仅保证同一 chunk 内样式先生效）。
 * 基底主题走静态模块，不重复下载（也不会重复求值 pages 的懒加载工厂）。
 */
export async function loadTheme(id: string): Promise<ThemeModule> {
  if (id === FALLBACK_THEME_ID) return baseTheme;
  const modKey = Object.keys(moduleLoaders).find((k) => idOf(k) === id);
  if (!modKey) throw new Error(`theme not found: ${id}`);
  const cssKey = Object.keys(cssLoaders).find((k) => idOf(k) === id);
  if (cssKey) await cssLoaders[cssKey]!();
  const mod = await moduleLoaders[modKey]!();
  return mod?.default ?? {};
}
