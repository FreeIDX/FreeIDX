import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import type { SearchUserHit, ThreadListItem } from '@freeidx/shared';
import { apiGet } from '../../../lib/api';
import { posInt } from '../../../lib/params';
import { Avatar } from '../../../components/Avatar';
import { Pagination } from '../../../components/Pagination';
import { ThreadList } from '../../../components/ThreadList';
import { ContentLangBar } from '../../../components/ContentLangBar';
import { Card, CardTitle, cx } from '../../../components/ui';
import { Highlight } from '../../../components/Highlight';
import { Icon } from '../../../components/icons';
import { useT } from '../../../lib/i18n';
import { useContentLangFilter } from '../../../store/contentLang';

type Range = 'thread' | 'all' | 'user';

interface SearchData {
  keyword: string;
  range: Range;
  list: ThreadListItem[];
  users: SearchUserHit[];
  page: number;
  size: number;
  total: number;
  totalPage: number;
}

/** 关键词高亮（idx_search「用户」结果昵称）见 components/Highlight.tsx（与主题列表共用唯一实现） */

/**
 * 站内搜索结果页（idx_search）。搜索框：白 25% 透明圆角 40px 容器 + 浅底输入 + 主色大按钮；
 * range 三档：主题（标题）/ 全部（标题+正文）/ 用户（昵称）；命中关键词高亮；主题结果复用 ThreadList（三样式）。
 */
export function SearchPage() {
  const t = useT();
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const kw = search.get('q') ?? '';
  const rangeRaw = search.get('range');
  const range: Range = rangeRaw === 'all' || rangeRaw === 'user' ? rangeRaw : 'thread';
  const page = posInt(search.get('page'));
  const [input, setInput] = useState(kw);
  // 仅 query 变化时 /search 不会重挂载（App.tsx 无 key）：input 必须跟随 URL 关键词同步，
  // 否则顶栏搜索或站内链接跳到新关键词后，输入框仍显示旧词。
  useEffect(() => setInput(kw), [kw]);
  /** 多关键词（空白分隔）取首个用于列表高亮（后端 AND 匹配，摘要已随行下发） */
  const kwFirst = kw.split(/\s+/).filter(Boolean)[0] ?? kw;

  /* 与列表同一内容语言偏好：搜索结果不跨语言串内容（空串 = 全部，站点关闭时后端会忽略） */
  const contentLang = useContentLangFilter();
  const q = useQuery({
    queryKey: ['search', kw, range, page, contentLang],
    queryFn: () =>
      apiGet<SearchData>(
        `/api/search?q=${encodeURIComponent(kw)}&range=${range}&page=${page}${contentLang ? `&lang=${encodeURIComponent(contentLang)}` : ''}`,
      ),
    placeholderData: keepPreviousData,
    enabled: Boolean(kw),
  });

  const href = (p: number, r: Range = range) => `/search?q=${encodeURIComponent(kw)}&range=${r}${p > 1 ? `&page=${p}` : ''}`;
  const total = q.data?.total ?? 0;
  const ranges: { k: Range; label: string }[] = [
    { k: 'thread', label: t('search_range_thread') },
    { k: 'all', label: t('search_range_all') },
    { k: 'user', label: t('search_range_user') },
  ];

  return (
    <>
      {/* 搜索框：白 25% 透明圆角 40px p-2.5 容器，浅底输入 + 主色大按钮 */}
      <form
        className="mx-auto my-4 flex w-full max-w-[780px] rounded-[40px] bg-card/25 p-2.5"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          const v = input.trim();
          navigate(v ? `/search?q=${encodeURIComponent(v)}&range=${range}` : '/search');
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t('search_placeholder')}
          aria-label={t('search')}
          autoComplete="off"
          className="h-10 min-w-0 flex-1 rounded-l-[40px] border-0 bg-lt-soft px-5 text-sm text-foreground outline-none placeholder:text-zh-grey"
        />
        <button
          type="submit"
          aria-label={t('search')}
          className="h-10 w-[120px] shrink-0 rounded-r-[40px] bg-brand text-sm text-white transition-colors hover:bg-brand-hover"
        >
          <Icon name="search" className="mr-1 inline size-4" /> {t('search')}
        </button>
      </form>

      {/* range 三档：主题/全部/用户 */}
      {kw && (
        <div className="mx-auto mb-3 flex w-full max-w-[780px] justify-center gap-2">
          {ranges.map((r) => (
            <Link
              key={r.k}
              to={href(1, r.k)}
              className={cx(
                'rounded-[20px] border px-4 py-1 text-sm transition-colors',
                r.k === range ? 'border-brand bg-brand text-white' : 'border-zh-line bg-card text-foreground hover:text-brand',
              )}
            >
              {r.label}
            </Link>
          ))}
        </div>
      )}

      {/* 内容语言筛选条（后台开启后显示；与首页/版块页共用同一偏好） */}
      {kw && (
        <div className="mx-auto w-full max-w-[780px]">
          <ContentLangBar />
        </div>
      )}

      <Card
        header={
          <CardTitle>
            {kw ? t('search_results_for', { keyword: kw }) : t('search')}
            <span className="text-xs font-normal text-lt-grey">
              {kw ? t('search_result_count', { count: total }) : t('enter_keyword')}
            </span>
          </CardTitle>
        }
        bodyClass="p-0"
      >
        {q.isError && <p className="px-5 py-6 text-center text-sm text-destructive">{(q.error as Error).message}</p>}
        {q.data && total > 0 && range === 'user' && (
          <ul className="m-0 list-none p-0">
            {q.data.users.map((u) => (
              <li key={u.uid} className="flex items-center gap-3 border-b border-zh-line px-5 py-[0.7rem] last:border-b-0 hover:bg-zh-row-hover">
                {u.avatar_auto ? (
                  <img src={u.avatar_auto} alt={u.username} className="size-10 shrink-0 rounded-full object-cover" />
                ) : (
                  <Avatar uid={u.uid} avatar={u.avatar} username={u.username} size={4} className="shrink-0" />
                )}
                <Link to={`/user/${u.uid}`} className="min-w-0 truncate text-sm font-bold text-foreground transition-colors hover:text-brand">
                  <Highlight text={u.username} kw={kw} />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {q.data && total > 0 && range !== 'user' && <ThreadList data={q.data} baseHref={href} highlightKw={kwFirst} />}
        {q.data && total === 0 && (
          <div className="py-10 text-center text-lt-grey">
            <Icon name="bug" className="mx-auto size-10" />
            <p className="mt-2">{t('no_data')}</p>
          </div>
        )}
      </Card>
      {q.data && <Pagination page={q.data.page} totalPage={q.data.totalPage} href={href} />}
    </>
  );
}
