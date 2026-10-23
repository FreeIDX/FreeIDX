import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { CONTENT_LANG_NATIVE_NAMES, Code, GroupId, type ContentLang } from '@freeidx/shared';
import { useAuth } from '../../../store/auth';
import { useLight } from '../../../store/theme';
import { ApiError, apiGet, modThreads } from '../../../lib/api';
import { posInt } from '../../../lib/params';
import { useT } from '../../../lib/i18n';
import { NotFoundPage } from './NotFoundPage';
import { Pagination } from '../../../components/Pagination';
import { ThreadList, type ThreadPageData } from '../../../components/ThreadList';
import { ContentLangBar } from '../../../components/ContentLangBar';
import { useContentLangFilter, useContentLangMode } from '../../../store/contentLang';
import { Alert, Card, CardTabs, CardTitle, CreateButton, HomeSideNav, Modal, SidePanel, TagBadge, TwoCol, cx } from '../../../components/ui';
import { RankForumHotCard } from '../../../components/rank';
import { Avatar } from '../../../components/Avatar';
import { Icon } from '../../../components/icons';

interface ForumPageData extends ThreadPageData {
  forum?: {
    fid: number;
    name: string;
    brief: string;
    moduids: string;
    icon?: number;
    /** 自定义图标直链（后台上传，/files/forum/{fid}.xxx）；空 = 内置默认图 */
    iconUrl?: string;
    announcement?: string;
    threads?: number;
    todayposts?: number;
    todaythreads?: number;
  };
}

/** 版主公开资料（逐个 GET /api/users/:uid，接口无批量端点） */
type ModBrief = { uid: number; username: string; avatar: number };

function parseModuids(s: string | undefined): number[] {
  return (s ?? '')
    .split(/[,;\s]+/)
    .map(Number)
    .filter((n) => n > 0)
    .slice(0, 8);
}

/** 版块徽标（.badge-pill）：黑实底 / 软红 / 浅灰三档 */
const pill = 'ml-1 rounded-full px-2.5 py-1 text-xs font-bold';
/** 标签筛选行次要态 chip（未选中）；选中态走 TagBadge */
const tagChip = 'inline-flex shrink-0 items-center rounded-full border border-zh-line bg-lt-soft px-2.5 py-[3px] text-xs leading-none text-ink-soft transition-colors hover:bg-zh-row-hover';

/** §4.2 版块页：版块信息卡 + 标签筛选行 + 公告条 + 列表卡（新回复/排序）+ 侧栏 */
export function ForumPage() {
  const params = useParams();
  const [search] = useSearchParams();
  const fid = posInt(params.fid);
  const page = posInt(search.get('page'));
  const digest = search.get('digest') === '1' ? 1 : 0;
  const orderby = search.get('orderby') === 'lastpid' ? 'lastpid' : 'tid';
  const curTag = (search.get('tag') ?? '').trim();
  const forumlist = useAuth((s) => s.forumlist);
  const me = useAuth((s) => s.me);
  const light = useLight();
  const tags = light.tags;
  const t = useT();
  const [noticeOff, setNoticeOff] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  /* 版主批量操作：勾选 → 底部动作条 → POST /api/mod/threads */
  const qc = useQueryClient();
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [batchAction, setBatchAction] = useState('');
  const [moveFid, setMoveFid] = useState(0);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchErr, setBatchErr] = useState('');

  /* 内容语言筛选（空串 = 全部；显式拼进 URL 以保证边缘缓存按语言隔离） */
  const contentLang = useContentLangFilter();
  const q = useQuery({
    queryKey: ['threads', fid, page, digest, orderby, curTag, contentLang],
    queryFn: () =>
      apiGet<ForumPageData>(
        `/api/forums/${fid}/threads?page=${page}${digest ? '&digest=1' : ''}&orderby=${orderby}${curTag ? `&tag=${encodeURIComponent(curTag)}` : ''}${contentLang ? `&lang=${encodeURIComponent(contentLang)}` : ''}`,
      ),
    placeholderData: keepPreviousData,
  });

  const href = (p: number) => {
    const sp = new URLSearchParams(search);
    if (p > 1) sp.set('page', String(p));
    else sp.delete('page');
    const qs = sp.toString();
    return `/forum/${fid}${qs ? `?${qs}` : ''}`;
  };
  /** 切换筛选条件回到第 1 页 */
  const nav = (patch: Record<string, string | null>) => {
    const sp = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) sp.delete(k);
      else sp.set(k, v);
    }
    sp.delete('page');
    const qs = sp.toString();
    return `/forum/${fid}${qs ? `?${qs}` : ''}`;
  };
  /* 站点「内容语言」开关：0=关闭 → 语言条与绑定提示都不渲染（与升级前一致） */
  const langMode = useContentLangMode();
  const node = forumlist.find((f) => f.fid === fid);
  const forum = { ...node, ...q.data?.forum };
  const name = forum.name ?? '';
  const brief = forum.brief ?? '';
  const announcement = forum.announcement ?? '';
  const mods = parseModuids(forum.moduids);
  /* 置顶主题：列表首页已并入 top（服务端 threadListHandler），取前 5 条展示 */
  const topList = (q.data?.list ?? []).filter((x) => x.top > 0).slice(0, 5);
  /** 版主可见批量操作条（前端近似口径：gid 1/2 恒可；gid 3/4 需在版块 moduids——组 allowtop 位由服务端逐条判定兜底） */
  const isMod =
    !!me &&
    (me.gid === GroupId.ADMIN ||
      me.gid === GroupId.SUPER_MOD ||
      ([3, 4].includes(me.gid) && mods.includes(me.uid)));

  /** 执行批量动作（'open' 是 close+value=0 的 UI 别名；服务端逐条鉴权，部分失败返回实际执行数） */
  const runBatch = async () => {
    setBatchErr('');
    if (!batchAction || !sel.size) return;
    if (batchAction === 'delete' && !window.confirm(t('confirm_delete_threads', { count: sel.size }))) return;
    if (batchAction === 'move' && !moveFid) {
      setBatchErr(t('select_target_forum'));
      return;
    }
    setBatchBusy(true);
    try {
      const r = await modThreads({
        tids: [...sel],
        action: batchAction === 'open' ? 'close' : (batchAction as 'top' | 'untop' | 'digest' | 'close' | 'delete' | 'move'),
        value:
          batchAction === 'move'
            ? moveFid
            : batchAction === 'top' || batchAction === 'digest' || batchAction === 'close'
              ? 1
              : batchAction === 'open'
                ? 0
                : undefined,
      });
      window.alert(t('batch_done_notice', { count: r.count }));
      setSel(new Set());
      setBatchAction('');
      void qc.invalidateQueries({ queryKey: ['threads'] });
    } catch (e) {
      setBatchErr(e instanceof Error ? e.message : t('operation_failed'));
    } finally {
      setBatchBusy(false);
    }
  };

  const toggleSel = (tid: number, checked: boolean) =>
    setSel((s) => {
      const n = new Set(s);
      if (checked) n.add(tid);
      else n.delete(tid);
      return n;
    });

  /* 404 页：版块不存在（后端 NOT_FOUND）→ 整页 404 替代错误行；其余错误原样展示 */
  if (q.isError && q.error instanceof ApiError && q.error.code === Code.NOT_FOUND) return <NotFoundPage />;

  return (
    <>
      <TwoCol
        asideSticky
        left={<HomeSideNav />}
        aside={
          <>
            {me && <CreateButton fid={fid} text={t('create_new_thread')} />}
            {/* 版块统计卡（卡头带背景图） */}
            <section className="zh-card mb-4">
              <div className="zh-card-header flex items-center gap-2 bg-[url(/theme-light/itemBg2.webp)] bg-cover bg-center px-5 py-3 text-sm font-medium">
                <Icon name="chart_bar" className="size-4" />
                <span>{t('forum_details')}</span>
              </div>
              <div className="p-4">
                <div className="flex items-center gap-2">
                  {forum.iconUrl ? (
                    <img src={forum.iconUrl} alt={name} className="size-10 shrink-0 rounded-full object-contain" />
                  ) : (
                    <span className="grid size-10 shrink-0 place-items-center rounded-full bg-lt-soft">
                      <Icon name="folder" className="size-5 text-zh-grey" />
                    </span>
                  )}
                  <span className="min-w-0 truncate font-medium">{name}</span>
                </div>
                <div className="mt-2 text-xs leading-[2] text-zh-grey">{brief || t('no_brief_yet')}</div>
                <ForumStats forum={forum} />
              </div>
            </section>
            {announcement && (
              <SidePanel pad="p-4">
                <CardTitle>{t('forum_announcement')}</CardTitle>
                <p className="mt-3 text-xs leading-[2] text-zh-grey">{announcement}</p>
              </SidePanel>
            )}
            {mods.length > 0 && <ModWall uids={mods} />}
            {/* 版块热门（侧栏末尾：本版块浏览量 top10） */}
            <RankForumHotCard fid={fid} />
          </>
        }
      >
        {/* 绑定语言提示（0024）：站点开启语言筛选、且本版（含继承父版块）锁定到具体语言时提示；
            站点关闭时整个语言功能不可见，提示随之隐藏 */}
        {langMode > 0 && forum.lang ? (
          <Alert className="mb-[.4rem]">{t('forum_lang_notice', { lang: CONTENT_LANG_NATIVE_NAMES[forum.lang as ContentLang] })}</Alert>
        ) : null}

        {/* 版块信息卡（forum-card-body，移动端也显示） */}
        <div className="zh-card mb-[.4rem]">
          <div className="flex items-start gap-3 p-5">
            {forum.iconUrl ? (
              <img src={forum.iconUrl} alt={name} className="size-[4.5rem] shrink-0 rounded-full object-contain" />
            ) : (
              <span className="grid size-[4.5rem] shrink-0 place-items-center rounded-full bg-lt-soft">
                <Icon name="folder" className="size-8 text-zh-grey" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <h5 className="text-base font-medium">{name}</h5>
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-2 text-xs">
                <span>
                  <span className="text-lt-grey">{t('thread_count_label')}</span>
                  <b className={cx(pill, 'bg-[#303133] text-white')}>{forum.threads ?? 0}</b>
                </span>
                <span>
                  <span className="text-lt-grey">{t('today_posts')}</span>
                  <b className={cx(pill, 'bg-destructive/10 text-destructive')}>{forum.todayposts ?? 0}</b>
                </span>
                <span>
                  <span className="text-lt-grey">{t('today_threads')}</span>
                  <b className={cx(pill, 'bg-lt-soft text-ink-soft')}>{forum.todaythreads ?? 0}</b>
                </span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="inline-flex h-8 items-center rounded-[6px] border border-brand px-3 text-sm text-brand transition-colors hover:bg-[#ecf5ff]"
                  onClick={() => setAboutOpen(true)}
                >
                  {t('about_forum')}
                </button>
                <Link
                  to={`/forum/${fid}/new`}
                  className="inline-flex h-8 items-center rounded-[6px] bg-brand px-3 text-sm text-white transition-colors hover:bg-brand-hover"
                >
                  <Icon name="edit" className="mr-1 size-4" />
                  {t('create_new_thread')}
                </Link>
              </div>
            </div>
          </div>
          {topList.length > 0 && (
            <div className="border-t border-zh-line px-5 py-3">
              <div className="mb-1.5 text-xs font-medium text-card-header-ink">{t('forum_top_threads')}</div>
              <ul className="m-0 list-none p-0">
                {topList.map((th) => (
                  <li key={th.tid}>
                    <Link
                      to={`/thread/${th.tid}`}
                      className="flex items-center gap-1.5 py-1 text-sm text-foreground transition-colors hover:text-brand"
                    >
                      <Icon name="top" className="size-3.5 shrink-0 text-brand" />
                      <span className="min-w-0 truncate">{th.subject}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* 内容语言筛选条（后台开启后显示；仅在前台筛选，不影响版块结构与权限） */}
        <ContentLangBar wrap="card" />

        {/* 标签筛选行（idx_tag，版块页顶部）：全部 + 各标签，切标签回第 1 页并保留其他筛选 */}
        {tags.length > 0 && (
          <div className="zh-card mb-[.4rem] p-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2 max-lg:flex-nowrap max-lg:overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <span className="shrink-0 text-sm text-zh-grey">{t('tag_label')}：</span>
              {!curTag ? (
                <TagBadge name={t('all_tags')} style="primary" to={nav({ tag: null })} />
              ) : (
                <Link to={nav({ tag: null })} className={tagChip}>
                  {t('all_tags')}
                </Link>
              )}
              {tags.map((tg) =>
                curTag === tg.name ? (
                  <TagBadge key={tg.name} name={tg.name} style={tg.style} to={nav({ tag: tg.name })} />
                ) : (
                  <Link key={tg.name} to={nav({ tag: tg.name })} className={tagChip}>
                    {tg.name}
                  </Link>
                ),
              )}
            </div>
          </div>
        )}

        {!noticeOff && announcement && (
          <Alert tone="secondary" icon="megaphone" className="mb-2">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{t('forum_announcement')}</p>
                <p className="mt-1 break-words text-xs leading-[1.8]">{announcement}</p>
              </div>
              <button
                type="button"
                aria-label={t('close_announcement')}
                className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
                onClick={() => setNoticeOff(true)}
              >
                <Icon name="close" className="size-4" />
              </button>
            </div>
          </Alert>
        )}

        <Card
          header={
            <div className="flex w-full items-center justify-between gap-3">
              <CardTabs
                items={[
                  { k: 'new', text: t('new_reply'), active: digest === 0, to: nav({ digest: null }) },
                  { k: 'digest', text: t('forum_digest'), active: digest === 1, to: nav({ digest: '1' }) },
                ]}
              />
              <SortPills orderby={orderby} nav={nav} />
            </div>
          }
          bodyClass="p-0"
        >
          {q.isError && <p className="px-5 py-6 text-center text-sm text-destructive">{(q.error as Error).message}</p>}
          {q.data && (
            <ThreadList
              data={q.data}
              baseHref={href}
              selectable={isMod}
              selected={sel}
              onToggle={toggleSel}
            />
          )}
          {isMod && q.data && q.data.list.length > 0 && (
            /* 批量操作条（全选框 + 动作下拉 + 提交） */
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-zh-line bg-lt-soft px-4 py-2.5 text-xs sm:px-5">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="size-4 cursor-pointer accent-brand"
                  aria-label={t('select_all_page')}
                  checked={sel.size > 0 && sel.size === q.data.list.length}
                  onChange={(e) => setSel(e.target.checked ? new Set(q.data.list.map((t2) => t2.tid)) : new Set())}
                />
                {t('select_all')}
              </label>
              <span className="text-zh-grey">{t('selected_count', { count: sel.size })}</span>
              <select
                className="h-8 rounded-[4px] border border-input-line bg-card px-2 text-xs outline-none focus:border-brand"
                value={batchAction}
                onChange={(e) => setBatchAction(e.target.value)}
                aria-label={t('batch_action_label')}
              >
                <option value="">{t('select_action')}</option>
                <option value="top">{t('mod_top')}</option>
                <option value="untop">{t('mod_untop')}</option>
                <option value="digest">{t('mod_digest')}</option>
                <option value="close">{t('mod_close_reply')}</option>
                <option value="open">{t('mod_reopen')}</option>
                <option value="move">{t('mod_move_to')}</option>
                <option value="delete">{t('delete_thread')}</option>
              </select>
              {batchAction === 'move' && (
                <select
                  className="h-8 rounded-[4px] border border-input-line bg-card px-2 text-xs outline-none focus:border-brand"
                  value={moveFid}
                  onChange={(e) => setMoveFid(Number(e.target.value))}
                  aria-label={t('target_forum')}
                >
                  <option value={0}>{t('select_target_forum_dots')}</option>
                  {forumlist
                    .filter((f) => f.fid !== fid)
                    .map((f) => (
                      <option key={f.fid} value={f.fid}>
                        {f.name}
                      </option>
                    ))}
                </select>
              )}
              <button
                type="button"
                className="inline-flex h-8 items-center rounded-[4px] bg-brand px-3 text-xs font-medium text-white transition-colors hover:bg-brand-hover disabled:pointer-events-none disabled:opacity-50"
                disabled={!batchAction || !sel.size || batchBusy}
                onClick={() => void runBatch()}
              >
                {batchBusy ? t('executing_dots') : t('execute_btn')}
              </button>
              {sel.size > 0 && (
                <button type="button" className="text-zh-grey transition-colors hover:text-brand" onClick={() => setSel(new Set())}>
                  {t('cancel_selection')}
                </button>
              )}
              {batchErr && <span className="text-destructive">{batchErr}</span>}
            </div>
          )}
        </Card>
        {q.data && <Pagination page={q.data.page} totalPage={q.data.totalPage} href={href} />}
      </TwoCol>

      {aboutOpen && (
        <Modal title={t('about_forum')} onClose={() => setAboutOpen(false)}>
          <div className="text-sm font-medium text-card-header-ink">{t('forum_moderators')}</div>
          <ModAvatars uids={mods} />
          {announcement && (
            <>
              <div className="mt-4 text-sm font-medium text-card-header-ink">{t('forum_announcement')}</div>
              <p className="mt-2 text-xs leading-[2] text-zh-grey">{announcement}</p>
            </>
          )}
        </Modal>
      )}
    </>
  );
}

/** 排序按钮组（方角 + 激活主色底白字，保留 tid/lastpid 导航逻辑） */
function SortPills({ orderby, nav }: { orderby: string; nav: (patch: Record<string, string | null>) => string }) {
  const t = useT();
  const opts = [
    ['tid', t('sort_post_time')],
    ['lastpid', t('sort_reply_time')],
  ] as const;
  return (
    <div className="hidden shrink-0 items-center sm:inline-flex" role="group" aria-label={t('thread_sort_aria')}>
      {opts.map(([k, label], i) => {
        const active = orderby === k;
        return (
          <Link
            key={k}
            to={nav({ orderby: k === 'tid' ? null : k })}
            aria-current={active ? 'true' : undefined}
            className={cx(
              'inline-flex h-[31px] items-center justify-center whitespace-nowrap border border-input-line px-2.5 text-[13px] transition-colors outline-none',
              i > 0 && '-ml-px',
              i === 0 ? 'rounded-l-[4px]' : 'rounded-r-[4px]',
              active ? 'z-10 border-brand bg-brand text-white' : 'bg-card text-ink-soft hover:bg-zh-row-hover',
            )}
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}

/** 版主公开资料批量拉取（同 queryKey 去重，侧栏卡与「关于版块」弹窗共用） */
function useMods(uids: number[]) {
  const q = useQuery({
    queryKey: ['mods', uids.join(',')],
    queryFn: () => Promise.all(uids.map((uid) => apiGet<ModBrief>(`/api/users/${uid}`))),
  });
  return { list: q.data ?? [], isPending: q.isPending };
}

/** 版主头像墙（侧栏卡：col-3 头像网格） */
function ModWall({ uids }: { uids: number[] }) {
  const t = useT();
  const { list, isPending } = useMods(uids);
  return (
    <SidePanel pad="p-4">
      <CardTitle>{t('forum_moderators')}</CardTitle>
      <div className="mt-3 flex flex-wrap">
        {list.map((m) => (
          <div key={m.uid} className="mb-1 w-1/4 text-center">
            <Link to={`/user/${m.uid}`} aria-label={m.username} className="inline-block">
              <Avatar uid={m.uid} avatar={m.avatar} username={m.username} size={3} />
            </Link>
            <br />
            <Link className="text-nowrap text-xs text-lt-grey transition-colors hover:text-brand" to={`/user/${m.uid}`}>
              {m.username}
            </Link>
          </div>
        ))}
        {!isPending && !list.length && <span className="text-xs text-lt-grey">{t('no_moderators')}</span>}
      </div>
    </SidePanel>
  );
}

/** 版主头像行（「关于版块」弹窗：头像 + 用户名） */
function ModAvatars({ uids }: { uids: number[] }) {
  const t = useT();
  const { list, isPending } = useMods(uids);
  if (!isPending && !list.length) return <p className="mt-2 text-xs text-lt-grey">{t('no_moderators')}</p>;
  return (
    <div className="mt-3 grid grid-cols-2 gap-3">
      {list.map((m) => (
        <Link key={m.uid} to={`/user/${m.uid}`} className="flex min-w-0 items-center gap-2 transition-colors hover:text-brand">
          <Avatar uid={m.uid} avatar={m.avatar} username={m.username} size={3} />
          <span className="min-w-0 truncate text-xs text-ink-soft">{m.username}</span>
        </Link>
      ))}
    </div>
  );
}

/** 版块信息卡脚 3 列统计表（细线分隔 + 数字加粗） */
function ForumStats({ forum }: { forum: { threads?: number; todayposts?: number; todaythreads?: number } }) {
  const t = useT();
  const cells: [number, string][] = [
    [forum.threads ?? 0, t('thread_count_short')],
    [forum.todayposts ?? 0, t('today_posts_short')],
    [forum.todaythreads ?? 0, t('today_threads')],
  ];
  return (
    <div className="mt-3 grid grid-cols-3 border-t border-zh-line pt-3 text-center">
      {cells.map(([v, l]) => (
        <div key={l}>
          <p className="text-[15px] font-bold tabular-nums text-foreground">{v}</p>
          <p className="mt-0.5 text-xs text-lt-grey">{l}</p>
        </div>
      ))}
    </div>
  );
}