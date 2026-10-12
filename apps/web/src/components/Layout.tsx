/**
 * 前台布局：简蓝主题。
 *  - #header：白色固定顶栏（backdrop-blur 10.5px，桌面 75px / 移动两行），左 logo + 导航（首页/发现/版块/排行榜/友链），
 *    右搜索 + 发帖 + 暗色三态切换 + 语言 + 消息 + 用户下拉（270px 卡：头像/UID/用户组徽章 + 积分金币 + 菜单）；
 *  - #mobile_nav：移动端头像（抽屉）/搜索胶囊/消息/发帖 + 二级导航行 + 汉堡抽屉（社区导航 + 版块宫格）；
 *  - 底部导航栏（dock_switch）：首页/发现/发帖（中央凸起圆钮）/消息/我的；
 *  - footer：logo + 一级/二级文案 + 联系方式圆钮 + 导航行 + 运行信息 + 友链；
 *  - ：右缘半圆角回顶（back_top，滚动后滑入）；
 *  - 暗色三态（自动/日间/夜间）见 store/theme.ts。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { GroupId, AVAILABLE_LOCALES, NATIVE_LANG_NAMES } from '@freeidx/shared';
import { useAuth } from '../store/auth';
import { useAuthModal } from '../store/authModal';
import { AuthModal } from './AuthModal';
import { useT, useLang, useLangPref, useGroupName } from '../lib/i18n';
import { Avatar } from './Avatar';
import { Icon, type IconName } from './icons';
import { InsertCode, useInsertCodes } from './InsertCode';
import { cx } from './ui';
import { useApplyTheme, useLight, useThemeMode } from '../store/theme';

/** 导航项（.navbar-nav>.nav-item>.nav-link：px-4 常规 #6c757d，激活主色） */
function NavItem({
  to,
  label,
  active,
  external,
  onClick,
  compact,
}: {
  to: string;
  label: string;
  active: boolean;
  external?: boolean;
  onClick?: () => void;
  compact?: boolean;
}) {
  const cls = cx(
    'flex items-center gap-1.5 whitespace-nowrap transition-colors',
    compact ? 'rounded-[3px] px-3 py-1.5 text-sm' : 'h-full px-4 text-[15px]',
    active ? 'font-medium text-brand' : 'text-[#6c757d] hover:text-brand',
  );
  const inner = (
    <>
      {external && <Icon name="link" className="size-3.5 shrink-0 opacity-70" />}
      {label}
    </>
  );
  if (external) {
    return (
      <a href={to} target="_blank" rel="noreferrer" onClick={onClick} title={label} className={cls}>
        {inner}
      </a>
    );
  }
  return (
    <Link to={to} onClick={onClick} aria-current={active ? 'page' : undefined} title={label} className={cls}>
      {inner}
    </Link>
  );
}

/** 搜索：顶栏圆角胶囊（.index_header_search：--aid-color 底 + 20px 圆角） */
function SearchForm({ kw, setKw, onSearch, pill }: { kw: string; setKw: (v: string) => void; onSearch: (e: React.FormEvent) => void; pill?: boolean }) {
  const t = useT();
  return (
    <form
      className={cx(
        'flex h-9 w-full items-center rounded-[20px] bg-lt-aid px-3.5 transition-shadow focus-within:ring-2 focus-within:ring-[rgba(64,158,255,0.25)]',
        !pill && 'lg:max-w-[260px]',
      )}
      onSubmit={onSearch}
      role="search"
    >
      <input
        value={kw}
        onChange={(e) => setKw(e.target.value)}
        placeholder={t('keyword')}
        aria-label={t('search')}
        autoComplete="off"
        className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-zh-grey"
      />
      <button type="submit" aria-label={t('search')} className="flex size-7 shrink-0 items-center justify-center text-zh-grey transition-colors hover:text-brand">
        <Icon name="search" className="size-4" />
      </button>
    </form>
  );
}

/** 右缘回顶：50×25 左半圆角，滚动 200px 后滑入 */
function GoTop() {
  const t = useT();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 80);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <button
      type="button"
      aria-label={t('back_to_top')}
      title={t('back_to_top')}
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      className={cx(
        'fixed right-0 top-[200px] z-[1000] flex h-[25px] w-[50px] items-center justify-center rounded-l-[15px] bg-card text-zh-grey shadow-[0_1px_4px_rgba(0,0,0,0.08)] transition-transform duration-300 hover:text-brand',
        show ? 'translate-x-0' : 'translate-x-[60px]',
      )}
    >
      <Icon name="chevron_up" className="size-4" />
    </button>
  );
}

/** 暗色三态切换：自动→日间→夜间 */
function ThemeSwitch() {
  const t = useT();
  const mode = useThemeMode((s) => s.mode);
  const cycle = useThemeMode((s) => s.cycle);
  const label = mode === 'auto' ? t('theme_mode_auto') : mode === 'day' ? t('theme_mode_day') : t('theme_mode_night');
  const icon: IconName = mode === 'auto' ? 'refresh_cw' : mode === 'day' ? 'sun' : 'moon';
  return (
    <button
      type="button"
      className="flex size-10 items-center justify-center text-[#6c757d] transition-colors hover:text-brand"
      aria-label={`${t('theme_switch')}：${label}`}
      title={`${t('theme_switch')}：${label}`}
      onClick={cycle}
    >
      <Icon name={icon} className="size-[18px]" />
    </button>
  );
}

function LangSwitch({ compact }: { compact?: boolean }) {
  const t = useT();
  const lang = useLang();
  const setPref = useLangPref((s) => s.setPref);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={cx(
          'flex items-center justify-center text-[#6c757d] transition-colors hover:text-brand',
          compact ? 'h-9 gap-1 rounded-[3px] px-3 text-sm' : 'size-10',
        )}
        aria-label={t('select_language')}
        title={t('select_language')}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="globe" className="size-[18px]" />
        {compact && <span>{NATIVE_LANG_NAMES[lang] ?? lang}</span>}
      </button>
      {open && (
        <div
          className="absolute right-0 top-[calc(100%+6px)] z-[1500] max-h-[70vh] w-44 overflow-y-auto rounded-md bg-card py-1 shadow-[0_3px_15px_rgba(90,97,105,0.1),0_2px_3px_rgba(90,97,105,0.2)]"
          role="menu"
        >
          {AVAILABLE_LOCALES.map((l) => (
            <button
              key={l}
              type="button"
              role="menuitem"
              className={cx(
                'flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent',
                l === lang ? 'font-semibold text-brand' : 'text-foreground',
              )}
              onClick={() => {
                setPref(l);
                setOpen(false);
              }}
            >
              {NATIVE_LANG_NAMES[l] ?? l}
              {l === lang && <Icon name="check" className="size-4 shrink-0" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 用户下拉（.dropdown-menu 270px：资料头 + 积分/金币两行 + 菜单） */
function UserMenu() {
  const t = useT();
  const gn = useGroupName();
  const navigate = useNavigate();
  const light = useLight();
  /* 字段级订阅：整店订阅会让任一 store 字段变化都触发本组件重渲染（顶栏在每个页面常驻） */
  const me = useAuth((s) => s.me);
  const grouplist = useAuth((s) => s.grouplist);
  const signOut = useAuth((s) => s.signOut);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (!me) return null;
  const group = grouplist.find((g) => g.gid === me.gid);
  const progress = group && group.creditsto > 0 ? Math.min(100, Math.round(((me.credits ?? 0) / group.creditsto) * 100)) : 100;
  const items: [string, string][] = [
    [t('personal_profile'), '/me'],
    [t('my_posts'), '/me?s=threads'],
    [t('my_favorites'), '/me?s=favorites'],
    ...(light.headerGoldCount ? ([[t('my_credits'), '/me?s=credits']] as [string, string][]) : []),
    [t('ranking_short'), '/rank'],
    [t('my_main_page'), `/user/${me.uid}`],
    ...(me.gid === GroupId.ADMIN ? ([[t('admin_backend'), '/admin']] as [string, string][]) : []),
  ];
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className="flex items-center gap-1 rounded-full transition-opacity hover:opacity-85"
        aria-label={me.username}
        aria-expanded={open}
        aria-haspopup="menu"
        title={me.username}
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar uid={me.uid} avatar={me.avatar} username={me.username} size={2} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-[calc(100%+8px)] z-[1500] w-[270px] overflow-hidden rounded-[8px] bg-card shadow-[0_3px_15px_rgba(90,97,105,0.1),0_2px_3px_rgba(90,97,105,0.2)]"
          role="menu"
        >
          {/* 资料头（widget-user-header） */}
          <div className="flex items-center gap-3 border-b border-zh-line bg-lt-soft px-5 py-3.5">
            <Link to={`/user/${me.uid}`} onClick={() => setOpen(false)} className="shrink-0">
              <Avatar uid={me.uid} avatar={me.avatar} username={me.username} size={4} />
            </Link>
            <div className="min-w-0">
              <Link to={`/user/${me.uid}`} onClick={() => setOpen(false)} className="block truncate text-sm font-bold text-foreground hover:text-brand">
                {me.username}
              </Link>
              <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] leading-none">
                <span className="rounded-[3px] bg-brand px-1.5 py-0.5 text-white">UID:{me.uid}</span>
                {group && <span className="rounded-[3px] bg-[#00b8d8] px-1.5 py-0.5 text-white">{gn(group.gid, group.name)}</span>}
              </div>
            </div>
          </div>
          {/* 金币 / 积分两行 + 升级进度 */}
          {light.headerGoldCount && (
            <div className="space-y-1.5 px-4 py-3 text-xs text-lt-grey">
              <div className="flex items-center gap-2 rounded-[4px] bg-[rgba(41,151,247,0.1)] px-2.5 py-1.5">
                <Icon name="gem" className="size-3.5 text-brand" />
                {t('credits_gold')}
                <b className="ml-auto tabular-nums text-foreground">{me.golds ?? 0}</b>
              </div>
              <div className="rounded-[4px] bg-[rgba(41,151,247,0.1)] px-2.5 py-1.5">
                <div className="flex items-center gap-2">
                  <Icon name="flask" className="size-3.5 text-brand" />
                  {t('credits_label')}
                  <b className="ml-auto tabular-nums text-foreground">{me.credits ?? 0}</b>
                </div>
                <div className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-[#e9ecef]">
                  <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${progress}%` }} />
                </div>
              </div>
            </div>
          )}
          <ul className="border-t border-zh-line p-1.5 text-sm">
            {items.map(([label, to]) => (
              <li key={to}>
                <Link
                  to={to}
                  role="menuitem"
                  className="block rounded-[3px] px-3 py-1.5 text-foreground transition-colors hover:bg-accent hover:text-brand"
                  onClick={() => setOpen(false)}
                >
                  {label}
                </Link>
              </li>
            ))}
            <li>
              <button
                type="button"
                role="menuitem"
                className="block w-full rounded-[3px] px-3 py-1.5 text-left text-destructive transition-colors hover:bg-[rgba(245,108,108,0.1)]"
                onClick={() => {
                  setOpen(false);
                  void signOut().finally(() => navigate('/'));
                }}
              >
                {t('logout_btn')}
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const setting = useAuth((s) => s.setting);
  const forumlist = useAuth((s) => s.forumlist);
  const me = useAuth((s) => s.me);
  const load = useAuth((s) => s.load);
  const error = useAuth((s) => s.error);
  const t = useT();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const insertCodes = useInsertCodes();
  const light = useLight();
  useApplyTheme(light);
  const [drawer, setDrawer] = useState(false);
  const [kw, setKw] = useState('');
  const openAuth = useAuthModal((s) => s.openAuth);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setDrawer(false);
  }, [pathname]);

  useEffect(() => {
    document.title = setting?.sitename || 'FreeIDX';
  }, [pathname, setting?.sitename]);

  /* 顶栏导航与一级版块均为派生数据：Layout 在每个页面常驻、路由与 store 变化都会重渲染，
     故按来源引用记忆化；原 topForums 用 filter + some 为 O(版块数²)，改为 Set 查找 O(n)。 */
  const customNav = useMemo(
    () => (setting?.nav ?? []).filter((n) => n.on && n.label && n.url).sort((a, b) => a.sort - b.sort),
    [setting?.nav],
  );
  /* 二级版块：顶栏/移动二级行/抽屉宫格只显示一级版块（父不可见的子版块回退为一级，避免入口丢失） */
  const topForums = useMemo(() => {
    const fids = new Set(forumlist.map((f) => f.fid));
    return forumlist.filter((f) => !f.parentFid || !fids.has(f.parentFid));
  }, [forumlist]);

  const doSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = kw.trim();
    setDrawer(false);
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  };

  const homeActive = pathname === '/' || pathname.startsWith('/page');
  const discActive = pathname.startsWith('/discovery');
  const rankActive = pathname.startsWith('/rank');
  const forumItems = customNav.length > 0 ? customNav : topForums.map((f) => ({ label: f.name, url: `/forum/${f.fid}`, sort: f.rank, on: 1 as const }));
  const contact: IconName[] = ['message', 'comment', 'envelope'];
  /** 发现页显示名（可后台自定义；缺省回落 i18n「发现」） */
  const discLabel = light.discPageTitle || t('discovery');

  /** 发帖入口（顶栏 / 底栏共用）：落到第一个一级版块 */
  const createTo = topForums[0] ? `/forum/${topForums[0].fid}/new` : '/new';
  /** 底栏第二格：有发现页走发现，否则落到第一个一级版块 */
  const dockSecond: { icon: IconName; label: string; to: string; active: boolean } = light.discPage
    ? { icon: 'atom', label: discLabel, to: '/discovery', active: discActive }
    : { icon: 'grid', label: t('all_forums'), to: topForums[0] ? `/forum/${topForums[0].fid}` : '/', active: false };

  return (
    <div className={cx('theme-zh flex min-h-dvh flex-col bg-background text-foreground', light.bodyFontStyle === 2 && 'font-smiley')}>
      {/* ============ #header：固定白色顶栏（blur 10.5px）============ */}
      <header className="fixed inset-x-0 top-0 z-[999] w-full bg-card/96 backdrop-blur-[10.5px] max-lg:border-b max-lg:border-zh-line">
        {/* PC 行（lg+） */}
        <div className="mx-auto hidden h-[75px] w-full max-w-[1140px] items-center gap-2 px-4 lg:flex 3xl:max-w-[1536px]">
          <Link to="/" className="flex shrink-0 items-center" aria-label={setting?.sitename || 'FreeIDX'}>
            {setting?.logo_url ? (
              <img src={String(setting.logo_url)} alt={setting.sitename} className="h-[42px] w-auto max-w-none" />
            ) : (
              <span className="text-xl font-bold tracking-tight text-brand">{setting?.sitename || 'FreeIDX'}</span>
            )}
          </Link>
          <nav className="ml-4 flex h-full min-w-0 flex-1 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label={t('forum_nav')}>
            <NavItem to="/" label={t('home')} active={homeActive} />
            {light.enabled && light.discPage && <NavItem to="/discovery" label={discLabel} active={discActive} />}
            {forumItems.slice(0, 8).map((f) => (
              <NavItem
                key={f.url}
                to={f.url}
                label={f.label}
                active={pathname === f.url || pathname.startsWith(`${f.url}/`) || pathname.startsWith(`${f.url}?`)}
                external={/^https?:\/\//i.test(f.url)}
              />
            ))}
            <NavItem to="/rank" label={t('ranking_short')} active={rankActive} />
            {light.links.map((l) => (
              <NavItem key={`${l.name}-${l.url}`} to={l.url} label={l.name} active={false} external />
            ))}
          </nav>
          {light.navSearchForm && (
            <div className="hidden min-w-0 flex-1 md:block md:max-w-[260px]">
              <SearchForm kw={kw} setKw={setKw} onSearch={doSearch} />
            </div>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <Link
              to={createTo}
              className="mr-1 hidden h-9 items-center justify-center gap-1 rounded-[6px] bg-brand px-3.5 text-sm font-medium text-white transition-colors hover:bg-brand-hover sm:flex"
            >
              <Icon name="edit" className="size-4" /> {t('create_new_thread')}
            </Link>
            {light.darkMode && <ThemeSwitch />}
            <LangSwitch />
            {me ? (
              <>
                <Link
                  to="/me?s=notices"
                  className="relative flex size-10 items-center justify-center text-ink-soft transition-colors hover:text-brand"
                  aria-label={(me.unreadNotices ?? 0) > 0 ? t('message_unread_count', { count: me.unreadNotices ?? 0 }) : t('messages_short')}
                  title={t('messages_short')}
                >
                  <Icon name="bell" className="size-[18px]" />
                  {(me.unreadNotices ?? 0) > 0 && (
                    <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] font-medium leading-4 text-white tabular-nums">
                      {(me.unreadNotices ?? 0) > 99 ? '99+' : me.unreadNotices}
                    </span>
                  )}
                </Link>
                <UserMenu />
              </>
            ) : (
              <div className="flex items-center">
                <button
                  type="button"
                  className="px-2.5 py-2 text-[15px] text-ink-soft transition-colors hover:text-brand"
                  onClick={() => openAuth('login')}
                >
                  {t('login')}
                </button>
                <button
                  type="button"
                  className="px-2.5 py-2 text-[15px] text-ink-soft transition-colors hover:text-brand"
                  onClick={() => openAuth('register')}
                >
                  {t('register')}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 移动行（<lg）：头像 + 搜索胶囊 + 消息 + 发帖 */}
        <div className="flex h-[55px] items-center gap-2.5 px-3 lg:hidden">
          <button
            type="button"
            className="flex shrink-0 items-center"
            aria-label={t('open_nav')}
            onClick={() => setDrawer(true)}
          >
            {me ? (
              <Avatar uid={me.uid} avatar={me.avatar} username={me.username} size={2} />
            ) : (
              <span className="grid size-8 place-items-center rounded-full bg-lt-soft text-zh-grey">
                <Icon name="user" className="size-4" />
              </span>
            )}
          </button>
          <div className="min-w-0 flex-1">
            <SearchForm kw={kw} setKw={setKw} onSearch={doSearch} pill />
          </div>
          <Link
            to="/me?s=notices"
            className="relative flex size-9 shrink-0 items-center justify-center text-ink-soft"
            aria-label={t('messages_short')}
            title={t('messages_short')}
          >
            <Icon name="bell" className="size-5" />
            {(me?.unreadNotices ?? 0) > 0 && (
              <span className="absolute right-0 top-0 min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] font-medium leading-4 text-white tabular-nums">
                {(me?.unreadNotices ?? 0) > 99 ? '99+' : me?.unreadNotices}
              </span>
            )}
          </Link>
          <Link to={createTo} className="flex size-9 shrink-0 items-center justify-center text-brand" aria-label={t('create_new_thread')} title={t('create_new_thread')}>
            <Icon name="plus_circle" className="size-[22px]" />
          </Link>
        </div>
        {/* 移动二级行：导航 tabs + 汉堡（.header_nav_2_mobile_menu） */}
        <div className="flex h-[37px] items-center gap-1.5 border-t border-zh-line px-3 lg:hidden">
          <nav className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label={t('forum_nav')}>
            <NavItem to="/" label={t('home')} active={homeActive} compact />
            {light.enabled && light.discPage && <NavItem to="/discovery" label={discLabel} active={discActive} compact />}
            {forumItems.slice(0, 6).map((f) => (
              <NavItem key={f.url} to={f.url} label={f.label} active={pathname.startsWith(f.url)} compact external={/^https?:\/\//i.test(f.url)} />
            ))}
            <NavItem to="/rank" label={t('ranking_short')} active={rankActive} compact />
          </nav>
          {light.darkMode && <ThemeSwitch />}
          <button
            type="button"
            className="flex size-8 shrink-0 items-center justify-center text-ink-soft"
            aria-label={t('open_nav')}
            onClick={() => setDrawer(true)}
          >
            <Icon name="menu" className="size-5" />
          </button>
        </div>
      </header>

      {/* ============ 抽屉：社区导航 + 版块宫格============ */}
      {drawer && (
        <div className="fixed inset-0 z-[1500] lg:hidden">
          <div className="modal-fade absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} aria-hidden="true" />
          <div className="drawer-in absolute left-0 top-0 h-full w-[80%] max-w-[300px] overflow-y-auto bg-background p-4 shadow-[2px_0_20px_rgba(0,0,0,0.2)]">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-base font-bold tracking-tight text-brand">{setting?.sitename || 'FreeIDX'}</span>
              <button
                type="button"
                className="-mr-2 flex size-9 items-center justify-center rounded-full text-zh-grey transition-colors hover:bg-accent hover:text-foreground"
                aria-label={t('close_nav')}
                onClick={() => setDrawer(false)}
              >
                <Icon name="close" className="size-5" />
              </button>
            </div>
            {me ? (
              <div className="mb-3 flex items-center gap-3 rounded-[5px] bg-card p-3">
                <Avatar uid={me.uid} avatar={me.avatar} username={me.username} size={3} />
                <div className="min-w-0 flex-1">
                  <Link to={`/user/${me.uid}`} className="block truncate text-sm font-bold" onClick={() => setDrawer(false)}>
                    {me.username}
                  </Link>
                  <div className="mt-1 flex gap-2 text-[11px] text-lt-grey">
                    <span>{t('credits_label')} {me.credits ?? 0}</span>
                    <span>{t('credits_gold')} {me.golds ?? 0}</span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mb-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setDrawer(false);
                    openAuth('login');
                  }}
                  className="flex h-9 flex-1 items-center justify-center rounded-[6px] bg-brand text-sm font-medium text-white"
                >
                  {t('login')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setDrawer(false);
                    openAuth('register');
                  }}
                  className="flex h-9 flex-1 items-center justify-center rounded-[6px] border border-brand text-sm font-medium text-brand"
                >
                  {t('register')}
                </button>
              </div>
            )}
            {/* 社区导航（nav-pills：激活 #2997f7 字 + 10% 底） */}
            <p className="mb-1.5 mt-4 text-xs font-medium text-lt-grey">{t('community_nav')}</p>
            <ul className="space-y-0.5">
              {(
                [
                  ['home', t('home'), '/'],
                  ...(light.discPage ? ([['atom', discLabel, '/discovery']] as [IconName, string, string][]) : []),
                  ['medal', t('ranking_short'), '/rank'],
                  ['star', t('my_favorites'), '/me?s=favorites'],
                  ['bell', t('my_messages'), '/me?s=notices'],
                  ['user', t('my_home'), '/me'],
                ] as [IconName, string, string][]
              ).map(([icon, label, to]) => (
                <li key={to}>
                  <Link
                    to={to}
                    className={cx(
                      'flex items-center gap-2.5 rounded-[5px] px-3 py-1.5 text-[15px] transition-colors',
                      pathname === to ? 'bg-[rgba(41,151,247,0.1)] font-medium text-[#2997f7]' : 'text-foreground hover:bg-lt-hover',
                    )}
                    onClick={() => setDrawer(false)}
                  >
                    <Icon name={icon} className="size-4 shrink-0 text-brand" />
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
            {/* 版块宫格（col-4） */}
            <p className="mb-1.5 mt-4 text-xs font-medium text-lt-grey">{t('all_forums')}</p>
            <ul className="grid grid-cols-4 gap-1">
              {topForums.map((f) => (
                <li key={f.fid}>
                  <Link
                    to={`/forum/${f.fid}`}
                    className="flex flex-col items-center gap-1.5 rounded-[5px] px-1 py-2 text-center transition-colors hover:bg-card"
                    onClick={() => setDrawer(false)}
                  >
                    {f.iconUrl ? (
                      <img src={f.iconUrl} alt="" className="size-9 rounded-full object-contain" />
                    ) : (
                      <span className="grid size-9 place-items-center rounded-full bg-lt-soft">
                        <Icon name="folder" className="size-4 text-zh-grey" />
                      </span>
                    )}
                    <span className="w-full truncate text-[11px] leading-tight text-foreground">{f.name}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="mt-4 border-t border-zh-line pt-3">
              <Link
                to={createTo}
                onClick={() => setDrawer(false)}
                className="flex h-10 items-center justify-center gap-1.5 rounded-[6px] bg-brand text-sm font-medium text-white transition-colors hover:bg-brand-hover"
              >
                <Icon name="edit" className="size-4" /> {t('create_new_thread')}
              </Link>
              <div className="mt-2">
                <LangSwitch compact />
              </div>
            </div>
          </div>
        </div>
      )}

      {error && <div className="mx-auto w-full max-w-[1140px] px-4 pt-[100px] text-sm text-destructive lg:pt-[83px] 3xl:max-w-[1536px]">{error}</div>}

      {/* 内容区：#body（padding-top:75px / 移动 3.93rem+二级行） */}
      <main id="body" className="mx-auto w-full max-w-[1140px] flex-1 px-4 pb-8 pt-[100px] 3xl:max-w-[1536px] lg:pt-[83px] max-lg:pb-20">
        {children}
      </main>

      {/* ============ footer ============ */}
      <footer className="w-full bg-card py-4 text-[13px] text-lt-grey max-lg:pb-20">
        <div className="mx-auto w-full max-w-[1140px] px-4 3xl:max-w-[1536px]">
          <InsertCode html={insertCodes.footer_start_htm} />
          <div className="flex flex-wrap items-start justify-between gap-4 max-sm:flex-col max-sm:items-center max-sm:text-center">
            <div className="min-w-0">
              {light.footerIconShow &&
                (setting?.logo_url ? (
                  <img src={String(setting.logo_url)} alt={setting.sitename} className="mb-2 block h-9 w-auto" />
                ) : (
                  <span className="mb-2 block text-base font-bold text-brand">{setting?.sitename || 'FreeIDX'}</span>
                ))}
              <p className="text-sm leading-[26px] text-foreground">{setting?.brief || t('no_brief_yet')}</p>
              {light.footerOneContent && <p className="mt-1 whitespace-pre-line text-sm leading-[26px] text-foreground">{light.footerOneContent}</p>}
              {light.footerTwoContent && <p className="whitespace-pre-line text-xs leading-[24px] text-lt-grey">{light.footerTwoContent}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {contact.map((icon) => (
                <span
                  key={icon}
                  className="flex size-[50px] items-center justify-center rounded-full bg-lt-soft text-lt-grey"
                  title={
                    (icon === 'message' ? light.footerContactQq : icon === 'comment' ? light.footerContactWx : light.footerContactEmail) ||
                    setting?.sitename ||
                    'FreeIDX'
                  }
                >
                  <Icon name={icon} className="size-5" />
                </span>
              ))}
            </div>
          </div>
          <hr className="my-3 border-zh-line" />
          <InsertCode html={insertCodes.footer_footer_left_end_htm} />
          <ul className="flex flex-wrap items-center gap-x-5 gap-y-1 max-sm:justify-center">
            <li>
              <Link to="/" className="block py-1 transition-colors hover:text-brand">
                {t('home')}
              </Link>
            </li>
            {light.discPage && (
              <li>
                <Link to="/discovery" className="block py-1 transition-colors hover:text-brand">
                  {discLabel}
                </Link>
              </li>
            )}
            <li>
              <Link to="/rank" className="block py-1 transition-colors hover:text-brand">
                {t('ranking_short')}
              </Link>
            </li>
            <li>
              <Link to={createTo} className="block py-1 transition-colors hover:text-brand">
                {t('want_contribute')}
              </Link>
            </li>
            {light.links.map((l) => (
              <li key={`${l.name}-${l.url}`}>
                <a href={l.url} target="_blank" rel="noreferrer" className="block py-1 transition-colors hover:text-brand">
                  {l.name}
                </a>
              </li>
            ))}
            {light.themeCopyrightSwitch && (
              <li className="text-xs text-lt-grey">
                © {new Date().getFullYear()} {setting?.sitename || 'FreeIDX'} · Powered by FreeIDX
              </li>
            )}
          </ul>
          <InsertCode html={insertCodes.footer_footer_right_end_htm} />
        </div>
      </footer>

      {/* ============ 移动底部导航栏（dock_switch：55px 五格，中央凸起圆钮）============ */}
      {light.enabled && light.dockSwitch && (
        <nav
          className="fixed inset-x-0 bottom-0 z-[1000] flex h-[55px] items-stretch border-t border-zh-line bg-card lg:hidden"
          aria-label={t('community_nav')}
        >
          <Link to="/" className={cx('flex flex-1 flex-col items-center justify-center gap-0.5', homeActive ? 'text-brand' : 'text-[#9e9e9e]')}>
            <Icon name="home" className="size-[20px]" />
            <span className="text-[12px] leading-none">{t('home')}</span>
          </Link>
          <Link to={dockSecond.to} className={cx('flex flex-1 flex-col items-center justify-center gap-0.5', dockSecond.active ? 'text-brand' : 'text-[#9e9e9e]')}>
            <Icon name={dockSecond.icon} className="size-[20px]" />
            <span className="text-[12px] leading-none">{dockSecond.label}</span>
          </Link>
          <Link to={createTo} className="relative flex w-[22%] flex-col items-center justify-center" aria-label={t('create_new_thread')} title={t('create_new_thread')}>
            <span className="jb-blue absolute -top-[18px] flex size-[46px] items-center justify-center rounded-full text-white shadow-[0_2px_8px_rgba(64,158,255,0.45)]">
              <Icon name="plus" className="size-6" />
            </span>
          </Link>
          <Link
            to="/me?s=notices"
            className={cx('relative flex flex-1 flex-col items-center justify-center gap-0.5', pathname.includes('notices') ? 'text-brand' : 'text-[#9e9e9e]')}
          >
            <Icon name="message" className="size-[20px]" />
            {(me?.unreadNotices ?? 0) > 0 && (
              <span className="absolute right-[18%] top-[6px] min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] leading-4 text-white tabular-nums">
                {(me?.unreadNotices ?? 0) > 99 ? '99+' : me?.unreadNotices}
              </span>
            )}
            <span className="text-[12px] leading-none">{t('messages_short')}</span>
          </Link>
          <Link
            to="/me"
            className={cx('flex flex-1 flex-col items-center justify-center gap-0.5', pathname.startsWith('/me') ? 'text-brand' : 'text-[#9e9e9e]')}
          >
            <Icon name="user" className="size-[20px]" />
            <span className="text-[12px] leading-none">{t('dock_my')}</span>
          </Link>
        </nav>
      )}

      {light.enabled && light.backTop && <GoTop />}

      <InsertCode html={insertCodes.footer_end_htm} />
      <AuthModal />
    </div>
  );
}