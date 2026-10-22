import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  apiGet,
  applyPresetAvatar,
  applyV,
  changePassword,
  deleteNotice,
  deleteNotices,
  exchangeCredits,
  fetchMyFavorites,
  fetchMyFollowingStream,
  fetchMyLikes,
  fetchMyNotices,
  fmtDate,
  getMyCreditRecord,
  getMyCredits,
  getMyPoints,
  getMyPurchased,
  getMyV,
  getRankList,
  readAllNotices,
  readNotice,
  saveBackground,
  transferCredits,
  uploadAttachment,
  uploadAvatar,
  type FollowStreamItem,
} from '../../../lib/api';
import { apiErrorMessage } from '../../../lib/errors';
import { posInt } from '../../../lib/params';
import { fileToPngDataUrlResize } from '../../../lib/image';
import { md5Hex } from '@freeidx/shared';
import { Avatar } from '../../../components/Avatar';
import { Icon } from '../../../components/icons';
import { FollowUserList } from '../../../components/FollowUserList';
import { Pagination } from '../../../components/Pagination';
import { ThreadList } from '../../../components/ThreadList';
import { UserReplyList } from '../../../components/UserReplyList';
import { useCursorThreads } from '../../../hooks/useCursorThreads';
import { Button, Card, CardTabs, IconInput, UserCountTile, UserInfoRow, UserSideItem, cx, inputCls } from '../../../components/ui';
import { useAuth } from '../../../store/auth';
import { useAuthModal } from '../../../store/authModal';
import { useLight, userBgImage } from '../../../store/theme';
import { useT, useGroupName } from '../../../lib/i18n';
import type { UserProfile } from './UserPage';

type Tab = 'info' | 'password' | 'avatar' | 'background';
type Section = 'profile' | 'threads' | 'replies' | 'favorites' | 'likes' | 'follow' | 'notices' | 'ranklist' | 'purchased' | 'credits' | 'points' | 'trade' | 'record' | 'vapply';

/** 预设头像清单（0..56 共 57 张，与后端白名单 /avatars/0..56.png 一致） */
const AVATAR_PRESETS = Array.from({ length: 57 }, (_v, i) => `/avatars/${i}.png`);

/** 移动端横向菜单按钮（<lg；财富管理合并积分/交易/记录） */
const MOBILE_NAV: { to: string; key: 'profile_short' | 'post' | 'my_replies' | 'credits_label' | 'ranking_short' | 'favorites_short' | 'messages_short' | 'verify_short' | 'my_follow' | 'my_likes'; match: (s: Section) => boolean }[] = [
  { to: '/me', key: 'profile_short', match: (s) => s === 'profile' },
  { to: '/me?s=threads', key: 'post', match: (s) => s === 'threads' },
  { to: '/me?s=replies', key: 'my_replies', match: (s) => s === 'replies' },
  { to: '/me?s=credits', key: 'credits_label', match: (s) => s === 'credits' || s === 'points' || s === 'trade' || s === 'record' },
  { to: '/me?s=ranklist', key: 'ranking_short', match: (s) => s === 'ranklist' },
  { to: '/me?s=favorites', key: 'favorites_short', match: (s) => s === 'favorites' },
  { to: '/me?s=likes', key: 'my_likes', match: (s) => s === 'likes' },
  { to: '/me?s=follow', key: 'my_follow', match: (s) => s === 'follow' },
  { to: '/me?s=notices', key: 'messages_short', match: (s) => s === 'notices' },
  { to: '/me?s=vapply', key: 'verify_short', match: (s) => s === 'vapply' },
];

/** 个人中心（§4.6）：左栏资料卡（个人资料/我的帖子/排行榜单/我的收藏/我的消息）+ 右卡 tabs（基本资料/密码/头像）；<lg 左栏收起为顶部按钮。头像上传保留 canvas 128px 裁切 */
export function MePage() {
  const t = useT();
  const gn = useGroupName();
  const [search] = useSearchParams();
  const s = search.get('s');
  const section: Section =
    s === 'threads'
      ? 'threads'
      : s === 'replies'
        ? 'replies'
        : s === 'favorites'
        ? 'favorites'
        : s === 'likes'
          ? 'likes'
          : s === 'follow'
            ? 'follow'
            : s === 'notices'
              ? 'notices'
              : s === 'ranklist'
                ? 'ranklist'
                : s === 'purchased'
                  ? 'purchased'
                  : s === 'credits'
                    ? 'credits'
                    : s === 'points'
                      ? 'points'
                      : s === 'trade'
                      ? 'trade'
                      : s === 'record'
                        ? 'record'
                        : s === 'vapply'
                          ? 'vapply'
                          : 'profile';
  const [tab, setTab] = useState<Tab>('info');

  const me = useAuth((s) => s.me);
  const loaded = useAuth((s) => s.loaded);
  const openAuth = useAuthModal((s) => s.openAuth);
  const grouplist = useAuth((s) => s.grouplist);
  const refresh = useAuth((s) => s.refresh);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [okMsg, setOkMsg] = useState('');
  const [fileName, setFileName] = useState('');
  /* 预设头像提交态（须与上方 hook 同层声明：早退分支之后不得再声明 hook，否则硬加载 bootstrap 未就绪时触发 React #310） */
  const [presetBusy, setPresetBusy] = useState(false);
  /* 主页背景：选中编号 + 提交态（hook 须在 me 早退分支之前声明） */
  const light = useLight();
  const [selBg, setSelBg] = useState(0);
  const [bgBusy, setBgBusy] = useState(false);
  const [bgErr, setBgErr] = useState('');
  const [bgOk, setBgOk] = useState('');
  useEffect(() => {
    setSelBg(Number(me?.bgimg ?? 0) || 0);
  }, [me?.bgimg]);

  const profile = useQuery({
    queryKey: ['user', me?.uid ?? 0],
    queryFn: () => apiGet<UserProfile>(`/api/users/${me!.uid}`),
    enabled: Boolean(me),
  });
  const threads = useCursorThreads(`/api/users/${me?.uid ?? 0}/threads`, section === 'threads' && Boolean(me));
  /** 私域资料（GET /api/me）：bootstrap 的 me 只带公开列，邮箱须走本接口 */
  const priv = useQuery({ queryKey: ['me'], queryFn: () => apiGet<{ email?: string }>('/api/me'), enabled: Boolean(me) });
  /* A5 我的收藏：游标翻页（bbs_favorite.rowid 倒序） */
  const favorites = useInfiniteQuery({
    queryKey: ['my-favorites'],
    queryFn: ({ pageParam }) => fetchMyFavorites(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: section === 'favorites' && Boolean(me),
  });
  /* 我赞过的主题（bbs_like.rowid 倒序） */
  const likes = useInfiniteQuery({
    queryKey: ['my-likes'],
    queryFn: ({ pageParam }) => fetchMyLikes(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: section === 'likes' && Boolean(me),
  });
  /* A2 改密：入参前端预哈希 md5(明文)（§8.4，与登录/注册一致） */
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [newPw2, setNewPw2] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwErr, setPwErr] = useState('');
  const [pwOk, setPwOk] = useState('');

  const submitPassword = async () => {
    setPwErr('');
    setPwOk('');
    if (!oldPw || !newPw || !newPw2) {
      setPwErr(t('fill_complete'));
      return;
    }
    if (newPw !== newPw2) {
      setPwErr(t('new_password_mismatch'));
      return;
    }
    setPwBusy(true);
    try {
      await changePassword({ oldPassword: md5Hex(oldPw), newPassword: md5Hex(newPw) });
      setPwOk(t('password_changed'));
      setOldPw('');
      setNewPw('');
      setNewPw2('');
      // 改密 = 服务端全端登出（tv+1 废 JWT + 删该用户全部 session）：本地登录态必须同步刷新
      // 为游客，否则界面仍显示已登录、后续请求逐一 NOT_LOGIN。刷新后本页回落到「请先登录」
      // 引导（下方 me 早退分支），用户以新密码重新登录即闭环。
      await refresh();
    } catch (e) {
      setPwErr(apiErrorMessage(e, t('modify_failed')));
    } finally {
      setPwBusy(false);
    }
  };

  // bootstrap 未完成前 me 必为 null，先等加载，避免首帧闪「请先登录」
  if (!loaded) return null;
  if (!me) {
    return (
      <Card header={t('my_home')}>
        <p className="text-sm text-muted-foreground">
          {t('please_login_first')}
          <button
            type="button"
            className="ml-1 text-foreground underline underline-offset-2 transition-opacity hover:opacity-75"
            onClick={() => openAuth('login')}
          >
            {t('go_to_login')}
          </button>
        </p>
      </Card>
    );
  }

  const meGroup = grouplist.find((g) => g.gid === me.gid);
  const groupName = meGroup ? gn(meGroup.gid, meGroup.name) : t('group_hash', { gid: me.gid });

  const onPickAvatar = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setErr('');
    setOkMsg('');
    try {
      const dataUrl = await fileToPngDataUrlResize(file, 128);
      await uploadAvatar(dataUrl);
      await refresh(); // me.avatar 由 bootstrap 回填，Avatar 组件据此刷新预览
      setOkMsg(t('avatar_updated'));
    } catch (ex) {
      setErr(apiErrorMessage(ex, t('avatar_upload_failed')));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  /** 预设头像选中：点击选中即 POST；再点当前已选项 → imgsrc 空串取消恢复默认 */
  const onPickPreset = async (src: string) => {
    const cancel = me.avatar_auto === src;
    setPresetBusy(true);
    setErr('');
    setOkMsg('');
    try {
      await applyPresetAvatar(cancel ? '' : src);
      await refresh(); // me.avatar / me.avatar_auto 由 bootstrap 回填，预览随之刷新
      setOkMsg(cancel ? t('preset_avatar_cancelled') : t('preset_avatar_updated'));
    } catch (ex) {
      setErr(apiErrorMessage(ex, t('preset_avatar_set_failed')));
    } finally {
      setPresetBusy(false);
    }
  };

  /** 主页背景保存：仅接受 0..light.userBgNum（服务端按配置白名单二次校验） */
  const onSaveBg = async () => {
    setBgBusy(true);
    setBgErr('');
    setBgOk('');
    try {
      await saveBackground(String(selBg));
      await refresh(); // me.bgimg 由 bootstrap 回填，个人卡背景随之刷新
      setBgOk(t('bg_saved'));
    } catch (ex) {
      setBgErr(apiErrorMessage(ex, t('bg_save_failed')));
    } finally {
      setBgBusy(false);
    }
  };

  /** 主页背景：user_bg_switch 开启且已选非默认背景时生效 */
  const bgImage = userBgImage(me.bgimg, light);

  return (
    <div className="my-[10px]">
      {/* 移动端：渐变资料头卡 + 横向滚动菜单（<lg） */}
      <div
        className="mb-4 overflow-hidden rounded-[5px] bg-[url(/theme-light/bg-0.webp)] bg-cover bg-center lg:hidden"
        style={bgImage ? { backgroundImage: bgImage } : undefined}
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-4">
          <div className="min-w-0">
            <div className="truncate text-lg font-bold text-foreground">{me.username}</div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex rounded-full bg-brand px-2 py-0.5 text-[11px] leading-none text-white">UID:{me.uid}</span>
              {groupName && (
                <span className="inline-flex rounded-full bg-info px-2 py-0.5 text-[11px] leading-none text-white">{groupName}</span>
              )}
            </div>
          </div>
          {me.avatar_auto ? (
            <img src={me.avatar_auto} alt={me.username} className="size-[3.75rem] shrink-0 rounded-full border-[3px] border-white object-cover" />
          ) : (
            <Avatar uid={me.uid} avatar={me.avatar} username={me.username} dim="3.75rem" className="shrink-0 border-[3px] border-white" />
          )}
        </div>
        <div className="my-mobile-nav-btn-group flex gap-2 overflow-x-auto px-4 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {MOBILE_NAV.map((it) => (
            <Link
              key={it.to}
              to={it.to}
              className={cx(
                'shrink-0 whitespace-nowrap rounded-[20px] border px-3 py-1 text-sm transition-colors',
                it.match(section) ? 'border-brand bg-brand text-white' : 'border-zh-line bg-card text-foreground hover:text-brand',
              )}
            >
              {t(it.key)}
            </Link>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* 桌面左栏（4/12 栅格）：资料卡（头像/用户名/组徽章 + 菜单） */}
        <aside className="hidden lg:block lg:w-1/3 lg:shrink-0">
          <div className="zh-card overflow-hidden">
            {/* 个人卡头部：用户选定预设背景时以其为底（桌面卡头 bg-image） */}
            <div
              className="flex flex-col items-center px-4 py-5 text-center"
              style={bgImage ? { backgroundImage: bgImage } : undefined}
            >
              {me.avatar_auto ? (
                <img src={me.avatar_auto} alt={me.username} className="size-[10rem] rounded-[1rem] border-[3px] border-card object-cover" />
              ) : (
                <Avatar
                  uid={me.uid}
                  avatar={me.avatar}
                  username={me.username}
                  dim="10rem"
                  radius="lg"
                  className="rounded-[1rem]! border-[3px] border-card"
                />
              )}
              <div className="mt-3 max-w-full truncate text-base font-bold text-foreground">{me.username}</div>
              {groupName && (
                <span className="mt-2 inline-flex rounded-full bg-brand px-2 py-0.5 text-[11px] leading-none text-white">{groupName}</span>
              )}
            </div>
            <div className="border-t border-zh-line px-2 py-1.5">
              <UserSideItem to="/me" label={t('personal_profile')} active={section === 'profile'} icon="user" />
              <UserSideItem to="/me?s=threads" label={t('my_posts')} active={section === 'threads'} icon="edit" />
              <UserSideItem to="/me?s=replies" label={t('my_replies')} active={section === 'replies'} icon="message" />
              {/* 已购 + 财富管理（插在“我的帖子”之后） */}
              <UserSideItem to="/me?s=purchased" label={t('purchased_label')} active={section === 'purchased'} icon="cart" />
              <UserSideItem
                to="/me?s=credits"
                label={t('wealth_management')}
                active={section === 'credits' || section === 'trade' || section === 'record'}
                icon="wallet"
              />
              {/* 排行榜单（插在“我的帖子”之后） */}
              <UserSideItem to="/me?s=ranklist" label={t('ranking_list')} active={section === 'ranklist'} icon="trending_up" />
              <UserSideItem to="/me?s=favorites" label={t('my_favorites')} active={section === 'favorites'} icon="star" />
              {/* 我赞过的 + 我的关注 */}
              <UserSideItem to="/me?s=likes" label={t('my_likes')} active={section === 'likes'} icon="thumbs_up" />
              <UserSideItem to="/me?s=follow" label={t('my_follow')} active={section === 'follow'} icon="users" />
              {/* 我的消息（侧栏入口） */}
              <UserSideItem to="/me?s=notices" label={t('my_messages')} active={section === 'notices'} icon="bell" />
              {/* 加V认证（侧栏入口「认证服务」） */}
              <UserSideItem to="/me?s=vapply" label={t('v_verify_label')} active={section === 'vapply'} icon="shield" />
            </div>
          </div>
        </aside>

        {/* 桌面右栏（8/12 栅格）：主卡（卡头 tabs + 卡体） */}
        <div className="min-w-0 flex-1">
        {section === 'profile' ? (
          <Card bodyClass="p-0 pb-4">
            <div className="zh-card-header px-5 py-2.5">
              <CardTabs
                items={[
                  { k: 'info', text: t('my_basic_profile'), active: tab === 'info', onClick: () => setTab('info') },
                  { k: 'password', text: t('password'), active: tab === 'password', onClick: () => setTab('password') },
                  { k: 'avatar', text: t('modify_avatar'), active: tab === 'avatar', onClick: () => setTab('avatar') },
                  ...(light.userBgSwitch
                    ? [{ k: 'background', text: t('bg_setting'), active: tab === 'background', onClick: () => setTab('background') }]
                    : []),
                ]}
              />
            </div>
            <div className="px-5">
            {tab === 'info' && (
              <>
                <ul className="m-0 flex list-none flex-wrap gap-2 px-1 pt-2">
                  <UserCountTile label={t('posted_articles')} value={me.threads ?? 0} desc={t('site_posts_desc')} icon="edit" />
                  <UserCountTile label={t('submitted_comments')} value={me.posts ?? 0} desc={t('site_comments_desc')} icon="comment" />
                  <UserCountTile label={t('following_count')} value={profile.data?.following ?? 0} desc={t('following_desc')} icon="users" />
                  <UserCountTile label={t('followers_count')} value={profile.data?.followers ?? 0} desc={t('followers_desc')} icon="user" />
                </ul>
                <div className="mt-4 divide-y divide-zh-line border-t border-zh-line">
                  <UserInfoRow title={t('nickname_colon')}>{me.username}</UserInfoRow>
                  <UserInfoRow title={t('user_group_colon')}>{groupName}</UserInfoRow>
                  <UserInfoRow title={t('description_colon')}>
                    {t('member_uid_prefix')}<b className="tabular-nums">{me.uid}</b>{t('member_uid_suffix')}<b>{fmtDate(profile.data?.createDate ?? 0)}</b>
                  </UserInfoRow>
                  <UserInfoRow title={t('email_colon')}>
                    {/* 展示本人邮箱：GET /api/me 对本人下发 email（公开 /api/users/:uid 仍零敏感字段） */}
                    {priv.data?.email ?? t('not_filled')}
                  </UserInfoRow>
                </div>
              </>
            )}
            {tab === 'password' && (
              <form
                className="max-w-sm space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submitPassword();
                }}
              >
                <IconInput icon="lock" type="password" placeholder={t('password_old')} value={oldPw} onChange={(e) => setOldPw(e.target.value)} autoComplete="current-password" />
                <IconInput icon="lock" type="password" placeholder={t('password_new')} value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" />
                <IconInput icon="lock" type="password" placeholder={t('password_new_repeat')} value={newPw2} onChange={(e) => setNewPw2(e.target.value)} autoComplete="new-password" />
                <Button type="submit" disabled={pwBusy}>
                  {pwBusy ? t('submitting_dots') : t('update_password')}
                </Button>
                {pwOk && <p className="text-xs text-success">{pwOk}</p>}
                {pwErr && <p className="text-xs text-destructive">{pwErr}</p>}
                <p className="text-xs text-muted-foreground">{t('password_change_tip')}</p>
              </form>
            )}
            {tab === 'avatar' && (
              <div className="text-center">
                <div className="flex justify-center">
                  {/* 预设头像生效时（avatar=0 + avatar_auto）直接显示预设图 */}
                  {me.avatar_auto ? (
                    <img src={me.avatar_auto} alt={me.username} className="size-[4.5rem] rounded-full bg-line object-cover" />
                  ) : (
                    <Avatar uid={me.uid} avatar={me.avatar} username={me.username} size={4} />
                  )}
                </div>
                <div className="mt-3 text-left">
                  {/* 自定义上传：文件控件 + 「Choose file」标签，选中即上传（无独立提交钮） */}
                  <label className="relative flex h-9 cursor-pointer items-center rounded-lg border border-input-line bg-background px-3 text-sm text-muted-foreground transition-colors outline-none hover:bg-muted">
                    <span className="truncate">{fileName || 'Choose file'}</span>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/gif,image/jpeg,image/png,image/jpg,image/bmp"
                      className="absolute inset-0 cursor-pointer opacity-0"
                      disabled={busy}
                      onChange={(e) => {
                        setFileName(e.target.files?.[0]?.name ?? '');
                        void onPickAvatar(e.target.files?.[0]);
                      }}
                    />
                  </label>
                  {/* Bootstrap 斜纹进度条，上传期显示 */}
                  {busy && (
                    <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={t('uploading_aria')}>
                      <div className="zh-progress-bar h-full w-full rounded-full bg-primary" />
                    </div>
                  )}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{t('avatar_size_tip')}</p>
                {/* 预设头像网格：点击选中即 POST，再点当前已选项视为取消 */}
                <div className="mt-5 border-t border-zh-line pt-4 text-left">
                  <p className="mb-2 text-sm font-medium text-foreground">{t('preset_avatar_label')}</p>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(48px,1fr))] gap-2">
                    {AVATAR_PRESETS.map((src, i) => {
                      const selected = me.avatar_auto === src;
                      return (
                        <button
                          key={src}
                          type="button"
                          disabled={presetBusy}
                          title={selected ? t('preset_avatar_cancel_tip') : t('preset_avatar_use_tip')}
                          aria-pressed={selected}
                          className={`block size-12 overflow-hidden rounded-[6px] border-2 bg-muted transition-transform hover:scale-110 disabled:opacity-60 ${selected ? 'border-brand' : 'border-transparent'}`}
                          onClick={() => void onPickPreset(src)}
                        >
                          <img src={src} alt={selected ? t('current_preset_avatar') : t('preset_avatar_index', { i })} loading="lazy" className="size-full object-cover" />
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">{t('preset_avatar_tip')}</p>
                </div>
                {okMsg && <p className="mt-2 text-xs text-success">{okMsg}</p>}
                {err && <p className="mt-2 text-xs text-destructive">{err}</p>}
              </div>
            )}
            {tab === 'background' && (
              <div className="py-3">
                {/* 预设背景九宫格（bg-0 默认 + bg-1..user_bg_num；点击选中 → 底部保存） */}
                <div className="grid grid-cols-3 gap-2">
                  {Array.from({ length: light.userBgNum + 1 }, (_v, n) => (
                    <button
                      key={n}
                      type="button"
                      disabled={bgBusy}
                      aria-pressed={selBg === n}
                      title={n === 0 ? t('bg_default') : t('bg_preset_index', { n })}
                      className={`overflow-hidden rounded-[5px] border-2 bg-muted transition-transform hover:scale-[1.03] disabled:opacity-60 ${selBg === n ? 'border-brand' : 'border-transparent'}`}
                      onClick={() => setSelBg(n)}
                    >
                      <img
                        src={n === 0 ? '/theme-light/bg-0.webp' : `/theme-light/bgimg/bg-${n}.png`}
                        alt={n === 0 ? t('bg_default') : t('bg_preset_index', { n })}
                        loading="lazy"
                        onError={(e) => {
                          e.currentTarget.src = '/theme-light/bg-0.webp';
                        }}
                        className="h-[60px] w-full object-cover"
                      />
                    </button>
                  ))}
                </div>
                <div className="mt-3">
                  <Button disabled={bgBusy} onClick={() => void onSaveBg()}>
                    {bgBusy ? t('submitting_dots') : t('bg_save')}
                  </Button>
                </div>
                {bgOk && <p className="mt-2 text-xs text-success">{bgOk}</p>}
                {bgErr && <p className="mt-2 text-xs text-destructive">{bgErr}</p>}
                <p className="mt-2 text-xs text-muted-foreground">{t('bg_tip')}</p>
              </div>
            )}
            </div>
          </Card>
        ) : section === 'threads' ? (
          <section className="zh-card mb-4 overflow-hidden">
            <div className="zh-card-header px-5 py-3 text-[15px] font-bold">{t('my_posts')}</div>
            <div>
              {threads.error && <p className="px-5 py-3 text-sm text-destructive">{threads.error}</p>}
              <ThreadList data={{ list: threads.items, page: 1, size: threads.size, totalPage: 1 }} baseHref={() => '#'} />
              {threads.loaded && threads.items.length === 0 && !threads.error && <p className="px-5 py-3 text-center text-xs text-lt-grey">{t('no_threads_posted')}</p>}
              {threads.canMore && (
                <div className="px-5 py-3 text-center">
                  <Button variant="secondary" size="sm" loading={threads.loading} loadingText={t('loading')} onClick={threads.loadMore}>
                    {t('load_more')}
                  </Button>
                </div>
              )}
            </div>
          </section>
        ) : section === 'replies' ? (
          <section className="zh-card mb-4 overflow-hidden">
            <div className="zh-card-header px-5 py-3 text-[15px] font-bold">{t('my_replies')}</div>
            <UserReplyList active />
          </section>
        ) : section === 'favorites' ? (
          <section className="zh-card mb-4 overflow-hidden">
            <div className="zh-card-header px-5 py-3 text-[15px] font-bold">{t('my_favorites')}</div>
            <div>
              {favorites.isError && <p className="px-5 py-3 text-sm text-destructive">{(favorites.error as Error).message}</p>}
              <ThreadList
                data={{ list: favorites.data?.pages.flatMap((pg) => pg.list) ?? [], page: 1, size: favorites.data?.pages[0]?.size ?? 20, totalPage: 1 }}
                baseHref={() => '#'}
                loading={favorites.isLoading}
              />
              {favorites.isSuccess && favorites.data.pages.flatMap((pg) => pg.list).length === 0 && (
                <p className="px-5 py-10 text-center text-sm text-lt-grey">
                  {t('no_favorites_prefix')}
                  <Icon name="star" className="mx-1 inline size-3.5 align-[-2px] text-brand" />
                  {t('no_favorites_suffix')}
                </p>
              )}
              {favorites.hasNextPage && (
                <div className="px-5 py-3 text-center">
                  <Button variant="secondary" size="sm" loading={favorites.isFetchingNextPage} loadingText={t('loading')} onClick={() => void favorites.fetchNextPage()}>
                    {t('load_more')}
                  </Button>
                </div>
              )}
            </div>
          </section>
        ) : section === 'likes' ? (
          <section className="zh-card mb-4 overflow-hidden">
            <div className="zh-card-header px-5 py-3 text-[15px] font-bold">{t('my_likes')}</div>
            <div>
              {likes.isError && <p className="px-5 py-3 text-sm text-destructive">{(likes.error as Error).message}</p>}
              <ThreadList
                data={{ list: likes.data?.pages.flatMap((pg) => pg.list) ?? [], page: 1, size: likes.data?.pages[0]?.size ?? 20, totalPage: 1 }}
                baseHref={() => '#'}
                loading={likes.isLoading}
              />
              {likes.isSuccess && likes.data.pages.flatMap((pg) => pg.list).length === 0 && (
                <p className="px-5 py-10 text-center text-sm text-lt-grey">
                  {t('no_likes_prefix')}
                  <Icon name="thumbs_up" className="mx-1 inline size-3.5 align-[-2px] text-brand" />
                </p>
              )}
              {likes.hasNextPage && (
                <div className="px-5 py-3 text-center">
                  <Button variant="secondary" size="sm" loading={likes.isFetchingNextPage} loadingText={t('loading')} onClick={() => void likes.fetchNextPage()}>
                    {t('load_more')}
                  </Button>
                </div>
              )}
            </div>
          </section>
        ) : section === 'follow' ? (
          <FollowSection active={section === 'follow'} />
        ) : section === 'ranklist' ? (
          <RanklistSection active={section === 'ranklist'} />
        ) : section === 'notices' ? (
          <NoticesSection active={section === 'notices'} />
        ) : section === 'purchased' ? (
          <PurchasedSection active={section === 'purchased'} />
        ) : section === 'credits' ? (
          <CreditsSection />
        ) : section === 'points' ? (
          <PointsSection />
        ) : section === 'trade' ? (
          <TradeSection />
        ) : section === 'vapply' ? (
          <VapplySection />
        ) : (
          <RecordSection />
        )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- 我的关注（关注动态 / 我关注的 / 关注我的） ---------------- */

type FollowTab = 'timeline' | 'following' | 'followers';

/** 动态流条目（头像 + 昵称/时间 + 动作条 + 主题标题或回复内容） */
function FollowStreamRow({ it }: { it: FollowStreamItem }) {
  const t = useT();
  return (
    <li className="border-b border-zh-line px-5 py-4 last:border-b-0">
      <div className="flex items-start gap-3">
        <Link to={`/user/${it.uid}`} className="shrink-0" aria-label={it.username}>
          <Avatar uid={it.uid} avatar={it.avatar} username={it.username} size={3} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs text-lt-grey">
            <Link className="font-bold text-zh-deep-link transition-colors hover:text-brand" to={`/user/${it.uid}`}>
              {it.remark ?? it.username}
            </Link>
            {it.remark && <span>{`(${it.username})`}</span>}
            <span>{fmtDate(it.createDate)}</span>
          </div>
          {/* 动作条（浅灰底小块） */}
          <div className="mt-2 rounded-[4px] bg-lt-soft px-2 py-1 text-xs text-lt-grey">
            {it.isfirst === 1 ? (
              t('follow_published_thread')
            ) : (
              <>
                {t('follow_replied_prefix')}
                <Link className="transition-colors hover:text-brand" to={`/thread/${it.tid}`}>
                  {it.subject}
                </Link>
                {t('follow_replied_suffix')}
              </>
            )}
          </div>
          <div className="mt-2 text-sm leading-6 text-foreground">
            {it.isfirst === 1 ? (
              <Link className="break-words transition-colors hover:text-brand" to={`/thread/${it.tid}`}>
                {it.subject}
              </Link>
            ) : (
              <div className="post-body break-words" dangerouslySetInnerHTML={{ __html: it.messageFmt ?? '' }} />
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/** 关注用户行（头像 + 昵称（双向图标）+ 粉丝数 + 关注/已关注按钮）
 * —— 抽到 components/FollowUserList.tsx 与用户主页共用 */

function FollowSection({ active }: { active: boolean }) {
  const t = useT();
  const me = useAuth((s) => s.me);
  const [tab, setTab] = useState<FollowTab>('timeline');

  const timeline = useInfiniteQuery({
    queryKey: ['my-follow-stream'],
    queryFn: ({ pageParam }) => fetchMyFollowingStream(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor,
    enabled: active && tab === 'timeline' && Boolean(me),
  });

  const streamItems = timeline.data?.pages.flatMap((pg) => pg.list) ?? [];

  return (
    <section className="zh-card mb-4 overflow-hidden">
      <div className="zh-card-header px-2 py-2.5">
        <CardTabs
          items={[
            { k: 'timeline', text: t('follow_timeline'), active: tab === 'timeline', onClick: () => setTab('timeline') },
            { k: 'following', text: t('my_following'), active: tab === 'following', onClick: () => setTab('following') },
            { k: 'followers', text: t('my_followers'), active: tab === 'followers', onClick: () => setTab('followers') },
          ]}
        />
      </div>
      <div>
        {tab === 'timeline' ? (
          <>
            {timeline.isError && <p className="px-5 py-3 text-sm text-destructive">{(timeline.error as Error).message}</p>}
            {streamItems.length > 0 && (
              <ul className="m-0 list-none">
                {streamItems.map((it) => (
                  <FollowStreamRow key={it.pid} it={it} />
                ))}
              </ul>
            )}
            {timeline.isSuccess && streamItems.length === 0 && <p className="px-5 py-10 text-center text-sm text-lt-grey">{t('no_follow_stream')}</p>}
            {timeline.hasNextPage && (
              <div className="px-5 py-3 text-center">
                <Button variant="secondary" size="sm" loading={timeline.isFetchingNextPage} loadingText={t('loading')} onClick={() => void timeline.fetchNextPage()}>
                  {t('load_more')}
                </Button>
              </div>
            )}
          </>
        ) : tab === 'following' ? (
          active && me ? <FollowUserList url="/api/my/following" emptyText={t('no_follows')} editable /> : null
        ) : active && me ? (
          <FollowUserList url="/api/my/followers" emptyText={t('no_fans')} />
        ) : null}
      </div>
    </section>
  );
}

/* ---------------- 我的消息 ---------------- */

/** 类型页签（全部/评论/系统/其他；type 0 仅筛选不带条件） */
const NOTICE_TABS: { k: number; key: 'all' | 'comment_label' | 'system_label' | 'other_label' }[] = [
  { k: 0, key: 'all' },
  { k: 2, key: 'comment_label' },
  { k: 3, key: 'system_label' },
  { k: 99, key: 'other_label' },
];

function NoticesSection({ active }: { active: boolean }) {
  const t = useT();
  const me = useAuth((s) => s.me);
  const refreshAuth = useAuth((s) => s.refresh);
  const qc = useQueryClient();
  const [type, setType] = useState(0);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const q = useInfiniteQuery({
    queryKey: ['my-notices', type],
    queryFn: ({ pageParam }) => fetchMyNotices(type, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.list.length >= last.size ? last.nextCursor : undefined),
    enabled: active && Boolean(me),
  });
  const items = q.data?.pages.flatMap((pg) => pg.list) ?? [];
  const unread = q.data?.pages[0]?.unread ?? me?.unreadNotices ?? 0;

  /** 写操作后：刷新消息列表 + bootstrap（导航铃铛未读数） */
  const afterWrite = async () => {
    await qc.invalidateQueries({ queryKey: ['my-notices'] });
    await refreshAuth();
  };

  const run = async (fn: () => Promise<unknown>, okText: string) => {
    setBusy(true);
    setFlash(null);
    try {
      await fn();
      await afterWrite();
      setFlash({ tone: 'ok', text: okText });
    } catch (e) {
      setFlash({ tone: 'err', text: apiErrorMessage(e, t('operation_failed')) });
    } finally {
      setBusy(false);
    }
  };

  const doRead = (nid: number) => run(() => readNotice(nid), t('marked_read_ok'));
  const doDelete = (nid: number) => run(() => deleteNotice(nid), t('notice_deleted_ok'));
  const doReadAll = () => run(() => readAllNotices(), t('all_marked_read_ok'));
  const doDeletePage = () => {
    if (!items.length) return;
    if (!window.confirm(t('confirm_delete_all_notices'))) return;
    return run(() => deleteNotices(items.map((n) => n.nid)), t('notice_deleted_ok'));
  };

  return (
    <section className="zh-card mb-4 overflow-hidden">
      {/* 头部：类型页签 + 右按钮组（card-header-tabs + .nav-button） */}
      <div className="zh-card-header flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <CardTabs items={NOTICE_TABS.map((tab) => ({ k: String(tab.k), text: t(tab.key), active: type === tab.k, onClick: () => setType(tab.k) }))} />
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={busy || !items.length}
            onClick={() => void doDeletePage()}
            className="rounded-[4px] border border-[#dc3545] px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('delete_page_notices')}
          </button>
          <button
            type="button"
            disabled={busy || unread === 0}
            onClick={() => void doReadAll()}
            className="rounded-[4px] border border-brand px-2.5 py-1 text-xs text-brand transition-colors hover:bg-brand/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {unread > 0 ? t('mark_all_read') : t('all_read')}
          </button>
        </div>
      </div>

      {flash && (
        <p className={cx('px-5 pt-3 text-xs', flash.tone === 'ok' ? 'text-success' : 'text-destructive')}>{flash.text}</p>
      )}
      {q.isError && <p className="px-5 py-3 text-sm text-destructive">{apiErrorMessage(q.error, t('notice_load_failed'))}</p>}

      <div className="px-5">
        {q.isLoading ? (
          <p className="py-6 text-center text-sm text-lt-grey">{t('loading')}</p>
        ) : items.length === 0 ? (
          /* 空态（bug 图标 + 文案） */
          <div className="py-10 text-center text-lt-grey">
            <Icon name="bug" className="mx-auto size-10 text-zh-grey" />
            <p className="mt-2 text-sm">{t('no_related_notices')}</p>
          </div>
        ) : (
          <ul className="noticelist m-0 list-none p-0">
            {items.map((n) => (
              <li key={n.nid} className={cx('notice flex gap-3 border-b border-zh-line last:border-b-0', n.isRead && 'isread')}>
                <div className="mt-1 shrink-0">
                  {n.fromUid > 0 ? (
                    <Link to={`/user/${n.fromUid}`} aria-label={n.fromUsername}>
                      <Avatar uid={n.fromUid} avatar={n.fromAvatar} username={n.fromUsername} size={2} />
                    </Link>
                  ) : (
                    <Avatar uid={n.fromUid} avatar={n.fromAvatar} username={n.fromUsername} size={2} />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="min-w-0 truncate">
                      <span className="mr-1.5 font-bold text-foreground">
                        {n.fromUid > 0 ? (
                          <Link to={`/user/${n.fromUid}`} className="transition-colors hover:text-brand">
                            {n.fromUsername}
                          </Link>
                        ) : (
                          n.fromUsername
                        )}
                      </span>
                      <span className="text-lt-grey">{fmtDate(n.createDate)}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {n.isRead ? (
                        <span className="text-muted-foreground">{t('read_label')}</span>
                      ) : (
                        <button type="button" className="text-brand transition-colors hover:underline" onClick={() => void doRead(n.nid)}>
                          {t('mark_read')}
                        </button>
                      )}
                      <button type="button" className="text-muted-foreground transition-colors hover:text-destructive hover:underline" onClick={() => void doDelete(n.nid)}>
                        {t('delete')}
                      </button>
                    </div>
                  </div>
                  {/* 消息体：服务端生成受限 HTML（用户输入已转义） */}
                  <div className="message mt-1 flex gap-1.5 text-sm text-lt-grey">
                    {!n.isRead && <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-destructive" aria-label={t('unread_aria')} />}
                    <div className="min-w-0 break-all" dangerouslySetInnerHTML={{ __html: n.message }} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {q.hasNextPage && (
        <div className="px-5 py-3 text-center">
          <Button variant="secondary" size="sm" loading={q.isFetchingNextPage} loadingText={t('loading')} onClick={() => void q.fetchNextPage()}>
            {t('load_more')}
          </Button>
        </div>
      )}
    </section>
  );
}

/* ---------------- 排行榜单 ---------------- */

/** 五个维度页签（threads/posts/credits1=经验(本站"积分")/credits2=金币/credits3=人民币） */
const RANK_TABS = [
  { k: 'threads', key: 'thread' as const },
  { k: 'posts', key: 'post' as const },
  { k: 'credits', key: 'credits_label' as const },
  { k: 'golds', key: 'credits_gold' as const },
  { k: 'rmbs', key: 'credits_rmb' as const },
] as const;
type RankSort = (typeof RANK_TABS)[number]['k'];

/** 数值列（表头：主题数/帖子数/积分/金币/人民币） */
const RANK_COLS: { k: 'threads' | 'posts' | 'credits' | 'golds' | 'rmbs'; key: 'thread_count_label' | 'post_count_label' | 'credits_label' | 'credits_gold' | 'credits_rmb' }[] = [
  { k: 'threads', key: 'thread_count_label' },
  { k: 'posts', key: 'post_count_label' },
  { k: 'credits', key: 'credits_label' },
  { k: 'golds', key: 'credits_gold' },
  { k: 'rmbs', key: 'credits_rmb' },
];

/** 全站用户排行榜（每页 20 人，当前用户行加粗；rmbs 显示为 /100；窄屏只留用户名与当前排序列） */
function RanklistSection({ active }: { active: boolean }) {
  const t = useT();
  const [search] = useSearchParams();
  const me = useAuth((st) => st.me);
  const tParam = search.get('t');
  const sort: RankSort = RANK_TABS.some((x) => x.k === tParam) ? (tParam as RankSort) : 'threads';
  const page = posInt(search.get('p'));
  const q = useQuery({
    queryKey: ['rank-list', sort, page],
    queryFn: () => getRankList(sort, page, 20),
    enabled: active,
  });
  const rows = q.data?.list ?? [];
  const href = (p: number) => `/me?s=ranklist&t=${sort}${p > 1 ? `&p=${p}` : ''}`;

  return (
    <section className="zh-card mb-4 overflow-hidden">
      <div className="zh-card-header px-4 py-2.5">
        <CardTabs items={RANK_TABS.map((tab) => ({ k: tab.k, text: t(tab.key), active: tab.k === sort, to: `/me?s=ranklist&t=${tab.k}` }))} />
      </div>
      {q.isError && <p className="px-5 py-3 text-sm text-destructive">{(q.error as Error).message}</p>}
      {q.isLoading ? (
        <p className="py-6 text-center text-sm text-lt-grey">{t('loading')}</p>
      ) : (
        <div className="overflow-x-auto px-4 pb-1">
          {/* bootstrap .table：表头浅底灰字、行底发丝线 + hover 换底色 */}
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-lt-soft text-[13px] text-lt-grey">
                <th className="px-3 py-3 text-left font-medium">{t('username_label')}</th>
                {RANK_COLS.map((c) => (
                  <th key={c.k} className={cx('px-3 py-3 text-left font-medium', c.k !== sort && 'hidden lg:table-cell')}>
                    {t(c.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.uid} className={cx('border-b border-zh-line hover:bg-zh-row-hover', me?.uid === r.uid && 'font-bold')}>
                  <td className="max-w-[10rem] truncate px-3 py-3">
                    <Link to={`/user/${r.uid}`} className="transition-colors hover:text-brand">
                      {r.username}
                    </Link>
                  </td>
                  {RANK_COLS.map((c) => (
                    <td key={c.k} className={cx('px-3 py-3 tabular-nums', c.k !== sort && 'hidden lg:table-cell')}>
                      {c.k === 'rmbs' ? r.rmbs / 100 : r[c.k]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {!q.isError && rows.length === 0 && <p className="py-6 text-center text-sm text-lt-grey">{t('no_data')}</p>}
        </div>
      )}
      <Pagination page={page} totalPage={q.data?.totalPage ?? 1} href={href} />
    </section>
  );
}

/* ---------------- 财富管理（积分/交易/记录/已购） ---------------- */

/** 积分家族页签（积分 + 流水 + 交易/记录） */
function CreditNavTabs({ current }: { current: 'credits' | 'points' | 'trade' | 'record' }) {
  const t = useT();
  return (
    <div className="zh-card-header px-4 py-2.5">
      <CardTabs
        items={[
          { k: 'credits', text: t('credits_label'), active: current === 'credits', to: '/me?s=credits' },
          { k: 'points', text: t('points_log_label'), active: current === 'points', to: '/me?s=points' },
          { k: 'trade', text: t('trade_label'), active: current === 'trade', to: '/me?s=trade' },
          { k: 'record', text: t('record_label'), active: current === 'record', to: '/me?s=record' },
        ]}
      />
    </div>
  );
}

/** 积分面板：渐变大卡（头像+组徽章+升级进度条）+ 三币种卡片 */
function CreditsSection() {
  const t = useT();
  const gn = useGroupName();
  const q = useQuery({ queryKey: ['my-credits'], queryFn: getMyCredits });
  const d = q.data;
  return (
    <section className="zh-card mb-4 overflow-hidden">
      <CreditNavTabs current="credits" />
      <div className="p-4">
        {q.isError && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
        {q.isLoading && <p className="py-6 text-center text-sm text-lt-grey">{t('loading')}</p>}
        {d && (
          <>
            {/* 大卡：linear-gradient(to top,#accbee,#e7f0fd)，进度条为 bootstrap striped animated 等价 */}
            <div className="rounded-[4px] p-4" style={{ backgroundImage: 'linear-gradient(to top, #accbee 0%, #e7f0fd 100%)' }}>
              <div className="flex items-center gap-3">
                <Avatar uid={d.uid} avatar={d.avatar} username={d.username} size={3} />
                <div className="min-w-0">
                  <span className="text-sm font-medium text-foreground">{d.username}</span>
                  <div className="mt-1.5 text-xs text-ink-soft">
                    {t('user_group_colon_space')} <span className="inline-flex rounded bg-brand px-1.5 py-0.5 text-[10px] leading-none text-white">{gn(d.gid, d.groupName)}</span>
                  </div>
                </div>
              </div>
              <div className="mt-3 h-4 w-full overflow-hidden rounded-full bg-lt-line" role="progressbar" aria-valuenow={d.progress} aria-valuemin={0} aria-valuemax={100}>
                <div className="zh-progress-bar h-full bg-brand" style={{ width: `${Math.max(0, Math.min(100, d.progress))}%` }} />
              </div>
            </div>
            {/* 三币种卡片（经验灰蓝/金币棕金/人民币粉红，人民币显示 rmbs/100 元） */}
            <div className="mt-4 grid gap-3 lg:grid-cols-3">
              {(
                [
                  { label: t('credits_experience'), icon: 'flask', value: d.credits, bg: 'linear-gradient(to top, #cfd9df 0%, #e2ebf0 100%)', color: '#6c757d' },
                  { label: t('credits_gold'), icon: 'coins', value: d.golds, bg: 'linear-gradient(to top, #e6b980 0%, #eacda3 100%)', color: '#905306' },
                  { label: t('credits_rmb'), icon: 'banknote', value: d.rmbs / 100, bg: 'linear-gradient(-20deg, #f794a4 0%, #fdd6bd 100%)', color: '#e00f31' },
                ] as const
              ).map((c) => (
                <div key={c.label} className="rounded-[4px] p-4" style={{ backgroundImage: c.bg }}>
                  <div className="flex items-center justify-between text-lg">
                    {c.label}
                    <Icon name={c.icon} className="size-6" style={{ color: c.color }} />
                  </div>
                  <div className="mt-1 text-2xl font-semibold tabular-nums" style={{ color: c.color }}>
                    {c.value}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/** 积分流水（my-points）：bbs_point_log 权威账本——签到/发帖奖励/精华结算/管理员调整等 15 类变动明细，
 *  与「记录」tab（user_pay 交易单）互补：交易单只覆盖购买/兑换/转账 4 类，账本全覆盖经验币种。 */
function PointsSection() {
  const t = useT();
  const [search] = useSearchParams();
  const page = posInt(search.get('p'));
  const q = useQuery({ queryKey: ['my-points', page], queryFn: () => getMyPoints(page) });
  const rows = q.data?.list ?? [];
  const href = (p: number) => `/me?s=points${p > 1 ? `&p=${p}` : ''}`;
  const reasonLabel = (reason: string): string => {
    switch (reason) {
      case 'thread': return t('point_reason_thread');
      case 'reply': return t('reply_btn');
      case 'daily_first': return t('point_reason_daily_first');
      case 'attach_purchase': return t('point_reason_attach_purchase');
      case 'attach_income': return t('point_reason_attach_income');
      case 'order': return t('point_reason_order');
      case 'admin': return t('point_reason_admin');
      case 'register': return t('point_reason_register');
      case 'thread_purchase': return t('point_reason_thread_purchase');
      case 'thread_income': return t('point_reason_thread_income');
      case 'transfer_out': return t('point_reason_transfer_out');
      case 'transfer_in': return t('point_reason_transfer_in');
      case 'digest': return t('digest_label');
      case 'checkin': return t('point_reason_checkin');
      case 'v_apply': return t('point_reason_v_apply');
      default: return reason;
    }
  };
  return (
    <section className="zh-card mb-4 overflow-hidden">
      <CreditNavTabs current="points" />
      {q.isError && <p className="px-5 py-3 text-sm text-destructive">{(q.error as Error).message}</p>}
      <div className="overflow-x-auto px-4 pb-1">
        {/* bootstrap .table：表头浅底灰字、行底发丝线 + hover 换底色（与「记录」同款） */}
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-lt-soft text-[13px] text-lt-grey">
              <th className="px-3 py-3 text-left font-medium">{t('time_label')}</th>
              <th className="px-3 py-3 text-left font-medium">{t('type_label')}</th>
              <th className="px-3 py-3 text-left font-medium">{t('point_log_change')}</th>
              <th className="px-3 py-3 text-left font-medium">{t('point_log_balance')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-zh-line hover:bg-zh-row-hover">
                <td className="whitespace-nowrap px-3 py-3">{fmtDate(r.create_date)}</td>
                <td className="px-3 py-3">{reasonLabel(r.reason)}</td>
                <td className={`px-3 py-3 tabular-nums ${r.change > 0 ? 'text-success' : r.change < 0 ? 'text-destructive' : ''}`}>
                  {r.change > 0 ? `+${r.change}` : r.change}
                </td>
                <td className="px-3 py-3 tabular-nums">{r.balance}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!q.isError && !q.isLoading && rows.length === 0 && <p className="py-6 text-center text-sm text-lt-grey">{t('no_data')}</p>}
      </div>
      <Pagination page={page} totalPage={q.data?.total_page ?? 1} href={href} />
    </section>
  );
}

/** 交易：兑换卡（人民币→金币，10 分钟频控提示走服务端）+ 转账卡（三币种） */
function TradeSection() {
  const t = useT();
  const qc = useQueryClient();
  const refreshAuth = useAuth((st) => st.refresh);
  const q = useQuery({ queryKey: ['my-credits'], queryFn: getMyCredits });
  const d = q.data;
  /* 兑换：输入 N（金币数）→ 实时显示 可兑换 N 金币，需消耗 ¥ N*exchange_n/100 */
  const [eRmb, setERmb] = useState('');
  /* 转账：用户名/金额/币种（select 默认 2=金币） */
  const [tUser, setTUser] = useState('');
  const [tNum, setTNum] = useState('');
  const [tType, setTType] = useState(2);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const goldsShow = eRmb === '' ? '0' : eRmb.replace(/[^0-9]/g, '') || '0';
  const rmbShow = eRmb === '' || Number(eRmb) === 0 ? '0' : ((Number(eRmb) / 100) * (d?.trade.exchangeN ?? 1)).toString();

  /** 写操作后刷新面板与 bootstrap（导航余额随动） */
  const afterWrite = async () => {
    await qc.invalidateQueries({ queryKey: ['my-credits'] });
    await refreshAuth();
  };

  const doExchange = async () => {
    const n = eRmb.replace(/[^0-9]/g, '');
    if (n === '' || Number(n) === 0) return;
    if (!window.confirm(t('confirm_exchange'))) return;
    setBusy(true);
    setFlash(null);
    try {
      await exchangeCredits({ op: 'n', e_rmb: Number(n) });
      await afterWrite();
      setFlash({ tone: 'ok', text: t('update_successfully') });
      setERmb('');
    } catch (e) {
      setFlash({ tone: 'err', text: apiErrorMessage(e, t('exchange_failed')) });
    } finally {
      setBusy(false);
    }
  };

  const doTransfer = async () => {
    const num = Math.floor(Number(tNum));
    if (!Number.isFinite(num) || num <= 0) {
      setFlash({ tone: 'err', text: t('input_positive') });
      return;
    }
    if (!tUser.trim()) {
      setFlash({ tone: 'err', text: t('username_empty') });
      return;
    }
    if (!window.confirm(t('confirm_transfer'))) return;
    setBusy(true);
    setFlash(null);
    try {
      await transferCredits({ username: tUser.trim(), num, creditType: tType });
      await afterWrite();
      setFlash({ tone: 'ok', text: t('transfer_success') });
      setTUser('');
      setTNum('');
    } catch (e) {
      setFlash({ tone: 'err', text: apiErrorMessage(e, t('transfer_failed')) });
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    'h-[38px] min-w-0 flex-1 rounded-[4px] border border-input-line bg-card px-3 text-sm text-foreground outline-none transition-colors placeholder:text-zh-grey focus:border-[#a0cfff] focus:ring-3 focus:ring-[rgba(64,158,255,0.25)]';

  return (
    <section className="zh-card mb-4 overflow-hidden">
      <CreditNavTabs current="trade" />
      <div className="p-4">
        {/* 兑换卡（#008CFF 虚线框；按钮 #6293d4） */}
        <div className="rounded-lg border border-dashed border-[#008CFF] p-4">
          <h5 className="text-center text-xl font-semibold">{t('exchange_label')}</h5>
          <h6 className="mt-1 text-center text-sm text-muted-foreground">
            {t('exchange_tip', { golds: goldsShow, rmb: rmbShow })}
          </h6>
          <div className="mt-3 flex">
            <span className="inline-flex w-20 shrink-0 items-center justify-center rounded-l-[4px] border border-[#ced4da] bg-lt-line px-2 text-sm text-ink-soft">{t('exchange_label')}</span>
            <input
              className={`${inputCls} rounded-l-none`}
              placeholder={t('exchange_placeholder')}
              maxLength={8}
              inputMode="numeric"
              value={eRmb}
              onChange={(e) => setERmb(e.target.value.replace(/[^0-9]/g, '').slice(0, 8))}
            />
          </div>
          <button
            type="button"
            disabled={busy}
            className="mt-3 h-[38px] w-full rounded-[4px] bg-[#6293d4] text-sm font-medium text-white transition-colors hover:bg-[#5485c6] disabled:opacity-60"
            onClick={() => void doExchange()}
          >
            {busy ? t('submitting_dots') : t('exchange_label')}
          </button>
        </div>

        {/* 转账卡（用户名 + 金额（仅数字）+ 币种 select 默认金币） */}
        <div className="mt-8 rounded-lg border border-dashed border-[#008CFF] p-4">
          <h5 className="text-center text-xl font-semibold text-[#6D6D6D]">{t('transfer_label')}</h5>
          <div className="mt-3 flex flex-wrap gap-2">
            <input className={`${inputCls} sm:w-[35%] sm:flex-none`} maxLength={36} placeholder={t('transfer_user_placeholder')} value={tUser} onChange={(e) => setTUser(e.target.value)} />
            <input
              className={`${inputCls} sm:ml-2 sm:w-[50%] sm:flex-none`}
              maxLength={36}
              placeholder={t('transfer_amount_placeholder')}
              inputMode="numeric"
              value={tNum}
              onChange={(e) => setTNum(e.target.value.replace(/[^0-9]/g, '').slice(0, 36))}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              className="h-[38px] w-[35%] min-w-[8rem] rounded-[4px] border border-input-line bg-card px-2 text-sm text-foreground outline-none transition-colors focus:border-[#a0cfff]"
              value={tType}
              onChange={(e) => setTType(Number(e.target.value))}
            >
              <option value={1}>{t('credits_experience')}</option>
              <option value={2}>{t('credits_gold')}</option>
              <option value={3}>{t('rmb_unit_fen')}</option>
            </select>
            <button
              type="button"
              disabled={busy}
              className="ml-auto h-[38px] rounded-[4px] bg-[#6293d4] px-5 text-sm font-medium text-white transition-colors hover:bg-[#5485c6] disabled:opacity-60"
              onClick={() => void doTransfer()}
            >
              {busy ? t('submitting_dots') : t('transfer_label')}
            </button>
          </div>
        </div>

        {flash && <p className={cx('mt-3 text-xs', flash.tone === 'ok' ? 'text-success' : 'text-destructive')}>{flash.text}</p>}
        {q.isError && <p className="mt-3 text-xs text-destructive">{(q.error as Error).message}</p>}
      </div>
    </section>
  );
}

/** 积分变动记录：时间|类型|积分|记录；积分列 = num>0 ? 显示值+币种 : '-' */
function RecordSection() {
  const t = useT();
  const [search] = useSearchParams();
  const page = posInt(search.get('p'));
  const q = useQuery({ queryKey: ['my-credit-record', page], queryFn: () => getMyCreditRecord(page) });
  const rows = q.data?.list ?? [];
  const href = (p: number) => `/me?s=record${p > 1 ? `&p=${p}` : ''}`;
  return (
    <section className="zh-card mb-4 overflow-hidden">
      <CreditNavTabs current="record" />
      {q.isError && <p className="px-5 py-3 text-sm text-destructive">{(q.error as Error).message}</p>}
      <div className="overflow-x-auto px-4 pb-1">
        {/* bootstrap .table：表头浅底灰字、行底发丝线 + hover 换底色 */}
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-lt-soft text-[13px] text-lt-grey">
              <th className="px-3 py-3 text-left font-medium">{t('time_label')}</th>
              <th className="px-3 py-3 text-left font-medium">{t('type_label')}</th>
              <th className="px-3 py-3 text-left font-medium">{t('credits_label')}</th>
              <th className="px-3 py-3 text-left font-medium">{t('record_label')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.cid} className="border-b border-zh-line hover:bg-zh-row-hover">
                <td className="whitespace-nowrap px-3 py-3">{fmtDate(r.time)}</td>
                <td className="px-3 py-3">
                  {r.typeName},{r.statusName}
                </td>
                <td className="px-3 py-3 tabular-nums">{r.num > 0 ? `${r.displayNum} ${r.creditName}` : '-'}</td>
                <td className="max-w-[16rem] break-all px-3 py-3">{r.code}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!q.isError && !q.isLoading && rows.length === 0 && <p className="py-6 text-center text-sm text-lt-grey">{t('no_data')}</p>}
      </div>
      <Pagination page={page} totalPage={q.data?.totalPage ?? 1} href={href} />
    </section>
  );
}

/** 已购主题：套「我的帖子」主题列表卡 + 分页 */
function PurchasedSection({ active }: { active: boolean }) {
  const t = useT();
  const [search] = useSearchParams();
  const page = posInt(search.get('p'));
  const q = useQuery({ queryKey: ['my-purchased', page], queryFn: () => getMyPurchased(page), enabled: active });
  const href = (p: number) => `/me?s=purchased${p > 1 ? `&p=${p}` : ''}`;
  return (
    <section className="zh-card mb-4 overflow-hidden">
      <div className="zh-card-header px-5 py-3 text-[15px] font-bold">{t('purchased_label')}</div>
      <div>
        {q.isError && <p className="px-5 py-3 text-sm text-destructive">{(q.error as Error).message}</p>}
        <ThreadList data={{ list: q.data?.list ?? [], page: 1, size: q.data?.size ?? 20, totalPage: 1 }} baseHref={() => '#'} loading={q.isLoading} />
        {q.isSuccess && q.data.list.length === 0 && (
          <p className="px-5 py-10 text-center text-sm text-lt-grey">{t('no_purchased_tip')}</p>
        )}
      </div>
      <Pagination page={page} totalPage={q.data?.totalPage ?? 1} href={href} />
    </section>
  );
}

/* ---------------- 加V认证 ---------------- */

/** 币种名（credits=积分 / golds=金币 / rmbs=人民币） */
const V_FEE_LABEL: Record<'credits' | 'golds' | 'rmbs', 'credits_label' | 'credits_gold' | 'credits_rmb'> = { credits: 'credits_label', golds: 'credits_gold', rmbs: 'credits_rmb' };
/** 证明图片限制（图片类型 + 2MB） */
const V_FILE_ACCEPT = 'image/gif,image/jpeg,image/png,image/jpg,image/bmp';
const V_FILE_MAX = 2 * 1024 * 1024;

/** 加V申请表单：顶部绿色/红色提示条两条件独立（可同时显示）；表单回填最近一次申请；
 * 证明图片选图即传附件端点（同 ThreadPage 图片上传），URL 回填 vFile 并预览；提交按钮带收费文案 */
function VapplySection() {
  const t = useT();
  const qc = useQueryClient();
  const refreshAuth = useAuth((s) => s.refresh);
  const q = useQuery({ queryKey: ['my-v'], queryFn: getMyV });
  const d = q.data;
  const [title, setTitle] = useState('');
  const [vInfo, setVInfo] = useState('');
  const [vFile, setVFile] = useState('');
  const [filled, setFilled] = useState(false);
  /* 回填仅首次数据到达时灌入（不覆盖用户后续编辑） */
  useEffect(() => {
    if (d && !filled) {
      setTitle(d.apply?.v ?? '');
      setVInfo(d.apply?.vInfo ?? '');
      setVFile(d.apply?.vFile ?? '');
      setFilled(true);
    }
  }, [d, filled]);

  /* 证明图片：选图即传 */
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState('');
  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    setUploadErr('');
    if (file.size > V_FILE_MAX) {
      setUploadErr(t('v_file_too_large'));
      return;
    }
    setUploading(true);
    try {
      const r = await uploadAttachment(file, { isImage: true });
      setVFile(r.url);
    } catch (e) {
      setUploadErr(apiErrorMessage(e, t('upload_failed')));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const [busy, setBusy] = useState(false);
  const [okMsg, setOkMsg] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    setErr('');
    setOkMsg('');
    if (!title.trim()) {
      setErr(t('fill_v_title'));
      return;
    }
    if (!vInfo.trim()) {
      setErr(t('fill_v_info'));
      return;
    }
    if (!vFile) {
      setErr(t('upload_v_file'));
      return;
    }
    setBusy(true);
    try {
      await applyV({ v: title.trim(), vInfo: vInfo.trim(), vFile });
      setOkMsg(t('v_submit_success'));
      await qc.invalidateQueries({ queryKey: ['my-v'] });
      await refreshAuth(); // 扣费后导航余额随动
    } catch (e) {
      setErr(apiErrorMessage(e, t('submit_failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="zh-card mb-4 overflow-hidden">
      <div className="zh-card-header px-5 py-3 text-[15px] font-bold">{t('v_verify_label')}</div>
      <div className="px-5 py-4">
        {q.isError && <p className="text-sm text-destructive">{(q.error as Error).message}</p>}
        {q.isLoading && <p className="py-6 text-center text-sm text-lt-grey">{t('loading')}</p>}
        {d && (
          <div className="mx-auto max-w-md">
            {/* 两提示条独立判断（user.v!='0' 与 apply.status==0 可同时显示） */}
            {d.v !== '0' && (
              <div role="alert" className="mb-3 rounded-[4px] border border-[#c3e6cb] bg-[#d4edda] px-4 py-3 text-sm text-[#155724]">
                {t('v_verified_tip')}
              </div>
            )}
            {d.apply && d.apply.status === 0 && (
              <div role="alert" className="mb-3 rounded-[4px] border border-[#f5c6cb] bg-[#f8d7da] px-4 py-3 text-sm text-[#721c24]">
                {t('v_reviewing_tip')}
              </div>
            )}
            {okMsg && (
              <div role="alert" className="mb-3 rounded-[4px] border border-[#c3e6cb] bg-[#d4edda] px-4 py-3 text-sm text-[#155724]">
                {okMsg}
              </div>
            )}
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <label className="block">
                <span className="mb-1 block text-sm text-muted-foreground">{t('v_title_label')}</span>
                <input className={inputCls} maxLength={10} placeholder={t('v_title_placeholder')} value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm text-muted-foreground">{t('v_info_label')}</span>
                <textarea
                  className={`${inputCls} h-auto resize-none py-2 leading-6`}
                  rows={4}
                  maxLength={50}
                  placeholder={t('v_info_placeholder')}
                  value={vInfo}
                  onChange={(e) => setVInfo(e.target.value)}
                />
              </label>
              <div>
                <span className="mb-1 block text-sm text-muted-foreground">{t('v_file_label')}</span>
                {/* 文件控件 + 「选择文件」标签，选中即上传 */}
                <label className="relative flex h-9 cursor-pointer items-center rounded-lg border border-input-line bg-background px-3 text-sm text-muted-foreground transition-colors outline-none hover:bg-muted">
                  <span className="truncate">{uploading ? t('uploading_dots') : t('choose_file')}</span>
                  <input
                    ref={fileRef}
                    type="file"
                    accept={V_FILE_ACCEPT}
                    className="absolute inset-0 cursor-pointer opacity-0"
                    disabled={uploading || busy}
                    onChange={(e) => void onPickFile(e.target.files?.[0])}
                  />
                </label>
                {uploading && (
                  <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={t('uploading_aria')}>
                    <div className="zh-progress-bar h-full w-full rounded-full bg-primary" />
                  </div>
                )}
                {/* 预览图 + 回填（vFile state） */}
                {vFile && <img src={vFile} alt={t('v_file_preview_alt')} className="mt-2 max-h-40 rounded-[4px] border border-zh-line object-contain" />}
                {uploadErr && <p className="mt-1 text-xs text-destructive">{uploadErr}</p>}
              </div>
              <Button type="submit" block disabled={busy || uploading}>
                {busy ? t('submitting_dots') : t('submit_apply_consume', { count: d.fee.count, unit: t(V_FEE_LABEL[d.fee.type]) })}
              </Button>
              {err && <p className="text-xs text-destructive">{err}</p>}
            </form>
          </div>
        )}
      </div>
    </section>
  );
}
