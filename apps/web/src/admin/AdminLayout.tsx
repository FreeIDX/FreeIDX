/**
 * 后台骨架：现代扁平风（浅色 220px 侧栏 + 白色顶栏 + 浅灰内容底 + 白卡）。
 * 由深色侧栏版式改版而来，路由与功能不变：
 *  - 侧栏白底 + 分组小标（内容/用户/系统）+ 图标菜单，选中态 = 品牌蓝浅底（bg-brand/10 + text-brand）；
 *  - ≥768 侧栏常驻 220px，header/content/footer 一律 margin-left:220px，<768 侧栏平移出屏由顶栏按钮拉回；
 *  - 顶栏/页脚白底 + 发丝线；右下「回到顶部」圆形白钮（滚动 >0 淡入）；
 *  - 顶栏标题 = 所属侧栏菜单名（见 routeTitle：与侧栏共用同一份 MENU 文案），同一个值同时驱动 `<title>`。
 * 闸门四态：bootstrap 未 loaded → 占位；无前台会话 → 链前台登录；gid≠1 → 无权限卡；admin_at 过期由各页 ErrorState 就地唤起登录弹窗（AdminLoginModal）。
 */
import { Suspense, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router';
import { GroupId, type AdminKey } from '@freeidx/shared';
import { useAuth } from '../store/auth';
import { Avatar } from '../components/Avatar';
import { Icon, type IconName } from '../components/icons';
import { useAdminDictReady, useAdminT, type AdminT } from './t';
import { Card, ErrorState, cx } from './ui';
import { AdminLoginModal } from './AdminLoginModal';
import { PageLoading } from '../components/PageLoading';
import admWordmark from '../assets/admin/adm-wordmark.svg';

/** 菜单文案：字典键 + 未命中回退（字典原文），或字面量（改过名的菜单用） */
type MenuLabel = { textKey: AdminKey; fallback: string } | { text: string };

interface MenuEntry {
  key: string;
  to: string;
  icon: IconName;
  label: MenuLabel;
  /** 归属此菜单的路径前缀（含二级 Tab 目标） */
  prefixes: string[];
  exact?: boolean;
}

interface MenuGroup {
  /** 分组小标；null = 分组前直排（首页项） */
  label: MenuLabel | null;
  items: MenuEntry[];
}

/** 菜单项与功能一一对应，仅按现代版式归为「内容/用户/系统」三组；
 *  全部菜单文案采用中文字面量（主页/导航栏设置/创建版块/帖子列表/用户管理/开通会员/积分设置/广播消息/基础设置/插件中心/运行维护/版本更新） */
const MENU: MenuGroup[] = [
  {
    label: null,
    items: [
      { key: 'home', to: '/admin', label: { textKey: 'admin_menu_home', fallback: 'Home' }, icon: 'home', prefixes: ['/admin'], exact: true },
      /* 「导航栏设置」挂在主页菜单下：配置前台顶栏自定义导航项（版块/文章/自定义链接） */
      { key: 'nav', to: '/admin/nav', label: { textKey: 'admin_menu_nav_setting', fallback: 'Nav Bar' }, icon: 'menu', prefixes: ['/admin/nav'] },
    ],
  },
  {
    label: { textKey: 'admin_menu_content', fallback: 'Content' },
    items: [
      /* forum 与 thread 按语义取不同图标（folder/message） */
      { key: 'forum', to: '/admin/forums', label: { textKey: 'admin_menu_forum_create', fallback: 'Create Forum' }, icon: 'folder', prefixes: ['/admin/forums'] },
      { key: 'thread', to: '/admin/threads', label: { textKey: 'admin_menu_thread_list', fallback: 'Thread List' }, icon: 'message', prefixes: ['/admin/threads'] },
      /* 「内容审核」后台：8 档同页切换（待审/未过审 主题·回帖·用户 + 回收站 + 设置） */
      { key: 'check', to: '/admin/check', label: { textKey: 'admin_menu_content_check', fallback: 'Content Review' }, icon: 'shield', prefixes: ['/admin/check'] },
    ],
  },
  {
    label: { textKey: 'admin_menu_user', fallback: 'User' },
    items: [
      { key: 'user', to: '/admin/users', label: { textKey: 'admin_menu_user_manage', fallback: 'User Management' }, icon: 'user', prefixes: ['/admin/users', '/admin/banned', '/admin/groups'] },
      /* 「加V认证」后台（待审核/已通过/手动加V/收费设置四档同页切换）；
         icon 取 star（加V/认证徽章语义，shield 已被「内容审核」占用） */
      { key: 'v', to: '/admin/v', label: { textKey: 'admin_menu_v_verify', fallback: 'V Verification' }, icon: 'star', prefixes: ['/admin/v'] },
      /* 「会员」= 原独立「支付」分组三页（VIP 计划/订单/卡密，§15.4）合并后的单入口：落 /admin/vip，
         三条路由共用页内 PAY_TABS 切换，选中态由 prefixes 覆盖全部三条路径 */
      { key: 'vip', to: '/admin/vip', label: { textKey: 'admin_menu_vip_open', fallback: 'Membership' }, icon: 'crown', prefixes: ['/admin/vip', '/admin/orders', '/admin/cards'] },
      /* 「积分」= 本项目新增：设置/用户积分/流水三档同页切换，选中态覆盖三条子路径 */
      { key: 'points', to: '/admin/points', label: { textKey: 'admin_menu_points', fallback: 'Credit Settings' }, icon: 'database', prefixes: ['/admin/points'] },
      /* 「广播消息」后台菜单（消息列表/发送系统通知两档） */
      { key: 'notice', to: '/admin/notices', label: { textKey: 'admin_menu_notice', fallback: 'Broadcast' }, icon: 'bell', prefixes: ['/admin/notices'] },
    ],
  },
  {
    label: { textKey: 'admin_menu_system', fallback: 'System' },
    items: [
      { key: 'setting', to: '/admin/setting', label: { textKey: 'admin_menu_setting', fallback: 'Basic Settings' }, icon: 'settings', prefixes: ['/admin/setting'] },
      /* 「主题管理」：内置完整主题的启用/切换（主题清单由前端构建期自动发现，见 lib/theme/registry） */
      { key: 'theme', to: '/admin/themes', label: { textKey: 'admin_menu_theme', fallback: 'Theme Management' }, icon: 'image', prefixes: ['/admin/themes'] },
      { key: 'plugin', to: '/admin/extensions', label: { textKey: 'admin_menu_plugin', fallback: 'Plugin Center' }, icon: 'plug', prefixes: ['/admin/extensions'] },
      { key: 'other', to: '/admin/other', label: { textKey: 'admin_menu_other', fallback: 'Maintenance' }, icon: 'wrench', prefixes: ['/admin/other', '/admin/maintenance', '/admin/modlogs'] },
      /* 「版本更新」菜单项：发布索引托管在仓库 .github/releases，页内直读 GitHub raw */
      { key: 'update', to: '/admin/update', label: { textKey: 'admin_menu_about', fallback: 'Version Updates' }, icon: 'tag', prefixes: ['/admin/update'] },
    ],
  },
];

function isActive(entry: MenuEntry, path: string): boolean {
  if (entry.exact) return path === '/admin' || path === '/admin/';
  return entry.prefixes.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * 顶栏标题：与侧栏菜单名保持一致——命中哪条侧栏菜单就显示哪条菜单的文案：
 * 与侧栏共用同一份 MENU（isActive 按 to/prefixes 匹配，
 * 二级 Tab 目标也算在本菜单名下），从构造上保证「菜单栏 = 页面左上角」；同一值仍驱动 `<title>`
 * （非空才渲染）。后台二次验证已改为弹窗（AdminLoginModal），不再有独立登录页。
 */
function routeTitle(path: string, t: AdminT): string | null {
  const seg = path.split('/').filter(Boolean);
  if (seg[0] !== 'admin') return null;
  const entry = MENU.flatMap((g) => g.items).find((m) => isActive(m, path));
  if (!entry) return null;
  return 'text' in entry.label ? entry.label.text : t(entry.label.textKey, entry.label.fallback);
}

/** 侧栏项：圆角 + 图标，选中态 = 品牌蓝浅底蓝字，hover = 浅灰底 */
function sideNavCls(active: boolean): string {
  return cx(
    'flex items-center gap-2.5 rounded-[6px] py-[.5rem] pl-[28px] pr-3 tracking-[1px] transition-colors',
    active ? 'bg-brand/10 font-medium text-brand' : 'text-adm-side-ink hover:bg-adm-side-hover hover:text-ink',
  );
}

/** 右下「回到顶部」：常驻 DOM + 透明度切换（滚动 >0 淡入），圆形白钮 + 软阴影 */
function ScrollTopButton() {
  const t = useAdminT();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 0);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <button
      type="button"
      aria-label={t('admin_back_to_top', '回到顶部')}
      title={t('admin_back_to_top', '回到顶部')}
      tabIndex={show ? 0 : -1}
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      className={cx(
        'fixed bottom-[70px] right-[20px] z-[1037] flex size-[40px] cursor-pointer items-center justify-center rounded-full bg-surface text-ink shadow-[0_2px_8px_rgba(0,0,0,.12)] transition-[opacity,background-color] duration-[600ms] hover:bg-canvas',
        show ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      <Icon name="top" className="size-4" />
    </button>
  );
}

export function AdminLayout() {
  const me = useAuth((s) => s.me);
  const loaded = useAuth((s) => s.loaded);
  const setting = useAuth((s) => s.setting);
  const load = useAuth((s) => s.load);
  const signOut = useAuth((s) => s.signOut);
  const t = useAdminT();
  /* 后台词典（admin 分区）按需拉取：未到位前内容区先占位，避免闪出词条 key */
  const dictReady = useAdminDictReady();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const title = routeTitle(location.pathname, t);

  useEffect(() => {
    void load();
  }, [load]);

  /* `<title>` 取顶栏标题原值（无站点名后缀）。
     现在只有「后台页面不存在」这类不属任何侧栏菜单的路径取到 null；SPA 只有一个 document，
     留空会一直空到用户回前台，所以这里为空时退回站点名（§7 记为有意偏离）。 */
  useEffect(() => {
    document.title = title ?? setting?.sitename ?? '';
  }, [title, setting?.sitename]);

  /* 顶栏图标钮：圆角方钮，hover 浅灰底，图标染墨色 */
  const headCls = 'flex h-[2.25rem] items-center rounded-[6px] px-2.5 text-ink-soft transition-colors hover:bg-canvas hover:text-ink';
  const shift = 'transition-[margin-left] duration-300 md:ml-[220px]';

  return (
    <div className="theme-adm min-h-dvh bg-canvas text-ink">
      {/* 侧栏：白底 + 右侧发丝线，宽 220px（<md 平移出屏） */}
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-[1038] flex w-[220px] -ml-[220px] flex-col border-r border-line bg-surface transition-[margin-left] duration-300 ease-in-out md:ml-0',
          open && 'ml-0',
        )}
      >
        {/* 品牌区：居中 logo（有 logo_url 用图，否则用自绘 FreeIDX 字标） */}
        <div className="flex h-[calc(3.5rem+1px)] shrink-0 items-center justify-center border-b border-line-soft px-3 text-center">
          {setting?.logo_url ? (
            <img src={String(setting.logo_url)} alt={setting.sitename} className="h-[36px] rounded-full" />
          ) : (
            <img src={admWordmark} alt={setting?.sitename || 'FreeIDX'} className="h-[30px] w-auto" />
          )}
        </div>
        <div className="adm-sidebar min-h-0 flex-1 overflow-y-auto px-3 pb-4 pt-2">
          {MENU.map((g, gi) => (
            <div key={gi}>
              {g.label && <div className="px-3 pb-1 pt-[1.25rem] text-[11px] font-medium tracking-[.12em] text-muted">{'text' in g.label ? g.label.text : t(g.label.textKey, g.label.fallback)}</div>}
              <ul className="m-0 list-none space-y-[2px] p-0">
                {g.items.map((m) => (
                  <li key={m.key}>
                    <NavLink to={m.to} className={() => sideNavCls(isActive(m, location.pathname))} onClick={() => setOpen(false)}>
                      <Icon name={m.icon} className="size-4 shrink-0" />
                      <span className="truncate">{'text' in m.label ? m.label.text : t(m.label.textKey, m.label.fallback)}</span>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </aside>

      {/* <lg 侧栏拉出时的遮罩（移动端 pushmenu 覆盖显示行为） */}
      {open && <div className="fixed inset-0 z-[1037] bg-black/40 md:hidden" onClick={() => setOpen(false)} aria-hidden="true" />}

      <div className="flex min-h-dvh flex-col">
        {/* 顶栏：白底 + 发丝线；标题为空时整格留空 */}
        <header className={cx('z-[1034] flex min-h-[3.5rem] flex-wrap items-center gap-1 border-b border-line bg-surface px-3 py-[.5rem]', shift)}>
          <button
            type="button"
            className={cx(headCls, 'cursor-pointer')}
            aria-label={t('toggler_menu', '展开菜单')}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <Icon name="menu" className="size-5" />
          </button>
          <span className="mr-2 text-[15px] font-medium text-ink">{title}</span>

          <div className="ml-auto flex items-center gap-0.5">
            {me && (
              <Link to="/me" className={headCls} aria-label={me.username}>
                <Avatar uid={me.uid} avatar={me.avatar} username={me.username} size={1} />
              </Link>
            )}
            <Link to="/" className={headCls} title={t('front_index_page', '前台首页')}>
              <Icon name="home" className="size-5" />
            </Link>
            <button type="button" className={cx(headCls, 'cursor-pointer bg-transparent border-0')} title={t('logout', '退出')} onClick={() => void signOut()}>
              <Icon name="logout" className="size-5" />
            </button>
          </div>
        </header>

        <main id="body" className={cx('flex-1 bg-transparent', shift)}>
          {/* 内容区：全宽 + 现代留白（<md 16px，≥md 20px） */}
          <div className="w-full p-4 md:p-5">
            {!loaded || !dictReady ? (
              <Card>{t('submiting', '加载中')}…</Card>
            ) : !me ? (
              <Card title={t('admin_login', '管理登陆')}>
                <p className="text-sm text-muted">{t('for_safe_input_password_again', '为了您的安全，请再次输入账户密码')}</p>
                <Link
                  to="/login"
                  className="mt-3 inline-flex rounded bg-brand px-3 py-[.375rem] text-white hover:bg-brand-hover"
                >
                  {t('login', '登录')}
                </Link>
              </Card>
            ) : Number(me.gid) !== GroupId.ADMIN ? (
              <Card title={t('admin_index_page', '后台')}>
                <ErrorState error={new Error(t('no_privilege', '当前账号不是管理员，无法进入后台'))} />
              </Card>
            ) : (
              /* 子页懒加载边界：页面 chunk 到达前只有内容区占位，侧栏/顶栏保持在位 */
              <Suspense fallback={<PageLoading label={t('loading', '加载中')} />}>
                <Outlet />
              </Suspense>
            )}
          </div>
        </main>

        {/* 页脚：白底 + 上边发丝线 + 灰字 */}
        <footer className={cx('flex flex-wrap justify-between gap-2 border-t border-line bg-surface px-5 py-3 text-xs text-adm-footer-ink', shift)}>
          <span>
            Powered by <b>FreeIDX</b>
          </span>
          <span className="text-right">{setting?.sitename}</span>
        </footer>
      </div>

      <ScrollTopButton />

      {/* 后台二次验证弹窗：各页 403 / 旧登录地址就地唤起，成功后原地恢复 */}
      <AdminLoginModal />
    </div>
  );
}
