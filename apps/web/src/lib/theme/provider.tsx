/**
 * 主题上下文（首屏一次装配，整页刷新才换主题）。
 *
 * 装配时机在 `main.tsx` 渲染之前：先解析启用中的主题 id，再加载其模块与样式，
 * 因此插槽/整页替换从第一帧就是对的，不会出现「先简蓝再换肤」的闪烁。
 * 主题缺失或加载失败 → 回落 light（内置简蓝，零覆写，等同不出主题）。
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { ResolvedTheme } from './types';

const ThemeCtx = createContext<ResolvedTheme | null>(null);

export function ThemeProvider({ theme, children }: { theme: ResolvedTheme; children: ReactNode }) {
  return <ThemeCtx.Provider value={theme}>{children}</ThemeCtx.Provider>;
}

/** 当前已装配主题；未包 Provider（例如后台独立路由树）时返回 null */
export function useTheme(): ResolvedTheme | null {
  return useContext(ThemeCtx);
}
