/**
 * 后台公共控件（docs/后端页面设计文档.md §2.6 归出的 5 类复用模式 + §4 实现模式）：
 *  A TabBar 二级 Tab（按钮组版式，选中项为次要按钮高亮态）
 *  B InlineEditGrid 表格式内联编辑（版块列表/用户组列表/邮箱设置等表格页共用）
 *  C Field/SubmitRow 水平表单行（标签窄栏 + 控件宽栏）
 *  D PermissionMatrix 权限勾选矩阵（可编辑矩阵，含 checkall 整行同步）
 *  E AdminPagination 分页（搜索/列表由各页组合 InlineEditGrid/Field 实现）
 * 令牌来自 globals.css 的 @theme（前后台共用），勿写死色值。
 */
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ApiError } from '../lib/api';
import { Code } from '@freeidx/shared';
import { Icon } from '../components/icons';
import { useAdminT } from './t';
import { useAdminLoginModal } from './loginModal';

/* className 合并的唯一实现在 lib/cx.ts；本模块内部使用 + 对外 re-export（既有 import 站点不变） */
import { cx } from '../lib/cx';
export { cx };

/** 表单控件：6px 圆角 + 发丝线边框，focus 品牌蓝描边 + 3px 软光圈（现代口径） */
export const inputCls =
  'w-full min-h-[calc(2.25rem+2px)] px-3 py-[.375rem] text-base leading-normal text-ink-soft bg-surface border border-input-line rounded-[6px] ' +
  'focus:outline-none focus:border-brand focus:ring-[3px] focus:ring-brand/20 disabled:bg-canvas disabled:text-muted';

/**
 * 卡：白底 + 8px 圆角 + 软阴影（现代扁平），带 1rem 下边距。注意 **卡本身没有内边距**，
 * 内边距属于卡体（cardBodyCls），所以勿再往 cardCls 上叠 p-5。
 */
export const cardCls = 'mb-4 rounded-[8px] bg-surface shadow-adm-card';
export const cardBodyCls = 'p-[1.25rem]';
/** 卡头：白底 + 下边发丝线（现代扁平口径），标题走 15px medium */
const cardHeaderBaseCls =
  'flex flex-wrap items-center justify-between gap-2 rounded-t-[8px] border-b border-line-soft px-[1.25rem] py-[.875rem]';
export const cardHeaderCls = cx(cardHeaderBaseCls, 'text-card-header-ink');
/** 卡脚：白底 + 上边发丝线 */
export const cardFooterCls = 'rounded-b-[8px] border-t border-line-soft px-[1.25rem] py-[.75rem] text-sm text-ink-soft';

type BtnVariant = 'primary' | 'secondary' | 'danger' | 'default';
/** 按钮变体：primary 实底品牌蓝、default 白底灰边（hover 转蓝）——现代扁平口径 */
const btnVariant: Record<BtnVariant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-hover',
  secondary: 'bg-secondary/10 text-ink-soft hover:bg-secondary/20',
  danger: 'bg-danger text-white hover:bg-danger/80',
  default: 'border-input-line bg-surface text-ink-soft hover:border-brand/50 hover:bg-brand/5 hover:text-brand',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  block = false,
  className,
  children,
  ...rest
}: {
  variant?: BtnVariant;
  size?: 'md' | 'sm';
  loading?: boolean;
  block?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      disabled={loading || rest.disabled}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 border border-transparent leading-[1.5] transition-colors disabled:opacity-60',
        size === 'sm' ? 'rounded-[6px] px-2 py-1 text-[.875rem]' : 'rounded-[6px] px-3 py-[.375rem] text-base',
        block && 'w-full',
        btnVariant[variant],
        className,
      )}
    >
      {loading && <Icon name="refresh" className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export function LinkButton({
  to,
  variant = 'primary',
  size = 'md',
  className,
  children,
}: {
  to: string;
  variant?: BtnVariant;
  size?: 'md' | 'sm';
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 border border-transparent leading-[1.5] transition-colors',
        size === 'sm' ? 'rounded-[6px] px-2 py-1 text-[.875rem]' : 'rounded-[6px] px-3 py-[.375rem] text-base',
        btnVariant[variant],
        className,
      )}
    >
      {children}
    </Link>
  );
}

/**
 * 后台**没有可见的页面大标题**（页面正文第一行要么是二级 Tab，
 * 要么直接是卡；卡内小标题在多数页面上不渲染），
 * 页面身份靠侧栏选中项 + 二级 Tab + 卡头标题表达。这里保留 h1 只为读屏与文档大纲，视觉走 `.sr-only`。
 */
export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="sr-only [&+*]:mt-0">{children}</h1>;
}

/**
 * 卡三段式（卡头 + 卡体 + 卡脚）：
 * 卡头只有标题（1.1rem / 400）时左对齐，给 `tools` 才渲染右侧按钮组；
 * 表格类卡走 `noPadding`（卡体无内距），内边距由表格自己的 .75rem 单元格提供。
 */
export function Card({
  title,
  tools,
  footer,
  bodyClass,
  noPadding = false,
  headerClass,
  className,
  children,
}: {
  title?: ReactNode;
  tools?: ReactNode;
  footer?: ReactNode;
  bodyClass?: string;
  noPadding?: boolean;
  /** 彩色卡头（#17a2b8 底白字）时覆盖 header 底色与字色 */
  headerClass?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cx(cardCls, 'flex flex-col', className)}>
      {(title || tools) && (
        <div className={cx(headerClass ? cx(cardHeaderBaseCls, headerClass) : cardHeaderCls)}>
          {title && <span className="text-[15px] font-medium leading-[1.5]">{title}</span>}
          {tools && <div className="ml-auto flex items-center gap-1">{tools}</div>}
        </div>
      )}
      <div className={cx('min-h-px flex-1', !noPadding && cardBodyCls, bodyClass)}>{children}</div>
      {footer && <div className={cardFooterCls}>{footer}</div>}
    </section>
  );
}

/** 徽标：软色底 + 同色字（现代扁平口径） */
const badgeTone: Record<string, string> = {
  primary: 'bg-brand/10 text-brand',
  secondary: 'bg-secondary/10 text-secondary',
  success: 'bg-success/10 text-success',
  info: 'bg-info/10 text-info',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/10 text-danger',
  dark: 'bg-surface-dark text-white',
};

export function Badge({
  tone = 'secondary',
  className,
  children,
}: {
  tone?: keyof typeof badgeTone;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        'inline-block rounded-[4px] px-[.5em] py-[.25em] text-center text-[75%] font-medium leading-none whitespace-nowrap align-baseline',
        badgeTone[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * 模式 A：二级 Tab（逐条渲染 tab 子表，**只有一项时也照出**
 * ——主题批量页就只有 list 一个 tab，它就是该页的标题位，所以这里不在项数<2 时隐藏）。
 * 版式采用现代分段按钮：选中实底品牌蓝，未选中白底灰边。
 */
export function TabBar({ items, active }: { items: { k: string; to: string; text: string }[]; active: string }) {
  if (!items.length) return null;
  return (
    <div className="mb-[1rem] flex flex-wrap gap-1" role="tablist">
      {items.map((it) => (
        <Link
          key={it.k}
          to={it.to}
          role="tab"
          aria-selected={it.k === active}
          className={cx(
            'inline-flex items-center justify-center rounded-[6px] border px-3 py-[.375rem] text-sm leading-[1.5] transition-colors',
            it.k === active
              ? 'border-brand bg-brand text-white'
              : 'border-line bg-surface text-ink-soft hover:border-brand/40 hover:text-brand',
          )}
        >
          {it.text}
        </Link>
      ))}
    </div>
  );
}

/** 模式 C：水平表单行（<sm 堆叠；标签窄栏 + 控件宽栏栅格） */
export function Field({
  label,
  htmlFor,
  hint,
  hintInline,
  hintAfter,
  labelClass = 'sm:w-2/12',
  controlClass = 'sm:w-10/12',
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  /** hint 与控件同行（右对齐），适合单选组等矮控件 */
  hintInline?: boolean;
  /** hint 排在控件右侧（而非下方），配合定宽控件使用 */
  hintAfter?: boolean;
  /** 标签栏宽（默认 2/12；定宽场景传如 `sm:w-[85px]`） */
  labelClass?: string;
  controlClass?: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-col sm:flex-row sm:items-start gap-2">
      <label htmlFor={htmlFor} className={cx('font-medium leading-6 sm:shrink-0', labelClass)}>
        {label}：
      </label>
      {hintAfter ? (
        <div className="flex w-full min-w-0 flex-col gap-x-3 gap-y-1 sm:flex-1 sm:flex-row sm:items-start">
          <div className={cx('w-full min-w-0', controlClass)}>{children}</div>
          {hint && <p className="text-xs leading-6 text-muted-2 sm:flex-1">{hint}</p>}
        </div>
      ) : (
        <div className={cx('w-full', controlClass)}>
          {hintInline ? (
            <div className="flex flex-wrap items-center gap-x-[30px] gap-y-1">
              {children}
              {hint && <p className="text-xs text-muted-2">{hint}</p>}
            </div>
          ) : (
            <>
              {children}
              {hint && <p className="mt-2 text-xs text-muted-2">{hint}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** 模式 C 的收尾行：确定满宽 + 返回次按钮（空 label 占位对齐，此处用左内距等价实现） */
export function SubmitRow({ children, indentClass = 'sm:pl-[16.666%] sm:w-10/12' }: { children: ReactNode; indentClass?: string }) {
  return <div className={indentClass}>{children}</div>;
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(inputCls, className)} />;
}
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(inputCls, 'min-h-[5rem]', className)} />;
}
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(inputCls, className)}>
      {children}
    </select>
  );
}

/**
 * 模式 C 的单选组：产出
 * `<label><input type=radio name=.. value=k> 文案</label> &nbsp;`，
 * 逐项**横排**、项间一个 `&nbsp;`：裸 label + 浏览器原生 radio，无自定义外观、输入框不套控件框。
 * 基础设置的 runlevel（6 项）与三个 *_on（是/否）都是这个控件，不是下拉框。
 */
export function RadioGroup({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: string | number;
  options: { value: string | number; text: string }[];
  onChange: (next: string | number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-[20px]">
      {options.map((o) => (
        <label key={String(o.value)} className="inline-flex cursor-pointer items-center">
          <input type="radio" name={name} checked={String(o.value) === String(value)} onChange={() => onChange(o.value)} /> {o.text}
        </label>
      ))}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className={cx('inline-flex items-center gap-1.5', disabled ? 'cursor-not-allowed text-muted' : 'cursor-pointer')} title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-[var(--color-brand)]"
      />
      {label}
    </label>
  );
}

/** 开关（本项目新增：公告显示等布尔开关；role=switch，轨道 36×20 圆角 + 滑块位移） */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className={cx('inline-flex select-none items-center gap-2', disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer')} title={title}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-3 focus-visible:ring-[rgba(0,132,255,0.25)] disabled:pointer-events-none',
          checked ? 'bg-[var(--color-brand)]' : 'bg-[#c4c9cf]',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.2)] transition-[left]',
            checked ? 'left-[18px]' : 'left-0.5',
          )}
        />
      </button>
      {label}
    </label>
  );
}

/** 操作反馈条（图标随 tone 变化） */
export function Alert({ tone, children }: { tone: 'ok' | 'warn'; children: ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx(
        'mb-3 flex items-start gap-2 rounded-[6px] px-3 py-2 text-sm',
        tone === 'ok' ? 'bg-success/10 text-success' : 'bg-danger/10 text-danger',
      )}
    >
      <Icon name={tone === 'ok' ? 'check' : 'warning'} className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/**
 * 错误展示：守卫失败是 code NO_PERMISSION（HTTP 403，Cookie 过期/降组/改密吊销），
 * 这种情况就地唤起**后台登录弹窗**（AdminLoginModal，admin_at 与前台会话是两枚 Cookie，前台仍登录着），
 * 重验成功后失效全量查询、本页自动恢复；其它错误只显示服务端 message。
 */
export function ErrorState({ error }: { error: unknown }) {
  const t = useAdminT();
  const showLogin = useAdminLoginModal((s) => s.show);
  if (!error) return null;
  if (error instanceof ApiError && error.code === Code.NO_PERMISSION) {
    return (
      <div className={cx(cardCls, 'flex flex-col')}>
        <div className={cx(cardBodyCls, 'text-center')}>
          <p className="m-0 text-danger">{error.message}</p>
          <p className="mt-3 text-sm text-muted">{t('admin_token_expired_hint', '后台令牌有效期 1 小时，闲置超时后需重新验证。')}</p>
          <Button variant="primary" className="mt-4 inline-flex" onClick={showLogin}>
            <Icon name="lock" />
            {t('admin_re_verify', '重新验证')}
          </Button>
        </div>
      </div>
    );
  }
  return <Alert tone="warn">{error instanceof Error ? error.message : String(error)}</Alert>;
}

/**
 * 列表/数据网格外壳：可横向滚动表格，min-width:800px。
 * `.adm-table` 提供 .75rem 胞距、发丝线行分隔与表头浅灰底
 * （globals.css 中 `.theme-adm .adm-table` 段），所以这里不再手写 py-2 / border-b。
 * 列头默认左对齐（浏览器 UA 默认 th 居中，靠 globals.css `:where(.theme-adm .adm-table thead th)`
 * 的 `text-align: inherit` 打回与单元格同左，特异度为 0 不影响工具类覆盖），需要居中由调用方给 `text-center`。
 */
export function Table({
  head,
  headCls,
  children,
  minWidth = 'min-w-[800px]',
  hover = true,
  striped = false,
  flush = false,
}: {
  head: ReactNode[];
  /** 与 head 一一对应，写 th 上的 width/对齐（如 `w-[60px] text-center`） */
  headCls?: string[];
  children: ReactNode;
  minWidth?: string;
  hover?: boolean;
  striped?: boolean;
  /** 无边距表格（卡体无内距时贴边排版）：去掉表格自带的 1rem 下边距 */
  flush?: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className={cx('adm-table w-full text-base', hover && 'adm-table-hover', striped && 'adm-table-striped', flush && 'adm-flush', minWidth)}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" className={cx('whitespace-nowrap font-medium', headCls?.[i])}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** 列表页码（setSearchParams 的对象写法不接受 undefined，统一只读） */
export function usePage(): number {
  const [sp] = useSearchParams();
  return Math.max(1, Number(sp.get('page') ?? 1) || 1);
}

/** 待处理队列分页（行内右对齐，单页时不渲染） */
export function QueuePager({ page, totalPage, path }: { page: number; totalPage: number; path: string }) {
  if (totalPage <= 1) return null;
  return (
    <div className="mt-3 flex justify-end">
      <AdminPagination page={page} totalPage={totalPage} href={(p) => (p === 1 ? path : `${path}?page=${p}`)} />
    </div>
  );
}

/** 分页：无边框圆角格 + 4px 间隔，当前页实底品牌蓝，上/下一页用 ‹ › */
export function AdminPagination({ page, totalPage, href }: { page: number; totalPage: number; href: (p: number) => string }) {
  const t = useAdminT();
  if (totalPage <= 1) return null;
  const from = Math.max(1, Math.min(page - 2, totalPage - 4));
  const nums = Array.from({ length: Math.min(5, totalPage) }, (_, i) => from + i).filter((p) => p <= totalPage);
  const link = 'flex h-[2rem] min-w-[2rem] items-center justify-center rounded-[6px] px-2 text-sm leading-none transition-colors';
  const idle = cx(link, 'text-ink-soft hover:bg-brand/10 hover:text-brand');
  const dis = cx(link, 'pointer-events-none text-muted/50');
  return (
    <nav aria-label={t('pagination', '分页')}>
      <ul className="m-0 flex list-none flex-wrap items-center justify-center gap-1 p-0">
        {page > 1 ? (
          <li>
            <Link className={idle} to={href(page - 1)} aria-label={t('admin_prev_page', '上一页')}>
              ‹
            </Link>
          </li>
        ) : (
          <li>
            <span className={dis} aria-hidden="true">
              ‹
            </span>
          </li>
        )}
        {from > 1 && (
          <li>
            <span className={cx(link, 'pointer-events-none text-muted')}>…</span>
          </li>
        )}
        {nums.map((p) => (
          <li key={p}>
            <Link
              to={href(p)}
              aria-current={p === page ? 'page' : undefined}
              className={cx(link, p === page ? 'bg-brand font-medium text-white' : 'text-ink-soft hover:bg-brand/10 hover:text-brand')}
            >
              {p}
            </Link>
          </li>
        ))}
        {page < totalPage ? (
          <li>
            <Link className={idle} to={href(page + 1)} aria-label={t('next_page', '下一页')}>
              ›
            </Link>
          </li>
        ) : (
          <li>
            <span className={dis} aria-hidden="true">
              ›
            </span>
          </li>
        )}
      </ul>
    </nav>
  );
}

/**
 * 游标式分页：后端 /api/admin/orders、/api/admin/cards 只返回 `{list,page,size}` 而**没有 total**，
 * AdminPagination 需要 totalPage 用不了，故单列这一档。下一页可用性由调用方判断（约定：返回条数 === size 即可能还有）。
 * 样式与 AdminPagination 同源（圆角格 + 品牌蓝 hover），只是把数字页码换成「第 N 页」文案。
 */
export function AdminCursorPager({
  page,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: {
  page: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const t = useAdminT();
  const link = 'inline-flex h-[2rem] items-center justify-center rounded-[6px] px-3 text-sm leading-none transition-colors';
  const idle = cx(link, 'cursor-pointer text-ink-soft hover:bg-brand/10 hover:text-brand');
  const dis = cx(link, 'cursor-not-allowed text-muted/50');
  return (
    <nav aria-label={t('pagination', '分页')}>
      <ul className="m-0 flex list-none flex-wrap items-center justify-center gap-2 p-0">
        <li>
          {hasPrev ? (
            <button type="button" className={idle} onClick={onPrev} aria-label={t('admin_prev_page', '上一页')}>
              ‹ {t('admin_prev_page', '上一页')}
            </button>
          ) : (
            <span className={dis} aria-hidden="true">
              ‹ {t('admin_prev_page', '上一页')}
            </span>
          )}
        </li>
        <li className="px-1 text-sm text-muted">{t('admin_page_n', '第 {page} 页', { page })}</li>
        <li>
          {hasNext ? (
            <button type="button" className={idle} onClick={onNext} aria-label={t('next_page', '下一页')}>
              {t('next_page', '下一页')} ›
            </button>
          ) : (
            <span className={dis} aria-hidden="true">
              {t('next_page', '下一页')} ›
            </span>
          )}
        </li>
      </ul>
    </nav>
  );
}

/**
 * 破坏性确认（§3.6 定稿：`window.confirm` 与弹层确认两种形态在 React 侧收敛成这一种）。
 * 标题固定「请确认以下信息：」，按钮 确定/取消；遮罩 `bg-black/50` 150ms 淡入 + 面板微弹（§5 动画表）。
 * 打开时锁滚动，Esc / 点遮罩 = 取消。
 */
export function ConfirmModal({
  open,
  text,
  onConfirm,
  onCancel,
  loading = false,
  danger = true,
}: {
  open: boolean;
  text: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
  danger?: boolean;
}) {
  const t = useAdminT();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[1050] flex items-start justify-center bg-black/50 p-4 pt-[1.75rem] transition-opacity duration-150"
      onClick={onCancel}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[500px] origin-top rounded-[8px] bg-surface shadow-[0_12px_32px_rgba(0,0,0,.18)] duration-150"
      >
        <div className="flex items-start justify-between px-5 py-4">
          <h5 id="confirm-modal-title" className="m-0 text-[15px] leading-[1.5] font-medium">
            {t('admin_confirm_info', '请确认以下信息：')}
          </h5>
          <button type="button" onClick={onCancel} className="-mt-1 -mr-2 cursor-pointer border-0 bg-transparent p-2 text-muted hover:text-ink" aria-label={t('close', '关闭')}>
            <Icon name="close" />
          </button>
        </div>
        <div className="border-t border-line-soft px-5 py-4 text-sm text-ink-soft">{text}</div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-soft px-3 py-3">
          <Button variant="default" onClick={onCancel} disabled={loading}>
            {t('cancel', '取消')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {t('confirm', '确定')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * 通用表单弹层：沿用 ConfirmModal 的遮罩/锁滚动/Esc 口径，正文与页脚由调用方注入
 * （编辑主题、移动版块等需要自定义字段的弹窗复用，避免每页重写一遍弹层骨架）。
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const t = useAdminT();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[1050] flex items-start justify-center bg-black/50 p-4 pt-[1.75rem] transition-opacity duration-150"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className={cx(
          'w-full origin-top rounded-[8px] bg-surface shadow-[0_12px_32px_rgba(0,0,0,.18)] duration-150',
          wide ? 'max-w-[680px]' : 'max-w-[500px]',
        )}
      >
        <div className="flex items-start justify-between border-b border-line-soft px-5 py-4">
          <h5 className="m-0 text-[15px] leading-[1.5] font-medium">{title}</h5>
          <button
            type="button"
            onClick={onClose}
            className="-mt-1 -mr-2 cursor-pointer border-0 bg-transparent p-2 text-muted hover:text-ink"
            aria-label={t('close', '关闭')}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-soft px-3 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * SweetAlert2 `Toast.fire({icon:'success'})` 的应用内等价物：右上角淡入 3s 自动消失。
 * 后台写操作成功统一走它（列表页删行后就地 Toast），失败仍用 Alert/ErrorState。
 */
export function Toast({ text, tone = 'ok', onDone }: { text: string; tone?: 'ok' | 'warn'; onDone?: () => void }) {
  useEffect(() => {
    const timer = setTimeout(() => onDone?.(), 3000);
    return () => clearTimeout(timer);
  }, [text, onDone]);
  return (
    <div className="fixed top-4 right-4 z-[1080] flex items-center gap-2" role="status" aria-live="polite">
      <div className="flex items-center gap-2 rounded-[8px] border border-line-soft bg-surface px-4 py-[.75rem] text-sm text-ink shadow-[0_8px_24px_rgba(0,0,0,.12)]">
        <Icon name={tone === 'ok' ? 'check' : 'warning'} className={cx('size-4', tone === 'ok' ? 'text-success' : 'text-danger')} />
        {text}
      </div>
    </div>
  );
}

/** 本地 toast 状态：与 useBatchAction 的 flash 并存，页面用 `<Toast {...toast.bind} />` */
export function useToast() {
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'warn' } | null>(null);
  return {
    toast,
    show: (text: string, tone: 'ok' | 'warn' = 'ok') => setToast({ text, tone }),
    close: () => setToast(null),
  };
}

/* ------------------------------------------------------------------ *
 * 模式 B：表格式内联编辑数据网格
 * ------------------------------------------------------------------ */

export interface GridColumn<T> {
  /** 可编辑列必须给真实字段名；只读列可省略 */
  key?: keyof T & string;
  title: ReactNode;
  width?: string;
  inputType?: 'text' | 'number';
  /** 编辑框 placeholder 默认取列名（与列头文案一致，便于对照） */
  placeholder?: string;
  /** 只读/自定义渲染 */
  render?: (row: T) => ReactNode;
}

/**
 * 模式 B：表格式内联编辑。
 * 版式约定：
 *  - 表体 min-width:800px、外层可横向滚动，**没有**行悬停高亮；
 *  - 编辑 / 删除各占**独立表头列**（不是合并的「操作」列）：文案由调用方通过 editLabel/deleteLabel 传入；
 *  - 每行两个按钮都是**裸按钮**（无变体类）；
 *  - 系统保留行的删除位有两种口径：`lockMode='hide'` 整格不渲染按钮，`lockMode='click'` 照常渲染、
 *    点击后弹提示（由页面决定提示内容）。默认按用户组页的隐藏口径；
 *  - 尾部三行都是 `<p>`：[+]增加一行（裸按钮）、居中 `width:10rem` 的提交钮、灰色小字「注：…」尾注
 *    （尾注文案按各页语义传入）。
 */
export function InlineEditGrid<T>({
  columns,
  rows,
  rowId,
  systemIds = [],
  lockMode = 'hide',
  blank,
  onChange,
  onEdit,
  onDelete,
  editLabel,
  deleteLabel,
  onSubmit,
  submitting,
  tip,
  submitText,
  addText,
}: {
  columns: GridColumn<T>[];
  rows: T[];
  rowId: (row: T) => number;
  systemIds?: number[];
  /** 系统保留行的删除位：'hide' = 整格空，'click' = 照常渲染交给页面弹提示 */
  lockMode?: 'hide' | 'click';
  /** 省略则不渲染"增加一行"（新建走独立表单页的网格） */
  blank?: () => T;
  onChange: (rows: T[]) => void;
  onEdit?: (row: T) => void;
  onDelete?: (row: T) => void;
  editLabel?: ReactNode;
  deleteLabel?: ReactNode;
  onSubmit?: () => void;
  submitting?: boolean;
  tip?: string;
  submitText?: string;
  addText?: string;
}) {
  const t = useAdminT();
  const editLabelResolved = editLabel ?? t('edit', '编辑');
  const deleteLabelResolved = deleteLabel ?? t('delete', '删除');
  const submitTextResolved = submitText ?? t('confirm', '确定');
  const addTextResolved = addText ?? t('add_line', '增加一行');
  const setCell = (index: number, col: GridColumn<T>, raw: string) => {
    if (!col.key) return;
    const next = rows.slice();
    const row = { ...next[index]! } as Record<string, unknown>;
    row[col.key] = col.inputType === 'number' ? Number(raw || 0) : raw;
    next[index] = row as unknown as T;
    onChange(next);
  };

  return (
    <div className={cx(cardCls, 'flex flex-col')}>
      <div className={cardBodyCls}>
        <div className="overflow-x-auto">
          <table className="adm-table w-full min-w-[800px] text-base">
            <thead>
              <tr>
                {columns.map((c, i) => (
                  <th key={i} scope="col" className={cx('whitespace-nowrap font-medium', c.width)}>
                    {c.title}
                  </th>
                ))}
                {onEdit && <th scope="col" className="w-[100px] text-center font-medium">{editLabelResolved}</th>}
                {onDelete && <th scope="col" className="w-[100px] text-center font-medium">{deleteLabelResolved}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const id = rowId(row);
                const locked = systemIds.includes(id);
                const showDelete = onDelete !== undefined && !(locked && lockMode === 'hide');
                return (
                  <tr key={`${rowId(row)}-${index}`} className="text-center">
                    {columns.map((c, i) => (
                      <td key={i}>
                        {c.key && c.render === undefined ? (
                          <Input
                            type={c.inputType ?? 'text'}
                            placeholder={c.placeholder}
                            value={String(row[c.key] ?? '')}
                            onChange={(e) => setCell(index, c, e.target.value)}
                          />
                        ) : (
                          <span className="inline-block py-1">{c.render ? c.render(row) : String(row[c.key!] ?? '')}</span>
                        )}
                      </td>
                    ))}
                    {/* 编辑/删除 各占一列、都是**裸按钮**（无主色/危险变体） */}
                    {onEdit && (
                      <td>
                        <Button variant="default" onClick={() => onEdit(row)}>
                          {editLabelResolved}
                        </Button>
                      </td>
                    )}
                    {onDelete && (
                      <td>{showDelete && <Button variant="default" onClick={() => onDelete(row)}>{deleteLabelResolved}</Button>}</td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {blank && (
          <p className="mb-[1rem]">
            {/* `[+]<a class="btn row_add">增加一行</a>` 也是裸 .btn */}
            <Button variant="default" onClick={() => onChange([...rows, blank()])}>
              [+]
              {addTextResolved}
            </Button>
          </p>
        )}
        {onSubmit && (
          <p className="mb-[1rem] text-center">
            <Button type="submit" loading={submitting} onClick={onSubmit} className="w-[10rem]">
              {submitTextResolved}
            </Button>
          </p>
        )}
        {/* `.small`=80% 尾注；现代风统一用后台 muted-2 令牌 */}
        {tip && <p className="mb-[1rem] text-[80%] text-muted-2">{t('admin_note_tip', '注：{tip}', { tip })}</p>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 模式 D：权限勾选矩阵
 * ------------------------------------------------------------------ */

interface PermCol {
  key: string;
  label: string;
}

/**
 * value: gid → 权限键 → 0/1。首列"全选"同步整行（checkall）。
 * enabled=false 时整块不渲染（accesson 开关关闭即收起）。
 */
export function PermissionMatrix<V extends Record<string, number>>({
  groups,
  perms,
  value,
  enabled,
  onChange,
}: {
  groups: { gid: number; name: string }[];
  perms: PermCol[];
  value: Record<number, V>;
  enabled: boolean;
  onChange: (gid: number, key: string, checked: boolean) => void;
}) {
  const t = useAdminT();
  if (!enabled) return null;
  return (
    <div className="mt-[1rem] overflow-x-auto">
      {/* `<table class="table text-small" style="min-width:700px">`：12px 小字表格，无 hover 行 */}
      <table className="adm-table w-full min-w-[700px] text-[12px]">
        <thead>
          <tr>
            <th scope="col" className="w-[60px] text-center font-medium">{t('check_all', '全选')}</th>
            <th scope="col" className="font-medium">{t('user_group', '用户组')}</th>
            {perms.map((p, i) => (
              <th key={p.key} scope="col" className={cx('text-center whitespace-nowrap font-medium', i === 0 ? 'w-[80px]' : 'w-[60px]')}>
                {p.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const row = value[g.gid] ?? ({} as V);
            const all = perms.every((p) => Number(row[p.key] ?? 0) === 1);
            return (
              <tr key={g.gid}>
                <td className="text-center">
                  <Checkbox checked={all} onChange={(next) => perms.forEach((p) => onChange(g.gid, p.key, next))} />
                </td>
                <th scope="row" className="text-left font-normal whitespace-nowrap">
                  {g.name}
                </th>
                {perms.map((p) => (
                  <td key={p.key} className="text-center">
                    <Checkbox checked={Number(row[p.key] ?? 0) === 1} onChange={(next) => onChange(g.gid, p.key, next)} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
