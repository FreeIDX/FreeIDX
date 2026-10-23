/**
 * 主题列表（三样式）：
 *  - 样式 1（默认）：左头像 + 首行（标题 + 标签 + 新帖标记 + 置顶徽章）+ 次行（版块 · 发布人 · 发布时间 · 最后回复 | 阅读/回复）
 *    + 一行摘要 + 图片组（≤3 张 100px）；
 *  - 样式 2：无左头像，作者/时间在标题上方小字，摘要 + 底行同构；
 *  - 样式 3：左头像，标题后底部单行（版块浅底 chip + 作者 + 最后回复）+ 右侧评论数。
 * 行 = border-bottom 1px #e9ecef + padding .7rem 0 + hover #f6f6f6。
 * 配置来自 light 扩展（thread_list_style / thread_summary / thread_forum_name / thread_last_reply）。
 */
import { useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { CONTENT_LANG_NATIVE_NAMES, type ContentLang, type ForumNode, type ThreadListItem } from '@freeidx/shared';
import { fmtDate } from '../lib/api';
import { Avatar } from './Avatar';
import { Icon } from './icons';
import { VBadge } from './VBadge';
import { Pill, TagBadge, cx } from './ui';
import { Highlight } from './Highlight';
import { useReadUnread } from '../hooks/useReadUnread';
import { useAuth } from '../store/auth';
import { useT } from '../lib/i18n';
import { useLight } from '../store/theme';

export interface ThreadPageData {
  list: ThreadListItem[];
  page: number;
  size: number;
  totalPage: number;
  nextCursor?: number;
  /** 游标列名（tid|lastpid）：翻页须拼 before_<cursorCol>=nextCursor，纯 page 参数不移动窗口 */
  cursorCol?: string;
}

/** 关键词高亮见 components/Highlight.tsx（与搜索页共用唯一实现） */

/** 置顶徽章（top=3 全站 jb-pink / top∈1..2 本版 jb-yellow） */
function TopBadge({ top }: { top: number }) {
  const t = useT();
  if (top <= 0) return null;
  return (
    <Pill jb={top === 3 ? 'jb-pink' : 'jb-yellow'} title={top === 3 ? t('top_level_3') : t('top_label')}>
      {t('top_label')}
    </Pill>
  );
}

/** 精华徽章（idx_digest：1/2/3 级 → jb-blue/jb-purple/jb-red「精」） */
function DigestBadge({ level }: { level: number }) {
  const t = useT();
  if (level <= 0) return null;
  const jb = level >= 3 ? 'jb-red' : level === 2 ? 'jb-purple' : 'jb-blue';
  return (
    <Pill jb={jb} title={t('digest_label')}>
      {t('digest_short')}
    </Pill>
  );
}

/** 判断秒级时间戳是否为今天（本地日历日；用于 newThread 新帖徽章） */
function isToday(sec: number): boolean {
  const d = new Date(sec * 1000);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

/** 主题标题行右侧状态图标（收费/附件/图片/关闭/审核/回收 + 未读 new） */
function SubjectIcons({ th, seeCheck, unread }: { th: ThreadListItem; seeCheck: boolean; unread: boolean }) {
  const t = useT();
  const light = useLight();
  return (
    <>
      <DigestBadge level={th.digest} />
      {th.contentBuy > 0 && <Icon name="cart" className="size-3.5 shrink-0" style={{ color: 'gold' }} title={t('paid_thread')} />}
      {th.images > 0 && (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-zh-grey" title={t('contains_images')}>
          <Icon name="image" className="size-3.5" /> {th.images}
        </span>
      )}
      {th.files > 0 && <Icon name="file" className="size-3.5 shrink-0 text-zh-grey" title={t('contains_attach')} />}
      {th.closed > 0 && <Icon name="lock" className="size-3.5 shrink-0 text-zh-grey" title={t('thread_closed')} />}
      {seeCheck && th.ok === 0 && (
        <Icon name="coffee" className="size-3.5 shrink-0" style={{ color: 'rebeccapurple' }} title={t('audit_thread')} />
      )}
      {seeCheck && th.ok === -2 && (
        <Icon name="recycle" className="size-3.5 shrink-0" style={{ color: 'lawngreen' }} title={t('recycled_thread')} />
      )}
      {unread && <Pill className="bg-destructive">{t('new_badge')}</Pill>}
      {light.newThread && isToday(th.createDate) && <Pill jb="jb-pink">{t('new_thread_badge')}</Pill>}
    </>
  );
}

/** 标签徽章集合（idx_tag：可跳筛选）；样式 1 与标题同行、样式 2/3 独立成行 */
function TagItems({ th }: { th: ThreadListItem }) {
  const light = useLight();
  if (!th.tags) return null;
  const defs = new Map(light.tags.map((x) => [x.name, x.style]));
  const names = th.tags.split(',').filter(Boolean);
  if (!names.length) return null;
  return (
    <>
      {names.map((n) => (
        <TagBadge key={n} name={n} style={defs.get(n) ?? 'primary'} to={`/forum/${th.fid}?tag=${encodeURIComponent(n)}`} />
      ))}
    </>
  );
}

/** 标签徽章行（列表标题下小徽章行，样式 2/3 用） */
function TagRow({ th }: { th: ThreadListItem }) {
  const names = th.tags ? th.tags.split(',').filter(Boolean) : [];
  /* 内容语言徽标（原生名）：与标签并列，空 lang 不占位（存量帖零残留） */
  const langName = th.lang ? CONTENT_LANG_NATIVE_NAMES[th.lang as ContentLang] : '';
  if (!names.length && !langName) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {langName && (
        <span
          className="inline-flex shrink-0 items-center rounded-full border border-zh-line bg-lt-soft px-2 py-[2px] text-[11px] leading-none text-ink-soft"
          title={langName}
        >
          {langName}
        </span>
      )}
      {names.length > 0 && <TagItems th={th} />}
    </div>
  );
}

/**
 * 版块 chip（次行最左）：版块图标（有图标用图标，无则文件夹）+ 版块名；名称缺失回落「版块」。
 * 版块节点由列表顶层一次性建成 Map 后下发（原先每行各自订阅 store 并对 forumlist 线性查找，行数 × 版块数）。
 */
function ForumChip({ th, forum }: { th: ThreadListItem; forum?: ForumNode }) {
  const t = useT();
  const name = forum?.name ?? t('forum_label');
  return (
    <Link to={`/forum/${th.fid}`} title={name} className="flex min-w-0 shrink-0 items-center gap-1 transition-colors hover:text-brand">
      {forum?.iconUrl ? (
        <img src={forum.iconUrl} alt="" className="size-4 shrink-0 rounded-[3px] object-contain" loading="lazy" />
      ) : (
        <Icon name="folder" className="size-3.5 shrink-0" />
      )}
      <span className="max-w-[8rem] truncate">{name}</span>
    </Link>
  );
}

/** 列表图片组（三列栅格、100px 高 cover、rounded、errpic 兜底）
 *  张数由 light.summaryPic 决定：3/6/9，超出换行 */
function ImageRow({ th, pic }: { th: ThreadListItem; pic: number }) {
  const t = useT();
  const list = (th.imageUrls ?? '').split(',').filter(Boolean).slice(0, pic);
  if (!list.length) return null;
  return (
    <div className="mt-2 flex flex-wrap px-1">
      {list.map((src) => (
        <div key={src} className="w-1/3 p-1">
          <Link to={`/thread/${th.tid}`}>
            <img
              src={src}
              alt={t('click_view_detail')}
              loading="lazy"
              className="block h-[100px] w-full rounded-[4px] object-cover"
              onError={(e) => {
                e.currentTarget.src = '/theme-light/errpic.webp';
              }}
            />
          </Link>
        </div>
      ))}
    </div>
  );
}

/** 底行统计（浏览/评论）+ 最后回复 */
function StatLine({ th }: { th: ThreadListItem }) {
  const t = useT();
  const light = useLight();
  return (
    <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-lt-grey">
      <span className="flex shrink-0 items-center gap-3 tabular-nums">
        <span className="inline-flex items-center gap-0.5" title={t('views_label')}>
          <Icon name="eye" className="size-3.5" />
          {th.views}
        </span>
        <span className="inline-flex items-center gap-0.5" title={t('reply_label')}>
          <Icon name="comment" className="size-3.5" />
          {th.posts}
        </span>
      </span>
      {light.threadLastReply && th.lastuid > 0 && (
        <span className="flex min-w-0 items-center gap-1.5">
          <Link to={`/user/${th.lastuid}`} className="shrink-0" aria-label={th.lastusername}>
            <Avatar uid={th.lastuid} avatar={0} username={th.lastusername} size={1} radius="soft" />
          </Link>
          <Link className="max-w-[6rem] truncate transition-colors hover:text-brand" to={`/user/${th.lastuid}`}>
            {th.lastusername}
          </Link>
          <span className="hidden shrink-0 sm:inline">
            {t('reply_at')} {fmtDate(th.lastDate)}
          </span>
        </span>
      )}
    </div>
  );
}

/** 行外壳（点击跳详情；a/button/input/label 内的点击不触发跳转） */
function Row({
  th,
  children,
  className,
  onSelect,
  selectable,
  selected,
}: {
  th: ThreadListItem;
  children: React.ReactNode;
  className?: string;
  selectable?: boolean;
  selected?: ReadonlySet<number>;
  onSelect?: (tid: number, checked: boolean) => void;
}) {
  const navigate = useNavigate();
  const t = useT();
  return (
    <li
      className={cx('cursor-pointer border-b border-zh-line px-5 py-[0.7rem] last:border-b-0 hover:bg-zh-row-hover', className)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a,button,input,label')) return;
        navigate(`/thread/${th.tid}`);
      }}
    >
      <div className="flex items-start gap-3">
        {selectable && (
          <label className="flex shrink-0 items-center self-center" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              className="size-4 cursor-pointer accent-brand"
              aria-label={t('select_thread', { subject: th.subject })}
              checked={selected?.has(th.tid) ?? false}
              onChange={(e) => onSelect?.(th.tid, e.target.checked)}
            />
          </label>
        )}
        {children}
      </div>
    </li>
  );
}

export function ThreadList(props: {
  data: ThreadPageData;
  baseHref: (p: number) => string;
  selectable?: boolean;
  selected?: ReadonlySet<number>;
  onToggle?: (tid: number, checked: boolean) => void;
  /** 站内搜索关键词（idx_search 结果高亮）：命中片段包 <mark>，前端渲染不注入 HTML */
  highlightKw?: string;
  /** 加载中：空列表占位前先显示「加载中」，避免首屏把「无数据」闪给用户 */
  loading?: boolean;
}) {
  const { list } = props.data;
  const { isRead } = useReadUnread();
  const t = useT();
  const light = useLight();
  /* 审核图标仅对 see_check 组可见 */
  const seeCheck = useAuth((s) => s.me?.seeCheck ?? false);
  /* 版块查找表：整份列表共享一个 Map（forumlist 未变时不重建），取代逐行订阅 + 线性查找 */
  const forumlist = useAuth((s) => s.forumlist);
  const forumMap = useMemo(() => new Map(forumlist.map((f) => [f.fid, f])), [forumlist]);
  if (!list.length) {
    return (
      <ul className="m-0">
        <li className="py-12 text-center">
          {props.loading ? (
            <>
              <Icon name="refresh" className="mx-auto size-10 text-[#dcdcdc]" />
              <span className="mt-2 block text-[15px] text-lt-grey">{t('loading')}</span>
            </>
          ) : (
            <>
              <Icon name="bug" className="mx-auto size-10 text-[#dcdcdc]" />
              <span className="mt-2 block text-[15px] text-lt-grey">{t('undeveloped_land')}</span>
            </>
          )}
        </li>
      </ul>
    );
  }
  const style = light.threadListStyle;
  return (
    <ul className="m-0 list-none p-0">
      {list.map((th) => {
        const unread = !isRead(th.tid, th.lastDate);
        const rowProps = { th, selectable: props.selectable, selected: props.selected, onSelect: props.onToggle };
        /* 列表摘要（thread_summary_word）：首帖纯文本按配置字数截断，0 或空则不出该行；
           搜索结果（idx_search range=all）优先展示命中正文摘要 th.snippet */
        const brief = th.snippet
          ? th.snippet
          : th.summary && light.summaryWord > 0
            ? th.summary.length > light.summaryWord
              ? `${th.summary.slice(0, light.summaryWord)}...`
              : th.summary
            : '';
        if (style === 2) {
          /* 样式 2：无左头像，作者+时间在标题上方 */
          return (
            <Row key={th.tid} {...rowProps}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-xs text-lt-grey">
                  <Link className="transition-colors hover:text-brand" to={`/user/${th.uid}`}>
                    {th.username}
                  </Link>
                  <span className="truncate">{fmtDate(th.createDate)}</span>
                  {light.threadForumName && (
                    <Link className="shrink-0 transition-colors hover:text-brand" to={`/forum/${th.fid}`}>
                      {t('forum_label')}
                    </Link>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <TopBadge top={th.top} />
                  </span>
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                  <Link
                    className="min-w-0 truncate text-sm font-bold text-foreground transition-colors hover:text-brand"
                    style={{ fontSize: `${light.threadSubjectSize}px` }}
                    to={`/thread/${th.tid}`}
                  >
                    <Highlight text={th.subject} kw={props.highlightKw} />
                  </Link>
                  <SubjectIcons th={th} seeCheck={seeCheck} unread={unread} />
                </div>
                {brief && (
                  <p className="mt-1 break-all text-xs text-lt-grey">
                    <Link to={`/thread/${th.tid}`} className="transition-colors hover:text-brand">
                      <Highlight text={brief} kw={props.highlightKw} />
                    </Link>
                  </p>
                )}
                <TagRow th={th} />
                <StatLine th={th} />
              </div>
            </Row>
          );
        }
        if (style === 3) {
          /* 样式 3：左头像 + 标题 + 底部单行（版块浅底 chip + 作者 + 最后回复）+ 右侧评论数 */
          return (
            <Row key={th.tid} {...rowProps}>
              <Link to={`/user/${th.uid}`} aria-label={th.username} className="shrink-0">
                <span className="relative inline-block">
                  <Avatar uid={th.uid} avatar={th.avatar} username={th.username} size={3} radius="soft" />
                  <VBadge v={th.uv} size={3} />
                </span>
              </Link>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <Link
                    className="min-w-0 truncate text-sm font-bold text-foreground transition-colors hover:text-brand"
                    style={{ fontSize: `${light.threadSubjectSize}px` }}
                    to={`/thread/${th.tid}`}
                  >
                    <Highlight text={th.subject} kw={props.highlightKw} />
                  </Link>
                  <SubjectIcons th={th} seeCheck={seeCheck} unread={unread} />
                  <span className="ml-auto shrink-0">
                    <TopBadge top={th.top} />
                  </span>
                </div>
                <TagRow th={th} />
                <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-lt-grey">
                  <Link to={`/forum/${th.fid}`} className="shrink-0 truncate rounded-[3px] bg-lt-soft px-1.5 py-0.5 transition-colors hover:text-brand">
                    {t('forum_label')}
                  </Link>
                  <Link className="shrink-0 transition-colors hover:text-brand" to={`/user/${th.uid}`}>
                    {th.username}
                  </Link>
                  {light.threadLastReply && th.lastuid > 0 && (
                    <span className="min-w-0 truncate">
                      {t('reply_at')} {th.lastusername} · {fmtDate(th.lastDate)}
                    </span>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-1 tabular-nums">
                    <Icon name="comment" className="size-3.5" />
                    {th.posts}
                  </span>
                </div>
              </div>
            </Row>
          );
        }
        /* 样式 1（默认）：左头像 + 首行（标题/标签/新帖标记）+ 次行（版块/发布人/时间/回帖/阅读/回复）
           + 摘要 + 图片组 */
        return (
          <Row key={th.tid} {...rowProps}>
            <Link to={`/user/${th.uid}`} aria-label={th.username} className="shrink-0">
              <span className="relative inline-block">
                <Avatar uid={th.uid} avatar={th.avatar} username={th.username} size={3} radius="soft" />
                <VBadge v={th.uv} size={3} />
              </span>
            </Link>
            <div className="min-w-0 flex-1">
              {/* 首行：标题 + 状态图标 + 标签 + 新帖标记 + 置顶 */}
              <div className="flex min-w-0 items-center gap-1.5">
                <Link
                  className="min-w-0 truncate text-sm font-bold text-foreground transition-colors hover:text-brand"
                  style={{ fontSize: `${light.threadSubjectSize}px` }}
                  to={`/thread/${th.tid}`}
                >
                  <Highlight text={th.subject} kw={props.highlightKw} />
                </Link>
                <SubjectIcons th={th} seeCheck={seeCheck} unread={unread} />
                <TagItems th={th} />
                <span className="ml-auto shrink-0">
                  <TopBadge top={th.top} />
                </span>
              </div>
              {/* 次行：版块 · 发布人 · 发布时间 · 最后回复 | 阅读/回复 */}
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-lt-grey">
                {light.threadForumName && <ForumChip th={th} forum={forumMap.get(th.fid)} />}
                <Link className="shrink-0 transition-colors hover:text-brand" to={`/user/${th.uid}`}>
                  {th.username}
                </Link>
                <span className="shrink-0">{fmtDate(th.createDate)}</span>
                {light.threadLastReply && th.lastuid > 0 && (
                  <span className="flex min-w-0 items-center gap-1">
                    <Icon name="reply" className="size-3.5 shrink-0" />
                    <Link className="max-w-[6rem] truncate transition-colors hover:text-brand" to={`/user/${th.lastuid}`}>
                      {th.lastusername}
                    </Link>
                    <span className="shrink-0">
                      {t('reply_at')} {fmtDate(th.lastDate)}
                    </span>
                  </span>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-3 tabular-nums">
                  <span className="inline-flex items-center gap-0.5" title={t('views_label')}>
                    <Icon name="eye" className="size-4" />
                    {th.views}
                  </span>
                  <span className="inline-flex items-center gap-0.5" title={t('reply_label')}>
                    <Icon name="comment" className="size-4" />
                    {th.posts}
                  </span>
                </span>
              </div>
              {brief && (
                <p className="mt-1 break-all text-xs text-lt-grey">
                  <Link to={`/thread/${th.tid}`} className="transition-colors hover:text-brand">
                    <Highlight text={brief} kw={props.highlightKw} />
                  </Link>
                </p>
              )}
              {light.threadSummary && <ImageRow th={th} pic={light.summaryPic} />}
            </div>
          </Row>
        );
      })}
    </ul>
  );
}