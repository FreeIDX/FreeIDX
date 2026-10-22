/**
 * 排行榜：
 *  - RankThreadCard：首页右栏「总排行 / 周排行」（主题按浏览量倒序）；
 *  - RankUserCard：首页右栏「新会员 / 活跃榜」（16 人 4 列头像网格）；
 *  - RankForumHotCard：版块页右栏「版块热门」（本版块浏览量 top10）。
 * 样式：名次 = badge-pill（前 3 名 jb-red/jb-yellow/jb-blue 渐变，其余 #909399）+ 行高 31px 虚线分隔（.zh-rank-row）。
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { fetchHotFavorites, getRankForum, getRankThreads, getRankUsers, type RankThreadItem } from '../lib/api';
import { Avatar } from './Avatar';
import { Icon } from './icons';
import { Card, CardTabs, CardTitle, SidePanel, cx } from './ui';
import { useT } from '../lib/i18n';
import { useLight } from '../store/theme';

/** 名次徽章（badge-pill：1 jb-red / 2 jb-yellow / 3 jb-blue / 其余 secondary） */
export function RankNo({ n }: { n: number }) {
  const jb = n === 1 ? 'jb-red' : n === 2 ? 'jb-yellow' : n === 3 ? 'jb-blue' : '';
  return (
    <span
      className={cx(
        'mr-[5px] inline-flex h-[17px] min-w-[17px] shrink-0 items-center justify-center rounded-full px-[7px] text-[11px] leading-[17px] text-white',
        jb || 'bg-[#909399]',
      )}
    >
      {n}
    </span>
  );
}

/** 主题榜列表（.site-top .site-list-ul：31px 行高单行，超长 ellipsis） */
function RankThreadList({ list }: { list: RankThreadItem[] }) {
  const t = useT();
  if (!list.length) return <p className="py-3 text-center text-xs text-lt-grey">{t('no_content')}</p>;
  return (
    <ul className="m-0 list-none p-0">
      {list.map((t2, i) => (
        <li key={t2.tid} className="zh-rank-row flex items-center gap-0.5">
          <RankNo n={i + 1} />
          <Link to={`/thread/${t2.tid}`} title={t2.subject} className="min-w-0 flex-1 truncate text-xs text-foreground transition-colors hover:text-brand">
            {t2.subject}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** 首页右栏卡一：总排行（全站浏览量倒序，缓存 1 天）/ 周排行（最近一周创建，缓存 1h） */
export function RankThreadCard() {
  const [range, setRange] = useState<'all' | 'week'>('all');
  const q = useQuery({ queryKey: ['rank-threads', range], queryFn: () => getRankThreads(range, 10) });
  const t = useT();
  return (
    <Card
      header={
        <CardTabs
          items={[
            { k: 'all', text: t('total_rank'), active: range === 'all', onClick: () => setRange('all') },
            { k: 'week', text: t('week_rank'), active: range === 'week', onClick: () => setRange('week') },
          ]}
        />
      }
      bodyClass="px-5 py-1"
    >
      {q.isError && <p className="py-3 text-center text-xs text-destructive">{(q.error as Error).message}</p>}
      {q.isPending && <p className="py-3 text-center text-xs text-muted-foreground">{t('loading')}</p>}
      {q.data && <RankThreadList list={q.data.list} />}
    </Card>
  );
}

/** 首页右栏「热门收藏」卡（标题「热门收藏（N）」+ 主题行 + ★收藏数） */
export function HotFavoritesCard() {
  const t = useT();
  const light = useLight();
  const q = useQuery({
    queryKey: ['hot-favorites', light.hotFavoriteDays, light.hotFavoriteCount],
    queryFn: () => fetchHotFavorites(light.hotFavoriteDays, light.hotFavoriteCount),
    staleTime: 300_000,
  });
  const list = q.data?.list ?? [];
  return (
    <SidePanel pad="p-4">
      <CardTitle>
        <Icon name="star" className="size-4 text-brand" />
        {t('hot_favorites_count', { count: light.hotFavoriteCount })}
      </CardTitle>
      <ul className="mt-2">
        {list.length === 0 && (
          <li className="py-3 text-center text-xs text-lt-grey">{q.isPending ? t('loading') : t('no_hot_favorites')}</li>
        )}
        {list.map((it) => (
          <li key={it.tid} className="zh-rank-row flex items-center justify-between gap-2">
            <Link
              to={`/thread/${it.tid}`}
              title={`${it.subject}（${it.favorites} ${t('favorites_short')}）`}
              className="min-w-0 flex-1 truncate text-xs text-foreground transition-colors hover:text-brand"
            >
              {it.subject}
            </Link>
            <span className="flex shrink-0 items-center gap-0.5 text-xs text-lt-grey" title={`${it.favorites} ${t('favorites_short')}`}>
              <Icon name="star" className="size-3.5" />
              {it.favorites}
            </span>
          </li>
        ))}
      </ul>
    </SidePanel>
  );
}

/** 用户榜 2 档（#rank_tab 的 span：active 蓝字 + #e5e5e5 边框，悬停即切换） */
const USER_TABS = [
  { k: 'new', key: 'new_members' },
  { k: 'active', key: 'active_rank' },
] as const;
type UserRankType = (typeof USER_TABS)[number]['k'];

/** 首页右栏卡二：新会员（uid 倒序）/ 活跃榜（login_date），各取 16 人 */
export function RankUserCard() {
  const [type, setType] = useState<UserRankType>('new');
  const q = useQuery({ queryKey: ['rank-users', type], queryFn: () => getRankUsers(type, 16) });
  const list = q.data?.list ?? [];
  const t = useT();
  return (
    <Card
      header={
        <div className="flex flex-wrap items-center gap-0.5">
          {USER_TABS.map((tab) => (
            <button
              key={tab.k}
              type="button"
              onMouseEnter={() => setType(tab.k)}
              onFocus={() => setType(tab.k)}
              onClick={() => setType(tab.k)}
              className={cx(
                'cursor-pointer rounded-[4px] border-[0.5px] px-[5px] py-1 text-sm font-medium transition-colors',
                type === tab.k ? 'border-[#e5e5e5] text-brand' : 'border-card text-foreground hover:text-brand',
              )}
            >
              {t(tab.key)}
            </button>
          ))}
        </div>
      }
      bodyClass="p-2"
    >
      {q.isError && <p className="py-2 text-center text-xs text-destructive">{(q.error as Error).message}</p>}
      {q.isPending && <p className="py-2 text-center text-xs text-muted-foreground">{t('loading')}</p>}
      <div className="flex flex-wrap">
        {list.map((u) => (
          /* .col-xs-4：25% 列宽、居中、hover 蓝底圆角加粗 */
          <Link
            key={u.uid}
            to={`/user/${u.uid}`}
            title={u.username}
            className="mb-3 w-1/4 rounded-[7px] text-center transition-colors hover:bg-[rgba(41,151,247,0.1)] hover:font-semibold hover:text-brand"
          >
            <Avatar uid={u.uid} avatar={u.avatar} username={u.username} dim="39px" className="mx-auto" />
            <span className="mt-1 block truncate text-[12px]">{u.username}</span>
          </Link>
        ))}
      </div>
      {!q.isPending && !q.isError && list.length === 0 && <p className="py-2 text-center text-xs text-muted-foreground">{t('no_content')}</p>}
    </Card>
  );
}

/** 版块页右栏：版块热门（本版块主题按浏览量倒序 top10） */
export function RankForumHotCard({ fid }: { fid: number }) {
  const q = useQuery({ queryKey: ['rank-forum', fid], queryFn: () => getRankForum(fid, 10), enabled: fid > 0 });
  const t = useT();
  return (
    <SidePanel pad="p-4">
      <CardTitle>{t('forum_hot')}</CardTitle>
      <div className="mt-2">
        {q.isError && <p className="py-2 text-center text-xs text-destructive">{(q.error as Error).message}</p>}
        {q.isPending && <p className="py-2 text-center text-xs text-muted-foreground">{t('loading')}</p>}
        {q.data && <RankThreadList list={q.data.list} />}
      </div>
    </SidePanel>
  );
}