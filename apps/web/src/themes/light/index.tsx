/**
 * 简蓝主题（内置默认 / 基底主题）。
 *
 * 物理搬迁后本主题承载简蓝的**完整实现**：
 *  - `Layout.tsx`  整站外壳（固定顶栏 + 移动端二级导航行 + 抽屉 + 页脚 + dock + 回顶），
 *                  内部再开 header/footer/dock 三个插槽，供其它主题局部覆写；
 *  - `pages/`      17 个前台页面（路由级懒加载，见下方 lazyPage）。
 * 其几十项配置（发现页/轮播/友链/标签/列表样式/底栏/字体/暗色…）仍由扩展侧
 * `ext:light:config` 承载，在插件中心「简蓝主题」详情页维护（主题管理卡片提供跳转）。
 *
 * 其它主题以本主题为基底：未声明的 layout、未覆写的插槽与页面自动继承（见 lib/theme/active.ts）。
 */
import { lazyPage } from '../../lib/theme/sdk';
import type { ThemeModule } from '../../lib/theme/types';
import { Layout } from './Layout';

const theme: ThemeModule = {
  layout: Layout,
  pages: {
    home: lazyPage(() => import('./pages/HomePage').then((m) => ({ default: m.HomePage }))),
    forum: lazyPage(() => import('./pages/ForumPage').then((m) => ({ default: m.ForumPage }))),
    thread: lazyPage(() => import('./pages/ThreadPage').then((m) => ({ default: m.ThreadPage }))),
    user: lazyPage(() => import('./pages/UserPage').then((m) => ({ default: m.UserPage }))),
    login: lazyPage(() => import('./pages/LoginPage').then((m) => ({ default: m.LoginPage }))),
    register: lazyPage(() => import('./pages/RegisterPage').then((m) => ({ default: m.RegisterPage }))),
    resetpw: lazyPage(() => import('./pages/ResetPwPage').then((m) => ({ default: m.ResetPwPage }))),
    me: lazyPage(() => import('./pages/MePage').then((m) => ({ default: m.MePage }))),
    paylist: lazyPage(() => import('./pages/PaylistPage').then((m) => ({ default: m.PaylistPage }))),
    compose: lazyPage(() => import('./pages/ComposePage').then((m) => ({ default: m.ComposePage }))),
    search: lazyPage(() => import('./pages/SearchPage').then((m) => ({ default: m.SearchPage }))),
    discovery: lazyPage(() => import('./pages/DiscoveryPage').then((m) => ({ default: m.DiscoveryPage }))),
    rank: lazyPage(() => import('./pages/RankListPage').then((m) => ({ default: m.RankListPage }))),
    mod: lazyPage(() => import('./pages/ModPage').then((m) => ({ default: m.ModPage }))),
    vip: lazyPage(() => import('./pages/VipPage').then((m) => ({ default: m.VipPage }))),
    order: lazyPage(() => import('./pages/OrderPage').then((m) => ({ default: m.OrderPage }))),
    notfound: lazyPage(() => import('./pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage }))),
  },
};

export default theme;
