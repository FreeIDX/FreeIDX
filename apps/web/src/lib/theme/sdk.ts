/**
 * 主题 SDK：主题组件可用的稳定 API 面（内置主题可直接 import 框架内部模块，
 * 但推荐从这里取通用能力，降低与业务实现细节的耦合）。
 *
 * 约定：主题（themes/<id>/index.tsx）可复用以下 hooks/组件，但**不得**修改它们；
 * 需要站点数据一律经 useAuth / useLight 读取 bootstrap 下发的只读快照。
 */
import { lazy, type ComponentType } from 'react';

import type { ThemeComponent } from './types';

export { Link, NavLink, useLocation, useNavigate, useParams } from 'react-router';
export { useAuth } from '../../store/auth';
export { useLight, useThemeMode, useApplyTheme, userBgImage } from '../../store/theme';
export { useT, useLang, useLangPref, useGroupName } from '../i18n';
export { Icon, type IconName } from '../../components/icons';
export { Avatar } from '../../components/Avatar';
export { cx } from '../cx';
export { useTheme } from './provider';
export type { ResolvedTheme, ThemeComponent, ThemeMeta, ThemeModule, ThemePageName, ThemeSlotName } from './types';

/**
 * 主题页懒加载：把 `import('./pages/X')` 包成可直接放进 `ThemeModule.pages` 的组件。
 * 保留路由级代码分割——未被渲染的页面 chunk 不会下载。
 *
 * 额外挂一个 `preload()`：页面 chunk 原本只有 React 渲染到该路由时才发起
 * （首屏实测：主包执行完 → 词典到位 → 渲染 → 才开始下 chunk，白等一个 RTT）。
 * 有了它，首屏可以在 boot 阶段按当前路径并行预取，站内链接也能在 hover 时提前取。
 * loader 结果做记忆化，预取与 React.lazy 复用同一个 Promise，不会重复请求。
 */
export function lazyPage(loader: () => Promise<{ default: ComponentType }>): ThemeComponent {
  let pending: Promise<{ default: ComponentType }> | null = null;
  const load = (): Promise<{ default: ComponentType }> => {
    if (!pending) {
      pending = loader().catch((e: unknown) => {
        // 失败不缓存：留给真正的渲染时机重试（例如发版后旧 hash 失效 → preloadError 自愈）
        pending = null;
        throw e;
      });
    }
    return pending;
  };
  const component = lazy(load) as unknown as ThemeComponent;
  component.preload = () => {
    void load().catch(() => undefined);
  };
  return component;
}
