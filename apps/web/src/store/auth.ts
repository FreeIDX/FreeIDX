/** useAuth：bootstrap 一次拉取（setting/forumlist/grouplist/me），Zustand 全局态（§10.3） */
import { create } from 'zustand';
import {
  md5Hex,
  type AnnouncementItem,
  type ForumNode,
  type GroupRow,
  type SiteSetting,
  type UserBrief,
} from '@freeidx/shared';
import { bootstrap, login, logout, onSessionExpired, register, type LoginResult, type RegisterResult } from '../lib/api';
import { queryClient } from '../lib/query-client';

interface AuthState {
  loaded: boolean;
  setting: SiteSetting | null;
  forumlist: ForumNode[];
  grouplist: GroupRow[];
  me: (UserBrief & {
    threads?: number;
    posts?: number;
    credits?: number;
    /** 三币种：金币 / 人民币（分，显示 ÷100） */
    golds?: number;
    rmbs?: number;
    /** A 组社交计数（bootstrap me） */
    followers?: number;
    following?: number;
    favorites?: number;
    /** 未读消息数（bootstrap me，导航铃铛徽标） */
    unreadNotices?: number;
    /** 账号审核状态（bootstrap me）：1=正常 0=待审核 -1=未通过；非 1 首页顶部提示 */
    ok?: number;
    /** 小黑屋（bootstrap me）：生效中的封禁位（0=未封禁/已到期）1 禁言 2 禁访 4 禁登 */
    banScope?: number;
    /** 封禁到期（unix 秒，0=永久） */
    banUntil?: number;
    banReason?: string;
    /** see_check 组（bootstrap me）：列表显示审核图标、帖内现场审核按钮 */
    seeCheck?: boolean;
    /** 预设头像路径（user.avatar_auto，如 /avatars/7.png；avatar=0 且已设预设时才下发） */
    avatar_auto?: string;
    /** 主页背景预设编号（user.bgimg，'0'=默认 bg-0.png） */
    bgimg?: string;
  }) | null;
  /** 站点运行数据（posts/users 计数，bootstrap 随下发） */
  runtime?: { posts: number; users: number };
  /** 首页系统公告（bootstrap 随下发，省掉独立请求） */
  announcements: AnnouncementItem[];
  /** 在线人数（bootstrap 随下发，省掉 GET /api/online?summary=1） */
  online: number;
  /** 扩展插件经 bootstrap:contribute 注入的字段（§12 契约⑦，如 checkin/ads 配置） */
  ext?: Record<string, unknown>;
  error: string | null;
  load: (force?: boolean) => Promise<void>;
  refresh: () => Promise<void>;
  signIn: (input: { account: string; password: string; turnstileToken?: string }) => Promise<LoginResult>;
  signUp: (input: {
    username: string;
    email: string;
    password: string;
    emailCode?: string;
    turnstileToken?: string;
  }) => Promise<RegisterResult>;
  signOut: () => Promise<void>;
}

/**
 * 在途请求单飞（性能项）：`main.tsx` 在模块求值时就发起 load()，`Layout` 挂载时还会再调一次。
 * 只判断 `loaded` 挡不住并发——bootstrap 未返回前两次调用都会真发请求（实测冷启动/慢网必现
 * 两个 /api/bootstrap，各打一次 D1，白等一个 RTT）。这里用模块级 Promise 合并。
 *
 * force（登录/登出/会话失效后的强制刷新）**不复用在途请求**：那个请求可能在本次鉴权变更
 * 之前就发出了，复用会拿到过期快照（例如刚登录完顶栏还是游客）。此时先等在途请求落地，
 * 再发一次新的；非 force 的并发调用则合并为同一次。
 */
let inflight: Promise<void> | null = null;

export const useAuth = create<AuthState>((set, get) => ({
  loaded: false,
  setting: null,
  forumlist: [],
  grouplist: [],
  me: null,
  announcements: [],
  online: 0,
  error: null,
  load: async (force = false) => {
    if (!force) {
      if (get().loaded) return;
      if (inflight) return inflight;
    } else if (inflight) {
      await inflight.catch(() => undefined);
    }
    /* 等待在途请求期间任意一方可能已经把数据填好（非 force 场景不必再发） */
    if (!force && get().loaded) return;
    inflight = (async () => {
      try {
        const d = await bootstrap();
        set({
          loaded: true,
          setting: d.setting,
          forumlist: d.forumlist,
          grouplist: d.grouplist,
          me: d.me,
          runtime: d.runtime,
          ext: d.ext,
          announcements: d.announcements ?? [],
          online: d.online ?? 0,
          error: null,
        });
      } catch (e) {
        // 原始错误只在这里能看到：超时（ApiTimeoutError）、断网（TypeError）与服务端 5xx
        // 都可能是同一条「系统繁忙」之外的现场信息，控制台留痕便于用户/站长自查
        console.error('[auth] bootstrap failed:', e);
        set({ error: e instanceof Error ? e.message : String(e) });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  },
  refresh: async () => {
    await get().load(true);
    // 改密/会话失效等场景同样改变了鉴权态：详情/列表的 perms 与计数由服务端按访问者下发，
    // 与 signIn/signUp/signOut 同口径失效全量缓存，避免游客界面配登录态缓存。
    void queryClient.invalidateQueries();
  },
  // 后端要求前端预哈希 md5(明文)（§8.4），登录/注册成功后 re-fetch bootstrap 让 me 生效
  // 鉴权态变更后失效全量 react-query 缓存：详情/列表的 allowupdate/allowdelete/计数由服务端按访问者下发，须随之刷新
  signIn: async (input) => {
    const r = await login({ account: input.account, password: md5Hex(input.password), turnstileToken: input.turnstileToken });
    await get().load(true);
    // 跨账号切换必须清空查询缓存：私域 key（['me']/['my-credits']/['my-favorites']…）不含 uid，
    // invalidate 只标 stale，新账号首帧仍会渲染上一账号的邮箱/余额/订单。
    queryClient.clear();
    return r;
  },
  signUp: async (input) => {
    const r = await register({
      username: input.username,
      email: input.email,
      password: md5Hex(input.password),
      emailCode: input.emailCode,
      turnstileToken: input.turnstileToken,
    });
    await get().load(true);
    queryClient.clear();
    return r;
  },
  signOut: async () => {
    // 登出请求失败（CSRF 缺失/网络抖动）也必须清掉本地登录态：
    // 否则调用方 `.finally(() => navigate('/'))` 会跳首页，界面却仍显示已登录（顶栏头像/待办数），
    // 而服务端会话可能已失效 → 后续请求 401 前端不自知。
    try {
      await logout();
    } catch {
      // 登出接口失败（CSRF 缺失/网络抖动）不阻断本地清理：服务端会话可能已失效，
      // 前端继续显示「已登录」会造成后续请求 401 而界面不自知。
    } finally {
      await get().load(true);
      // 登出必须移除私域缓存（邮箱/余额/订单/收藏），否则同浏览器下一账号可见
      queryClient.clear();
    }
  },
}));
/*
 * 会话失效全局兜底：任何 API 信封返回 NOT_LOGIN 且本地仍是登录态（me 非空）时——
 * 服务端已吊销会话（改密/登出 = 全端 tv+1、100 天过期、管理员强制下线）——
 * 重拉 bootstrap 同步为游客态并失效全量查询缓存，让顶栏/操作按钮与真实态一致，
 * 而不是每个请求各自散点报「请登录」（P4：前台缺 401 → 感知 → 重登闭环）。
 * 5s 节流：并发请求同时 401 只触发一次刷新；游客本就 me=null，通知直接忽略。
 */
let lastSessionExpiredAt = 0;
onSessionExpired(() => {
  const { me, load } = useAuth.getState();
  if (!me) return;
  const nowTs = Date.now();
  if (nowTs - lastSessionExpiredAt < 5000) return;
  lastSessionExpiredAt = nowTs;
  void load(true).then(() => queryClient.invalidateQueries());
});
