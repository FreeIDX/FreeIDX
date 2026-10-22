/**
 * 排行榜页：5 榜 tab（主题/帖子/经验/金币/人民币）+ 表格 + 分页。
 * 行 = 名次徽章（badge-pill jb-*）+ 头像用户名 + 各列数值；当前用户行加粗高亮；窄屏隐藏数值列（≤1024px）。
 * 数据复用 GET /api/rank/list（实时查询，每页 20）。
 */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { getRankList, type RankListData } from '../../../lib/api';
import { posInt } from '../../../lib/params';
import { useAuth } from '../../../store/auth';
import { useT } from '../../../lib/i18n';
import { Avatar } from '../../../components/Avatar';
import { Breadcrumb, Card, CardTabs, cx } from '../../../components/ui';
import { Pagination } from '../../../components/Pagination';
import { RankNo } from '../../../components/rank';

type RankSort = 'threads' | 'posts' | 'credits' | 'golds' | 'rmbs';
const SORTS: RankSort[] = ['threads', 'posts', 'credits', 'golds', 'rmbs'];

/** 人民币列（分 → 元，保留 2 位） */
function rmb(fen: number): string {
  return (fen / 100).toFixed(2);
}

export function RankListPage() {
  const t = useT();
  const me = useAuth((s) => s.me);
  const [search] = useSearchParams();
  const raw = search.get('sort') ?? 'threads';
  const sort: RankSort = (SORTS as string[]).includes(raw) ? (raw as RankSort) : 'threads';
  const page = posInt(search.get('page'));

  const q = useQuery({
    queryKey: ['rank-list', sort, page],
    queryFn: () => getRankList(sort, page, 20),
    placeholderData: keepPreviousData,
  });

  const href = (p: number) => {
    const sp = new URLSearchParams();
    if (sort !== 'threads') sp.set('sort', sort);
    if (p > 1) sp.set('page', String(p));
    const qs = sp.toString();
    return qs ? `/rank?${qs}` : '/rank';
  };
  const tabHref = (k: RankSort) => (k === 'threads' ? '/rank' : `/rank?sort=${k}`);
  const data: RankListData | undefined = q.data;

  const cols: [string, (r: RankListData['list'][number]) => string][] = [
    [t('rank_by_threads'), (r) => String(r.threads)],
    [t('rank_by_posts'), (r) => String(r.posts)],
    [t('rank_by_credits'), (r) => String(r.credits)],
    [t('rank_by_golds'), (r) => String(r.golds)],
    [t('rank_by_rmbs'), (r) => rmb(r.rmbs)],
  ];

  return (
    <div>
      <Breadcrumb items={[{ text: t('home'), to: '/' }, { text: t('ranking_list') }]} />
      <Card
        header={
          <CardTabs
            items={[
              { k: 'threads', text: t('rank_by_threads'), active: sort === 'threads', to: tabHref('threads') },
              { k: 'posts', text: t('rank_by_posts'), active: sort === 'posts', to: tabHref('posts') },
              { k: 'credits', text: t('rank_by_credits'), active: sort === 'credits', to: tabHref('credits') },
              { k: 'golds', text: t('rank_by_golds'), active: sort === 'golds', to: tabHref('golds') },
              { k: 'rmbs', text: t('rank_by_rmbs'), active: sort === 'rmbs', to: tabHref('rmbs') },
            ]}
          />
        }
        bodyClass="p-0"
      >
        {q.isError && <p className="px-5 py-6 text-center text-sm text-destructive">{(q.error as Error).message}</p>}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-lt-soft text-left text-[13px] font-medium text-lt-grey">
                <th className="w-[72px] px-4 py-2.5">{t('rank_no')}</th>
                <th className="px-4 py-2.5">{t('username')}</th>
                {cols.map(([label], i) => (
                  <th key={label} className={cx('px-4 py-2.5 text-right tabular-nums', i > 1 && 'max-lg:hidden')}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {!data && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-lt-grey">
                    {q.isPending ? t('loading') : t('no_content')}
                  </td>
                </tr>
              )}
              {data?.list.map((r, i) => {
                const isMe = me?.uid === r.uid;
                return (
                  <tr
                    key={r.uid}
                    className={cx(
                      'border-b border-zh-line transition-colors last:border-b-0 hover:bg-zh-row-hover',
                      isMe && 'bg-[rgba(41,151,247,0.08)] font-bold',
                    )}
                  >
                    <td className="px-4 py-2">
                      <RankNo n={(data.page - 1) * data.size + i + 1} />
                    </td>
                    <td className="px-4 py-2">
                      <Link to={`/user/${r.uid}`} className="flex items-center gap-2 text-foreground transition-colors hover:text-brand">
                        <Avatar uid={r.uid} avatar={0} username={r.username} size={1} />
                        <span className="truncate">{r.username}</span>
                      </Link>
                    </td>
                    {cols.map(([label, get], ci) => (
                      <td key={label} className={cx('px-4 py-2 text-right tabular-nums', ci > 1 && 'max-lg:hidden')}>
                        {get(r)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data && (
          <div className="border-t border-zh-line px-4 py-3">
            <Pagination page={data.page} totalPage={data.totalPage} href={href} className="my-0" />
          </div>
        )}
      </Card>
    </div>
  );
}