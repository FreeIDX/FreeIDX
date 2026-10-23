import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router';
import { useAuth } from '../../../store/auth';
import { apiGet } from '../../../lib/api';
import { posInt } from '../../../lib/params';
import { siteThreadsQuery } from '../../../lib/queries';
import { InsertCode, useInsertCodes } from '../../../components/InsertCode';
import { Pagination } from '../../../components/Pagination';
import { ThreadList } from '../../../components/ThreadList';
import { AnnouncementBar } from '../../../components/AnnouncementBar';
import { ContentLangBar } from '../../../components/ContentLangBar';
import { useContentLangFilter } from '../../../store/contentLang';
import { CheckinCard } from '../../../components/CheckinCard';
import {
  Alert,
  Card,
  CardStats,
  CardTabs,
  GuestCard,
  HomeSideNav,
  QuickHelpCard,
  SidePanel,
  UserSideCard,
} from '../../../components/ui';
import { HotFavoritesCard, RankThreadCard, RankUserCard } from '../../../components/rank';
import { useT, useGroupName } from '../../../lib/i18n';
import { useLight } from '../../../store/theme';

/** 首页：左侧版块导航（主页入口 + 版块直链）+
 *  最新主题卡（卡头 tabs + 分页）+ 右栏（用户/游客卡 → 签到 → 帖子排行 → 站点数据 → 排行榜 → 注入位） */
export function HomePage() {
  const t = useT();
  const gn = useGroupName();
  const light = useLight();
  const params = useParams();
  const page = posInt(params.n);
  /* digest/orderby 走 URL 参数（筛选入口 = 左侧导航，切筛选回第 1 页） */
  const [search] = useSearchParams();
  const digest: 0 | 1 = search.get('digest') === '1' ? 1 : 0;
  const orderby = search.get('orderby') === 'lastpid' ? 'lastpid' : 'tid';
  const forumlist = useAuth((s) => s.forumlist);
  const grouplist = useAuth((s) => s.grouplist);
  const me = useAuth((s) => s.me);
  const runtime = useAuth((s) => s.runtime);
  /* 插入代码扩展注入位原始 HTML（全站共享缓存） */
  const insertCodes = useInsertCodes();

  /** 筛选切换链接：始终回第 1 页（路径 /），保留其余参数 */
  const nav = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) sp.delete(k);
      else sp.set(k, v);
    }
    const qs = sp.toString();
    return qs ? `/?${qs}` : '/';
  };

  /* queryKey/URL 与发现页共用同一描述符（同 URL 同 key → 跨页共享缓存，切页不重复请求） */
  const contentLang = useContentLangFilter();
  const q = useQuery({ ...siteThreadsQuery(page, digest, orderby, contentLang), placeholderData: keepPreviousData });

  /** 在线数（GET /api/online?summary=1 只回 total；不带参数会连同 500 行会话列表一起下发） */
  const online = useQuery({
    queryKey: ['online'],
    queryFn: () => apiGet<{ total: number }>('/api/online?summary=1'),
    staleTime: 60_000,
  });

  const totalThreads = forumlist.reduce((s, f) => s + f.threads, 0);

  const group = me ? grouplist.find((g) => g.gid === me.gid) : undefined;
  const credits = me?.credits ?? 0;
  const progress = group && group.creditsto > 0 ? Math.round((credits / group.creditsto) * 100) : 100;

  /** 站点统计（.wzxx 四项：zt 主题数 / tz 贴子数 / user 用户数 / zx 在线数） */
  const stats: [number, string, 'zt' | 'tz' | 'user' | 'zx'][] = [
    [totalThreads, t('threads'), 'zt'],
    [runtime?.posts ?? 0, t('posts_count'), 'tz'],
    [runtime?.users ?? 0, t('users'), 'user'],
    [online.data?.total ?? 0, t('online_count'), 'zx'],
  ];

  return (
    <div className="flex items-start gap-4">
      {/* 左侧版块导航列（2/12 栅格，190px，可折叠） */}
      <HomeSideNav />
      <div className="min-w-0 flex-1">
        {/* 首页系统公告条（0011）：中间栏最顶部，多条轮播 */}
        <AnnouncementBar />
        {/* 账号审核提示（alert 三态，仅登录且 OK!=1 时） */}
        {me && me.ok !== 1 && (
          <Alert tone={me.ok === 0 ? 'primary' : 'warning'} icon={me.ok === 0 ? 'coffee' : 'warning_circle'} className="mb-2">
            {me.ok === 0 ? t('account_under_review') : t('account_not_approved')}
          </Alert>
        )}
        {/* 插入代码 index_main_start_htm：主列最新主题卡之前 */}
        <InsertCode html={insertCodes.index_main_start_htm} />
        {/* 主题列表卡（.card.card-threadlist：卡头 tabs + 列表 + 卡脚分页） */}
        <Card
          header={
            <CardTabs
              items={[
                { k: 'new', text: t('new_thread'), icon: 'clock', active: digest === 0 && orderby === 'tid', to: nav({ digest: null, orderby: null }) },
                { k: 'digest', text: t('digest_label'), icon: 'star', active: digest === 1, to: nav({ digest: '1', orderby: null }) },
                { k: 'recent', text: t('recent_thread'), icon: 'chat_bubbles', active: orderby === 'lastpid', to: nav({ digest: null, orderby: 'lastpid' }) },
              ]}
            />
          }
          bodyClass="p-0"
        >
          {/* 内容语言筛选条（后台开启后显示；关闭时组件返回 null，连分隔线都不出现） */}
          <ContentLangBar wrap="bar" />
          {q.isError && <p className="px-5 py-6 text-center text-sm text-destructive">{(q.error as Error).message}</p>}
          {q.data && <ThreadList data={q.data} baseHref={(p) => (p === 1 ? '/' : `/page/${p}`)} />}
          {q.data && (
            <div className="border-t border-zh-line px-4 py-3">
              <Pagination page={q.data.page} totalPage={q.data.totalPage} href={(p) => (p === 1 ? '/' : `/page/${p}`)} className="my-0" />
            </div>
          )}
        </Card>
      </div>
      {/* 右栏（3/12 栅格：用户卡/签到/热门收藏/排行/站点数据/用户榜） */}
      <aside className="hidden w-[285px] shrink-0 self-start lg:sticky lg:top-4 lg:z-10 lg:block">
        {light.indexUserinfo &&
          (me ? (
            <>
              <UserSideCard
                me={{
                  uid: me.uid,
                  username: me.username,
                  avatar: me.avatar,
                  gid: me.gid,
                  threads: me.threads ?? 0,
                  posts: me.posts ?? 0,
                  credits,
                  following: me.following ?? 0,
                  followers: me.followers ?? 0,
                }}
                groupName={group ? gn(group.gid, group.name) : ''}
                progress={progress}
              />
              <QuickHelpCard uid={me.uid} />
            </>
          ) : (
            <GuestCard />
          ))}
        {/* 每日签到卡片（checkin 插件启用时渲染，停用零残留） */}
        <CheckinCard />
        {/* 热门收藏卡（light.hotFavoriteCard 开关，出厂关） */}
        {light.hotFavoriteCard && <HotFavoritesCard />}
        {/* 帖子排行卡（总排行/周排行，light.threadRankCard 开关） */}
        {light.threadRankCard && <RankThreadCard />}
        {/* 站点数据（site_info_total） */}
        {light.siteInfoTotal && (
          <SidePanel pad="p-4">
            <p className="mb-2 text-sm font-medium text-card-header-ink">{t('site_stats')}</p>
            <CardStats items={stats} />
          </SidePanel>
        )}
        {/* 用户榜（新会员/活跃） */}
        <RankUserCard />
        {/* 插入代码 index_site_brief_after_htm：侧栏排行榜卡之后 */}
        <InsertCode html={insertCodes.index_site_brief_after_htm} />
      </aside>
    </div>
  );
}