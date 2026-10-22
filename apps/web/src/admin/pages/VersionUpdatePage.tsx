/**
 * 版本更新（/admin/about，系统分组最后一项；菜单文案仍复用 admin_menu_about 键）。
 *
 * 口径（参考 InsightFlare 的 manage/version-updates 页）：
 *  - 发布数据托管在 GitHub 仓库 `.github/releases/version.json`，更新日志为仓库内 Markdown，
 *    页面经 raw.githubusercontent.com 直接读取，发版不需要重新部署站点（见 admin/release-index.ts）。
 *  - 当前版本是站点代码版本（1.0.0）；当前提交取构建期注入的 VITE_COMMIT_SHA，
 *    部署流水线在 GitHub Actions 里注入，本地开发未注入时显示 -。
 *  - 版式沿用截图：顶部说明 + 数据来源、四格指标、按版本倒序的发布卡（徽标/元信息/更新日志）。
 */
import { useQuery } from '@tanstack/react-query';
import { useAdminLang, useAdminT } from '../t';
import type { IconName } from '../../components/icons';
import { Icon } from '../../components/icons';
import { Alert, Badge, PageTitle, cardBodyCls, cardCls, cx } from '../ui';
import {
  REPO_URL,
  fetchReleaseChangelog,
  fetchReleaseIndex,
  isSameCommit,
  normalizeVersion,
  shortCommit,
  type ReleaseEntry,
} from '../release-index';

/** 构建期注入：<package 版本>+<提交总数>[.dirty]，每次提交后自动变化（见 vite.config.ts） */
declare const __APP_VERSION__: string;
/** 构建期注入：当前构建对应的完整提交哈希 */
declare const __COMMIT_SHA__: string;

/** 当前构建版本号（去掉可能的 v 前缀），如 1.0.0+128；未命中发布 Tag 时展示它 */
const CURRENT_VERSION = normalizeVersion(__APP_VERSION__);
/** 当前运行构建的提交号 */
const CURRENT_COMMIT = __COMMIT_SHA__ || null;

/** 索引/日志变动不频繁，缓存 5 分钟，避免每次进页都打 GitHub */
const CACHE_TIME = 5 * 60 * 1000;

const linkBtnCls =
  'inline-flex items-center gap-1.5 rounded-[6px] border border-input-line bg-surface px-2 py-1 text-[.875rem] leading-[1.5] text-ink-soft transition-colors hover:border-brand/50 hover:bg-brand/5 hover:text-brand';

function formatTime(iso: string, locale: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '-';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(time);
}

/** 取当前条目之后（更旧）的第一个非草稿发布，用于生成 GitHub compare 链接 */
function previousTagOf(releases: ReleaseEntry[], entry: ReleaseEntry): string | null {
  const index = releases.findIndex((r) => r.tagName === entry.tagName);
  for (let i = index + 1; i < releases.length; i += 1) {
    const next = releases[i];
    if (next && !next.draft) return next.tagName;
  }
  return null;
}

function Metric({ icon, label, value, mono }: { icon: IconName; label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start gap-3 bg-surface p-4">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-brand/10 text-brand">
        <Icon name={icon} className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="m-0 text-xs text-muted">{label}</p>
        <p className={cx('m-0 mt-0.5 truncate text-[15px] font-semibold', mono && 'font-mono')}>{value}</p>
      </div>
    </div>
  );
}

function ReleaseCard({ entry, previousTag }: { entry: ReleaseEntry; previousTag: string | null }) {
  const t = useAdminT();
  const lang = useAdminLang();
  const notes = useQuery({
    queryKey: ['admin', 'release-notes', entry.tagName, lang],
    queryFn: ({ signal }) => fetchReleaseChangelog(entry, lang, signal),
    staleTime: Infinity,
    retry: false,
  });

  const isCurrent = isSameCommit(entry.targetCommitish, CURRENT_COMMIT);
  const status = entry.draft
    ? { tone: 'warning' as const, text: t('admin_version_draft') }
    : entry.prerelease
      ? { tone: 'warning' as const, text: t('admin_version_prerelease') }
      : { tone: 'success' as const, text: t('admin_version_stable') };

  return (
    <article className={cx(cardCls, 'overflow-hidden')}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-5 py-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Icon name="tag" className="size-4 text-brand" />
          <h3 className="m-0 font-mono text-[1.1rem] leading-tight font-semibold">{entry.tagName}</h3>
          <Badge tone={status.tone}>{status.text}</Badge>
          {isCurrent && <Badge tone="primary">{t('admin_version_current')}</Badge>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {previousTag && (
            <a
              href={`${REPO_URL}/compare/${previousTag}...${entry.tagName}`}
              target="_blank"
              rel="noreferrer"
              className={linkBtnCls}
            >
              <Icon name="git_commit" className="size-3.5" />
              {t('admin_version_view_changes')}
            </a>
          )}
          <a href={entry.htmlUrl} target="_blank" rel="noreferrer" className={linkBtnCls}>
            <Icon name="external_link" className="size-3.5" />
            {t('admin_version_open_release')}
          </a>
        </div>
      </div>

      <div className={cardBodyCls}>
        <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-2">
          <span>{t('admin_version_published_at')}: {formatTime(entry.publishedAt, lang)}</span>
          {entry.authorLogin && <span>{t('admin_version_author')}: {entry.authorLogin}</span>}
          {entry.targetCommitish && (
            <span>
              {t('admin_version_commit')}: <code className="font-mono">{shortCommit(entry.targetCommitish)}</code>
            </span>
          )}
        </p>

        <div className="mt-3 border-t border-line-soft pt-3">
          <h4 className="m-0 mb-2 text-sm font-medium">{t('admin_version_notes')}</h4>
          {notes.isPending ? (
            <p className="m-0 text-sm text-muted">{t('loading', '加载中…')}</p>
          ) : notes.data ? (
            <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[13px] leading-relaxed text-ink-soft">{notes.data}</pre>
          ) : (
            <p className="m-0 text-sm text-muted">{t('no_data', '暂无数据')}</p>
          )}
        </div>
      </div>
    </article>
  );
}

export function VersionUpdatePage() {
  const t = useAdminT();
  const q = useQuery({
    queryKey: ['admin', 'releases'],
    queryFn: ({ signal }) => fetchReleaseIndex(signal),
    staleTime: CACHE_TIME,
    retry: false,
  });

  const releases = q.data ?? [];
  const latest = releases.find((r) => !r.draft && !r.prerelease) ?? releases[0] ?? null;
  // 运行中的提交若正好是某个发布 Tag 指向的提交，就直接展示该 Tag（例如 v1.1.0），
  // 这样打 Tag 后无需重新部署，页面也能立刻把「当前版本」收敛到发布版本。
  const runningRelease = CURRENT_COMMIT
    ? (releases.find((r) => isSameCommit(r.targetCommitish, CURRENT_COMMIT)) ?? null)
    : null;

  return (
    <>
      <PageTitle>{t('admin_menu_about')}</PageTitle>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="m-0 text-[1.25rem] leading-tight font-medium">{t('admin_menu_about')}</h2>
          <p className="m-0 mt-1 text-sm text-muted">{t('admin_version_subtitle')}</p>
        </div>
        <a href={`${REPO_URL}/releases`} target="_blank" rel="noreferrer" className={linkBtnCls}>
          <Icon name="external_link" className="size-3.5" />
          {t('admin_version_source')}
        </a>
      </div>

      <section className={cx(cardCls, 'overflow-hidden')}>
        <div className="grid gap-px bg-line-soft sm:grid-cols-2 xl:grid-cols-4">
          <Metric icon="tag" label={t('admin_version_current')} value={runningRelease?.tagName ?? `v${CURRENT_VERSION}`} mono />
          <Metric icon="rocket" label={t('admin_version_latest')} value={latest?.tagName ?? '-'} mono />
          <Metric icon="git_commit" label={t('admin_version_current_commit')} value={shortCommit(CURRENT_COMMIT)} mono />
          <Metric
            icon="git_branch"
            label={t('admin_version_release_count')}
            value={q.isPending ? '-' : String(releases.length)}
          />
        </div>
      </section>

      {q.isPending && (
        <div className={cx(cardCls, cardBodyCls)}>
          <p className="m-0 text-sm text-muted">{t('loading', '加载中…')}</p>
        </div>
      )}

      {q.isError && (
        <Alert tone="warn">
          {t('admin_version_load_failed')}: {q.error instanceof Error ? q.error.message : String(q.error)}
        </Alert>
      )}

      {!q.isPending && !q.isError && releases.length === 0 && (
        <div className={cx(cardCls, cardBodyCls)}>
          <p className="m-0 text-sm text-muted">{t('no_data', '暂无数据')}</p>
        </div>
      )}

      {releases.map((entry) => (
        <ReleaseCard key={entry.tagName} entry={entry} previousTag={previousTagOf(releases, entry)} />
      ))}
    </>
  );
}
