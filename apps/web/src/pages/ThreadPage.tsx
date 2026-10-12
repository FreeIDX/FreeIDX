import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Code, PageSize, type FavoriterItem, type FrontKey, type HotPostsData, type PostItem, type ThreadDetail } from '@freeidx/shared';
import { ApiError, apiGet, checkAudit, createReply, deletePost, fetchPostReplies, fetchQuickReplyMessage, fmtDate, getThreadPaylist, modThreads, payThread, recycleThread, toggleFavorite, toggleLike, togglePostLike, updatePost } from '../lib/api';
import { apiErrorMessage } from '../lib/errors';
import { posInt } from '../lib/params';
import { AttachRows } from '../components/AttachRows';
import { Avatar } from '../components/Avatar';
import { Composer, type ComposerSubmit, type QuotedSummary } from '../components/Composer';
import { Icon } from '../components/icons';
import { InsertCode, useInsertCodes } from '../components/InsertCode';
import { Pagination } from '../components/Pagination';
import { PmButton } from '../components/PmButton';
import { PostCard } from '../components/PostCard';
import { VBadge } from '../components/VBadge';
import { NotFoundPage } from './NotFoundPage';
import { Turnstile, turnstileDisabled } from '../components/Turnstile';
import { Alert, Breadcrumb, Button, Card, Modal, TagBadge, cx } from '../components/ui';
import { useReadUnread } from '../hooks/useReadUnread';
import { useAuth } from '../store/auth';
import { useAuthModal } from '../store/authModal';
import { useT, useGroupName } from '../lib/i18n';
import { useLight } from '../store/theme';
import type { UserProfile } from './UserPage';

type TranslateFn = (key: FrontKey, params?: Record<string, string | number>) => string;

function snippetOf(html: string): string {
  const text = html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 购物车图标内联 HTML（付费块用；几何同 components/icons.tsx 的 cart） */
const payIcon = (color: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="mr-1 inline size-4" style="color:${color}" aria-hidden="true"><title>ttPay</title><path d="m2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/><path d="M9 21a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/><path d="M20 21a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/></svg>`;

/**
 * 付费段渲染（alert 语义色）：
 *  content_buy>0 → [ttPay]…[/ttPay] 逐段替换：已购/作者 → 绿 alert（「付费内容查看」+ 查看购买记录链接 + 段内容）；
 *  未购 → 首段黄 alert（价格 + 「支付」按钮 data-pay-btn），其余段置空；
 *  content_buy=0 → 仅去掉标记显示原文。
 */
function renderPayHtml(html: string, o: { contentBuy: number; type: number; purchased: boolean; tid: number; sitename: string; t: TranslateFn }): string {
  if (o.contentBuy <= 0) return html.replace(/\[\/?ttPay\]/gi, '');
  const unit = o.type === 1 ? o.t('credits_experience') : o.type === 2 ? o.t('credits_gold') : o.t('credits_rmb');
  const price = o.type === 3 ? o.contentBuy / 100 : o.contentBuy;
  let seen = false;
  return html.replace(/\[ttPay\]([\s\S]*?)\[\/ttPay\]/gi, (_all, inner: string) => {
    if (o.purchased) {
      return `<div class="alert alert-success my-4 rounded-[5px] bg-[rgba(103,194,58,0.12)] px-4 py-2.5 text-sm leading-6 text-[#4d8b23]" role="alert">${payIcon('green')}${esc(o.sitename)} - ${o.t('paid_content_view')}<div class="float-right"><a href="/thread/${o.tid}/paylist" data-paylist>${o.t('view_buy_record')}</a></div><hr class="my-2 border-[rgba(103,194,58,0.25)]"/>${inner}</div>`;
    }
    if (seen) return '';
    seen = true;
    return `<div class="alert alert-warning my-4 rounded-[5px] bg-[rgba(230,162,60,0.14)] px-4 py-2.5 text-sm leading-6 text-[#a4681a]" role="alert">${payIcon('gold')}${esc(o.sitename)} - ${o.t('pay')}<hr class="my-2 border-[rgba(230,162,60,0.25)]"/>${o.t('paid_content_hint_prefix')}<span class="font-bold">${price}${unit}</span>${o.t('paid_content_hint_suffix')}<button type="button" data-pay-btn class="float-right rounded-[4px] bg-[#e6a23c] px-3 py-1.5 text-white transition-colors hover:bg-[#d4941f]">${o.t('pay')}</button><div style="clear:both;"></div></div>`;
  });
}

/** 购买记录金额文案：人民币分转元，其余按原值 + 币种单位 */
function paylistAmount(t: TranslateFn, d: { contentBuy: number; contentBuyType: number }): string {
  const unit = d.contentBuyType === 1 ? t('credits_experience') : d.contentBuyType === 2 ? t('credits_gold') : t('credits_rmb');
  return `${d.contentBuyType === 3 ? d.contentBuy / 100 : d.contentBuy} ${unit}`;
}

/** 购买时间格式 YYYY-MM-DD HH:mm:ss */
function fmtPayTime(ts: number): string {
  if (!ts) return '';
  const dt = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}

/** 主贴作者行操作（编辑/删除 + 版务）：灰字小按钮，hover 主色/危险色 */
const actCls =
  'inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs text-lt-grey transition-colors hover:text-brand disabled:opacity-50';
const delCls =
  'inline-flex h-7 items-center gap-1 rounded-full px-2 text-xs text-lt-grey transition-colors hover:text-destructive disabled:opacity-50';
/** 审核提示条内按钮（次要描边：#868e96 描边，hover 反色填充） */
const alertBtn =
  'inline-flex h-8 items-center rounded-[4px] border border-[#868e96] px-3 text-xs text-[#868e96] transition-colors hover:bg-[#868e96] hover:text-white disabled:opacity-50';
/** 左侧悬浮工具栏圆钮：白底圆形，hover/激活主色，48px */
const barBtn =
  'flex size-12 items-center justify-center rounded-full border border-zh-line bg-card text-lt-grey transition-colors hover:text-brand disabled:opacity-50';
/** 版务小圆钮（保持原尺寸，仅管理员可见） */
const barBtnSm =
  'flex size-10 items-center justify-center rounded-full border border-zh-line bg-card text-lt-grey transition-colors hover:text-brand disabled:opacity-50';
/** 左侧悬浮工具栏计数徽标（圆钮下方，胶囊形灰蓝底白字） */
const barBadge =
  'inline-flex min-w-[20px] items-center justify-center rounded-full bg-[#8a94a6] px-1.5 py-0.5 text-[11px] leading-none font-semibold text-white tabular-nums';

/** 标题样式（h4 级：text-base font-medium；关闭话题置灰） */
function getTitleCls(th: { digest: number; closed: number }): string {
  if (th.closed > 0) return 'text-base font-medium leading-snug text-zh-grey';
  return 'text-base font-medium leading-snug text-foreground';
}

/** 附件区（首帖）：列表组外壳 + 共用附件行（AttachRows：免费图片预览，其余走下载端点强校验） */
function Attaches({ post }: { post: PostItem }) {
  const t = useT();
  if (!post.attaches?.length) return null;
  return (
    <div className="mt-5 overflow-hidden rounded-[5px] border border-zh-line bg-lt-soft">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zh-line px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Icon name="attachment" className="size-4 text-lt-grey" />
          <h4 className="text-sm font-medium">{t('attach_list')}</h4>
        </div>
        <span className="text-xs text-lt-grey">{t('attach_count', { count: post.attaches.length })}</span>
      </div>
      <div className="p-2">
        <AttachRows attaches={post.attaches} />
      </div>
    </div>
  );
}

/**
 * 上一篇/下一篇双卡（light 扩展 preNextThread 开启时渲染）：
 * 同版块 tid 邻接（服务端下发 prev/next），两卡各 49% 宽；无邻帖显示「无更多文章」。
 */
function PrevNextCards({ prev, next }: { prev: { tid: number; subject: string } | null; next: { tid: number; subject: string } | null }) {
  const t = useT();
  const items = [
    { key: 'prev' as const, item: prev },
    { key: 'next' as const, item: next },
  ];
  return (
    <div className="mb-4 flex flex-wrap justify-between gap-3">
      {items.map(({ key, item }) => {
        const isNext = key === 'next';
        const head = (
          <div className={cx('mb-2 text-xs text-lt-grey', isNext && 'text-right')}>
            {isNext ? (
              <>
                {t('next_thread')}
                <Icon name="arrow_right" className="ml-3 inline size-3.5 align-[-2px]" />
              </>
            ) : (
              <>
                <Icon name="arrow_left" className="mr-3 inline size-3.5 align-[-2px]" />
                {t('prev_thread')}
              </>
            )}
          </div>
        );
        return (
          <div key={key} className="zh-card min-w-0 flex-1 basis-[47%] p-4">
            {item ? (
              <Link to={`/thread/${item.tid}`} className="group block">
                {head}
                <div className="truncate text-sm text-foreground transition-colors group-hover:text-brand">{item.subject}</div>
              </Link>
            ) : (
              <>
                {head}
                <div className="text-sm text-lt-grey">{t('no_more_threads')}</div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * 主题详情：
 * 面包屑（右侧浏览/回复/点赞/收藏）+ 左悬浮工具栏（回复/点赞/收藏/版务，仅 lg+）
 * + 主贴卡（card-thread：卡头标题 + 作者行，卡体正文/标签/附件，卡脚插件区）
 * + 快捷回复卡（#comment_input，楼层列表之前）+ 楼层卡（card-postlist，可折叠）
 * + 分页 + 右栏作者卡（80px 背景图 + 上移头像 + 三列统计）
 * + 移动端贴内悬浮条（thread-nav，仅 <lg）。
 * 写侧（回帖/编辑/删除/版务）乐观更新 + 失败回滚保留；楼内搜索保留；API 调用与查询逻辑不变。
 */
export function ThreadPage() {
  const t = useT();
  const gn = useGroupName();
  const light = useLight();
  const params = useParams();
  const navigate = useNavigate();
  const openAuth = useAuthModal((s) => s.openAuth);
  const qc = useQueryClient();
  const tid = posInt(params.tid);
  const page = posInt(params.page);
  const [quoted, setQuoted] = useState<QuotedSummary | null>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  /* 插入代码扩展注入位原始 HTML（全站共享缓存） */
  const insertCodes = useInsertCodes();
  const [advanced, setAdvanced] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [quick, setQuick] = useState('');
  const [quickTs, setQuickTs] = useState('');
  const [quickNonce, setQuickNonce] = useState(0);
  const [quickErr, setQuickErr] = useState('');
  /* 快速回复下拉（[默认语, ...# 分隔备选语]，首项 value=0 选中不动作） */
  const quickReplyMsg = useQuery({
    queryKey: ['quick-reply-message'],
    queryFn: fetchQuickReplyMessage,
    staleTime: 5 * 60_000,
  });
  const [quickSel, setQuickSel] = useState(0);
  const [opEditing, setOpEditing] = useState(false);
  const [opErr, setOpErr] = useState('');
  const { markRead } = useReadUnread();
  const me = useAuth((s) => s.me);
  const refresh = useAuth((s) => s.refresh);
  const forumlist = useAuth((s) => s.forumlist);
  const grouplist = useAuth((s) => s.grouplist);
  const setting = useAuth((s) => s.setting);
  /* 版务操作（mod_top/mod_digest/mod_close/mod_move 的 dialog 等价实现） */
  const [modDlg, setModDlg] = useState<'top' | 'digest' | 'move' | null>(null);
  const [modVal, setModVal] = useState(0);
  const [modBusy, setModBusy] = useState(false);
  const [modErr, setModErr] = useState('');
  /* 现场审核：主题提示条与回收站按钮共用 busy/错误位 */
  const [chkBusy, setChkBusy] = useState(false);
  const [chkErr, setChkErr] = useState('');
  /* 付费主题购买：确认弹层与提交态 */
  const [payOpen, setPayOpen] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  const [payErr, setPayErr] = useState('');
  /* 购买记录弹层：仅弹层打开时拉取买家清单，弹层内翻页 */
  const [paylistOpen, setPaylistOpen] = useState(false);
  const [paylistPage, setPaylistPage] = useState(1);
  const paylist = useQuery({
    queryKey: ['thread-paylist', tid, paylistPage],
    queryFn: () => getThreadPaylist(tid, paylistPage),
    enabled: paylistOpen,
    staleTime: 30_000,
  });
  /* 收藏用户弹层：仅弹层打开时拉取收藏者列表 */
  const [favUsersOpen, setFavUsersOpen] = useState(false);
  const favUsers = useQuery({
    queryKey: ['favoriters', tid],
    queryFn: () => apiGet<{ list: FavoriterItem[]; total: number }>(`/api/threads/${tid}/favoriters`),
    enabled: favUsersOpen,
    staleTime: 30_000,
  });
  /* 楼层「查看所有回复」弹层（show_all_reply）：按下入口楼层 pid 拉取其全部直接回复 */
  const [repliesPid, setRepliesPid] = useState<number | null>(null);
  const replies = useQuery({
    queryKey: ['post-replies', repliesPid],
    queryFn: () => fetchPostReplies(repliesPid as number, 1),
    enabled: repliesPid !== null,
    staleTime: 30_000,
  });
  /* 楼层点赞：toggle 后刷新主题详情与热门回复 */
  const postLike = useMutation({
    mutationFn: (p: PostItem) => togglePostLike(p.pid),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['thread', tid] });
      void qc.invalidateQueries({ queryKey: ['hot-posts', tid] });
    },
  });
  /* 帖子内「热门回复」卡：仅第 1 页且开启时拉取 */
  const hotPosts = useQuery({
    queryKey: ['hot-posts', tid, light.hotLikePostLowCount, light.hotLikePostSize, light.hotLikeIsFirst],
    queryFn: () =>
      apiGet<HotPostsData>(
        `/api/threads/${tid}/hot-posts?limit=${light.hotLikePostSize}&threshold=${light.hotLikePostLowCount}&includeFirst=${light.hotLikeIsFirst ? 1 : 0}`,
      ),
    enabled: light.hotLikePost && page === 1,
    staleTime: 30_000,
  });
  /** 楼层点赞回调（登录态才渲染按钮；未登录不显示） */
  const onLikePost = light.postLike && me ? (p: PostItem) => postLike.mutate(p) : undefined;
  /* 首帖编辑的收费设置（allowsell 组才出现，初值取主题现值） */
  const canSell = me ? grouplist.find((g) => g.gid === me.gid)?.allowsell === 1 : false;
  const [opSellOn, setOpSellOn] = useState(false);
  const [opSellNum, setOpSellNum] = useState('');
  const [opSellType, setOpSellType] = useState(1);

  const doMod = async (action: 'top' | 'digest' | 'move' | 'close', value: number) => {
    setModErr('');
    setModBusy(true);
    try {
      await modThreads({ tids: [tid], action, value });
      setModDlg(null);
      void qc.invalidateQueries({ queryKey: ['thread', tid] });
      void qc.invalidateQueries({ queryKey: ['threads'] });
    } catch (e) {
      setModErr(e instanceof Error ? e.message : t('operation_failed'));
    } finally {
      setModBusy(false);
    }
  };

  /** 现场审核主题（统一 confirm；opt -2 真删后回版块页） */
  const doCheck = async (opt: number) => {
    if (!window.confirm(t('confirm_audit_thread'))) return;
    setChkErr('');
    setChkBusy(true);
    try {
      await checkAudit(0, tid, opt);
      void qc.invalidateQueries({ queryKey: ['threads'] });
      void refresh();
      if (opt === -2 && th) {
        navigate(`/forum/${th.fid}`);
        return;
      }
      void qc.invalidateQueries({ queryKey: ['thread', tid] });
    } catch (e) {
      setChkErr(e instanceof Error ? e.message : t('operation_failed'));
    } finally {
      setChkBusy(false);
    }
  };

  /** 回收站操作（set_thread_recycle：-1 恢复 / 1 彻底删除；删除后回版块页） */
  const doRecycle = async (opt: number) => {
    if (!window.confirm(opt === 1 ? t('confirm_delete_thread_q') : t('confirm_restore_thread_q'))) return;
    setChkErr('');
    setChkBusy(true);
    try {
      await recycleThread(tid, opt);
      void qc.invalidateQueries({ queryKey: ['threads'] });
      void refresh();
      if (opt === 1 && th) {
        navigate(`/forum/${th.fid}`);
        return;
      }
      void qc.invalidateQueries({ queryKey: ['thread', tid] });
    } catch (e) {
      setChkErr(e instanceof Error ? e.message : t('operation_failed'));
    } finally {
      setChkBusy(false);
    }
  };

  /** 回帖现场审核（PostCard 透传：act=1；删除后该楼层随刷新消失） */
  const auditPost = async (pid: number, opt: number) => {
    await checkAudit(1, pid, opt);
    void qc.invalidateQueries({ queryKey: ['thread', tid] });
    void qc.invalidateQueries({ queryKey: ['threads'] });
  };

  const queryKey = ['thread', tid, page];
  const q = useQuery({
    queryKey,
    queryFn: () =>
      apiGet<ThreadDetail>(`/api/threads/${tid}?page=${page}`),
    placeholderData: keepPreviousData,
  });

  /* A4 点赞 / A5 收藏 toggle：乐观翻转 + 失败回滚，settled 后以服务端计数为准 */
  const [socialErr, setSocialErr] = useState('');
  const like = useMutation({
    mutationFn: () => toggleLike(tid),
    onMutate: async () => {
      setSocialErr('');
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<ThreadDetail>(queryKey);
      if (prev) {
        qc.setQueryData<ThreadDetail>(queryKey, { ...prev, liked: !prev.liked, likes: prev.likes + (prev.liked ? -1 : 1) });
      }
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev);
      setSocialErr(e instanceof Error ? e.message : t('operation_failed'));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['thread', tid] });
    },
  });
  const favorite = useMutation({
    mutationFn: () => toggleFavorite(tid),
    onMutate: async () => {
      setSocialErr('');
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<ThreadDetail>(queryKey);
      if (prev) {
        qc.setQueryData<ThreadDetail>(queryKey, {
          ...prev,
          favorited: !prev.favorited,
          favorites: prev.favorites + (prev.favorited ? -1 : 1),
        });
      }
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev);
      setSocialErr(e instanceof Error ? e.message : t('operation_failed'));
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['thread', tid] });
    },
  });
  const onSocial = (m: typeof like | typeof favorite) => {
    if (!me) {
      openAuth('login');
      return;
    }
    m.mutate();
  };

  useEffect(() => {
    if (q.data) markRead(tid);
  }, [q.data, tid, markRead]);

  const d = q.data;
  const th = d?.thread;
  /* 标签页标题：主题加载后覆盖 Layout 基线为「主题标题 - 站点名」 */
  useEffect(() => {
    if (th?.subject) document.title = `${th.subject} - ${setting?.sitename || 'FreeIDX'}`;
  }, [th?.subject, setting?.sitename]);
  const perms = d?.perms;
  const opUid = th?.uid ?? 0;
  const author = useQuery({
    queryKey: ['user', opUid],
    queryFn: () => apiGet<UserProfile>(`/api/users/${opUid}`),
    enabled: Boolean(th),
  });
  const au = author.data;

  const mutateList = (fn: (list: PostItem[]) => PostItem[]) => {
    const prev = qc.getQueryData<ThreadDetail>(queryKey);
    if (prev) qc.setQueryData<ThreadDetail>(queryKey, { ...prev, posts: { ...prev.posts, list: fn(prev.posts.list) } });
    return prev;
  };

  const fid = th?.fid ?? 0;

  const reply = useMutation({
    mutationFn: (vars: ComposerSubmit & { quotepid: number }) =>
      createReply(tid, {
        message: vars.html,
        doctype: 0,
        quotepid: vars.quotepid > 0 ? vars.quotepid : undefined,
        attachAids: vars.attachAids,
        turnstileToken: vars.turnstileToken,
      }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey });
      const prev = qc.getQueryData<ThreadDetail>(queryKey);
      if (prev && me) {
        const temp: PostItem = {
          pid: -Date.now(),
          tid,
          uid: me.uid,
          username: me.username,
          avatar: me.avatar,
          isfirst: 0,
          doctype: 0,
          quotepid: vars.quotepid,
          message: vars.html,
          messageFmt: vars.html,
          images: 0,
          files: 0,
          createDate: Math.floor(Date.now() / 1000),
          /* 乐观回帖视为已过审（提交后以服务端刷新为准；未过审主题下本人可见自己内容） */
          ok: 1,
          allowupdate: false,
          allowdelete: false,
          likes: 0,
          liked: false,
          quoted: quoted ? { pid: quoted.pid, username: quoted.username, messageSnippet: quoted.snippet } : undefined,
        };
        qc.setQueryData<ThreadDetail>(queryKey, { ...prev, posts: { ...prev.posts, list: [...prev.posts.list, temp] } });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev); // 回滚乐观回帖；报错由提交方呈现
    },
    onSuccess: () => {
      setQuoted(null);
      // thread_reply_reload：整页刷新替代增量失效（失败回滚仍走 onError）
      if (light.threadReplyReload) window.location.reload();
    },
    onSettled: () => {
      if (light.threadReplyReload) return;
      void qc.invalidateQueries({ queryKey: ['thread', tid] });
      void qc.invalidateQueries({ queryKey: ['threads'] }); // 版块列表回复数/最后回复随回帖刷新
      void refresh();
    },
  });

  const edit = useMutation({
    mutationFn: (vars: { pid: number; change: { html: string; attachAids: number[] }; contentBuy?: number; contentBuyType?: number }) =>
      updatePost(vars.pid, {
        message: vars.change.html,
        doctype: 0,
        attachAids: vars.change.attachAids,
        // 首帖编辑携带收费设置（否/空数 → content_buy=0）
        ...(vars.contentBuy !== undefined ? { contentBuy: vars.contentBuy, contentBuyType: vars.contentBuyType } : {}),
      }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey });
      const prev = mutateList((list) =>
        list.map((p) => (p.pid === vars.pid ? { ...p, message: vars.change.html, messageFmt: vars.change.html } : p)),
      );
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev);
      throw e;
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['thread', tid] });
    },
  });

  const remove = useMutation({
    mutationFn: (post: PostItem) => deletePost(post.pid),
    onMutate: async (post) => {
      await qc.cancelQueries({ queryKey });
      const prev = mutateList((list) => list.filter((p) => p.pid !== post.pid));
      return { prev, first: post.isfirst > 0 };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey, ctx.prev);
      throw e;
    },
    onSuccess: (_d, post) => {
      if (post.isfirst > 0 && fid) navigate(`/forum/${fid}`);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['thread', tid] });
      void qc.invalidateQueries({ queryKey: ['threads'] }); // 删除回帖/主题同步刷新列表计数
      void refresh();
    },
  });

  const onReplyClick = (post: PostItem) => {
    if (!me) {
      openAuth('login');
      return;
    }
    setQuoted({ pid: post.pid, username: post.username, snippet: snippetOf(post.messageFmt) });
    if (advanced || opEditing) return;
    composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  /** 楼层快捷 @（thread_quick_at）：把「@用户名 」追加进快捷回复框并聚焦（仅本地编辑，不要求登录） */
  const onQuickAt = (p: PostItem) => {
    setQuick((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}@${p.username} `);
    composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    requestAnimationFrame(() => document.getElementById('quick_reply_text')?.focus());
  };

  /** overrideText：快速回复下拉选中即发（赋值后立刻提交，不等 React 状态回写） */
  const submitQuick = async (overrideText?: string) => {
    setQuickErr('');
    const text = (overrideText ?? quick).trim();
    if (!text) {
      setQuickErr(t('please_input_message'));
      return;
    }
    if (!turnstileDisabled() && !quickTs) {
      setQuickErr(t('please_complete_captcha'));
      return;
    }
    const html = `<p>${text.split(/\n+/).map(esc).join('</p><p>')}</p>`;
    try {
      await reply.mutateAsync({ html, attachAids: [], turnstileToken: quickTs, quotepid: quoted?.pid ?? 0 });
      setQuick('');
    } catch (e) {
      setQuickErr(e instanceof Error ? e.message : t('submit_failed'));
    } finally {
      // token 一次性 ⇒ 不论成败都重挂换发
      setQuickTs('');
      setQuickNonce((n) => n + 1);
    }
  };

  /** 快速回复下拉：选中非默认项 → 文本填入回复框并立即提交；完毕后下拉复位 */
  const onQuickReplyPick = async (idx: number) => {
    setQuickSel(idx);
    if (idx <= 0) return;
    const text = quickReplyMsg.data?.options[idx] ?? '';
    if (!text) return;
    setQuick(text);
    await submitQuick(text);
    setQuickSel(0);
  };

  const removeOp = async () => {
    if (!op) return;
    if (!window.confirm(t('confirm_delete_op_post'))) return;
    setOpErr('');
    try {
      await remove.mutateAsync(op);
    } catch (e) {
      setOpErr(e instanceof Error ? e.message : t('delete_failed'));
    }
  };

  /** 进入首帖编辑：收费设置初值取主题现值 */
  const startOpEdit = () => {
    if (!th) return;
    setOpSellOn(th.contentBuy > 0);
    setOpSellNum(th.contentBuy > 0 ? String(th.contentBuy) : '');
    setOpSellType(th.contentBuyType > 0 ? th.contentBuyType : 1);
    setOpErr('');
    setOpEditing(true);
  };

  /** 购买付费主题（确认后 POST thread-cPay；NOT_LOGIN 转登录、积分不足转积分面板） */
  const doPay = async () => {
    setPayErr('');
    setPayBusy(true);
    try {
      await payThread(tid);
      setPayOpen(false);
      void qc.invalidateQueries({ queryKey: ['thread', tid] });
      void qc.invalidateQueries({ queryKey: ['threads'] });
      void refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === Code.NOT_LOGIN) {
        setPayOpen(false);
        if (window.confirm(`${e.message}\n\n${t('go_login_confirm')}`)) openAuth('login');
        return;
      }
      if (e instanceof ApiError && e.code === Code.FORM_INSUFFICIENT_CREDITS) {
        setPayOpen(false);
        if (window.confirm(`${e.message}\n\n${t('go_credits_confirm')}`)) navigate('/me?s=credits');
        return;
      }
      setPayErr(apiErrorMessage(e, t('buy_failed')));
    } finally {
      setPayBusy(false);
    }
  };

  const href = (p: number) => (p === 1 ? `/thread/${tid}` : `/thread/${tid}/p/${p}`);
  /** 卡脚/悬浮条“回复”钮：滚到快捷回复框并聚焦 */
  const focusReply = (e?: MouseEvent) => {
    e?.preventDefault();
    if (!me) {
      openAuth('login');
      return;
    }
    composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    composerRef.current?.querySelector('textarea')?.focus();
  };
  const op = d && page === 1 ? d.posts.list.find((p) => p.isfirst > 0) : undefined;
  // 下一楼层 = 回帖数（不含楼主） + 2
  const nextFloor = (th?.posts ?? 0) + 2;
  /* 标签样式定义表（light 扩展 idx_tag：名称 → badge 样式） */
  const tagDefs = new Map(light.tags.map((x) => [x.name, x.style]));

  /* 404 页：主题不存在或已删除（后端 NOT_FOUND）→ 整页 404 替代错误行；其余错误原样展示 */
  if (q.isError && q.error instanceof ApiError && q.error.code === Code.NOT_FOUND) return <NotFoundPage />;

  return (
    <>
      <div className="flex flex-col gap-5 lg:flex-row">
        {/* ============ 左侧悬浮工具栏（thread_left_switch：仅 lg+）============ */}
        {th && d && light.threadLeftSwitch && (
          <div className="hidden w-14 shrink-0 lg:block">
            <div className="sticky top-[88px] z-10 flex flex-col items-center gap-3">
              <div className="flex flex-col items-center gap-1.5">
                <button type="button" className={barBtn} title={t('reply_label')} aria-label={t('reply_label')} onClick={() => focusReply()}>
                  <Icon name="chat_bubbles" className="size-[25px]" />
                </button>
                <span className={barBadge}>{th.posts}</span>
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  className={cx(barBtn, d.liked && 'text-brand')}
                  title={d.liked ? t('unlike') : t('like')}
                  aria-label={d.liked ? t('unlike') : t('like')}
                  disabled={like.isPending}
                  onClick={() => onSocial(like)}
                >
                  <Icon name="thumbs_up" className="size-[25px]" />
                </button>
                <span className={barBadge}>{d.likes}</span>
              </div>
              <div className="flex flex-col items-center gap-1.5">
                <button
                  type="button"
                  className={cx(barBtn, d.favorited && 'text-brand')}
                  title={d.favorited ? t('unfavorite') : t('favorite')}
                  aria-label={d.favorited ? t('unfavorite') : t('favorite')}
                  disabled={favorite.isPending}
                  onClick={() => onSocial(favorite)}
                >
                  <Icon name="star" className="size-[25px]" />
                </button>
                <span className={barBadge}>{d.favorites}</span>
              </div>
              {perms?.allowmod && (
                <div className="flex flex-col items-center gap-2">
                  <button type="button" className={barBtnSm} title={th.top > 0 ? t('mod_untop') : t('mod_top')} aria-label={th.top > 0 ? t('mod_untop') : t('mod_top')} onClick={() => { setModVal(th.top); setModErr(''); setModDlg('top'); }}>
                    <Icon name="top" className="size-4" />
                  </button>
                  <button type="button" className={barBtnSm} title={th.digest > 0 ? t('unfeature') : t('mod_digest')} aria-label={th.digest > 0 ? t('unfeature') : t('mod_digest')} onClick={() => { setModVal(th.digest); setModErr(''); setModDlg('digest'); }}>
                    <Icon name="flame" className="size-4" />
                  </button>
                  <button type="button" className={barBtnSm} title={th.closed ? t('mod_reopen') : t('mod_close_reply')} aria-label={th.closed ? t('mod_reopen') : t('mod_close_reply')} disabled={modBusy} onClick={() => void doMod('close', th.closed ? 0 : 1)}>
                    <Icon name="lock" className="size-4" />
                  </button>
                  <button type="button" className={barBtnSm} title={t('mod_move_to')} aria-label={t('mod_move_to')} onClick={() => { setModVal(0); setModErr(''); setModDlg('move'); }}>
                    <Icon name="folder" className="size-4" />
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ============ 主列 ============ */}
        <div className="min-w-0 flex-[3]">
          {th && d && light.threadTopNav && (
            <Breadcrumb
              items={[
                { text: t('home'), to: '/' },
                { text: d.forum.name, to: `/forum/${th.fid}` },
                { text: th.subject, title: th.subject },
              ]}
              right={
                <>
                  <span className="flex items-center gap-1 tabular-nums">
                    <Icon name="eye" className="size-3.5" /> {th.views}
                  </span>
                  <a href="#pid-new" className="flex items-center gap-1 tabular-nums transition-colors hover:text-brand" onClick={focusReply}>
                    <Icon name="comment" className="size-3.5" /> {th.posts}
                  </a>
                  {/* A4 点赞 / A5 收藏（面包屑同位；未登录跳登录页） */}
                  <button
                    type="button"
                    title={d.liked ? t('unlike') : t('like')}
                    aria-label={d.liked ? t('unlike') : t('like')}
                    disabled={like.isPending}
                    className={cx('flex items-center gap-1 tabular-nums transition-colors disabled:opacity-60', d.liked ? 'text-brand' : 'hover:text-brand')}
                    onClick={() => onSocial(like)}
                  >
                    <Icon name="thumbs_up" className="size-3.5" /> {d.likes}
                  </button>
                  <button
                    type="button"
                    title={d.favorited ? t('unfavorite') : t('favorite')}
                    aria-label={d.favorited ? t('unfavorite') : t('favorite')}
                    disabled={favorite.isPending}
                    className={cx('flex items-center gap-1 tabular-nums transition-colors disabled:opacity-60', d.favorited ? 'text-brand' : 'hover:text-brand')}
                    onClick={() => onSocial(favorite)}
                  >
                    <Icon name="star" className="size-3.5" /> {d.favorites}
                  </button>
                  {/* ：点击弹出收藏者列表 */}
                  <button
                    type="button"
                    title={t('favoriters_show')}
                    aria-label={t('favoriters_show')}
                    className="flex items-center gap-1 transition-colors hover:text-brand"
                    onClick={() => setFavUsersOpen(true)}
                  >
                    <Icon name="users" className="size-3.5" />
                  </button>
                </>
              }
            />
          )}

          {socialErr && <p className="mb-2 text-xs text-destructive">{socialErr}</p>}

          {q.isError && <p className="mb-4 text-sm text-destructive">{(q.error as Error).message}</p>}

          {/* 主题审核提示（alert-secondary 三态；see_check 附现场按钮） */}
          {th && th.ok !== 1 && (
            <Alert tone="secondary" icon={th.ok === 0 ? 'coffee' : 'warning_circle'} className="mb-4">
              {th.ok === -2 ? (
                <>
                  {t('thread_deleted_in_recycle')}
                  {perms?.seeCheck && (
                    <>
                      <hr className="my-3 border-zh-line" />
                      <div className="flex flex-wrap gap-2">
                        <button className={alertBtn} disabled={chkBusy} onClick={() => void doRecycle(-1)}>
                          {t('restore')}
                        </button>
                        <button className={alertBtn} disabled={chkBusy} onClick={() => void doRecycle(1)}>
                          {t('purge_delete')}
                        </button>
                      </div>
                    </>
                  )}
                </>
              ) : (
                <>
                  {th.ok === -1 ? t('thread_audit_rejected') : t('thread_audit_pending')}
                  {perms?.seeCheck && (
                    <>
                      <hr className="my-3 border-zh-line" />
                      <div className="flex flex-wrap gap-2">
                        <button className={alertBtn} disabled={chkBusy} onClick={() => void doCheck(1)}>
                          {t('audit_pass')}
                        </button>
                        <button className={alertBtn} disabled={chkBusy} onClick={() => void doCheck(-1)}>
                          {t('audit_reject')}
                        </button>
                        <button className={alertBtn} disabled={chkBusy} onClick={() => void doCheck(-2)}>
                          {t('delete')}
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
              {chkErr && <p className="mt-2 text-xs text-destructive">{chkErr}</p>}
            </Alert>
          )}

          {/* ============ 主贴卡（.card.card-thread）============ */}
          {th && (
            <Card
              className="card-thread"
              bodyClass="p-5"
              header={
                <div className="w-full">
                  <h1 className={cx('break-all', getTitleCls(th))}>
                    {/* 标题购物车图标（content_buy>0 时，已购绿/未购金） */}
                    {th.contentBuy > 0 && (
                      <Icon
                        name="cart"
                        className="mr-1 inline size-5 align-[-2px]"
                        style={{ color: d?.purchased ? 'green' : 'gold' }}
                        title={t('paid_thread')}
                      />
                    )}
                    {th.subject}
                  </h1>
                  <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-lt-grey">
                    <Link to={`/user/${th.uid}`} aria-label={th.username} className="shrink-0">
                      {/* 加V认证徽章（主贴作者头像右下角 V 标，title=头衔） */}
                      <span className="relative inline-block">
                        <Avatar uid={th.uid} avatar={th.avatar} username={th.username} size={1} />
                        <VBadge v={th.uv} size={1} />
                      </span>
                    </Link>
                    <Link className="font-medium text-foreground transition-colors hover:text-brand" to={`/user/${th.uid}`}>
                      {th.username}
                    </Link>
                    <span>·</span>
                    <span>
                      <span className="hidden sm:inline">{t('posted_at')}</span>
                      {fmtDate(op?.createDate ?? th.createDate)}
                    </span>
                    <span className="flex items-center gap-1" title={t('views_label')}>
                      <Icon name="eye" className="size-3.5" /> {th.views}
                    </span>
                    <span className="flex items-center gap-1" title={t('reply_label')}>
                      <Icon name="comment" className="size-3.5" /> {th.posts}
                    </span>
                    <span className="ml-auto flex items-center gap-1">
                      {/* 楼层「查看所有回复」（show_all_reply）：楼主楼层同样有入口，覆盖全部楼层 */}
                      {light.showAllReply && op && (
                        <button className={actCls} title={t('show_all_replies')} onClick={() => setRepliesPid(op.pid)}>
                          <Icon name="comment" className="size-3.5" /> {t('show_all_replies')}
                        </button>
                      )}
                      {op?.allowupdate && (
                        <button className={actCls} disabled={edit.isPending} onClick={startOpEdit}>
                          <Icon name="edit" className="size-3.5" /> {t('edit')}
                        </button>
                      )}
                      {op?.allowdelete && (
                        <button className={delCls} disabled={remove.isPending} onClick={() => void removeOp()}>
                          <Icon name="trash" className="size-3.5" /> {t('delete')}
                        </button>
                      )}
                      {/* 版务工具在 lg+ 走左侧悬浮栏，移动端在本行兜底露出 */}
                      {perms?.allowmod && (
                        <span className="flex items-center gap-1 lg:hidden">
                          <button className={actCls} onClick={() => { setModVal(th.top); setModErr(''); setModDlg('top'); }}>
                            {th.top > 0 ? t('mod_untop') : t('mod_top')}
                          </button>
                          <button className={actCls} onClick={() => { setModVal(th.digest); setModErr(''); setModDlg('digest'); }}>
                            {th.digest > 0 ? t('unfeature') : t('mod_digest')}
                          </button>
                          <button className={actCls} disabled={modBusy} onClick={() => void doMod('close', th.closed ? 0 : 1)}>
                            {th.closed ? t('mod_reopen') : t('mod_close_reply')}
                          </button>
                          <button className={actCls} onClick={() => { setModVal(0); setModErr(''); setModDlg('move'); }}>
                            {t('mod_move_to')}
                          </button>
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              }
              footer={
                <footer className="flex flex-wrap items-center justify-center gap-3 border-t border-zh-line bg-lt-soft px-5 py-3">
                  <button
                    type="button"
                    className={cx('inline-flex h-8 items-center gap-1.5 rounded-[4px] px-3 text-sm transition-colors', d?.liked ? 'text-brand' : 'text-lt-grey hover:text-brand')}
                    disabled={like.isPending}
                    onClick={() => onSocial(like)}
                  >
                    <Icon name="thumbs_up" className="size-4" /> {d?.liked ? t('unlike') : t('like')}
                  </button>
                  <button
                    type="button"
                    className={cx('inline-flex h-8 items-center gap-1.5 rounded-[4px] px-3 text-sm transition-colors', d?.favorited ? 'text-brand' : 'text-lt-grey hover:text-brand')}
                    disabled={favorite.isPending}
                    onClick={() => onSocial(favorite)}
                  >
                    <Icon name="star" className="size-4" /> {d?.favorited ? t('unfavorite') : t('favorite')}
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-8 items-center gap-1.5 rounded-[4px] px-3 text-sm text-lt-grey transition-colors hover:text-brand"
                    onClick={() => focusReply()}
                  >
                    <Icon name="chat_bubbles" className="size-4" /> {t('reply')}
                  </button>
                </footer>
              }
            >
              {op ? (
                opEditing ? (
                  <div>
                    <Composer
                      initialHtml={op.message ?? ''}
                      submitLabel={t('save')}
                      busy={edit.isPending}
                      allowSell={canSell && opSellOn}
                      onSubmit={(c) =>
                        edit
                          .mutateAsync({
                            pid: op.pid,
                            change: { html: c.html, attachAids: c.attachAids },
                            // 收费设置（非 allowsell 组不带此二参，服务端忽略）
                            ...(canSell ? { contentBuy: opSellOn ? Number(opSellNum || 0) : 0, contentBuyType: opSellType } : {}),
                          })
                          .then(() => setOpEditing(false))
                      }
                      onCancel={() => setOpEditing(false)}
                    />
                    {/* 收费设置（首帖 + allowsell 组；「购买 :」+ 是/否，选「是」现数字与币种） */}
                    {canSell && (
                      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                        <span className="text-ink-soft">{t('buy_label')}</span>
                        <label className="flex cursor-pointer items-center gap-1">
                          <input type="radio" name="op-sell" checked={!opSellOn} onChange={() => setOpSellOn(false)} />
                          {t('no')}
                        </label>
                        <label className="flex cursor-pointer items-center gap-1">
                          <input type="radio" name="op-sell" checked={opSellOn} onChange={() => setOpSellOn(true)} />
                          {t('yes')}
                        </label>
                        {opSellOn && (
                          <>
                            <input
                              className="h-[33px] w-[5.5rem] rounded-[4px] border border-[#ced4da] bg-card px-2 text-sm text-foreground outline-none transition-colors placeholder:text-zh-grey focus:border-[#a0cfff] focus:ring-3 focus:ring-[rgba(64,158,255,0.25)]"
                              maxLength={10}
                              placeholder="0"
                              inputMode="numeric"
                              value={opSellNum}
                              onChange={(e) => {
                                let v = e.target.value.replace(/\D/g, '').slice(0, 10);
                                if (Number(v) > 9999999) v = '9999999';
                                setOpSellNum(v);
                              }}
                            />
                            <select
                              className="h-[33px] rounded-[4px] border border-[#ced4da] bg-card px-1.5 text-sm text-foreground outline-none transition-colors focus:border-[#a0cfff] focus:ring-3 focus:ring-[rgba(64,158,255,0.25)]"
                              value={opSellType}
                              onChange={(e) => setOpSellType(Number(e.target.value))}
                            >
                              <option value={1}>{t('credits_experience')}</option>
                              <option value={2}>{t('credits_gold')}</option>
                              <option value={3}>{t('credits_rmb')}</option>
                            </select>
                          </>
                        )}
                      </div>
                    )}
                    {opErr && <p className="mt-2 text-xs text-destructive">{opErr}</p>}
                  </div>
                ) : (
                  <>
                    <article
                      className="post-body break-words text-sm leading-[1.7]"
                      onClick={(e) => {
                        // 付费块内交互由事件委托处理（renderPayHtml 产出纯 HTML）：支付按钮开确认弹层、购买记录走 SPA 路由
                        const target = e.target as HTMLElement;
                        if (target.closest('[data-pay-btn]')) {
                          e.preventDefault();
                          setPayErr('');
                          setPayOpen(true);
                          return;
                        }
                        if (target.closest('a[data-paylist]')) {
                          e.preventDefault();
                          setPaylistPage(1);
                          setPaylistOpen(true);
                        }
                      }}
                      dangerouslySetInnerHTML={{
                        __html: renderPayHtml(op.messageFmt, {
                          contentBuy: th.contentBuy,
                          type: th.contentBuyType,
                          purchased: d.purchased,
                          tid,
                          sitename: setting?.sitename || 'FreeIDX',
                          t,
                        }),
                      }}
                    />
                    {/* 标签行（idx_tag：样式取自 light 扩展定义表，可跳标签筛选） */}
                    {th.tags && (
                      <div className="mt-3 flex flex-wrap items-center gap-1.5">
                        <Icon name="tag" className="size-3.5 text-lt-grey" />
                        {th.tags
                          .split(',')
                          .filter(Boolean)
                          .map((n) => (
                            <TagBadge key={n} name={n} style={tagDefs.get(n) ?? 'primary'} to={`/forum/${th.fid}?tag=${encodeURIComponent(n)}`} />
                          ))}
                      </div>
                    )}
                    <Attaches post={op} />
                  </>
                )
              ) : (
                <p className="text-sm">
                  <Link className="text-zh-deep-link transition-colors hover:text-brand" to={`/thread/${tid}`}>
                    {t('view_thread_message')}
                  </Link>
                </p>
              )}
            </Card>
          )}

          {/* 插入代码 thread_message_after_htm：主贴内容卡之后，每页一次 */}
          <InsertCode html={insertCodes.thread_message_after_htm} />

          {/* ============ 快捷回复卡（#comment_input，位于楼层列表之前）============ */}
          {d && th && (
            <div id="comment_input">
              <Card header={t('quick_reply_label')} bodyClass="p-5">
                {/* 快捷回复上方公告（light.commentAnnouncement） */}
                {light.commentAnnouncement && (
                  <Alert tone="primary" icon="megaphone" className="mb-3 whitespace-pre-line">
                    {light.commentAnnouncement}
                  </Alert>
                )}
                {perms?.allowpost && me ? (
                  <div id="pid-new" ref={composerRef} className="flex items-start gap-2.5">
                    <span className="hidden lg:block">
                      <Avatar uid={me.uid} avatar={me.avatar} username={me.username} size={3} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between text-xs">
                        <Link className="font-medium text-foreground transition-colors hover:text-brand" to="/me">
                          {me.username}
                        </Link>
                        <span className="tabular-nums text-lt-grey">
                          {nextFloor}
                          {t('floor')}
                        </span>
                      </div>
                      {quoted && !advanced && (
                        <blockquote className="relative my-2 border-l-[5px] border-brand bg-zh-quote p-3 pr-9 text-xs leading-5 text-ink-soft">
                          <button
                            className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center text-zh-grey transition-colors hover:text-brand"
                            aria-label={t('cancel_quote_aria')}
                            onClick={() => setQuoted(null)}
                          >
                            <Icon name="close" className="size-3.5" />
                          </button>
                          {t('reply')} <span className="font-medium">#{quoted.pid}</span> {quoted.username}
                          {t('full_colon')}
                          {quoted.snippet}
                        </blockquote>
                      )}
                      {advanced ? (
                        <div className="mt-2">
                          <Composer
                            turnstile
                            quoted={quoted}
                            placeholder={t('content_placeholder')}
                            submitLabel={t('reply_btn')}
                            busy={reply.isPending}
                            onCancel={() => setAdvanced(false)}
                            onSubmit={(c) => reply.mutateAsync({ ...c, quotepid: quoted?.pid ?? 0 })}
                          />
                        </div>
                      ) : (
                        <div className="mt-2">
                          {/* 快速回复下拉（直出在回复框上方，选中即填入并提交） */}
                          {quickReplyMsg.data?.enabled && quickReplyMsg.data.options.length > 0 && (
                            <select
                              id="quick_reply_message"
                              aria-label={t('quick_reply_label')}
                              className="mb-2 h-10 w-full rounded-[4px] border border-[#ced4da] bg-card px-2 text-sm text-foreground outline-none transition-colors focus:border-[#a0cfff] focus:ring-3 focus:ring-[rgba(64,158,255,0.25)]"
                              value={quickSel}
                              onChange={(e) => void onQuickReplyPick(Number(e.target.value))}
                            >
                              <option value={0}>{quickReplyMsg.data.options[0] || t('quick_reply_label')}</option>
                              {quickReplyMsg.data.options.slice(1).map((opt, i) => (
                                <option key={`${i + 1}-${opt}`} value={i + 1}>
                                  {opt}
                                </option>
                              ))}
                            </select>
                          )}
                          {/* 快捷回复输入（min-h 5rem 圆角 4px，聚焦蓝环） */}
                          <textarea
                            id="quick_reply_text"
                            className="min-h-[5rem] w-full resize-none rounded-[4px] border border-[#ced4da] bg-card px-3 py-2 text-sm leading-6 text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-zh-grey focus:border-[#a0cfff] focus:ring-3 focus:ring-[rgba(64,158,255,0.25)]"
                            placeholder={t('join_reply_placeholder')}
                            value={quick}
                            onChange={(e) => setQuick(e.target.value)}
                          />
                          <Turnstile key={quickNonce} onToken={setQuickTs} />
                          {quickErr && <p className="mt-1 text-xs text-destructive">{quickErr}</p>}
                          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                            <button
                              type="button"
                              disabled={reply.isPending}
                              onClick={() => void submitQuick()}
                              className="inline-flex h-[38px] select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-[6px] bg-brand px-5 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:pointer-events-none disabled:opacity-50"
                            >
                              {reply.isPending && <Icon name="refresh" className="size-3.5 animate-spin" />}
                              {reply.isPending ? t('submitting') : t('reply_btn')}
                            </button>
                            <button className="text-sm text-lt-grey transition-colors hover:text-brand" onClick={() => setAdvanced(true)}>
                              <Icon name="forward" className="mr-0.5 inline size-3.5" /> {t('advanced_reply')}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ) : th.closed > 0 ? (
                  <textarea className={inputReadOnlyCls} value={t('thread_closed_notice')} readOnly />
                ) : (
                  <div className="text-xs">
                    {me ? (
                      <span className="text-lt-grey">{t('no_reply_permission')}</span>
                    ) : (
                      <button type="button" className="text-zh-deep-link transition-colors hover:text-brand" onClick={() => openAuth('login')}>
                        {t('login_to_reply')}
                      </button>
                    )}
                  </div>
                )}
              </Card>
            </div>
          )}

          {/* ============ 上一篇/下一篇（thread_postlist_before 位，light.preNextThread 开启时）============ */}
          {light.preNextThread && d && <PrevNextCards prev={d.prev ?? null} next={d.next ?? null} />}

          {/* ============ 热门回复（thread_postlist_before 位，仅第 1 页）============ */}
          {light.hotLikePost && page === 1 && hotPosts.data && hotPosts.data.list.length > 0 && (
            <Card
              bodyClass="p-0"
              header={
                <span className="flex items-center gap-2 text-sm font-medium">
                  <Icon name="flame" className="size-4" style={{ color: 'var(--danger)' }} />
                  {t('hot_replies')}
                </span>
              }
            >
              <ul className="m-0 list-none">
                {hotPosts.data.list.map((p) => (
                  <PostCard key={`hot-${p.pid}`} post={p} floor={0} onLike={onLikePost} likeBusy={postLike.isPending} onQuickAt={light.threadQuickAt ? onQuickAt : undefined} />
                ))}
              </ul>
            </Card>
          )}

          {/* ============ 楼层列表卡（.card.card-postlist#comments，可折叠）============ */}
          {d && th && (
            <Card
              className="card-postlist"
              bodyClass="p-0"
              ariaLabel={t('reply_count_header', { count: th.posts })}
              header={
                <button type="button" className="flex items-center gap-2" onClick={() => setCollapsed((c) => !c)} aria-expanded={!collapsed}>
                  <Icon name="comment" className="size-4 text-brand" />
                  <b>{t('reply_count_header', { count: th.posts })}</b>
                  <Icon name={collapsed ? 'chevron_down' : 'chevron_up'} className="size-4 text-lt-grey" />
                </button>
              }
            >
              {!collapsed && (
                <ul className="m-0 list-none">
                  {d.posts.list.map((p, i) =>
                    p === op ? null : (
                      <PostCard
                        key={p.pid}
                        post={p}
                        floor={(d.posts.page - 1) * PageSize.POST_PAGE + i + 1}
                        canReply={perms?.allowpost}
                        seeCheck={perms?.seeCheck}
                        onReply={onReplyClick}
                        onUpdate={(pid, change) => edit.mutateAsync({ pid, change })}
                        onDelete={(post) => remove.mutateAsync(post)}
                        onAudit={auditPost}
                        onShowReplies={light.showAllReply ? (pid) => setRepliesPid(pid) : undefined}
                        onLike={onLikePost}
                        likeBusy={postLike.isPending}
                        onQuickAt={light.threadQuickAt ? onQuickAt : undefined}
                      />
                    ),
                  )}
                  {d.posts.list.length === 0 && <li className="px-5 py-6 text-center text-sm text-lt-grey">{t('no_reply')}</li>}
                </ul>
              )}
            </Card>
          )}

          {d && <Pagination className="my-4" page={d.posts.page} totalPage={d.posts.totalPage} href={href} />}

          <div className="mx-auto lg:w-1/2">
            <Button variant="secondary" block onClick={() => navigate(-1)}>
              {t('back')}
            </Button>
          </div>
        </div>

        {/* ============ 右栏作者卡（仅 lg+）============ */}
        <aside className="hidden w-[260px] shrink-0 self-start lg:sticky lg:top-4 lg:z-10 lg:block">
          {th && (
            <>
              <section className="zh-card mb-4 overflow-hidden">
                {/* .index-siteInfo-bg：80px 背景图（bg-0.webp，cover/center） */}
                <div className="h-[80px] w-full bg-[url(/theme-light/bg-0.webp)] bg-cover bg-center" />
                <div className="relative -mt-[25px] px-4 pb-4 text-center">
                  <div className="flex flex-col items-center">
                    <Link to={`/user/${th.uid}`} aria-label={th.username}>
                      <Avatar uid={th.uid} avatar={th.avatar} username={th.username} dim="64px" className="border-[3px] border-white bg-card" />
                    </Link>
                    <Link to={`/user/${th.uid}`} className="mt-2 max-w-full truncate text-sm font-bold text-foreground hover:text-brand">
                      {th.username}
                    </Link>
                    <div className="mt-1.5 flex flex-wrap items-center justify-center gap-1">
                      <span className="inline-flex rounded-[3px] bg-brand px-1.5 py-0.5 text-[11px] leading-none text-white">
                        {t('uid')}:{th.uid}
                      </span>
                      {au?.groupName && (
                        <span className="inline-flex rounded-[3px] bg-[#00b8d8] px-1.5 py-0.5 text-[11px] leading-none text-white">
                          {gn(au.gid, au.groupName)}
                        </span>
                      )}
                    </div>
                    {/* A6 在线态（bbs_session 15min 窗口，服务端下发） */}
                    {au?.online && (
                      <span className="mt-1.5 inline-flex items-center gap-1 text-[10px] text-[#00b96b]">
                        <span className="size-1.5 rounded-full bg-[#00b96b]" />
                        {t('online_now')}
                      </span>
                    )}
                  </div>
                  <div className="mt-3 grid grid-cols-3 gap-2 border-t border-zh-line pt-3">
                    {(
                      [
                        [t('threads'), au?.threads ?? 0],
                        [t('posts'), au?.posts ?? 0],
                        [t('create_rank'), th.uid],
                      ] as const
                    ).map(([label, value]) => (
                      <div key={label} className="text-center">
                        <div className="text-xs text-lt-grey">{label}</div>
                        <b className="tabular-nums text-foreground">{value}</b>
                      </div>
                    ))}
                  </div>
                  {/* （作者卡统计下方） */}
                  <div className="mt-3">
                    <PmButton uid={th.uid} username={th.username} block />
                  </div>
                </div>
              </section>
              {/* 插入代码 thread_user_after_htm：侧栏「关于盘主」卡之后 */}
              <InsertCode html={insertCodes.thread_user_after_htm} />
            </>
          )}
        </aside>
      </div>

      {/* ============ 移动端贴内悬浮条（.thread-nav，仅 <lg）============ */}
      {th && d && (
        <div className="fixed inset-x-0 bottom-[55px] z-[999] flex h-[45px] items-center gap-3 border-t border-zh-line bg-card px-3 lg:hidden">
          <button
            type="button"
            className="thread-nav-input min-w-0 flex-1 truncate text-left text-sm text-lt-grey"
            onClick={() => focusReply()}
          >
            {t('join_reply_placeholder')}
          </button>
          <button type="button" className={cx('shrink-0 transition-colors', 'text-lt-grey hover:text-brand')} aria-label={t('reply_label')} onClick={() => focusReply()}>
            <Icon name="reply" className="size-[22px]" />
          </button>
          <button
            type="button"
            className={cx('shrink-0 transition-colors disabled:opacity-60', d.favorited ? 'text-brand' : 'text-lt-grey hover:text-brand')}
            aria-label={d.favorited ? t('unfavorite') : t('favorite')}
            disabled={favorite.isPending}
            onClick={() => onSocial(favorite)}
          >
            <Icon name="star" className="size-[22px]" />
          </button>
          <button
            type="button"
            className={cx('shrink-0 transition-colors disabled:opacity-60', d.liked ? 'text-brand' : 'text-lt-grey hover:text-brand')}
            aria-label={d.liked ? t('unlike') : t('like')}
            disabled={like.isPending}
            onClick={() => onSocial(like)}
          >
            <Icon name="thumbs_up" className="size-[22px]" />
          </button>
        </div>
      )}

      {th && modDlg && (
        <Modal
          title={modDlg === 'top' ? t('top_manage') : modDlg === 'digest' ? t('digest_manage') : t('move_thread_dlg')}
          onClose={() => setModDlg(null)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setModDlg(null)}>
                {t('cancel_label')}
              </Button>
              <Button
                size="sm"
                loading={modBusy}
                disabled={modDlg === 'move' && !modVal}
                onClick={() => void doMod(modDlg === 'move' ? 'move' : modDlg, modVal)}
              >
                {t('confirm')}
              </Button>
            </div>
          }
        >
          {modDlg === 'move' ? (
            <select
              className="h-[38px] w-full rounded-[4px] border border-[#ced4da] bg-card px-3 text-sm outline-none focus:border-[#a0cfff]"
              value={modVal}
              onChange={(e) => setModVal(Number(e.target.value))}
              aria-label={t('target_forum')}
            >
              <option value={0}>{t('select_target_forum_dots')}</option>
              {forumlist
                .filter((f) => f.fid !== th.fid)
                .map((f) => (
                  <option key={f.fid} value={f.fid}>
                    {f.name}
                  </option>
                ))}
            </select>
          ) : (
            <div className="space-y-2.5">
              {(modDlg === 'top'
                ? ([
                    [0, t('untop_label')],
                    [1, t('top_level_1')],
                    [2, t('top_level_2')],
                    [3, t('top_level_3')],
                  ] as const)
                : ([
                    [0, t('unfeature')],
                    [1, t('digest_level_1')],
                    [2, t('digest_level_2')],
                    [3, t('digest_level_3')],
                  ] as const)
              ).map(([v, label]) => (
                <label key={v} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="mod-level"
                    className="accent-brand"
                    checked={modVal === v}
                    onChange={() => setModVal(v)}
                  />
                  {label}
                </label>
              ))}
            </div>
          )}
          {modErr && <p className="mt-3 text-xs text-destructive">{modErr}</p>}
        </Modal>
      )}

      {/* 购买确认弹层（标题「购买」+ 主题名/作者/橙字价格） */}
      {th && payOpen && (
        <Modal
          title={t('buy_title')}
          onClose={() => setPayOpen(false)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setPayOpen(false)}>
                {t('cancel_label')}
              </Button>
              <Button size="sm" loading={payBusy} loadingText={t('submitting_dots')} onClick={() => void doPay()}>
                {t('confirm')}
              </Button>
            </div>
          }
        >
          <div className="space-y-2 text-center">
            <h4 className="text-lg font-semibold text-[#2997f7]">{th.subject}</h4>
            <div className="flex items-center justify-center gap-2">
              <Avatar uid={th.uid} avatar={th.avatar} username={th.username} dim="60px" radius="lg" />
              <span>{th.username}</span>
            </div>
            <div className="flex items-center justify-center gap-1 text-[#e6a23c]">
              <Icon name={th.contentBuyType === 1 ? 'flask' : th.contentBuyType === 2 ? 'coins' : 'banknote'} className="size-4" />
              {th.contentBuyType === 1 ? t('credits_experience') : th.contentBuyType === 2 ? t('credits_gold') : t('credits_rmb')}{' '}
              {th.contentBuyType === 3 ? th.contentBuy / 100 : th.contentBuy}
            </div>
          </div>
          {payErr && <p className="mt-3 text-center text-xs text-destructive">{payErr}</p>}
        </Modal>
      )}

      {/* 购买记录弹层（主题信息 + 时间|买家清单 + 弹层内翻页） */}
      {th && paylistOpen && (
        <Modal title={t('buy_record')} onClose={() => setPaylistOpen(false)} width="max-w-[560px]">
          {paylist.isLoading && <p className="py-4 text-center text-sm text-lt-grey">{t('loading')}</p>}
          {paylist.isError && <p className="py-4 text-center text-sm text-destructive">{(paylist.error as Error).message}</p>}
          {paylist.data && (
            <>
              <div className="mb-3 flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-ink-soft">{paylist.data.thread.subject}</span>
                <span className="shrink-0 text-lt-grey">
                  {t('quantity')} {paylist.data.count} · {t('amount_label')} {paylistAmount(t, paylist.data)}
                </span>
              </div>
              <div className="max-h-[55vh] overflow-y-auto">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-lt-soft text-xs text-lt-grey">
                      <th className="w-[45%] px-3 py-2 text-left font-medium">{t('time_label')}</th>
                      <th className="w-[55%] px-3 py-2 text-left font-medium">{t('user_label')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paylist.data.list.map((r) => (
                      <tr key={r.uid} className={cx('border-b border-zh-line last:border-b-0', me?.uid === r.uid && 'font-bold')}>
                        <td className="whitespace-nowrap px-3 py-2.5">{fmtPayTime(r.paytime)}</td>
                        <td className="px-3 py-2.5">
                          <Link
                            to={`/user/${r.uid}`}
                            className="inline-flex items-center gap-1.5"
                            aria-label={r.username}
                            onClick={() => setPaylistOpen(false)}
                          >
                            <Avatar uid={r.uid} avatar={r.avatar} username={r.username} size={1} />
                            <span className="transition-colors hover:text-brand">{r.username}</span>
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {paylist.data.list.length === 0 && <p className="py-10 text-center text-sm text-lt-grey">{t('no_purchase_records')}</p>}
              </div>
              {paylist.data.totalPage > 1 && (
                <div className="mt-4 flex items-center justify-center gap-3 text-sm">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={paylistPage <= 1}
                    onClick={() => setPaylistPage((p) => Math.max(1, p - 1))}
                  >
                    {t('last_page')}
                  </Button>
                  <span className="text-lt-grey">
                    {paylistPage} / {paylist.data.totalPage}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={paylistPage >= paylist.data.totalPage}
                    onClick={() => setPaylistPage((p) => Math.min(paylist.data!.totalPage, p + 1))}
                  >
                    {t('next_page')}
                  </Button>
                </div>
              )}
            </>
          )}
        </Modal>
      )}

      {/* 收藏用户弹层（头像 + 用户名列表，≤50 人） */}
      {favUsersOpen && (
        <Modal title={t('favoriters_title')} onClose={() => setFavUsersOpen(false)}>
          {favUsers.isLoading && <p className="py-4 text-center text-sm text-lt-grey">{t('loading')}</p>}
          {favUsers.isError && <p className="py-4 text-center text-sm text-destructive">{(favUsers.error as Error).message}</p>}
          {favUsers.data &&
            (favUsers.data.list.length ? (
              <ul className="max-h-[60vh] list-none space-y-3 overflow-y-auto p-0">
                {favUsers.data.list.map((u) => (
                  <li key={u.uid} className="flex items-center gap-2">
                    <Link to={`/user/${u.uid}`} aria-label={u.username} onClick={() => setFavUsersOpen(false)}>
                      <Avatar uid={u.uid} avatar={u.avatar} username={u.username} size={1} />
                    </Link>
                    <Link to={`/user/${u.uid}`} className="truncate text-sm text-zh-deep-link transition-colors hover:text-brand" onClick={() => setFavUsersOpen(false)}>
                      {u.username}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-4 text-center text-sm text-lt-grey">{t('no_favoriters')}</p>
            ))}
        </Modal>
      )}

      {/* 楼层「查看所有回复」弹层（show_all_reply：head #楼主 + 直接回复列表，空态提示） */}
      {repliesPid !== null && (
        <Modal title={t('show_all_replies')} onClose={() => setRepliesPid(null)}>
          {replies.isLoading && <p className="py-4 text-center text-sm text-lt-grey">{t('loading')}</p>}
          {replies.isError && <p className="py-4 text-center text-sm text-destructive">{(replies.error as Error).message}</p>}
          {replies.data && (
            <div className="max-h-[60vh] overflow-y-auto">
              {/* head：该楼层本身（#楼主） */}
              <div className="flex items-start gap-2.5 border-b border-zh-line pb-3">
                <Link to={`/user/${replies.data.head.uid}`} aria-label={replies.data.head.username} onClick={() => setRepliesPid(null)} className="shrink-0">
                  {replies.data.head.avatar_auto ? (
                    <img src={replies.data.head.avatar_auto} alt={replies.data.head.username} className="size-10 rounded-full object-cover" />
                  ) : (
                    <Avatar uid={replies.data.head.uid} avatar={replies.data.head.avatar} username={replies.data.head.username} size={3} />
                  )}
                </Link>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2 text-xs text-lt-grey">
                    <Link
                      to={`/user/${replies.data.head.uid}`}
                      className="font-bold text-lt-grey transition-colors hover:text-brand"
                      onClick={() => setRepliesPid(null)}
                    >
                      {replies.data.head.username}
                    </Link>
                    <span>
                      {fmtDate(replies.data.head.createDate)} · {t('landlord_label')}
                    </span>
                  </div>
                  <div className="post-body mt-1 break-words text-sm leading-[1.7]" dangerouslySetInnerHTML={{ __html: replies.data.head.messageFmt }} />
                </div>
              </div>
              {replies.data.list.length ? (
                <ul className="m-0 list-none p-0">
                  {replies.data.list.map((x) => (
                    <li key={x.pid} className="mt-3 flex items-start gap-2.5 border-b border-zh-line pb-3 last:border-b-0">
                      <Link to={`/user/${x.uid}`} aria-label={x.username} onClick={() => setRepliesPid(null)} className="shrink-0">
                        {x.avatar_auto ? (
                          <img src={x.avatar_auto} alt={x.username} className="size-10 rounded-full object-cover" />
                        ) : (
                          <Avatar uid={x.uid} avatar={x.avatar} username={x.username} size={3} />
                        )}
                      </Link>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2 text-xs text-lt-grey">
                          <span className="flex min-w-0 items-center gap-1">
                            <Link
                              to={`/user/${x.uid}`}
                              className="truncate font-bold text-lt-grey transition-colors hover:text-brand"
                              onClick={() => setRepliesPid(null)}
                            >
                              {x.username}
                            </Link>
                            <Icon name="reply" className="size-3 shrink-0" />
                            <span className="truncate">{replies.data.head.username}</span>
                          </span>
                          <span className="shrink-0">{fmtDate(x.createDate)}</span>
                        </div>
                        <div className="post-body mt-1 break-words text-sm leading-[1.7]" dangerouslySetInnerHTML={{ __html: x.messageFmt }} />
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="py-6 text-center text-sm text-lt-grey">{t('no_other_replies')}</p>
              )}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

const inputReadOnlyCls =
  'min-h-[2.4rem] w-full resize-none rounded-[4px] border border-zh-line bg-zh-row-hover px-3 py-2 text-sm leading-6 text-lt-grey';