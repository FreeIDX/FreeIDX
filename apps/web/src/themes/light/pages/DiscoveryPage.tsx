/**
 * 发现页：
 *  轮播图（light.slides，4s 自动）→ 三列聚合卡（新鲜发布 itemBg3 / 最新讨论 itemBg1 / 互动评论 itemBg4，31px 虚线行）
 *  → 全部版块聚合（.discovery_forum 卡片网格，hover 主色边 + 进入按钮填充）→ 右栏（站点统计 / 热门版块 / 活跃·贡献·财富三榜）。
 * 三列口径：最新主题（create_date desc）/ 最新回复（last_date desc）
 *  / 最新评论（顶层回帖 create_date desc，头像+昵称+25 字摘要）；
 * 开关与轮播图来自 light 扩展（后台插件中心可配，停用则本页入口与内容零残留）。
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { ThreadListItem } from '@freeidx/shared';
import { apiGet, fetchLatestComments, fmtDate, getRankUsers, type LatestComment, type RankUserItem } from '../../../lib/api';
import { useAuth } from '../../../store/auth';
import { useT } from '../../../lib/i18n';
import { useLight } from '../../../store/theme';
import { Carousel } from '../../../components/Carousel';
import { Avatar } from '../../../components/Avatar';
import { Icon, type IconName } from '../../../components/icons';
import { CardTitle, SidePanel } from '../../../components/ui';
import { RankNo } from '../../../components/rank';
import { siteThreadsQuery } from '../../../lib/queries';
import { useContentLangFilter } from '../../../store/contentLang';
import { NotFoundPage } from './NotFoundPage';

/** 聚合卡（卡头背景图 + .discovery-rank-list 滚动区；行渲染交由调用方） */
function AggCard({ title, bg, children }: { title: string; bg: string; children: React.ReactNode }) {
  return (
    <section className="zh-card mb-4 overflow-hidden">
      <div className="flex h-[52px] items-center bg-cover bg-center px-4 text-[15px] font-medium text-white" style={{ backgroundImage: `url(${bg})` }}>
        {title}
      </div>
      <ul className="max-h-[256px] overflow-y-auto px-4 py-1.5">{children}</ul>
    </section>
  );
}

/** 尺寸=avatar-1 的空行占位（无数据） */
function AggEmpty({ text }: { text: string }) {
  return <li className="py-6 text-center text-xs text-lt-grey">{text}</li>;
}

/** 主题行：头像 + 标题链接 + 右侧灰色时间 */
function AggThreadRow({ th }: { th: ThreadListItem }) {
  return (
    <li className="zh-rank-row flex items-center justify-between gap-2">
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <Link to={`/user/${th.uid}`} className="shrink-0" tabIndex={-1} aria-label={th.username}>
          <Avatar uid={th.uid} avatar={th.avatar} username={th.username} size={1} />
        </Link>
        <Link to={`/thread/${th.tid}`} title={th.subject} className="min-w-0 truncate text-xs text-foreground transition-colors hover:text-brand">
          {th.subject}
        </Link>
      </span>
      <span className="shrink-0 text-xs text-lt-grey">{fmtDate(th.createDate)}</span>
    </li>
  );
}

/** 评论行：头像 + 粗体昵称 + 去标签摘要 + 右侧灰色时间 */
function AggCommentRow({ it }: { it: LatestComment }) {
  return (
    <li className="zh-rank-row flex items-center justify-between gap-2">
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <Link to={`/user/${it.uid}`} className="flex shrink-0 items-center gap-1" tabIndex={-1} aria-label={it.username}>
          <Avatar uid={it.uid} avatar={it.avatar} username={it.username} size={1} />
          <span className="text-xs font-bold text-foreground">{it.username}</span>
        </Link>
        <Link to={`/thread/${it.tid}`} title={it.text} className="min-w-0 truncate text-xs text-foreground transition-colors hover:text-brand">
          {it.text}
        </Link>
      </span>
      <span className="shrink-0 text-xs text-lt-grey">{fmtDate(it.createDate)}</span>
    </li>
  );
}

/** 右栏榜单卡（活跃榜/贡献榜/财富榜，头像 + 名次） */
function UserRankCard({ type, title, icon }: { type: 'active' | 'posts' | 'wealth'; title: string; icon: IconName }) {
  const t = useT();
  const q = useQuery({ queryKey: ['rank-users', type, 10], queryFn: () => getRankUsers(type, 10) });
  const list: RankUserItem[] = q.data?.list ?? [];
  return (
    <SidePanel pad="p-4">
      <CardTitle>
        <Icon name={icon} className="size-4 text-brand" />
        {title}
      </CardTitle>
      <ul className="mt-2">
        {list.length === 0 && <li className="py-3 text-center text-xs text-lt-grey">{q.isPending ? t('loading') : t('no_content')}</li>}
        {list.map((u, i) => (
          <li key={u.uid} className="zh-rank-row flex items-center gap-2">
            <RankNo n={i + 1} />
            <Link to={`/user/${u.uid}`} className="flex min-w-0 flex-1 items-center gap-1.5">
              <Avatar uid={u.uid} avatar={u.avatar} username={u.username} size={1} />
              <span className="min-w-0 truncate text-xs text-foreground">{u.username}</span>
            </Link>
          </li>
        ))}
      </ul>
    </SidePanel>
  );
}

export function DiscoveryPage() {
  const t = useT();
  const light = useLight();
  const forumlist = useAuth((s) => s.forumlist);
  const runtime = useAuth((s) => s.runtime);

  const discOn = light.enabled && light.discPage;
  /* 发现页与首页共用同一筛选偏好：切换语言后两边口径一致，不出现「首页英文、发现页全部」 */
  const contentLang = useContentLangFilter();
  /* 新鲜发布/最新讨论：与首页共用同一 queryKey 与 URL（siteThreadsQuery），切页命中缓存不重复请求；
     四个查询一并挂 enabled —— 此前 hooks 先于 404 早退执行，发现页关闭的站点每次误入仍白打 4 个接口。 */
  const latest = useQuery({ ...siteThreadsQuery(1, 0, 'tid', contentLang), staleTime: 60_000, enabled: discOn });
  const replied = useQuery({ ...siteThreadsQuery(1, 0, 'lastpid', contentLang), staleTime: 60_000, enabled: discOn });
  const comments = useQuery({
    queryKey: ['discovery', 'comments'],
    queryFn: fetchLatestComments,
    staleTime: 60_000,
    enabled: discOn,
  });
  const online = useQuery({
    queryKey: ['online'],
    queryFn: () => apiGet<{ total: number }>('/api/online?summary=1'),
    staleTime: 60_000,
    enabled: discOn,
  });

  /* 发现页关闭（light.disc_page=0）→ 直接 404，避免空壳页 */
  if (!discOn) return <NotFoundPage />;

  const latestList = (latest.data?.list ?? []).slice(0, 10);
  const repliedList = (replied.data?.list ?? []).slice(0, 10);
  const commentList = comments.data?.list ?? [];
  const totalThreads = forumlist.reduce((s, f) => s + f.threads, 0);
  const hotForums = [...forumlist].sort((a, b) => b.threads - a.threads).slice(0, 6);
  const stats: [IconName, string, number][] = [
    ['message', t('threads'), totalThreads],
    ['comment', t('posts_count'), runtime?.posts ?? 0],
    ['users', t('users'), runtime?.users ?? 0],
    ['chart_bar', t('online_count'), online.data?.total ?? 0],
  ];

  return (
    <div>
      <Carousel slides={light.slides} />

      {/* 三列聚合卡（新鲜发布 / 最新讨论 / 互动评论；行=头像+标题/评论+时间） */}
      <div className="mb-1 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        <AggCard title={t('fresh_publish')} bg="/theme-light/itemBg3.webp">
          {latestList.length === 0 ? <AggEmpty text={t('no_content')} /> : latestList.map((th) => <AggThreadRow key={th.tid} th={th} />)}
        </AggCard>
        <AggCard title={t('latest_discussion')} bg="/theme-light/itemBg1.webp">
          {repliedList.length === 0 ? <AggEmpty text={t('no_content')} /> : repliedList.map((th) => <AggThreadRow key={th.tid} th={th} />)}
        </AggCard>
        <AggCard title={t('hot_comments')} bg="/theme-light/itemBg4.jpg">
          {commentList.length === 0 ? <AggEmpty text={t('no_content')} /> : commentList.map((it) => <AggCommentRow key={it.pid} it={it} />)}
        </AggCard>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* 全部版块聚合（.discovery_forum 卡片网格） */}
        <div className="min-w-0 flex-1">
          <section className="zh-card mb-4">
            <div className="zh-card-header flex items-center px-4 py-3 text-sm font-medium">
              <Icon name="grid" className="mr-2 size-4 text-brand" />
              {t('all_forums')}
            </div>
            <div className="grid grid-cols-1 gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
              {forumlist.map((f) => {
                const mods = (f as unknown as { moduids?: string }).moduids;
                return (
                  <section key={f.fid} className="discovery-forum rounded-[5px] bg-card p-3">
                    <div className="flex items-start gap-3">
                      {f.iconUrl ? (
                        <img src={f.iconUrl} alt="" className="size-14 shrink-0 rounded-full object-contain" />
                      ) : (
                        <span className="grid size-14 shrink-0 place-items-center rounded-full bg-lt-soft">
                          <Icon name="folder" className="size-6 text-zh-grey" />
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <Link to={`/forum/${f.fid}`} className="min-w-0 truncate text-sm font-medium text-foreground hover:text-brand" title={f.name}>
                            {f.name}
                          </Link>
                          <span className="shrink-0 rounded-full bg-[#303133] px-2 py-0.5 text-[11px] leading-none text-white tabular-nums">
                            {f.threads}
                          </span>
                          <span className="shrink-0 rounded-full bg-destructive/10 px-2 py-0.5 text-[11px] leading-none text-destructive tabular-nums">
                            {f.todayposts}
                          </span>
                        </div>
                        <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-lt-grey">{f.brief}</p>
                        {mods && (
                          <p className="mt-1 flex items-center gap-1 text-xs text-lt-grey">
                            <Icon name="user" className="size-3" />
                            {t('forum_moderators')}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between border-t border-zh-line pt-2 text-xs text-lt-grey">
                      <span className="tabular-nums">
                        {t('today_posts_short')} {f.todayposts}
                      </span>
                      <Link to={`/forum/${f.fid}`} className="into-forum-link rounded-[3px] text-brand">
                        {t('enter_forum')}
                      </Link>
                    </div>
                  </section>
                );
              })}
            </div>
          </section>
        </div>

        {/* 右栏：站点统计 + 热门版块 + 三榜（discovery_forum_right） */}
        <aside className="hidden w-[285px] shrink-0 self-start lg:block">
          <SidePanel pad="p-4">
            <CardTitle>
              <Icon name="chart_bar" className="size-4 text-brand" />
              {t('site_statistics')}
            </CardTitle>
            <ul className="mt-2">
              {stats.map(([icon, label, value]) => (
                <li key={label} className="zh-rank-row flex items-center gap-2 text-xs text-lt-grey">
                  <Icon name={icon} className="size-4 text-brand" />
                  {label}
                  <b className="ml-auto tabular-nums text-foreground">{value}</b>
                </li>
              ))}
            </ul>
          </SidePanel>
          <SidePanel pad="p-4">
            <CardTitle>
              <Icon name="flame" className="size-4 text-brand" />
              {t('hot_forums')}
            </CardTitle>
            <ul className="mt-2">
              {hotForums.map((f) => (
                <li key={f.fid} className="zh-rank-row flex items-center gap-2">
                  <Link to={`/forum/${f.fid}`} className="flex min-w-0 flex-1 items-center gap-2">
                    {f.iconUrl ? (
                      <img src={f.iconUrl} alt="" className="size-6 shrink-0 rounded-full object-contain" />
                    ) : (
                      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-lt-soft">
                        <Icon name="folder" className="size-3.5 text-zh-grey" />
                      </span>
                    )}
                    <span className="min-w-0 truncate text-xs text-foreground">{f.name}</span>
                  </Link>
                  <span className="shrink-0 text-[11px] tabular-nums text-lt-grey">{f.threads}</span>
                </li>
              ))}
            </ul>
          </SidePanel>
          <UserRankCard type="active" title={t('active_rank')} icon="trending_up" />
          <UserRankCard type="posts" title={t('contribution_rank')} icon="trophy" />
          <UserRankCard type="wealth" title={t('wealth_rank')} icon="gem" />
        </aside>
      </div>
    </div>
  );
}