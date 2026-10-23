/**
 * 前台公共组件。
 * 卡片 = 白底 5px 圆角、扁平无阴影（.zh-card，globals.css）；主色 #409EFF；
 * 卡头 = 透明底 + 1px #dee2e6 下边线 + #454d55 字（.zh-card-header）；列表发丝线 border-zh-line。
 * 一律消费 globals.css @theme 令牌，勿写死色值（主题专有色 zh、lt 前缀令牌除外）。
 */
import { Fragment, useEffect, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ForumNode } from '@freeidx/shared';
import { Icon, type IconName } from './icons';
import { Avatar } from './Avatar';
import { useT } from '../lib/i18n';
import { useAuthModal } from '../store/authModal';
import { useAuth } from '../store/auth';
import ztIcon from '../assets/theme/zt.png';
import tzIcon from '../assets/theme/tz.png';
import userIcon from '../assets/theme/user.png';
import zxIcon from '../assets/theme/zx.png';

/* className 合并的唯一实现在 lib/cx.ts；本模块内部使用 + 对外 re-export（既有 import 站点不变） */
import { cx } from '../lib/cx';
export { cx };

/** 输入框基元：38px 高、4px 圆角、#ced4da 边、聚焦蓝环 */
export const inputCls =
  'h-[38px] w-full min-w-0 rounded-[4px] border border-input-line bg-card px-3 text-sm text-foreground transition-colors ' +
  'outline-none placeholder:text-zh-grey focus:border-[#a0cfff] focus:ring-3 focus:ring-[rgba(64,158,255,0.25)] ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

type BtnVariant = 'primary' | 'outline' | 'secondary' | 'danger';
const btnVariant: Record<BtnVariant, string> = {
  /* 主色按钮：#409EFF，hover #006fe6 */
  primary: 'bg-brand text-white hover:bg-brand-hover',
  /* 主色描边按钮：主色边主色字，hover 填 #ecf5ff */
  outline: 'border border-brand bg-card text-brand hover:bg-[#ecf5ff]',
  /* 次要按钮：--secondary #909399 */
  secondary: 'bg-[#909399] text-white hover:bg-[#7d8590]',
  /* 危险按钮：#F56C6C */
  danger: 'bg-destructive text-white hover:bg-[#f78989]',
};
const btnBase =
  'inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[4px] border border-transparent ' +
  'text-sm transition-all outline-none focus-visible:ring-3 focus-visible:ring-[rgba(64,158,255,0.25)] ' +
  'disabled:pointer-events-none disabled:opacity-50';

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  block = false,
  loadingText,
  className,
  children,
  ...rest
}: {
  variant?: BtnVariant;
  size?: 'md' | 'sm';
  loading?: boolean;
  block?: boolean;
  loadingText?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const t = useT();
  return (
    <button
      {...rest}
      disabled={loading || rest.disabled}
      className={cx(
        btnBase,
        variant === 'outline' ? 'border-brand' : 'border-0',
        size === 'sm' ? 'h-[31px] px-2' : 'h-[38px] px-3',
        block && 'w-full',
        btnVariant[variant],
        className,
      )}
    >
      {loading && <Icon name="refresh" className="size-3.5 animate-spin" />}
      {loading ? (loadingText ?? t('submitting')) : children}
    </button>
  );
}

export function LinkButton({
  to,
  variant = 'primary',
  size = 'md',
  block = false,
  className,
  children,
}: {
  to: string;
  variant?: BtnVariant;
  size?: 'md' | 'sm';
  block?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cx(
        btnBase,
        variant === 'outline' ? 'border-brand' : 'border-0',
        size === 'sm' ? 'h-[31px] px-2' : 'h-[38px] px-3',
        block && 'w-full',
        btnVariant[variant],
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** 卡片（.zh-card：白底 5px 圆角、扁平；卡头 .zh-card-header 透明底 + 1px 下边线） */
export function Card({
  header,
  children,
  footer,
  className,
  bodyClass = 'p-5',
  ariaLabel,
}: {
  header?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyClass?: string;
  ariaLabel?: string;
}) {
  return (
    <section className={cx('zh-card mb-4', className)} aria-label={ariaLabel}>
      {header && (
        <div className="zh-card-header flex items-center gap-2 px-5 py-3 text-sm font-medium">
          {header}
        </div>
      )}
      <div className={bodyClass}>{children}</div>
      {footer}
    </section>
  );
}

/** 卡头标题（无竖条，14px #454d55） */
export function CardTitle({ children }: { children: ReactNode }) {
  return <span className="flex items-center gap-2 text-sm font-medium">{children}</span>;
}

/** Alert 色调（.alert-primary #2997f7 10% 底 / .alert-secondary #e9ecef / .alert-success 绿 10% 底） */
export function Alert({
  tone = 'primary',
  icon,
  children,
  className,
}: {
  tone?: 'primary' | 'secondary' | 'success' | 'warning' | 'info';
  icon?: IconName;
  children: ReactNode;
  className?: string;
}) {
  const toneCls: Record<string, string> = {
    primary: 'bg-[rgba(41,151,247,0.1)] text-[#1f6fbf]',
    secondary: 'bg-zh-notice text-zh-notice-ink',
    success: 'bg-[rgba(103,194,58,0.12)] text-[#4d8b23]',
    warning: 'bg-[rgba(230,162,60,0.14)] text-[#a4681a]',
    info: 'bg-[rgba(0,184,216,0.12)] text-[#0f7d92]',
  };
  return (
    <div className={cx('flex items-start gap-2 rounded-[5px] px-4 py-2.5 text-sm leading-6', toneCls[tone], className)} role="note">
      {icon && <Icon name={icon} className="mt-1 size-4 shrink-0" />}
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

/** 标签徽章（idx_tag：badge-pill + badge-{style}）；样式取自后台 light 扩展的标签定义 */
const TAG_STYLE_CLS: Record<string, string> = {
  primary: 'bg-brand text-white',
  secondary: 'bg-[#909399] text-white',
  success: 'bg-[#67c23a] text-white',
  danger: 'bg-[#f56c6c] text-white',
  warning: 'bg-[#e6a23c] text-white',
  info: 'bg-[#00b8d8] text-white',
  dark: 'bg-[#303133] text-white',
  light: 'bg-lt-soft text-ink-soft',
};

export function TagBadge({ name, style = 'primary', to, className }: { name: string; style?: string; to?: string; className?: string }) {
  const cls = cx(
    'inline-flex shrink-0 items-center rounded-full px-2.5 py-[3px] text-xs leading-none transition-opacity',
    TAG_STYLE_CLS[style] ?? TAG_STYLE_CLS.primary,
    to && 'hover:opacity-85',
    className,
  );
  if (to) {
    return (
      <Link to={to} className={cls}>
        {name}
      </Link>
    );
  }
  return <span className={cls}>{name}</span>;
}

/** 通用小胶囊徽章（.badge：置顶/精华/审核等） */
export function Pill({ children, className, jb, title }: { children: ReactNode; className?: string; jb?: string; title?: string }) {
  return (
    <span
      className={cx('inline-flex shrink-0 items-center rounded-[3px] px-1.5 py-0.5 text-[11px] leading-none text-white', jb, className)}
      title={title}
    >
      {children}
    </span>
  );
}

/** 卡脚统计（.wzxx：2 列图文数据，图标 25px） */
const STAT_ICON = { zt: ztIcon, tz: tzIcon, user: userIcon, zx: zxIcon } as const;

export function CardStats({ items }: { items: [ReactNode, string, (keyof typeof STAT_ICON)?][] }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-4 p-4">
      {items.map(([value, label, icon]) => (
        <div key={label} className="flex items-center gap-2.5 text-sm">
          {icon && <img src={STAT_ICON[icon]} alt="" className="w-6 shrink-0" />}
          <span className="min-w-0 truncate text-muted-foreground">{label}</span>
          <b className="ml-auto tabular-nums text-foreground">{value}</b>
        </div>
      ))}
    </div>
  );
}

/** 卡头 tabs（常规 #909399，激活主色 + 2px 主色下划线） */
export function CardTabs({ items }: { items: { k: string; text: string; icon?: IconName; active?: boolean; to?: string; onClick?: () => void }[] }) {
  return (
    <ul className="flex flex-nowrap items-center justify-start gap-4 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {items.map((it) => {
        const cls = cx(
          'flex shrink-0 items-center gap-1 whitespace-nowrap border-b-2 pb-1 text-sm transition-colors',
          it.active ? 'border-brand font-medium text-brand' : 'border-transparent text-lt-grey hover:text-brand',
        );
        const icon = it.icon && <Icon name={it.icon} className="h-4 w-4" />;
        return (
          <li key={it.k}>
            {it.to ? (
              <Link className={cls} to={it.to}>
                {icon}
                <span>{it.text}</span>
              </Link>
            ) : (
              <button className={cls} onClick={it.onClick}>
                {icon}
                <span>{it.text}</span>
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** 带图标前缀的输入框（灰底前缀 + 白底输入） */
export function IconInput({ icon, className, ...rest }: { icon: IconName } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="flex items-stretch">
      <span className="flex items-center rounded-l-[4px] border border-r-0 border-[#ced4da] bg-[#e9ecef] px-3 text-[#6c757d] dark:border-[#28262d] dark:bg-[#28262d] dark:text-[#a8abb2]">
        <Icon name={icon} />
      </span>
      <input
        {...rest}
        className={cx(inputCls, 'rounded-l-none', className)}
      />
    </div>
  );
}

/** 侧栏导航项（快捷筛选 + 版块直链同一行式） */
type SideNavItem = { k: string; label: string; icon: IconName; to: string; active?: boolean };

const SIDENAV_COLLAPSED_KEY = 'freeidx:side-nav-collapsed';

/** 版块导航折叠态（localStorage 持久化，首页/版块页共用） */
function useSideNavCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDENAV_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem(SIDENAV_COLLAPSED_KEY, next ? '1' : '0');
      } catch {
        /* 隐私模式等写入失败时仅本次会话生效 */
      }
      return next;
    });
  return [collapsed, toggle];
}

/** 左侧版块导航（lg 以上显示、190px、滚动吸顶）。
 *  可折叠为 56px 图标轨（增强交互），折叠态持久化。 */
function SideNav({ items, ariaLabel, divider = true }: { items: SideNavItem[]; ariaLabel?: string; divider?: boolean }) {
  const forumlist = useAuth((s) => s.forumlist);
  const t = useT();
  const [collapsed, toggle] = useSideNavCollapsed();
  const itemCls = (active: boolean) =>
    cx(
      'flex h-10 items-center gap-2.5 rounded-[5px] px-3 text-sm leading-6 transition-colors outline-none',
      collapsed && 'justify-center gap-0 px-0',
      active ? 'bg-[rgba(41,151,247,0.1)] font-medium text-[#2997f7]' : 'text-foreground hover:bg-lt-hover',
    );
  const toggleLabel = collapsed ? t('side_nav_expand') : t('side_nav_collapse');
  /* 二级版块：一级版块（父不可见的子版块回退为一级，避免入口丢失）+ 其下缩进子项 */
  const tops = forumlist.filter((f) => !f.parentFid || !forumlist.some((p) => p.fid === f.parentFid));
  const kidsOf = (fid: number) => forumlist.filter((f) => f.parentFid === fid);
  const forumLink = (f: ForumNode) => (
    <Link to={`/forum/${f.fid}`} title={f.name} className={itemCls(false)}>
      {f.iconUrl ? (
        <img src={f.iconUrl} alt="" className="size-[24px] shrink-0 rounded-full object-contain" />
      ) : (
        <Icon name="folder" className="size-[20px] shrink-0 text-zh-grey" aria-hidden="true" />
      )}
      {!collapsed && <span className="truncate">{f.name}</span>}
    </Link>
  );
  return (
    <div
      className={cx(
        'hidden shrink-0 self-start transition-[width] duration-200 lg:sticky lg:top-4 lg:z-10 lg:block',
        collapsed ? 'w-[56px]' : 'w-[190px]',
      )}
    >
      <nav aria-label={ariaLabel} className="zh-card mb-4 py-2">
        {/* 导航项与折叠按钮同一行：展开时项在左、按钮在右；折叠（56px）时纵向排列、按钮置顶 */}
        <div className={cx('flex gap-1 px-2', collapsed ? 'flex-col items-center' : 'items-center')}>
          <ul className={cx('min-w-0', collapsed ? 'w-full' : 'flex-1')}>
            {items.map((it) => (
              <li key={it.k}>
                <Link
                  to={it.to}
                  title={collapsed ? it.label : undefined}
                  aria-current={it.active ? 'page' : undefined}
                  className={itemCls(!!it.active)}
                >
                  <Icon name={it.icon} className={cx('size-[20px] shrink-0', it.active ? 'text-brand' : 'text-zh-grey')} />
                  {!collapsed && <span className="truncate">{it.label}</span>}
                </Link>
              </li>
            ))}
          </ul>
          <button
            type="button"
            title={toggleLabel}
            aria-label={toggleLabel}
            aria-expanded={!collapsed}
            onClick={toggle}
            className={cx(
              'flex size-7 shrink-0 items-center justify-center rounded-full border border-zh-line text-zh-grey transition-colors hover:border-brand hover:text-brand',
              collapsed && 'order-first',
            )}
          >
            <Icon name="chevron_left" className={cx('size-3.5 transition-transform duration-200', collapsed && 'rotate-180')} />
          </button>
        </div>
        {divider && <div className={cx('my-2 border-t border-zh-line', collapsed ? 'mx-2' : 'mx-4')} aria-hidden="true" />}
        <ul>
          {tops.map((f) => {
            /* 折叠态（56px）不渲染子项，避免溢出 */
            const kids = collapsed ? [] : kidsOf(f.fid);
            return (
              <Fragment key={f.fid}>
                <li className="px-2">{forumLink(f)}</li>
                {kids.length > 0 && (
                  <li>
                    <ul className="ml-[26px] border-l border-zh-line">
                      {kids.map((k) => (
                        <li key={k.fid} className="px-2">
                          {forumLink(k)}
                        </li>
                      ))}
                    </ul>
                  </li>
                )}
              </Fragment>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

/** 左侧版块导航「主页」版（首页/版块页共用）：置顶「主页」入口 + 版块直链，无分隔线 */
export function HomeSideNav() {
  const t = useT();
  const items: SideNavItem[] = [{ k: 'home', label: t('home'), icon: 'home', to: '/' }];
  return <SideNav items={items} ariaLabel={t('home_forum_nav')} divider={false} />;
}

/** 两栏：主内容 + 右侧栏（9/12 + 3/12 栅格，<lg 隐藏侧栏）。
 * left = 可选左侧版块导航（SideNav，自带列宽与折叠态）；asideSticky = 右栏滚动吸顶。 */
export function TwoCol({
  children,
  aside,
  left,
  asideSticky = false,
}: {
  children: ReactNode;
  aside: ReactNode;
  left?: ReactNode;
  asideSticky?: boolean;
}) {
  return (
    /* gap-4 与左侧导航列/行级布局同口径（.row 栅格间距） */
    <div className="flex flex-col gap-4 lg:flex-row">
      {left}
      <div className="min-w-0 flex-[3]">{children}</div>
      <aside className={cx('hidden w-[285px] shrink-0 lg:block', asideSticky && 'self-start lg:sticky lg:top-4 lg:z-10')}>
        {aside}
      </aside>
    </div>
  );
}

/** 侧栏面板（无卡头的小卡：白底 5px 圆角、扁平；p-0 供通栏卡头版式用） */
export function SidePanel({ children, className, pad = 'p-4' }: { children: ReactNode; className?: string; pad?: 'p-0' | 'p-3' | 'p-4' }) {
  return <section className={cx('zh-card mb-4', pad, className)}>{children}</section>;
}

/** 侧栏置顶“发新帖”按钮 */
export function CreateButton({ fid, text }: { fid?: number; text?: string }) {
  const t = useT();
  return (
    <LinkButton to={fid ? `/forum/${fid}/new` : '/new'} variant="primary" block className="mb-4">
      <Icon name="edit" className="size-4" /> {text ?? t('create_new_thread')}
    </LinkButton>
  );
}

/** 面包屑（.breadcrumb：白卡条 14px） */
export function Breadcrumb({ items, right }: { items: { text: string; to?: string; title?: string }[]; right?: ReactNode }) {
  return (
    <div className="zh-card mb-2 flex min-h-[50px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
      <ol className="flex min-w-0 items-center gap-1.5 text-lt-grey">
        {items.map((it, i) => (
          <li key={i} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && <span className="shrink-0 opacity-50">/</span>}
            {it.to ? (
              <Link className="flex items-center gap-1 text-foreground transition-colors hover:text-brand" to={it.to}>
                {i === 0 ? <Icon name="home" className="size-4" /> : <span className="truncate">{it.text}</span>}
              </Link>
            ) : (
              <span className="truncate text-foreground" title={it.title}>
                {it.text}
              </span>
            )}
          </li>
        ))}
      </ol>
      {right && <div className="ml-auto flex items-center gap-3 text-lt-grey">{right}</div>}
    </div>
  );
}

/** 占位插画（自绘极简柴犬线稿，等宽 61px） */
function MascotSketch() {
  return (
    <svg viewBox="0 0 64 64" className="w-[61px] shrink-0 self-end text-brand opacity-80" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 27 12.5 11 25 18" />
        <path d="M49 27 51.5 11 39 18" />
        <circle cx="32" cy="37" r="17.5" />
        <circle cx="25" cy="34" r="1.6" fill="currentColor" stroke="none" />
        <circle cx="39" cy="34" r="1.6" fill="currentColor" stroke="none" />
        <path d="M32 40.5v4" />
        <path d="M27.5 48.5c2.8 2.2 6.2 2.2 9 0" />
      </g>
    </svg>
  );
}

/** 游客侧栏面板：站点问候 + 登录/注册（主色按钮 / 蓝描边按钮），右侧插画位 */
export function GuestCard() {
  const t = useT();
  const openAuth = useAuthModal((s) => s.openAuth);
  return (
    <SidePanel>
      <div className="flex items-stretch gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[15px] font-bold text-foreground">
            <span className="h-4 w-[3px] shrink-0 rounded bg-brand" /> {t('guest_hello')}
          </div>
          <div className="mt-1.5 text-xs text-muted-foreground">{t('guest_login_tip')}</div>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => openAuth('login')}
              className="inline-flex h-8 items-center justify-center rounded-[4px] bg-brand px-3 text-sm text-white transition-colors hover:bg-[#006fe6]"
            >
              {t('login')}
            </button>
            <button
              type="button"
              onClick={() => openAuth('register')}
              className="inline-flex h-8 items-center justify-center rounded-[4px] border border-brand bg-card px-3 text-sm text-brand transition-colors hover:bg-[#ecf5ff]"
            >
              {t('register')}
            </button>
          </div>
        </div>
        <MascotSketch />
      </div>
    </SidePanel>
  );
}

/** 登录态快捷入口卡（三个 50px 彩色圆形图标入口 + 底部「个人中心|我的主页」行） */
export function QuickHelpCard({ uid }: { uid: number }) {
  const t = useT();
  const items = [
    { icon: 'user' as const, color: '#0084FF', label: t('my_posts'), to: '/me?s=threads' },
    { icon: 'database' as const, color: '#F4C807', label: t('post_resource'), to: '/new' },
    { icon: 'comment' as const, color: '#26BFBF', label: t('resource_help'), to: '/new' },
  ];
  return (
    <SidePanel pad="p-4">
      <div className="grid grid-cols-3 gap-2">
        {items.map((it) => (
          <Link key={it.label} to={it.to} className="flex flex-col items-center gap-1.5">
            <span
              className="flex size-[50px] items-center justify-center rounded-full text-white transition-transform hover:-translate-y-0.5"
              style={{ backgroundColor: it.color }}
            >
              <Icon name={it.icon} className="size-5" />
            </span>
            <span className="text-xs text-muted-foreground">{it.label}</span>
          </Link>
        ))}
      </div>
      <div className="mt-3 flex justify-center items-center gap-2 border-t border-zh-line pt-2.5 text-xs text-muted-foreground">
        <Link to="/me" className="transition-colors hover:text-brand">
          {t('my_home')}
        </Link>
        <span className="opacity-40">|</span>
        <Link to={`/user/${uid}`} className="transition-colors hover:text-brand">
          {t('my_homepage')}
        </Link>
      </div>
    </SidePanel>
  );
}

/** 登录态侧栏用户卡（80px 背景图 bg-0.webp + 上移 25px 白边头像 + 组徽章 + 等级进度 + 数据行） */
export function UserSideCard(props: {
  me: { uid: number; username: string; avatar: number; gid: number; threads: number; posts: number; credits: number; following: number; followers: number };
  groupName: string;
  progress: number;
}) {
  const { me } = props;
  const pct = Math.max(0, Math.min(100, props.progress));
  const t = useT();
  return (
    <section className="zh-card mb-4 overflow-hidden">
      {/* .index-siteInfo-bg：80px 背景图（bg-0.webp，cover/center） */}
      <div className="h-[80px] w-full bg-cover bg-center" style={{ backgroundImage: 'url(/theme-light/bg-0.webp)' }} />
      <div className="relative -mt-[25px] px-4 pb-4 text-center">
        <div className="flex flex-col items-center">
          <Avatar uid={me.uid} avatar={me.avatar} username={me.username} size={4} className="border-[3px] border-card bg-card" />
          <Link
            to={`/user/${me.uid}`}
            className="mt-2 max-w-full truncate text-sm font-bold text-foreground hover:text-brand"
          >
            {me.username}
          </Link>
          {props.groupName && (
            <span className="mt-1.5 inline-flex rounded bg-brand px-1.5 py-0.5 text-[10px] leading-none text-white">
              {props.groupName}
            </span>
          )}
          {/* 等级行：iconpark v{gid} 精灵图简化为蓝字 v{gid} 徽章 */}
          <div className="mt-1.5 flex items-center gap-1 text-xs">
            <span className="font-semibold text-ink-soft">{t('level_label')}</span>
            <span className="rounded bg-[rgba(41,151,247,0.1)] px-1.5 py-0.5 text-[10px] font-medium leading-none text-brand">
              v{me.gid}
            </span>
          </div>
          <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-[#e9ecef]">
            <div className="zh-progress-bar h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
          </div>
          {/* 四格统计：主题/帖子/关注/粉丝 */}
          <div className="mt-3 grid w-full grid-cols-4 gap-1.5">
            {(
              [
                [me.threads, t('thread_count_short')],
                [me.posts, t('posts_label')],
                [me.following, t('following_label')],
                [me.followers, t('followers_label')],
              ] as const
            ).map(([value, label]) => (
              <div key={label} className="rounded-md bg-zh-stat-bg px-1 py-1.5 text-center">
                <b className="text-sm font-semibold leading-none tabular-nums text-foreground">{value}</b>
                <p className="mt-1 text-[10px] leading-none text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/** 个人/他人主页左侧栏菜单行（.user-sidebar-info：灰字 + 蓝图标，active 浅蓝底蓝字） */
export function UserSideItem({ to, label, active, icon }: { to: string; label: string; active: boolean; icon: IconName }) {
  return (
    <Link
      className={cx(
        'flex items-center gap-2.5 rounded-[10px] px-3.5 py-2.5 text-sm transition-colors',
        active ? 'bg-[rgba(13,137,253,0.08)] font-medium text-brand' : 'text-zh-grey hover:bg-accent hover:text-brand',
      )}
      to={to}
    >
      <Icon name={icon} className={cx('size-4 shrink-0', active ? 'text-brand' : 'text-[#007fff]')} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Icon name="chevron_right" className="size-3.5 shrink-0 opacity-50" />
    </Link>
  );
}

/** 数据磁贴（#F7F9FA 底 + 24px 加粗数字 + #AAAEB3 描述） */
export function UserCountTile({ label, value, desc, icon }: { label: string; value: number; desc: string; icon: IconName }) {
  return (
    <li className="relative w-full overflow-hidden rounded-md bg-zh-stat-bg p-4">
      <Icon name={icon} className="absolute -right-2 -top-2 size-16 text-[rgba(209,233,255,0.28)]" />
      <div className="relative">
        <div className="text-sm text-foreground">{label}</div>
        <p className="my-2 text-2xl font-semibold tabular-nums text-foreground">{value}</p>
        <div className="text-xs text-[#AAAEB3]">{desc}</div>
      </div>
    </li>
  );
}

/** 资料行（#8590A6 标题 + 值） */
export function UserInfoRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <p className="relative py-3 text-sm">
      <span className="mr-1.5 inline-block text-zh-grey">{title}</span>
      <span className="inline-block text-foreground">{children}</span>
    </p>
  );
}

/** Modal：白卡 6px 圆角 + 悬浮投影（modal-content 无边框） */
export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 'max-w-[500px]',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const t = useT();
  return (
    <div className="modal-fade fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <section
        className={cx('modal-pop w-full overflow-hidden rounded-[5px] bg-card shadow-[0_3px_15px_rgba(90,97,105,0.1),0_2px_3px_rgba(90,97,105,0.2)]', width)}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <header className="flex items-center justify-between border-b border-zh-line px-5 py-3">
          <h5 className="text-sm font-medium text-card-header-ink">{title}</h5>
          <button
            className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={t('close')}
            onClick={onClose}
          >
            <Icon name="close" className="size-4" />
          </button>
        </header>
        <div className="p-5">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-zh-line px-5 py-3">{footer}</footer>}
      </section>
    </div>
  );
}
