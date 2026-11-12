/**
 * 前后端共用 DTO 骨架（§6、铁律 6：共享契约先于前后端分工）。
 * 统一响应信封：{ code, message, ...data }。
 */
import type { DocType, GroupId, Top, Digest, Closed } from './constants';
import type { ContentLang } from './content-lang';
import type { NameI18nMap } from './forum-name';
import type { UserPerm } from './permissions';

export interface ApiEnvelope {
  /** 0 成功；<0 全局错误；>0 表单级业务错误（Codes） */
  code: number;
  message: string;
  [extra: string]: unknown;
}

interface Paged<T> {
  list: T[];
  page: number;
  /** 总页数（版块列表取缓存 forum.threads 计算，无 COUNT） */
  totalPage: number;
  /** 游标翻页参数（§7 禁 OFFSET；>100 页倒排） */
  nextCursor?: number;
}

export interface UserBrief {
  uid: number;
  gid: number;
  username: string;
  /** avatar 时间戳，前端拼 R2 URL cache-buster */
  avatar: number;
}

export interface ForumNode {
  fid: number;
  name: string;
  /** 版块名多语言（0027）：locale → 名称；缺省/空 = 未配置，展示回退 name。
   *  前台按当前界面语言取词（forumNameOf），切换语言即时生效，无需重新请求。 */
  nameI18n?: Record<string, string>;
  rank: number;
  brief: string;
  /** 版块简介多语言（0028）：locale → 简介；缺省/空 = 未配置，展示回退 brief。
   *  **bootstrap 不下发**（28 版块 × 10 语言 ≈ 15KB gzip，占整包 66%）：只有发现页需要，
   *  改由 GET /api/forums/briefs 按需拉取（见 ForumBriefsPayload）。 */
  briefI18n?: Record<string, string>;
  threads: number;
  todayposts: number;
  todaythreads?: number;
  /** SEO 标题（0028，单值）。**不下发多语言映射**：前端零引用，SEO 产物由 prerender
   *  直接查库、固定按站点语言取词生成（apps/api/src/modules/seo/core.ts），
   *  10 个语言副本里只有 1 个会进 HTML —— 下发整份 map 每次 bootstrap 要多背 11KB。 */
  seoTitle: string;
  /** SEO 关键词（0028，单值；多语言映射同上，不下发） */
  seoKeywords: string;
  /** 版块图标版本号（存"最后更新时间"，>0 即有图标） */
  icon?: number;
  /** 自定义图标直链（后台上传，/files/forum/{fid}.xxx?v=ts）；空 = 前台用内置默认图 */
  iconUrl?: string;
  /** 版块栏图标显示开关（0029）：0 = 前台版块栏只显示版块名、不渲染图标；缺省/1 = 显示 */
  iconShow?: number;
  /** 版块公告（公告卡/绿底 alert）。bootstrap 只下发这个单值；
   *  公告多语言（0028）由版块页自己的 GET /api/forums/:fid/threads 随 forum 对象下发。 */
  announcement?: string;
  /** 上级版块 fid，0/缺省 = 一级版块（0018_forum_parent，仅两级） */
  parentFid?: number;
  /** 生效内容语言（0024，已含父版块继承与「显式不限制」哨兵解析）：空/缺省 = 不限制；
   *  非空 = 本版块新主题强制该语言（发帖页锁定语言选择）。哨兵值不会出现在此字段。 */
  lang?: ContentLang | '';
  /** 二级导航（并入 bootstrap） */
  children?: ForumNode[];
}

/**
 * GET /api/forums/briefs：版块简介多语言（0028）的按需下发。
 * 由发现页「全部版块」网格消费；只含当前访问者可见且**配了多语言简介**的版块。
 */
export interface ForumBriefsPayload {
  list: Array<{ fid: number; briefI18n: Record<string, string> }>;
}

/** 列表行：thread 反规范化列 → 零 JOIN 零 user 查询（§5.2） */
export interface ThreadListItem {
  tid: number;
  fid: number;
  top: number & (typeof Top)[keyof typeof Top];
  digest: number & (typeof Digest)[keyof typeof Digest];
  closed: number & (typeof Closed)[keyof typeof Closed];
  uid: number;
  username: string;
  avatar: number;
  subject: string;
  posts: number;
  views: number;
  images: number;
  files: number;
  lastpid: number;
  lastuid: number;
  lastusername: string;
  createDate: number;
  lastDate: number;
  /** 审核状态：1=正常 0=待审核 -1=未通过 -2=回收站；非 1 仅作者与 see_check 组可见 */
  ok: number;
  /** 付费主题价格：>0 即收费帖；type 1=经验 2=金币 3=人民币（单位分，显示时 ÷100） */
  contentBuy: number;
  contentBuyType: number;
  /** 作者认证头衔（'0'=未认证；列表按页批量补查，仅认证用户下发） */
  uv?: string;
  /** 作者预设头像路径（如 /avatars/7.png；avatar=0 且 avatar_auto 非 '0' 时下发） */
  avatar_auto?: string;
  /** 标签（简蓝主题 idx_tag 轻量实现）：逗号分隔的标签名（≤4），空/缺省 = 无标签 */
  tags?: string;
  /** 列表图片组（thread_summary_pic）：首帖图片地址，逗号分隔（≤9），空/缺省 = 无图 */
  imageUrls?: string;
  /** 列表摘要（thread_summary_word）：首帖去标签纯文本（≤300 字），空/缺省 = 无摘要 */
  summary?: string;
  /** 搜索命中正文摘要（仅 /api/search range=all 下发，≤120 字；前端据此高亮关键词） */
  snippet?: string;
  /** 内容语言（zh/en/ja/ko/ru/th/de/fr/es/other；空/缺省 = 未指定，不参与语言过滤） */
  lang?: string;
  /** 已读标记为纯前端 localStorage，不占 DTO */
}

/** 站内搜索 range=user 的用户命中项（idx_search「用户」范围；公开字段零敏感） */
export interface SearchUserHit {
  uid: number;
  username: string;
  avatar: number;
  /** 预设头像路径（avatar=0 且 avatar_auto 非 '0' 时下发） */
  avatar_auto?: string;
}

/** 楼层「查看所有回复」条目（show_all_reply：quotepid 命中的直接回复 / head 为该楼层本身） */
export interface PostReplyItem {
  pid: number;
  uid: number;
  username: string;
  avatar: number;
  /** 预设头像路径（avatar=0 且 avatar_auto 非 '0' 时下发） */
  avatar_auto?: string;
  createDate: number;
  messageFmt: string;
}

/** GET /api/posts/:pid/replies 响应体 */
export interface PostRepliesData {
  head: PostReplyItem;
  list: PostReplyItem[];
  page: number;
  size: number;
  total: number;
  totalPage: number;
}

export interface AttachItem {
  aid: number;
  tid: number;
  pid: number;
  /**
   * 刻意不下发 R2 对象 key：正式附件 key 形如 `attach/YYYYmm/xxx.ext`，
   * 一旦随详情下发即可被 `/files/attach/...` 匿名直取，绕过 allowdown / 付费主题 / 付费附件三重校验。
   * 下载统一走 `GET /api/attachments/:aid/download`，内联预览走 `GET /api/attachments/:aid/preview`。
   */
  orgfilename: string;
  filesize: number;
  isimage: number;
  width: number;
  height: number;
  downloads: number;
  createDate: number;
  /** 付费附件价格（积分，0=免费，§15.1）：前端据此渲染付费墙与下载放行 */
  credits?: number;
}

export interface PostItem {
  pid: number;
  tid: number;
  uid: number;
  username: string;
  avatar: number;
  /** 作者认证头衔（'0'=未认证；楼层头像旁 V 标 title） */
  v?: string;
  /** 作者预设头像路径（avatar=0 且 avatar_auto 非 '0' 时下发） */
  avatar_auto?: string;
  isfirst: number;
  doctype: number & (typeof DocType)[keyof typeof DocType];
  quotepid: number;
  /** 仅详情页返回；列表页绝不触碰 message/message_fmt（§7 禁 SELECT *） */
  message?: string;
  messageFmt: string;
  images: number;
  files: number;
  userip?: number; // 仅 allowviewip 组返回
  createDate: number;
  /** 审核状态（tt_check OK 列）：1=正常 0=待审核 -1=未通过（回帖无 -2：普通回帖删除即真删） */
  ok: number;
  allowupdate: boolean;
  allowdelete: boolean;
  attaches?: AttachItem[];
  quoted?: { pid: number; username: string; messageSnippet: string };
  /** 楼层点赞数（bbs_post_like 实时 COUNT） */
  likes: number;
  /** 当前访问者是否已赞该楼层 */
  liked: boolean;
}

/** GET /api/threads/:tid/hot-posts 响应：帖子内「热门回复」卡 */
export interface HotPostsData {
  /** 按点赞数倒序的热门回复（PostItem 同构，isfirst 恒为 1 或 0，仅首页展示） */
  list: PostItem[];
  /** 生效的点赞阈值 */
  threshold: number;
  limit: number;
}

/** GET /api/mod/forums/:fid：版务页权限（服务端计算，前端不推断） */
export interface ModForumData {
  fid: number;
  name: string;
  /** 版块名多语言（0027）：前台按当前界面语言取词，缺省回退 name */
  nameI18n?: Record<string, string>;
  perms: { allowmod: boolean; allowdelete: boolean; allowmove: boolean };
}

export interface ThreadDetail {
  thread: ThreadListItem;
  /** nameI18n：版块名多语言（0027），前台按当前界面语言取词 */
  forum: { fid: number; name: string; moduids: string; nameI18n?: Record<string, string> };
  posts: Paged<PostItem>;
  /** 当前用户对本帖的可操作位（服务端计算，前端不做权限推断） */
  perms: {
    allowpost: boolean;
    allowupdate: boolean;
    allowdelete: boolean;
    allowmod: boolean;
    /** see_check 组：可见他人未过审内容并在帖内现场审核 */
    seeCheck: boolean;
  };
  /** 点赞（tid 级，bbs_like 实时 COUNT）+ 当前访问者是否已赞 */
  likes: number;
  liked: boolean;
  /** 收藏数 + 当前访问者是否已收藏（bbs_favorite） */
  favorites: number;
  favorited: boolean;
  /** tt_credits：付费内容是否可见（作者本人 / 已购 / content_buy=0 或无 [ttPay] 段时为 true） */
  purchased: boolean;
  /** thread_postlist_before：同版块上一篇（tid 更小者；无则 null 或不下发） */
  prev?: { tid: number; subject: string } | null;
  /** 同版块下一篇（tid 更大者；无则 null 或不下发） */
  next?: { tid: number; subject: string } | null;
}

/** 收藏者：GET /api/threads/:tid/favoriters */
export interface FavoriterItem {
  uid: number;
  username: string;
  avatar: number;
}

/** GET /api/bootstrap 一次下发：版块树 + 当前用户 + 二级导航 + 插件贡献字段 */
export interface BootstrapPayload {
  version: string;
  setting: SiteSetting;
  forumlist: ForumNode[];
  grouplist: GroupRow[];
  me:
    | (UserBrief & {
        email?: string;
        threads: number;
        posts: number;
        credits: number;
        /** 三币种：金币 / 人民币（分，显示时 ÷100） */
        golds: number;
        rmbs: number;
        /** 社交计数（bbs_follow/bbs_favorite 实时 COUNT） */
        followers: number;
        following: number;
        favorites: number;
        /** 未读消息数（bbs_notice 实时 COUNT） */
        unreadNotices: number;
        /** 账号审核状态：1=正常 0=待审核 -1=未通过；非 1 时前台顶部提示且禁发帖回帖 */
        ok: number;
        /** see_check 组：可见他人未过审内容并在帖内现场审核 */
        seeCheck: boolean;
        /** 认证头衔（'0'=未认证；个人中心头像旁 V 标） */
        v?: string;
        /** 预设头像路径（avatar=0 且 avatar_auto 非 '0' 时下发） */
        avatar_auto?: string;
        /** 主页背景预设编号（'0'=默认 bg-0.png） */
        bgimg?: string;
      })
    | null;
  /** 扩展插件经 bootstrap:contribute 注入（§12 契约 ⑦），如 ads 配置 */
  ext?: Record<string, unknown>;
  /** 站点运行数据：全站贴子总数 + 用户数，60s 读穿缓存 */
  runtime?: { posts: number; users: number };
  /** 首页系统公告（0011）：随 bootstrap 下发，省掉 GET /api/announcements 这一次冷启动请求 */
  announcements?: AnnouncementItem[];
  /** 在线人数（bbs_session 计数）：随 bootstrap 下发，省掉 GET /api/online?summary=1 */
  online?: number;
}

/** 首页公告条条目（bbs_announcement，isshow=1，aid 倒序 ≤10 条） */
export interface AnnouncementItem {
  aid: number;
  /** 已还原 HTML 实体的原文（写侧入库时转义过，见 apps/api/src/core/fmt.ts 的 unescapeHtmlEntities） */
  message: string;
  createDate: number;
}

export interface SiteSetting {
  sitename: string;
  brief: string;
  runlevel: number;
  url: string;
  kw: string;
  desc: string;
  /** 关闭原因（runlevel 0/1 时给访客的提示；缺省用内置文案） */
  runlevelReason?: string;
  /**
   * 基础设置五个文本字段的多语言覆盖（kv setting 的 `*_i18n` 键，locale → 文本）。
   * 前台按当前界面语言取词（localizedSetting），未配置的语言回退上面的主字段。
   */
  sitenameI18n?: NameI18nMap;
  briefI18n?: NameI18nMap;
  kwI18n?: NameI18nMap;
  descI18n?: NameI18nMap;
  runlevelReasonI18n?: NameI18nMap;
  userCreateOn: boolean;
  userCreateEmailOn: boolean;
  userResetpwOn: boolean;
  /**
   * 邮件通道是否可用（SMTP 池非空）。由 bootstrap 现算后随 setting 下发，缺省视为可用：
   * 后台只把 `user_create_email_on` 打开却没配 SMTP 池时，后端实际按「验证关闭」降级（§11.3），
   * 前端据此同步隐藏验证码输入框，避免出现「必填验证码但发码永远失败」的死路。
   */
  mailOn?: boolean;
  forumOrderby: 0 | 1; // 0 顶贴时间 1 发帖时间
  updateViewsOn: boolean;
  uploadMaxSize: number;
  lang: string;
  /** 后台界面语言（后台设置 admin_lang，与前台站点 lang 相互独立；缺省回落 lang） */
  adminLang: string;
  /** 积分发放数值（后台可配，kv setting；0=关闭该来源，§15.1） */
  creditThread?: number;
  creditReply?: number;
  creditDailyFirst?: number;
  /** 注册审核开关（tt_check user_check：新注册用户 ok=0 待审核，未过审禁发帖回帖） */
  userCheck: boolean;
  /** 回收站开关（tt_check recycle：版主删除主题改为软删除 ok=-2） */
  recycle: boolean;
  /** 设备访问三开关（后台基础设置；键缺省 = 开启） */
  devicePhoneOn: boolean;
  deviceTabletOn: boolean;
  deviceTvOn: boolean;
  /** 前台 Logo 直链（后台基础设置上传，/files/site/logo.*；空 = 前台用内置默认 logo 图 assets/theme/logo-default.svg） */
  logo_url?: string;
  /** 站点图标 Favicon 直链（后台基础设置上传，/files/site/favicon.*；空 = 无自定义图标） */
  favicon_url?: string;
  /** 顶部导航栏自定义项（后台「导航栏设置」，kv setting 存 JSON 字符串，归一化为数组；空/缺省 = 前台回落默认导航） */
  nav?: NavItem[];
  /**
   * 内容语言分区模式（后台「内容语言」设置，kv setting.content_lang）：
   * 0 = 关闭（默认，行为与改造前完全一致）
   * 1 = 开启，列表默认「全部语言」，用户可在筛选条自行切换
   * 2 = 开启，列表默认跟随界面语言（适合内容已回填、希望默认分流的站点）
   */
  contentLang?: number;
  [k: string]: unknown;
}

/** 顶部导航栏单项（后台「导航栏设置」可配：链接到版块 /thread、文章或自定义地址） */
export interface NavItem {
  /** 显示名称（默认名称：未配置当前语言译文时回退它） */
  label: string;
  /** 名称多语言：locale → 名称（与版块名 name_i18n 同一结构，前台按当前界面语言取词） */
  labels?: Record<string, string>;
  /**
   * 图标名（可选）：取自前台图标集 `components/icons.tsx` 的语义名（如 `flame`、`tag`）。
   * 前台渲染前会做白名单校验，未知名称静默忽略（只显示名称），不会白屏；
   * 空/缺省 = 不显示图标（外部链接仍显示外链小图标）。
   */
  icon?: string;
  /**
   * 自定义图标直链（可选）：后台「导航栏设置」上传图片后由服务端落 R2（`site/nav/{随机段}.{ext}`），
   * 本字段只保存这条站内直链（服务端白名单校验，不收外部 URL）。
   * 前台优先渲染这张图，其次才回退 `icon` 内置图标；空/缺省 = 不显示图标。
   */
  iconUrl?: string;
  /** 链接目标：站内路径（/forum/{fid}、/thread/{tid}、/new 等）或完整 URL */
  url: string;
  /** 排序（小在前） */
  sort: number;
  /** 是否启用（1=显示 0=隐藏） */
  on: 0 | 1;
}

export interface GroupRow {
  gid: number & (typeof GroupId)[keyof typeof GroupId];
  name: string;
  creditsfrom: number;
  creditsto: number;
  /** 收费帖权限（tt_credits allowsell）：1=该组可在发帖时设置付费内容 */
  allowsell: number;
}

export interface RegisterReq {
  username: string;
  email: string;
  /** 迁移期保留前端预哈希：md5(明文)，服务端 PBKDF2 再哈希（§8.4） */
  password: string;
  emailCode?: string;
  turnstileToken?: string;
}

export interface LoginReq {
  account: string; // email 或 username
  password: string;
  turnstileToken?: string;
}

export interface CreateThreadReq {
  fid: number;
  subject: string;
  message: string;
  doctype: number;
  attachAids?: number[];
  /** 收费帖设置：仅 allowsell 组生效；>0 即收费，type 1=经验 2=金币 3=人民币（单位分） */
  contentBuy?: number;
  contentBuyType?: number;
  /** Turnstile 挂件产出的一次性 token；服务端未配 TURNSTILE_SECRET 时可不带（附录 B 同位挂载） */
  turnstileToken?: string;
  /** 标签（简蓝主题）：≤4 个，服务端归一（剔空白/逗号、单标签 ≤12 字、去重）后落 thread.tags */
  tags?: string[];
  /** 内容语言（zh/en/ja/ko/ru/th/de/fr/es/other）：显式选择优先，缺省由服务端按标题+正文自动检测 */
  lang?: string;
}

export interface CreatePostReq {
  message: string;
  doctype: number;
  quotepid?: number;
  attachAids?: number[];
  turnstileToken?: string;
}

export interface ModThreadsReq {
  tids: number[];
  action: 'top' | 'untop' | 'close' | 'delete' | 'move' | 'digest';
  value?: number; // top/digest 级别或 move 目标 fid
}

export type { UserPerm };
