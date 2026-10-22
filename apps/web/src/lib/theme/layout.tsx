/**
 * 前台布局装配：由启用主题的 `layout` 接管整站外壳（顶栏/页脚/dock 由该外壳内部
 * 通过 ThemeSlot 再开插槽），主题未声明 layout 时退化为 children 直出，
 * 保证路由在主题不完整时依然可达（基底主题 light 始终提供 layout，见 active.ts）。
 */
import type { ReactNode } from 'react';
import { useTheme } from './provider';

export function ThemeLayout({ children }: { children: ReactNode }) {
  const Layout = useTheme()?.module.layout;
  return Layout ? <Layout>{children}</Layout> : <>{children}</>;
}
