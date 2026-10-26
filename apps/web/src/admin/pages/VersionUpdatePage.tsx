/**
 * 版本更新（/admin/update，系统分组最后一项；菜单文案仍复用 admin_menu_about 键）。
 *
 * 口径：
 *  - 发布数据托管在 GitHub 仓库 `.github/releases/version.json`，更新日志为仓库内 Markdown，
 *    页面经 raw.githubusercontent.com 直接读取，发版不需要重新部署站点（见 admin/release-index.ts）。
 *  - 当前版本取构建期注入的最近发布 Tag __GIT_TAG__（vite.config.ts 用 git describe 计算），
 *    构建点无论在 Tag 之前还是之后都能归到正确发布；构建号（__BUILD_NUM__）仅作为提交号后的
 *    行内附注，绝不拼进版本号（此前 `1.0.1+17` 的 +17 是提交总数）。
 *  - 当前提交取构建期注入的 VITE_COMMIT_SHA，部署流水线在 GitHub Actions 里注入，
 *    本地开发未注入时显示 -；无 git 元数据的构建（源码包/浅克隆）无 Tag 时回落包版本。
 *  - 版式：顶部说明 + 数据来源、四格指标、按版本倒序的发布卡（徽标/元信息/更新日志）；
 *    页面标题只由后台顶栏承担（此处不再重复渲染），发布卡默认折叠（点卡头展开元信息与更新日志）。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAdminLang, useAdminT } from '../t';
import type { IconName } from '../../components/icons';
import { Icon } from '../../components/icons';
import { Alert, Badge, PageTitle, cardBodyCls, cardCls, cx } from '../ui';
import {
  REPO_URL,
  compareVersion,
  fetchReleaseChangelog,
  fetchReleaseIndex,
  isSameCommit,
  normalizeVersion,
  shortCommit,
  type ReleaseEntry,
} from '../release-index';

/** 构建期注入：发布版本号（最近 Tag 的版本或包版本，无 +build 元数据，见 vite.config.ts） */
declare const __APP_VERSION__: string;
/** 构建期注入：当前构建对应的完整提交哈希 */
declare const __COMMIT_SHA__: string;
/** 构建期注入：最近可达发布 Tag（如 v1.0.2）；无 git 元数据时为空 */
declare const __GIT_TAG__: string | null;
/** 构建期注入：git 提交总数（构建号），仅用于「当前提交」附注；无 git 元数据时为空 */
declare const __BUILD_NUM__: number | null;

/** 最近发布 Tag（构建期已算好），如 v1.0.2 */
const CURRENT_TAG = __GIT_TAG__ || null;
/** 当前构建号（提交总数） */
const CURRENT_BUILD = __BUILD_NUM__ ?? null;
/** 当前构建的提交号 */
const CURRENT_COMMIT = __COMMIT_SHA__ || null;
/** 兜底展示的发布版本号（无 Tag 时用，如 1.0.2；构建元数据已在构建期剥离） */
const CURRENT_VERSION = normalizeVersion(__APP_VERSION__);

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

function Metric({
  icon,
  label,
  value,
  mono,
  hint,
  hintTone,
}: {
  icon: IconName;
  label: string;
  value: string;
  mono?: boolean;
  /** 主值右侧的小字附注（如更新状态、构建号） */
  hint?: string | null;
  /** 附注语义色：success=正常/最新，warning=有新版本，缺省为灰 */
  hintTone?: 'success' | 'warning';
}) {
  return (
    <div className="flex items-start gap-3 bg-surface p-4">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-brand/10 text-brand">
        <Icon name={icon} className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="m-0 text-xs text-muted">{label}</p>
        {/* 附注与主值同行：状态跟在版本号后，构建号跟在提交号后，避免多占一行 */}
        <p className="m-0 mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className={cx('truncate text-[15px] font-semibold', mono && 'font-mono')}>{value}</span>
          {hint && (
            <span
              className={cx(
                'shrink-0 whitespace-nowrap text-xs',
                hintTone === 'success' && 'text-emerald-600',
                hintTone === 'warning' && 'text-amber-600',
                !hintTone && 'text-muted-2',
              )}
            >
              {hint}
            </span>
          )}
        </p>
      </div>
    </div>
  );
}

function ReleaseCard({ entry, previousTag }: { entry: ReleaseEntry; previousTag: string | null }) {
  const t = useAdminT();
  const lang = useAdminLang();
  /* 版本详情默认折叠：卡头常驻（版本号/徽标/外链），点卡头展开元信息与更新说明；
     折叠期间不下发更新日志请求，展开后才按需拉取（缓存跨折叠复用）。 */
  const [open, setOpen] = useState(false);
  const notes = useQuery({
    queryKey: ['admin', 'release-notes', entry.tagName, lang],
    queryFn: ({ signal }) => fetchReleaseChangelog(entry, lang, signal),
    enabled: open,
    staleTime: Infinity,
    retry: false,
  });

  /* 「当前」判定按最近 Tag 匹配（构建期 git describe 得出）：Tag 之后继续提交的构建
     仍能正确归到该发布；提交哈希相等作为补充（万一 Tag 缺失但构建正好是发布提交）。 */
  const isCurrent = entry.tagName === CURRENT_TAG || isSameCommit(entry.targetCommitish, CURRENT_COMMIT);
  const status = entry.draft
    ? { tone: 'warning' as const, text: t('admin_version_draft') }
    : entry.prerelease
      ? { tone: 'warning' as const, text: t('admin_version_prerelease') }
      : { tone: 'success' as const, text: t('admin_version_stable') };

  return (
    <article className={cx(cardCls, 'overflow-hidden')}>
      <div className={cx('flex flex-wrap items-center justify-between gap-3 px-5 py-4', open && 'border-b border-line-soft')}>
        {/* 卡头左侧即折叠开关：版本号/徽标随卡头常驻，点它展开下方元信息与更新说明 */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? t('side_nav_collapse') : t('side_nav_expand')}
          className="group flex min-w-0 cursor-pointer flex-wrap items-center gap-2 border-0 bg-transparent p-0 text-left"
        >
          <Icon
            name={open ? 'chevron_down' : 'chevron_right'}
            className="size-4 shrink-0 text-muted-2 transition-colors group-hover:text-ink"
          />
          <Icon name="tag" className="size-4 text-brand" />
          <span className="font-mono text-[1.1rem] leading-tight font-semibold">{entry.tagName}</span>
          <Badge tone={status.tone}>{status.text}</Badge>
          {isCurrent && <Badge tone="primary">{t('admin_version_current')}</Badge>}
        </button>
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

      {open && (
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
      )}
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
  // 当前构建所属的发布：优先按构建期最近 Tag 匹配（哈希相等仅作 Tag 缺失时的补充），
  // 这样打 Tag 后无需重新部署、且 Tag 之后继续提交的构建也能收敛到正确发布版本。
  const runningRelease = CURRENT_TAG
    ? (releases.find((r) => r.tagName === CURRENT_TAG) ?? null)
    : CURRENT_COMMIT
      ? (releases.find((r) => isSameCommit(r.targetCommitish, CURRENT_COMMIT)) ?? null)
      : null;

  // 更新状态提示：以构建期最近 Tag（无 Tag 时回落包版本）与最新正式发布对比。
  // 不再展示「领先 N 个提交」——构建发生在 Tag 之后属正常情况，不向用户暴露开发期细节。
  const currentRef = CURRENT_TAG ?? CURRENT_VERSION;
  const upToDate = latest ? compareVersion(latest.tagName, currentRef) <= 0 : null;
  const currentHint =
    upToDate === null
      ? null
      : upToDate
        ? t('admin_version_up_to_date')
        : t('admin_version_newer', undefined, { v: latest?.tagName ?? '' });

  return (
    <>
      <PageTitle>{t('admin_menu_about')}</PageTitle>

      {/* 页面标题由后台顶栏承担（同一份菜单文案），此处只留一句说明，避免与顶栏重复 */}
      <div className="-mt-1 mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-sm text-muted">{t('admin_version_subtitle')}</p>
        <a href={`${REPO_URL}/releases`} target="_blank" rel="noreferrer" className={linkBtnCls}>
          <Icon name="external_link" className="size-3.5" />
          {t('admin_version_source')}
        </a>
      </div>

      <section className={cx(cardCls, 'overflow-hidden')}>
        <div className="grid gap-px bg-line-soft sm:grid-cols-2 xl:grid-cols-4">
          {/* 当前版本 = 构建期最近 Tag（优先）或运行发布匹配；无 Tag 时回落包版本（无 +build 元数据） */}
          <Metric
            icon="tag"
            label={t('admin_version_current')}
            value={CURRENT_TAG ?? runningRelease?.tagName ?? `v${CURRENT_VERSION}`}
            mono
            hint={currentHint}
            hintTone={upToDate === false ? 'warning' : 'success'}
          />
          <Metric icon="rocket" label={t('admin_version_latest')} value={latest?.tagName ?? '-'} mono />
          {/* 构建号不再拼进版本号，作为提交号后的行内附注展示 */}
          <Metric
            icon="git_commit"
            label={t('admin_version_current_commit')}
            value={shortCommit(CURRENT_COMMIT)}
            mono
            hint={CURRENT_BUILD ? t('admin_version_build', undefined, { n: CURRENT_BUILD }) : null}
          />
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
