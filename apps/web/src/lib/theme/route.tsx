/**
 * 整页替换：主题 `pages.<name>` 存在时整页交给主题，否则渲染 children（可选）。
 *
 * 物理搬迁后框架不再内置前台页面，`children` 仅作为兜底；正常情况由基底主题
 * `light` 提供全部页面（见 active.ts 的双层装配），因此这里渲染 null 只是防御。
 */
import type { ReactNode } from 'react';
import { useTheme } from './provider';
import type { ThemePageName } from './types';

export function ThemeRoute({ name, children }: { name: ThemePageName; children?: ReactNode }) {
  const theme = useTheme();
  const Override = theme?.module.pages?.[name];
  if (Override) return <Override />;
  return <>{children ?? null}</>;
}
