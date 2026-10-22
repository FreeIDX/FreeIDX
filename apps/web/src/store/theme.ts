/**
 * 简蓝主题运行时（前台主题层）：
 *  - useLight()：读取 bootstrap 契约⑦下发的 ext.light（发现页/轮播/友链/标签/列表样式/底栏/字体/暗色），
 *    扩展被后台停用时返回内置出厂默认（与 light.ts parseLightConfig 的缺省一致）。
 *  - 暗色三态（Cookie `Theme`：1=按时段自动 / 2=日间 / 3=夜间；开关由顶栏月亮按钮驱动）：
 *    状态持久化 localStorage['light.theme']，自动档按时段（darkTime1→darkTime2 跨零点）每分钟校验一次，
 *    最终以 <html class="dark"> 落地（globals.css `.dark .theme-zh` 令牌整体切换）。
 */
import { create } from 'zustand';
import { useEffect, useMemo } from 'react';
import { useAuth } from './auth';

export interface LightSlide {
  name: string;
  url: string;
  pic: string;
}
interface LightLink {
  name: string;
  url: string;
}
interface LightTag {
  name: string;
  style: string;
}

interface LightConfig {
  enabled: boolean;
  discPage: boolean;
  slides: LightSlide[];
  links: LightLink[];
  tags: LightTag[];
  /** 帖子页上一篇/下一篇双卡（出厂默认关） */
  preNextThread: boolean;
  /** 列表图片组张数 3/6/9 */
  summaryPic: number;
  dockSwitch: boolean;
  /** 楼层「查看所有回复」入口 */
  showAllReply: boolean;
  backTop: boolean;
  threadListStyle: 1 | 2 | 3;
  threadSummary: boolean;
  /** 列表摘要字数（0 = 不显示摘要行） */
  summaryWord: number;
  threadForumName: boolean;
  threadLastReply: boolean;
  threadRankCard: boolean;
  /** 侧栏「热门收藏」卡（出厂默认关） */
  hotFavoriteCard: boolean;
  /** 热门收藏条数（hot_favorite_count） */
  hotFavoriteCount: number;
  /** 热门收藏统计窗口天数 */
  hotFavoriteDays: number;
  /** 回复点赞开关 */
  postLike: boolean;
  /** 帖子内「热门回复」卡 */
  hotLikePost: boolean;
  /** 热门回复点赞阈值（hot_like_post_low_count） */
  hotLikePostLowCount: number;
  /** 热门回复条数（hot_like_post_size） */
  hotLikePostSize: number;
  /** 热门回复是否包含主贴（hot_like_isfirst） */
  hotLikeIsFirst: boolean;
  /** 登录/注册页公告 */
  loginAnnouncement: string;
  /** 快捷回复上方公告 */
  commentAnnouncement: string;
  /** 发帖页公告 */
  postAnnouncement: string;
  /** 页脚一级文案（footer_one_content） */
  footerOneContent: string;
  /** 页脚二级文案（footer_two_content） */
  footerTwoContent: string;
  /** 页脚联系 QQ */
  footerContactQq: string;
  /** 页脚联系微信 */
  footerContactWx: string;
  /** 页脚联系邮箱 */
  footerContactEmail: string;
  /** 发现页标题（disc_page_title，缺省回落 t('discovery')） */
  discPageTitle: string;
  /** 楼层号显示（post_show_floors） */
  postShowFloors: boolean;
  /** 回帖时间换行显示（post_show_time） */
  postShowTime: boolean;
  /** 楼层操作区位置（post_func_position：0=头部行，1=正文下方） */
  postFuncPosition: 0 | 1;
  /** 帖内左侧悬浮工具栏（thread_left_switch） */
  threadLeftSwitch: boolean;
  /** 帖子页顶部面包屑（thread_top_nav） */
  threadTopNav: boolean;
  /** 回帖后整页刷新（thread_reply_reload） */
  threadReplyReload: boolean;
  /** 列表标题字号 px（thread_subject_size） */
  threadSubjectSize: number;
  /** 首页右栏用户信息卡（index_userinfo） */
  indexUserinfo: boolean;
  /** 首页右栏站点数据卡（site_info_total） */
  siteInfoTotal: boolean;
  /** 列表「新帖」角标（new_thread） */
  newThread: boolean;
  /** 帖子页脚信息（thread_footer_info） */
  threadFooterInfo: boolean;
  /** 帖子页脚信息内容（thread_footer_info_content） */
  threadFooterInfoContent: string;
  /** 登录/注册/找回页左栏背景图（login_page_banner，空=login_bg.png） */
  loginPageBanner: string;
  /** 页脚 Logo（footer_icon_show） */
  footerIconShow: boolean;
  /** 页脚版权行（theme_copyright_switch） */
  themeCopyrightSwitch: boolean;
  /** 顶栏搜索框（nav_search_form） */
  navSearchForm: boolean;
  /** 顶栏金币/积分显示（header_gold_count） */
  headerGoldCount: boolean;
  /** 楼层快捷 @ 提及（thread_quick_at） */
  threadQuickAt: boolean;
  bodyFontStyle: 0 | 1 | 2;
  /** 主页背景设置开关 */
  userBgSwitch: boolean;
  /** 可选背景数量（预设 /theme-light/bgimg/bg-1..N.png） */
  userBgNum: number;
  darkMode: boolean;
  darkTime1: number;
  darkTime2: number;
}

/** 出厂默认（等同 api 侧 parseLightConfig({}) 的缺省形态） */
const LIGHT_DEFAULTS: LightConfig = {
  enabled: false,
  discPage: false,
  slides: [],
  links: [],
  tags: [],
  preNextThread: false,
  summaryPic: 3,
  dockSwitch: false,
  showAllReply: true,
  backTop: true,
  threadListStyle: 1,
  threadSummary: true,
  summaryWord: 100,
  threadForumName: true,
  threadLastReply: true,
  threadRankCard: true,
  hotFavoriteCard: false,
  hotFavoriteCount: 10,
  hotFavoriteDays: 30,
  postLike: true,
  hotLikePost: true,
  hotLikePostLowCount: 10,
  hotLikePostSize: 5,
  hotLikeIsFirst: false,
  loginAnnouncement: '',
  commentAnnouncement: '',
  postAnnouncement: '',
  footerOneContent: '',
  footerTwoContent: '',
  footerContactQq: '',
  footerContactWx: '',
  footerContactEmail: '',
  discPageTitle: '',
  postShowFloors: true,
  postShowTime: false,
  postFuncPosition: 0,
  threadLeftSwitch: true,
  threadTopNav: true,
  threadReplyReload: false,
  threadSubjectSize: 14,
  indexUserinfo: true,
  siteInfoTotal: true,
  newThread: false,
  threadFooterInfo: false,
  threadFooterInfoContent: '',
  loginPageBanner: '',
  footerIconShow: true,
  themeCopyrightSwitch: true,
  navSearchForm: true,
  headerGoldCount: true,
  threadQuickAt: false,
  bodyFontStyle: 0,
  userBgSwitch: true,
  userBgNum: 9,
  darkMode: false,
  darkTime1: 19,
  darkTime2: 7,
};

/** 主题配置：优先 bootstrap ext.light；未启用/加载中回落出厂默认 */
export function useLight(): LightConfig {
  const ext = useAuth((s) => s.ext);
  const raw = ext?.light as Partial<LightConfig> | undefined;
  /* 引用稳定性：此前每次调用都新建对象，任何把它放进 deps/props/memo 的地方都会整体失效；
     ext.light 未变时现在返回同一引用（关闭态本就是模块级常量 LIGHT_OFF）。 */
  return useMemo(() => {
    if (!raw || raw.enabled !== true) return LIGHT_OFF;
    return { ...LIGHT_DEFAULTS, ...raw, enabled: true };
  }, [raw]);
}

/**
 * 扩展停用（或 bootstrap 未下发 ext.light）时的形态：所有「配置面」功能一律关闭，
 * 前台零残留（发现页/轮播/友链/标签/底栏/回顶/排行卡/楼层点赞/热门回复/公告/页脚文案/主页背景…全隐）。
 * 列表样式等渲染基元保持中性默认（样式 1），不影响基础可读性——React 前台即简蓝主题本体，
 * 不存在「停用后回退到另一套模板」的形态，故只回退配置面而非整套视觉。
 */
const LIGHT_OFF: LightConfig = {
  ...LIGHT_DEFAULTS,
  enabled: false,
  discPage: false,
  slides: [],
  links: [],
  tags: [],
  preNextThread: false,
  dockSwitch: false,
  showAllReply: false,
  backTop: false,
  threadSummary: false,
  threadForumName: false,
  threadLastReply: false,
  threadRankCard: false,
  hotFavoriteCard: false,
  postLike: false,
  hotLikePost: false,
  userBgSwitch: false,
  darkMode: false,
  loginAnnouncement: '',
  commentAnnouncement: '',
  postAnnouncement: '',
  footerOneContent: '',
  footerTwoContent: '',
  footerContactQq: '',
  footerContactWx: '',
  footerContactEmail: '',
  discPageTitle: '',
  postShowFloors: false,
  postShowTime: false,
  postFuncPosition: 0,
  threadLeftSwitch: false,
  threadTopNav: false,
  threadReplyReload: false,
  indexUserinfo: false,
  siteInfoTotal: false,
  newThread: false,
  threadFooterInfo: false,
  threadFooterInfoContent: '',
  loginPageBanner: '',
  footerIconShow: false,
  themeCopyrightSwitch: false,
  navSearchForm: false,
  headerGoldCount: false,
  threadQuickAt: false,
};

/** 主页背景 CSS：userBgSwitch 开启且用户选了非默认背景时返回 background-image 值；
 *  预设图缺失时多层回退默认 bg-0.webp（bg-1..N 由站长上传，缺图不破版） */
export function userBgImage(bgimg: string | undefined, cfg: LightConfig): string | undefined {
  const n = Number(bgimg ?? 0);
  if (!cfg.userBgSwitch || !Number.isFinite(n) || n <= 0) return undefined;
  return `url(/theme-light/bgimg/bg-${n}.png), url(/theme-light/bg-0.webp)`;
}

type ThemeMode = 'auto' | 'day' | 'night';

const MODE_KEY = 'light.theme';

function readMode(): ThemeMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === 'day' || v === 'night' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

interface ThemeState {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  /** 三态轮换（顺序：自动 → 日间 → 夜间） */
  cycle: () => void;
}

export const useThemeMode = create<ThemeState>((set, get) => ({
  mode: readMode(),
  setMode: (m) => {
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* 隐私模式下忽略 */
    }
    set({ mode: m });
  },
  cycle: () => {
    const order: ThemeMode[] = ['auto', 'day', 'night'];
    const next = order[(order.indexOf(get().mode) + 1) % order.length] ?? 'auto';
    get().setMode(next);
  },
}));

/** 夜间判定：跨零点时段（如 19→7） */
function isNightHour(hour: number, from: number, to: number): boolean {
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * 应用暗色到 <html>：Layout 挂载一次。
 * 自动档每 60s 校验（跨时段自动切换），手动档即时生效。
 */
export function useApplyTheme(cfg: LightConfig) {
  const mode = useThemeMode((s) => s.mode);
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const night =
        cfg.darkMode && (mode === 'night' || (mode === 'auto' && isNightHour(new Date().getHours(), cfg.darkTime1, cfg.darkTime2)));
      root.classList.toggle('dark', night);
    };
    apply();
    if (!cfg.darkMode || mode !== 'auto') return;
    const timer = window.setInterval(apply, 60_000);
    return () => window.clearInterval(timer);
  }, [cfg.darkMode, cfg.darkTime1, cfg.darkTime2, mode]);
}