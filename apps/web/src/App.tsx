/**
 * 路由表（§10.2）：前台全部路由由启用主题渲染（`ThemeRoute` 取主题 `pages.<name>`），
 * 后台是**独立外壳**（暗色 navbar、单列容器、自己的闸门），因此 /admin 前缀整体走 AdminRoutes，
 * 不套前台布局——前台/后台模板本就分属两个 view 目录。
 */
import { Link, Route, Routes, useLocation } from 'react-router';
import { Suspense, lazy, useEffect, useMemo, type ReactNode } from 'react';
import { useT } from './lib/i18n';
import { useAuth } from './store/auth';
import { detectDevice } from './lib/device';
import { Icon } from './components/icons';
import { PageLoading } from './components/PageLoading';
import { ThemeLayout } from './lib/theme/layout';
import { ThemeRoute } from './lib/theme/route';

/*
 * 路由级代码分割（§10.2）：前台页面已随「简蓝主题」迁至 apps/web/src/themes/light/pages/，
 * 由主题入口 themes/light/index.tsx 经 lazyPage() 注册（保持每页独立 chunk）；
 * 后台页在此处懒加载：普通访客只下载当前页 chunk，后台页与富文本编辑器 chunk 永不进入首屏。
 */

/* 后台是独立外壳（自带 Layout 与闸门），整块懒加载：普通访客完全不下发后台代码 */
const AdminLayout = lazy(() => import('./admin/AdminLayout').then((m) => ({ default: m.AdminLayout })));
const AdminIndexPage = lazy(() => import('./admin/pages/AdminIndexPage').then((m) => ({ default: m.AdminIndexPage })));
const VersionUpdatePage = lazy(() =>
  import('./admin/pages/VersionUpdatePage').then((m) => ({ default: m.VersionUpdatePage })),
);
const SettingPage = lazy(() => import('./admin/pages/SettingPage').then((m) => ({ default: m.SettingPage })));
const NavBarSettingPage = lazy(() => import('./admin/pages/NavBarSettingPage').then((m) => ({ default: m.NavBarSettingPage })));
const EmailSettingPage = lazy(() => import('./admin/pages/EmailSettingPage').then((m) => ({ default: m.EmailSettingPage })));
const ForumListPage = lazy(() => import('./admin/pages/ForumListPage').then((m) => ({ default: m.ForumListPage })));
const ForumEditPage = lazy(() => import('./admin/pages/ForumEditPage').then((m) => ({ default: m.ForumEditPage })));
const ThreadAdminPage = lazy(() => import('./admin/pages/ThreadAdminPage').then((m) => ({ default: m.ThreadAdminPage })));
const GroupListPage = lazy(() => import('./admin/pages/GroupListPage').then((m) => ({ default: m.GroupListPage })));
const GroupEditPage = lazy(() => import('./admin/pages/GroupEditPage').then((m) => ({ default: m.GroupEditPage })));
const UserListPage = lazy(() => import('./admin/pages/UserListPage').then((m) => ({ default: m.UserListPage })));
const UserEditPage = lazy(() => import('./admin/pages/UserEditPage').then((m) => ({ default: m.UserEditPage })));
const OtherPage = lazy(() => import('./admin/pages/OtherPage').then((m) => ({ default: m.OtherPage })));
const DbMaintenancePage = lazy(() => import('./admin/pages/DbMaintenancePage').then((m) => ({ default: m.DbMaintenancePage })));
const R2MaintenancePage = lazy(() => import('./admin/pages/R2MaintenancePage').then((m) => ({ default: m.R2MaintenancePage })));
const ModlogPage = lazy(() => import('./admin/pages/ModlogPage').then((m) => ({ default: m.ModlogPage })));
const ExtensionPage = lazy(() => import('./admin/pages/ExtensionPage').then((m) => ({ default: m.ExtensionPage })));
const ThemePage = lazy(() => import('./admin/pages/ThemePage').then((m) => ({ default: m.ThemePage })));
const ExtensionEditPage = lazy(() => import('./admin/pages/ExtensionEditPage').then((m) => ({ default: m.ExtensionEditPage })));
const VipPlanPage = lazy(() => import('./admin/pages/VipPlanPage').then((m) => ({ default: m.VipPlanPage })));
const OrderAdminPage = lazy(() => import('./admin/pages/OrderAdminPage').then((m) => ({ default: m.OrderAdminPage })));
const CardAdminPage = lazy(() => import('./admin/pages/CardAdminPage').then((m) => ({ default: m.CardAdminPage })));
const PointsPage = lazy(() => import('./admin/pages/PointsPage').then((m) => ({ default: m.PointsPage })));
const NoticeAdminPage = lazy(() => import('./admin/pages/NoticeAdminPage').then((m) => ({ default: m.NoticeAdminPage })));
const CheckPage = lazy(() => import('./admin/pages/CheckPage').then((m) => ({ default: m.CheckPage })));
const AdminVPage = lazy(() => import('./admin/pages/AdminVPage').then((m) => ({ default: m.AdminVPage })));

function ComingSoon({ label }: { label: string }) {
  const t = useT();
  return (
    <div className="zh-card px-6 py-10 text-center">
      <p className="font-medium">{label}</p>
      <p className="mt-2 text-sm text-muted-foreground">{t('coming_soon_hint')}</p>
      <Link className="mt-4 inline-block text-sm text-brand" to="/">
        {t('back_to_home')}
      </Link>
    </div>
  );
}

/** 后台外壳自带顶栏/页脚，故不套前台 Layout。
 *  Suspense 边界在此层：AdminLayout 外壳与其子页各自懒加载，外壳先渲染、子页随后补入。 */
function AdminRoutes() {
  const t = useT();
  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminIndexPage />} />
          <Route path="setting" element={<SettingPage />} />
          <Route path="setting/email" element={<EmailSettingPage />} />
          {/* 导航栏设置（主页菜单下）：配置前台顶栏自定义导航项 */}
          <Route path="nav" element={<NavBarSettingPage />} />
          <Route path="forums" element={<ForumListPage />} />
          <Route path="forums/new" element={<ForumEditPage />} />
          <Route path="forums/:fid/edit" element={<ForumEditPage />} />
          <Route path="threads" element={<ThreadAdminPage />} />
          <Route path="groups" element={<GroupListPage />} />
          <Route path="groups/:gid/edit" element={<GroupEditPage />} />
          <Route path="users" element={<UserListPage />} />
          <Route path="users/new" element={<UserEditPage />} />
          <Route path="users/:uid/edit" element={<UserEditPage />} />
          <Route path="other" element={<OtherPage />} />
          {/* 运行维护：数据库孤儿清理 / R2 未使用对象清理（第二批 tab，与「清理缓存」同菜单） */}
          <Route path="maintenance/db" element={<DbMaintenancePage />} />
          <Route path="maintenance/r2" element={<R2MaintenancePage />} />
          <Route path="modlogs" element={<ModlogPage />} />
          {/* 主题管理（系统分组，位于基础设置与插件中心之间） */}
          <Route path="themes" element={<ThemePage />} />
          <Route path="extensions" element={<ExtensionPage />} />
          <Route path="extensions/:id" element={<ExtensionEditPage />} />
          {/* 支付管理三页（本项目新增，§15.4） */}
          <Route path="vip" element={<VipPlanPage />} />
          <Route path="orders" element={<OrderAdminPage />} />
          <Route path="cards" element={<CardAdminPage />} />
          {/* 积分管理三档（本项目新增）：设置 / 用户积分 / 流水，同页按子路径切换 */}
          <Route path="points/*" element={<PointsPage />} />
          <Route path="notices/*" element={<NoticeAdminPage />} />
          {/* 内容审核八档：待审/未过审 主题·回帖·用户 + 回收站 + 设置 */}
          <Route path="check/*" element={<CheckPage />} />
          {/* 加V认证四档：待审核 / 已通过 / 手动加V / 收费设置 */}
          <Route path="v/*" element={<AdminVPage />} />
          {/* 版本更新（系统分组最后一项）：路径用 update，勿再用 about（前台「关于」语义） */}
          <Route path="update" element={<VersionUpdatePage />} />
          <Route path="*" element={<ComingSoon label={t('admin_page_not_found')} />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

/**
 * 设备访问闸门：后台「基础设置」可分别关闭手机/平板/电视端访问（device_*_on）。
 * 只拦前台；/admin 走独立分支不套本闸门，保证站长随时能回后台改回开关。
 * setting 未加载完（loaded=false）不拦截，避免误伤首屏。
 */
function DeviceGate({ children }: { children: ReactNode }) {
  const loaded = useAuth((s) => s.loaded);
  const setting = useAuth((s) => s.setting);
  const t = useT();
  const device = useMemo(() => detectDevice(), []);
  const allowed =
    device === 'desktop' ||
    (device === 'phone' && (setting?.devicePhoneOn ?? true)) ||
    (device === 'tablet' && (setting?.deviceTabletOn ?? true)) ||
    (device === 'tv' && (setting?.deviceTvOn ?? true));
  if (!loaded || allowed) return <>{children}</>;
  return (
    <div className="theme-zh flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
      <div className="zh-card w-full max-w-[420px] px-6 py-10 text-center">
        <Icon name="warning_circle" className="mx-auto size-10 text-zh-grey" />
        <p className="mt-3 text-lg font-bold">{t('device_disabled_title')}</p>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('device_disabled_desc')}</p>
      </div>
    </div>
  );
}

export function App() {
  const { pathname } = useLocation();
  /* 浏览器标签页图标：后台「基础设置」上传的 favicon（全局 setting 下发，前后台路由共用本组件）。
     index.html 里不预置 link，上传前保持无图标现状，上传后动态注入/更新。 */
  const faviconUrl = useAuth((s) => s.setting?.favicon_url);
  useEffect(() => {
    if (!faviconUrl) return;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = String(faviconUrl);
  }, [faviconUrl]);

  if (pathname === '/admin' || pathname.startsWith('/admin/')) return <AdminRoutes />;

  return (
    <DeviceGate>
      <ThemeLayout>
        {/* Suspense 内层化：页面 chunk 首次加载时顶栏/页脚保持在场，仅内容区显示回落，避免整页闪烁 */}
        <Suspense fallback={<PageLoading />}>
          <Routes>
            {/* 前台每个路由交给主题的整页实现（基底主题 light 提供全部页面，见 themes/light/index.tsx） */}
            <Route path="/" element={<ThemeRoute name="home" />} />
            <Route path="/page/:n" element={<ThemeRoute name="home" />} />
            <Route path="/forum/:fid" element={<ThemeRoute name="forum" />} />
            <Route path="/thread/:tid" element={<ThemeRoute name="thread" />} />
            <Route path="/thread/:tid/p/:page" element={<ThemeRoute name="thread" />} />
            {/* 购买记录（thread-sPay） */}
            <Route path="/thread/:tid/paylist" element={<ThemeRoute name="paylist" />} />
            <Route path="/thread/:tid/paylist/p/:page" element={<ThemeRoute name="paylist" />} />
            <Route path="/user/:uid" element={<ThemeRoute name="user" />} />
            <Route path="/login" element={<ThemeRoute name="login" />} />
            <Route path="/register" element={<ThemeRoute name="register" />} />
            <Route path="/resetpw" element={<ThemeRoute name="resetpw" />} />
            <Route path="/reset-password" element={<ThemeRoute name="resetpw" />} />
            <Route path="/me" element={<ThemeRoute name="me" />} />
            <Route path="/new" element={<ThemeRoute name="compose" />} />
            <Route path="/forum/:fid/new" element={<ThemeRoute name="compose" />} />
            <Route path="/search" element={<ThemeRoute name="search" />} />
            {/* 发现页（聚合页）+ 排行榜页 */}
            <Route path="/discovery" element={<ThemeRoute name="discovery" />} />
            <Route path="/rank" element={<ThemeRoute name="rank" />} />
            <Route path="/mod/:fid" element={<ThemeRoute name="mod" />} />
            {/* VIP 收银台（§15）：套餐页公开可浏览；订单页需登录（收银台/卡密/轮询） */}
            <Route path="/vip" element={<ThemeRoute name="vip" />} />
            <Route path="/order/:no" element={<ThemeRoute name="order" />} />
            {/* 404 页：未匹配路由 → 专门 404 页 */}
            <Route path="*" element={<ThemeRoute name="notfound" />} />
          </Routes>
        </Suspense>
      </ThemeLayout>
    </DeviceGate>
  );
}
