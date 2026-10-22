import { Link } from 'react-router';
import { useT } from '../lib/i18n';
import { cx } from './ui';

/** §3.4 分页（格子上 3px 圆角、外边距 3px、选中 #0084ff 白字），≤1 页不渲染。
 * 外层 margin：首页/版块页 `my-3`，详情页 `my-4`。 */
export function Pagination({
  page,
  totalPage,
  href,
  className = 'my-3',
}: {
  page: number;
  totalPage: number;
  href: (p: number) => string;
  className?: string;
}) {
  const t = useT();
  if (totalPage <= 1) return null;

  /** 页码截断：totalPage<=7 全显；否则取 {1, totalPages, page-1, page, page+1} 排序后插省略号 */
  const tokens: (number | 'ellipsis')[] =
    totalPage <= 7
      ? Array.from({ length: totalPage }, (_, i) => i + 1)
      : (() => {
          const visible = Array.from(new Set([1, totalPage, page, page - 1, page + 1]))
            .filter((v) => v >= 1 && v <= totalPage)
            .sort((a, b) => a - b);
          const out: (number | 'ellipsis')[] = [];
          for (const cur of visible) {
            const last = out[out.length - 1];
            const prev = typeof last === 'number' ? last : null;
            if (prev !== null && cur - prev > 1) out.push('ellipsis');
            out.push(cur);
          }
          return out;
        })();

  /* 分页格：38px 高、#dee2e6 边、#0084ff 字；hover #e9ecef；选中 #0084ff 白字 */
  const cell = 'inline-flex h-[38px] min-w-[38px] items-center justify-center rounded-[3px] border border-[#dee2e6] px-3 text-sm text-brand transition-colors';
  const cellOff = 'inline-flex h-[38px] min-w-[38px] items-center justify-center rounded-[3px] border border-[#dee2e6] px-3 text-sm text-zh-grey opacity-60';

  return (
    <nav className={cx(className, 'flex justify-center')} aria-label={t('pagination')}>
      <ul className="m-0 flex list-none flex-wrap items-center justify-center gap-1.5 p-0">
        {page > 1 ? (
          <li>
            <Link className={cx(cell, 'bg-card hover:bg-accent')} to={href(page - 1)} aria-label={t('last_page')}>
              {t('last_page')}
            </Link>
          </li>
        ) : (
          <li>
            <span className={cellOff} aria-disabled="true">
              {t('last_page')}
            </span>
          </li>
        )}
        {tokens.map((t, i) =>
          t === 'ellipsis' ? (
            <li key={`ellipsis-${i}`} className="px-1 text-sm text-zh-grey">
              …
            </li>
          ) : (
            <li key={t}>
              <Link
                to={href(t)}
                aria-current={t === page ? 'page' : undefined}
                className={cx(cell, t === page ? 'border-brand bg-brand text-white' : 'bg-card hover:bg-accent')}
              >
                {t}
              </Link>
            </li>
          ),
        )}
        {page < totalPage ? (
          <li>
            <Link className={cx(cell, 'bg-card hover:bg-accent')} to={href(page + 1)} aria-label={t('next_page')}>
              {t('next_page')}
            </Link>
          </li>
        ) : (
          <li>
            <span className={cellOff} aria-disabled="true">
              {t('next_page')}
            </span>
          </li>
        )}
      </ul>
    </nav>
  );
}
