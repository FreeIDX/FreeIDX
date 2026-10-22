/**
 * 内置完整主题的类型契约（主题层唯一对外形状）。
 *
 * 定位：`apps/web/src/themes/<id>/` 是主题的唯一存放处，**只允许放主题文件夹**；
 * 主题基础设施（发现/装配/插槽）全部在 `lib/theme/`。开发者新建一个主题 = 新建一个文件夹（`<id>` 处替换为主题文件夹名）：
 *   themes/<id>/theme.json     ← 元信息（名称/简介/版本/排序/预览图）
 *   themes/<id>/index.tsx      ← 默认导出 ThemeModule（可接管布局、覆写插槽/整页）
 *   themes/<id>/theme.css      ← 可选：随主题启用的全局样式
 * 文件夹名即主题 id，无需改任何注册文件（见 registry.ts 的 import.meta.glob 自动发现）。
 *
 * 基底继承：`light` 是基底主题，自带整站布局与全部前台页面；其它主题未声明 `layout`
 * 时沿用基底的布局，未覆写的插槽/页面也由基底补齐（见 active.ts 的双层装配）。
 */
import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';

/** 可被主题覆写的布局插槽（未覆写则由基底主题的实现兜底）。
 *  header 含移动端二级导航行与抽屉；dock 为移动端底部导航栏。 */
export type ThemeSlotName = 'header' | 'dock' | 'footer';

/** 可被主题整页替换的前台路由页 */
export type ThemePageName =
  | 'home'
  | 'forum'
  | 'thread'
  | 'user'
  | 'login'
  | 'register'
  | 'resetpw'
  | 'me'
  | 'compose'
  | 'search'
  | 'discovery'
  | 'rank'
  | 'mod'
  | 'paylist'
  | 'vip'
  | 'order'
  | 'notfound';

/** theme.json 的形状（多语言文案用 `{ 'zh-cn': '…' }` map，与插件 manifest.name 同口径） */
export interface ThemeMeta {
  /** 主题 id：必须与文件夹名一致（check-themes.mjs 会校验） */
  id: string;
  name: Record<string, string>;
  description?: Record<string, string>;
  version?: string;
  author?: string;
  /** 列表排序，小的在前（缺省 100） */
  order?: number;
  /**
   * 该主题的后台配置页路径（可选）。主题若把配置项托管在别处（如简蓝主题放在
   * 插件中心 `/admin/extensions/light`），在这里声明后，主题管理卡片会出「设置」入口。
   */
  configPath?: string;
}

/** 主题页面组件：普通组件或经 `lazyPage()` 包装的懒加载组件（保留路由级分包）。
 *  统一声明可选 children，页面自身不取 props，布局外壳则接收路由内容。 */
export type ThemeComponent =
  | ComponentType<{ children?: ReactNode }>
  | LazyExoticComponent<ComponentType<{ children?: ReactNode }>>;

/**
 * 主题模块（`themes/<id>/index.tsx` 的默认导出）。
 * 三个接管点都是可选的：只覆写部分插槽即「局部换肤」，覆写 pages 即「整页替换」，
 * 声明 layout 即「自带整站外壳」（未声明则沿用基底主题的布局）。
 * 主题组件通过 `lib/theme/sdk` 取用运行时能力（useAuth/useT/useLight/Icon/Link…）。
 */
export interface ThemeModule {
  /** 整站布局：包住全部前台路由的壳（顶栏/页脚/dock 通常在此内部再开插槽） */
  layout?: ThemeComponent;
  /** 布局插槽：返回取代该区域的组件（无 props，自行经 sdk 取数据） */
  slots?: Partial<Record<ThemeSlotName, ComponentType>>;
  /** 整页替换：键为页面名，值为取代该路由整页的组件 */
  pages?: Partial<Record<ThemePageName, ThemeComponent>>;
}

/** 已装配好的主题（Provider 上下文值） */
export interface ResolvedTheme {
  id: string;
  meta: ThemeMeta | null;
  module: ThemeModule;
  /** 是否处于兜底态（id 对应主题缺失/加载失败 → 已回落 light） */
  fallback: boolean;
}
