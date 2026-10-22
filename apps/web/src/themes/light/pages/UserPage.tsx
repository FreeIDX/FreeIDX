import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import { apiGet, fmtDate, toggleFollow } from '../../../lib/api';
import { apiErrorMessage } from '../../../lib/errors';
import { posInt } from '../../../lib/params';
import { useT, useGroupName } from '../../../lib/i18n';
import { Avatar } from '../../../components/Avatar';
import { FollowUserList } from '../../../components/FollowUserList';
import { PmButton } from '../../../components/PmButton';
import { ThreadList } from '../../../components/ThreadList';
import { UserReplyList } from '../../../components/UserReplyList';
import { VBadge } from '../../../components/VBadge';
import { useCursorThreads } from '../../../hooks/useCursorThreads';
import { useAuth } from '../../../store/auth';
import { useAuthModal } from '../../../store/authModal';
import { useLight, userBgImage } from '../../../store/theme';
import { Button, LinkButton, UserInfoRow, UserSideItem, cx } from '../../../components/ui';

export interface UserProfile {
  uid: number;
  gid: number;
  groupName: string;
  username: string;
  avatar: number;
  threads: number;
  posts: number;
  credits: number;
  createDate: number;
  loginDate: number;
  /** A 组新增：在线态 + 关注/粉丝（bbs_follow 实时 COUNT）+ 当前访问者是否已关注 */
  online: boolean;
  followers: number;
  following: number;
  followed: boolean;
  /** 认证头衔（user.v，'0'=未认证；头像 V 标 title） */
  v: string;
  /** 主页背景预设编号（'0'=默认 bg-0.webp） */
  bgimg?: string;
}

/** NumberBoard 磁贴（#f8f9fa 浅底 5px 圆角 + 加粗数字 + #909399 描述） */
function NumTile({ value, label }: { value: number; label: string }) {
  return (
    <li className="m-0 rounded-[5px] bg-lt-soft px-4 py-3 text-center">
      <p className="text-xl font-bold tabular-nums text-foreground">{value}</p>
      <p className="mt-0.5 text-xs text-lt-grey">{label}</p>
    </li>
  );
}

/** 他人主页（§4.7）：左 240px 侧栏 + 渐变横幅头卡 + NumberBoard/资料行 */
export function UserPage() {
  const params = useParams();
  const openAuth = useAuthModal((s) => s.openAuth);
  const [search] = useSearchParams();
  const uid = posInt(params.uid);
  const section = search.get('s') === 'threads' ? 'threads' : search.get('s') === 'replies' ? 'replies' : search.get('s') === 'following' ? 'following' : search.get('s') === 'followers' ? 'followers' : 'profile';
  const me = useAuth((s) => s.me);
  const t = useT();
  const gn = useGroupName();

  const profile = useQuery({ queryKey: ['user', uid], queryFn: () => apiGet<UserProfile>(`/api/users/${uid}`) });
  const threads = useCursorThreads(`/api/users/${uid}/threads`, section === 'threads');

  const p = profile.data;
  const isSelf = me?.uid === uid;
  /* 主页背景：user_bg_switch 开启且该用户选了非默认背景时生效 */
  const light = useLight();

  /* A3 关注 toggle：乐观翻转 + 失败回滚，错误行内提示 */
  const qc = useQueryClient();
  const [followErr, setFollowErr] = useState('');
  const follow = useMutation({
    mutationFn: () => toggleFollow(uid),
    onMutate: async () => {
      setFollowErr('');
      await qc.cancelQueries({ queryKey: ['user', uid] });
      const prev = qc.getQueryData<UserProfile>(['user', uid]);
      if (prev) {
        qc.setQueryData<UserProfile>(['user', uid], {
          ...prev,
          followed: !prev.followed,
          followers: prev.followers + (prev.followed ? -1 : 1),
        });
      }
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['user', uid], ctx.prev);
      setFollowErr(apiErrorMessage(e, t('follow_failed')));
    },
  });

  const onFollowClick = () => {
    if (!me) {
      openAuth('login'); // 与回帖口径一致：未登录先去登录
      return;
    }
    follow.mutate();
  };

  return (
    <div className="my-[10px] flex flex-col gap-4 lg:flex-row">
      <aside className="hidden lg:block lg:w-[240px] lg:shrink-0">
        <div className="zh-card px-4 py-4">
          <UserSideItem to={`/user/${uid}`} label={t('personal_profile')} active={section === 'profile'} icon="user" />
          <UserSideItem to={`/user/${uid}?s=threads`} label={t('his_posts')} active={section === 'threads'} icon="edit" />
          <UserSideItem to={`/user/${uid}?s=replies`} label={t('his_replies')} active={section === 'replies'} icon="message" />
          {/* ：Ta关注的 / 关注Ta的 */}
          <UserSideItem to={`/user/${uid}?s=following`} label={t('his_following')} active={section === 'following'} icon="users" />
          <UserSideItem to={`/user/${uid}?s=followers`} label={t('his_followers')} active={section === 'followers'} icon="users" />
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="mb-4 flex flex-wrap gap-1 lg:hidden">
          <LinkButton to={`/user/${uid}`} variant={section === 'profile' ? 'primary' : 'secondary'} className="min-w-0 flex-1">
            {t('personal_profile')}
          </LinkButton>
          <LinkButton to={`/user/${uid}?s=threads`} variant={section === 'threads' ? 'primary' : 'secondary'} className="min-w-0 flex-1">
            {t('his_posts')}
          </LinkButton>
          <LinkButton to={`/user/${uid}?s=replies`} variant={section === 'replies' ? 'primary' : 'secondary'} className="min-w-0 flex-1">
            {t('his_replies')}
          </LinkButton>
          <LinkButton to={`/user/${uid}?s=following`} variant={section === 'following' ? 'primary' : 'secondary'} className="min-w-0 flex-1">
            {t('his_following')}
          </LinkButton>
          <LinkButton to={`/user/${uid}?s=followers`} variant={section === 'followers' ? 'primary' : 'secondary'} className="min-w-0 flex-1">
            {t('his_followers')}
          </LinkButton>
        </div>

        {profile.isError && <p className="mb-4 text-sm text-destructive">{(profile.error as Error).message}</p>}

        {section === 'profile' ? (
          p && (
            <section className="zh-card mb-4 overflow-hidden">
              {/* 80px 背景图（默认 bg-0.webp，用户选了预设背景时以其为准）+ 上移 6rem 白边头像（.avatar-6） */}
              <div
                className="h-[80px] w-full bg-[url(/theme-light/bg-0.webp)] bg-cover bg-center"
                style={(() => {
                  const img = userBgImage(p.bgimg, light);
                  return img ? { backgroundImage: img } : undefined;
                })()}
              />
              <div className="px-4 pb-5 sm:px-5">
                <div className="flex items-start justify-between gap-2">
                  {/* 加V认证徽章（头像右下角 V 标，title=头衔） */}
                  <span className="relative inline-block">
                    <Avatar
                      uid={p.uid}
                      avatar={p.avatar}
                      username={p.username}
                      dim="6rem"
                      radius="lg"
                      className="-mt-[45px] border-[3px] border-card bg-card"
                    />
                    <VBadge v={p.v} dim="6rem" />
                  </span>
                  {/* A3 关注按钮 + （他人主页 + 已登录才出现；未登录点击去登录页） */}
                  {!isSelf && (
                    <span className="mt-2 flex shrink-0 items-center gap-2">
                      {me && (
                        <button
                          type="button"
                          disabled={follow.isPending}
                          onClick={onFollowClick}
                          className={cx(
                            'inline-flex h-[31px] shrink-0 items-center justify-center rounded-[4px] px-3 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                            p.followed
                              ? 'border border-zh-line bg-card text-lt-grey hover:border-brand hover:text-brand'
                              : 'bg-brand text-white hover:bg-brand-hover',
                          )}
                        >
                          {p.followed ? t('cancel_follow') : t('add_follow')}
                        </button>
                      )}
                      <PmButton uid={uid} username={p.username} />
                    </span>
                  )}
                </div>
                <h1 className="mt-3 flex flex-wrap items-center gap-2 break-all text-xl font-bold text-foreground">
                  {p.username}
                  {p.online && (
                    <span className="inline-flex items-center gap-1 text-xs font-normal text-[#00b96b]" title={t('online_label')}>
                      <span className="size-1.5 rounded-full bg-[#00b96b]" />
                      {t('online_now')}
                    </span>
                  )}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex rounded-full bg-brand px-2 py-0.5 text-[11px] leading-none text-white">UID:{p.uid}</span>
                  {p.groupName && (
                    <span className="inline-flex rounded-full bg-info px-2 py-0.5 text-[11px] leading-none text-white">{gn(p.gid, p.groupName)}</span>
                  )}
                </div>
                {followErr && <p className="mt-2 text-xs text-destructive">{followErr}</p>}
                <ul className="m-0 mt-4 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-4">
                  <NumTile value={p.threads} label={t('posted_threads')} />
                  <NumTile value={p.posts} label={t('submitted_comments')} />
                  <NumTile value={p.following} label={t('following_count')} />
                  <NumTile value={p.followers} label={t('followers_count')} />
                </ul>
                {/* user-info 资料行（#909399 标题 + 值，发丝线分隔） */}
                <div className="mt-4 divide-y divide-zh-line border-t border-zh-line">
                  <UserInfoRow title={t('user_group_colon')}>{gn(p.gid, p.groupName)}</UserInfoRow>
                  <UserInfoRow title={t('description_colon')}>
                    {t('member_uid_prefix')}<b className="tabular-nums">{p.uid}</b>{t('member_uid_suffix')}<b>{fmtDate(p.createDate)}</b>
                  </UserInfoRow>
                  <UserInfoRow title={t('last_active_colon')}>{fmtDate(p.loginDate)}</UserInfoRow>
                </div>
              </div>
            </section>
          )
        ) : section === 'replies' ? (
          <section className="zh-card mb-4 overflow-hidden">
            <div className="zh-card-header px-5 py-3 text-[15px] font-bold">{t('his_replies')}</div>
            <UserReplyList uid={uid} active />
          </section>
        ) : section === 'following' ? (
          <section className="zh-card mb-4 overflow-hidden">
            <div className="zh-card-header px-5 py-3 text-[15px] font-bold">{t('his_following')}</div>
            {/* Ta 关注的（关注按钮态按当前访问者） */}
            <FollowUserList url={`/api/users/${uid}/following`} emptyText={t('no_follows')} onChanged={() => void qc.invalidateQueries({ queryKey: ['user', uid] })} />
          </section>
        ) : section === 'followers' ? (
          <section className="zh-card mb-4 overflow-hidden">
            <div className="zh-card-header px-5 py-3 text-[15px] font-bold">{t('his_followers')}</div>
            {/* 关注 Ta 的 */}
            <FollowUserList url={`/api/users/${uid}/followers`} emptyText={t('no_fans')} onChanged={() => void qc.invalidateQueries({ queryKey: ['user', uid] })} />
          </section>
        ) : (
          <section className="zh-card mb-4 overflow-hidden">
            <div className="zh-card-header px-5 py-3 text-[15px] font-bold">{t('his_posts')}</div>
            <div>
              {threads.error && <p className="px-5 py-3 text-sm text-destructive">{threads.error}</p>}
              <ThreadList data={{ list: threads.items, page: 1, size: threads.size, totalPage: 1 }} baseHref={() => '#'} />
              {threads.loaded && threads.items.length === 0 && !threads.error && <p className="px-5 py-10 text-center text-sm text-lt-grey">{t('no_threads')}</p>}
              {threads.canMore && (
                <div className="px-5 py-3 text-center">
                  <Button variant="secondary" size="sm" loading={threads.loading} loadingText={t('loading')} onClick={threads.loadMore}>
                    {t('load_more')}
                  </Button>
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
