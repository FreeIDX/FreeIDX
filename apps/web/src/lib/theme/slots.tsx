/**
 * 布局插槽：主题覆写优先，未覆写则渲染内置简蓝实现（children）。
 * 用法：`<ThemeSlot name="header"><Header /></ThemeSlot>`——主题不提供 header 时 Header 照旧生效。
 */
import type { ReactNode } from 'react';
import { useTheme } from './provider';
import type { ThemeSlotName } from './types';

export function ThemeSlot({ name, children }: { name: ThemeSlotName; children: ReactNode }) {
  const theme = useTheme();
  const Override = theme?.module.slots?.[name];
  if (Override) return <Override />;
  return <>{children}</>;
}
