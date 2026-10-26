/**
 * 后台接口返回的行类型——字段名逐字对齐 apps/api 的显式投影（本仓库禁 `SELECT *`，投影即可用列）。
 * 两处易错口径：
 *  1. `/api/admin/users` 在 USER_PUBLIC_COLS 之外**额外**投影 email + create_ip
 *     （服务端补 `create_ip_fmt`=long2ip）；前台的 /api/user/:uid 仍是纯 USER_PUBLIC_COLS，不带邮箱。
 *  2. `/api/bootstrap` 的 `me` 用 camelCase（createDate），后台行用 snake_case（create_date），不可混用。
 */
import type { ExtSchema, LocText } from '@freeidx/shared';

/** 版块权限矩阵的一行（bbs_forum_access，按 gid 归档） */
interface ForumAccessRow {
  fid: number;
  gid: number;
  allowread: number;
  allowthread: number;
  allowpost: number;
  allowattach: number;
  allowdown: number;
}

/** GET /api/admin/forums 的版块行 = FORUM_COLS + loader 计算的 accesslist */
export interface AdminForumRow {
  fid: number;
  name: string;
  rank: number;
  threads: number;
  todayposts: number;
  todaythreads: number;
  brief: string;
  announcement: string;
  accesson: number;
  orderby: number;
  icon: number;
  /** 自定义图标 R2 key（如 forum/3.png），空 = 未上传 */
  icon_file: string;
  /** 图标上传时间戳（缓存版本号） */
  icon_time: number;
  /** 图标直链（icon_file 非空才有值；空 = 前台用内置默认图） */
  icon_url: string;
  /** 逗号分隔的版主 uid */
  moduids: string;
  seo_title: string;
  seo_keywords: string;
  /** 上级版块 fid，0 = 一级版块（0018_forum_parent，仅两级） */
  parent_fid: number;
  /** 绑定内容语言原始值（0024）：'' = 未绑定（子版块继承父版块，顶级版块不限制）；'none' = 显式不限制（仅子版块）；其余 = 强制该语言 */
  lang: string;
  accesslist: Record<string, ForumAccessRow>;
}

/** bbs_group 全列（loadGrouplist 用 SELECT * ——仓库内唯一豁免处） */
export interface GroupFullRow {
  gid: number;
  name: string;
  creditsfrom: number;
  creditsto: number;
  allowread: number;
  allowthread: number;
  allowpost: number;
  allowattach: number;
  allowdown: number;
  allowtop: number;
  allowupdate: number;
  allowdelete: number;
  allowmove: number;
  allowbanuser: number;
  allowdeleteuser: number;
  allowviewip: number;
}

/** 版块表单提交的权限矩阵条目（gid<=0 的条目服务端静默丢弃） */
export interface AccessInput {
  gid: number;
  allowread: number;
  allowthread: number;
  allowpost: number;
  allowattach: number;
  allowdown: number;
}

export interface ForumInput {
  name: string;
  rank?: number;
  brief?: string;
  announcement?: string;
  accesson?: number;
  orderby?: number;
  icon?: number;
  moduids?: string;
  seo_title?: string;
  seo_keywords?: string;
  /** 上级版块 fid：0/缺省 = 一级版块；>0 挂到该一级版块下（仅两级） */
  parent_fid?: number;
  /** 绑定内容语言原始值（0024）：''/缺省 = 未绑定（子版块继承父版块，顶级版块不限制）；'none' = 显式不限制（仅子版块）；其余 = 强制该语言 */
  lang?: string;
  /** 仅在此键存在时整体替换权限矩阵；提交标量字段时不要带上，否则矩阵被清空 */
  access?: AccessInput[];
}

/** 用户组表单提交项：mod 权限位仅 1<=gid<=5 持久化（自定义组静默丢弃） */
export interface GroupUpsertItem {
  gid: number;
  name: string;
  creditsfrom: number;
  creditsto: number;
  allowread: number;
  allowthread: number;
  allowpost: number;
  allowattach: number;
  allowdown: number;
  allowtop?: number;
  allowupdate?: number;
  allowdelete?: number;
  allowmove?: number;
  allowbanuser?: number;
  allowdeleteuser?: number;
  allowviewip?: number;
}

export interface PageData<T> {
  total: number;
  page: number;
  size: number;
  totalPage: number;
  list: T[];
}

/** GET /api/admin/users 行 = USER_PUBLIC_COLS + email + create_ip/create_ip_fmt（后台专用投影） */
export interface AdminUserRow {
  uid: number;
  gid: number;
  username: string;
  avatar: number;
  threads: number;
  posts: number;
  credits: number;
  create_date: number;
  login_date: number;
  email: string;
  /** 整数存储的注册 IP，服务端已 long2ip；0 → '0.0.0.0' */
  create_ip_fmt: string;
  /** 账号审核状态：1=正常 0=待审核 -1=未通过 */
  ok: number;
  /** 小黑屋（0025）：封禁位掩码 0=无 1=禁言 2=禁访 4=禁登（可组合） */
  ban_scope: number;
  /** 封禁到期（unix 秒，0=永久） */
  ban_until: number;
  ban_reason: string;
}

/** GET /api/admin/users/banned 行（生效中的封禁；ban_by_name 由服务端批量补） */
export interface BannedUserRow {
  uid: number;
  gid: number;
  username: string;
  email: string;
  ban_scope: number;
  ban_until: number;
  ban_reason: string;
  ban_at: number;
  ban_by: number;
  ban_by_name: string;
}

/** GET /api/admin/users/:uid/bans 行（bbs_user_ban 历史） */
export interface UserBanHistoryRow {
  bid: number;
  scope: number;
  reason: string;
  operator_uid: number;
  operator_name: string;
  create_date: number;
  expire_date: number;
  lifted_at: number;
  lifted_by: number;
}

/** POST /api/admin/users/:uid/ban 入参（duration 与 until 二选一，duration=N 秒后解封） */
export interface BanInput {
  scope: number;
  until?: number;
  duration?: number;
  reason?: string;
}

export interface AdminThreadRow {
  tid: number;
  fid: number;
  uid: number;
  username: string;
  /** 以下 6 列均为 bbs_thread 反规范化列（§5.2），与前台 ThreadListItem 同源，供论坛主题列表样式行渲染 */
  avatar: number;
  subject: string;
  posts: number;
  views: number;
  top: number;
  digest: number;
  closed: number;
  images: number;
  files: number;
  lastpid: number;
  lastuid: number;
  lastusername: string;
  create_date: number;
  last_date: number;
}

/** GET /api/admin/threads/:tid —— 编辑弹窗回显：主题字段 + 首帖原文（message/doctype 原样） */
export interface AdminThreadDetail {
  tid: number;
  fid: number;
  subject: string;
  firstpid: number;
  closed: number;
  top: number;
  digest: number;
  message: string;
  doctype: number;
}

export interface ModlogRow {
  logid: number;
  uid: number;
  tid: number;
  pid: number;
  subject: string;
  comment: string;
  action: string;
  create_date: number;
}

/* ---------------- 内容审核（后台） ---------------- */

/** GET /api/admin/check/threads|recycle 行（作者为 LEFT JOIN，用户已删为 null） */
export interface AdminCheckThreadRow {
  tid: number;
  fid: number;
  subject: string;
  uid: number;
  username: string | null;
  create_date: number;
}

/** GET /api/admin/check/posts 行：isfirst=0，message 为原文纯文本（前端转义渲染） */
export interface AdminCheckPostRow {
  pid: number;
  tid: number;
  uid: number;
  username: string | null;
  create_date: number;
  message: string;
  subject: string | null;
}

/** 审核设置矩阵行（组四列、板块三列） */
interface CheckGroupRow {
  gid: number;
  name: string;
  thread_check: number;
  post_check: number;
  see_check: number;
  edit_check: number;
}
interface CheckForumRow {
  fid: number;
  name: string;
  thread_check: number;
  post_check: number;
  edit_check: number;
}

/** GET /api/admin/check/setting 回显 */
export interface AdminCheckSetting {
  user_check: 0 | 1;
  recycle: 0 | 1;
  groups: CheckGroupRow[];
  forums: CheckForumRow[];
}

/** GET /api/admin/runtime：totals 实时 COUNT、today 取版块求和、online 为活跃会话数、budget 为本请求的守卫计数 */
interface AdminGroupStat {
  gid: number;
  name: string;
  count: number;
  users: { uid: number; username: string; avatar: number }[];
}

export interface RuntimeData {
  totals: { users: number; threads: number; posts: number; attachs: number };
  today: { threads: number; posts: number; users: number };
  online: number;
  online_window: number;
  runtime_cache: Record<string, number>;
  /**
   * 仪表盘「快捷管理」表 + 「用户分布图」共用的分组数据：
   * 收录 gid<=7（管理组表，users 给该组 uid 倒序前 6 名）与 gid>100（环形图，users 为空数组）。
   */
  groups: AdminGroupStat[];
  server: { client_ip: string };
  budget: {
    d1_queries: number;
    subrequests: number;
    rows_read_estimate: number;
    cpu_ms_estimate: number;
    limits: {
      hard_d1_queries: number;
      ci_d1_queries_max: number;
      ci_subrequests_max: number;
      ci_cpu_ms_max: number;
      ci_rows_read_max: number;
    };
  };
}

/** GET /api/admin/setting 返回 kv 'setting' 的原样 JSON（snake_case，含扩展自建的键） */
export type AdminSettingMap = Record<string, unknown>;

/* ------------------------------------------------------------------ *
 * 运行维护 · 数据库维护 / R2 存储维护（T3-11）
 * 所有清理都是分片的：一次请求只推进有限批次，done=false 时由前端继续调用。
 * ------------------------------------------------------------------ */

/** 本请求三预算实测（与 runtime 面板同口径，只投影维护页要展示的字段） */
export interface MaintBudget {
  d1_queries: number;
  subrequests: number;
  rows_read_estimate: number;
  cpu_ms_estimate: number;
  limits_hard_d1_queries: number;
  limits_ci_d1_queries_max: number;
  limits_ci_subrequests_max: number;
}

/** 体检行：risk 1=社交/倒排孤儿、2=涉及 R2 对象的附件 */
export interface MaintDbTaskStat {
  id: string;
  risk: 1 | 2;
  /** 命中数（上限 probeCap，超出时 capped=true 显示为 N+） */
  count: number;
  capped: boolean;
}

export interface MaintOverview {
  tasks: MaintDbTaskStat[];
  generated: number;
  probeCap: number;
  cached: boolean;
  budget?: MaintBudget;
}

export interface MaintDbRunResult {
  task: string;
  dryRun: boolean;
  deleted: number;
  batches: number;
  done: boolean;
  remaining: number;
  capped: boolean;
  /** 仅 attach_orphan：R2 对象删除失败而保留待重试的行数 */
  objectFailed?: number;
  samples?: Record<string, unknown>[];
  budget?: MaintBudget;
}

export interface MaintCronResult {
  job: string;
  affected: number;
  detail: Record<string, unknown>;
  budget?: MaintBudget;
}

/** 内容语言分布：单行（lang 空串 = 未标注） */
export interface MaintLangStatRow {
  lang: string;
  total: number;
  recent: number;
}

/** 内容语言分布：全表聚合结果（服务端缓存 10 分钟） */
export interface MaintLangStats {
  rows: MaintLangStatRow[];
  total: number;
  since: number;
  recentDays: number;
  generated: number;
  cached: boolean;
  budget?: MaintBudget;
}

/** 内容语言回填：单批结果（前端循环推进直到 done） */
export interface MaintLangBackfillResult {
  scanned: number;
  updated: number;
  remaining: number;
  done: boolean;
  batch: number;
  budget?: MaintBudget;
}

/** R2 扫描/删除任务状态（服务端存 bbs_cache，7 天 TTL） */
export interface MaintR2State {
  prefix: string;
  mode: 'scan' | 'delete';
  cursor: string;
  scanned: number;
  hits: number;
  deleted: number;
  kept: number;
  skipped: number;
  /** 已判定待删但尚未删完的 key（数组，前端只看长度） */
  pending: string[];
  done: boolean;
  minAgeHours: number;
  /** 是否仍走 R2 批量删除；false = 已降级为逐 key（服务端持久化该决定） */
  bulk: boolean;
  /** 每步实际可删的对象数（批量 200 / 降级后 20） */
  deleteBatch: number;
  updated: number;
}

export interface MaintR2Status {
  prefixes: string[];
  pendingDeletePerStep: number;
  pageSize: number;
  minAgeHours: number;
  states: (MaintR2State | null)[];
  budget?: MaintBudget;
}

export interface AdminSettingInput {
  sitename?: string;
  brief?: string;
  url?: string;
  kw?: string;
  desc?: string;
  runlevel?: number;
  runlevel_reason?: string;
  user_create_on?: number;
  user_create_email_on?: number;
  user_resetpw_on?: number;
  forum_orderby?: number;
  update_views_on?: number;
  content_lang?: number;
  upload_max_size?: number;
  lang?: string;
  /** 后台界面语言（与前台站点 lang 相互独立；缺省回落 lang） */
  admin_lang?: string;
  /** 积分奖励三键（「积分」后台页；0=关闭，grantForPost 消费） */
  credit_thread?: number;
  credit_reply?: number;
  credit_daily_first?: number;
  /** 设备访问三开关（手机/平板/电视端是否允许访问前台；1=开启 0=关闭） */
  device_phone_on?: number;
  device_tablet_on?: number;
  device_tv_on?: number;
  /** 顶部导航栏自定义项（「导航栏设置」页；提交 NavItem[] 的 JSON 字符串） */
  nav?: string;
}

/** GET/PUT /api/admin/email-setting（§11.3 SMTP 账号池；密码永不回显，只回 hasPass，提交留空即保持） */
interface SmtpAccountView {
  from: string;
  host: string;
  port: number;
  user: string;
  /** 每日发送上限（0 = 不限） */
  dailyLimit: number;
  hasPass: boolean;
}

export interface SmtpAccountInput {
  from: string;
  host: string;
  port: number;
  user: string;
  dailyLimit: number;
  pass?: string;
}

export interface EmailSettingView {
  pool: SmtpAccountView[];
}

/** GET /api/admin/points/logs 行（username 经 LEFT JOIN，理论上不空，仍按可空处理） */
export interface AdminPointLogRow {
  logid: number;
  uid: number;
  username: string | null;
  change: number;
  balance: number;
  reason: string;
  biz_key: string;
  create_date: number;
}

/**
 * GET /api/admin/extensions 行：manifest 里 name 是多语言 map（`{'zh-cn':…,'en-us':…}`），
 * 取词由前端按后台语言（setting.adminLang）做；brief 来自插件自声明 schema（卡片简介）。
 */
export interface ExtensionRow {
  id: string;
  name: Record<string, string>;
  version: string;
  installed: 0 | 1;
  enable: 0 | 1;
  brief?: LocText;
}

/** GET /api/admin/extensions/:id —— config 明文回显，secret 只回 hasSecret 布尔 + 已配置键名（secretKeys，永不回值）；schema 由插件自声明、API 下发 */
export interface ExtensionDetail {
  manifest: { id: string; name: Record<string, string>; version: string };
  installed: 0 | 1;
  enable: 0 | 1;
  config: Record<string, unknown>;
  hasSecret: boolean;
  secretKeys?: string[];
  schema?: ExtSchema;
}

/** 广告位行：config 服务端已 JSON.parse 成对象；position 建议取 shared 的 SLOT_POSITIONS */
export interface AdSlotRow {
  id: number;
  position: string;
  type: string;
  config: Record<string, unknown>;
  enabled: number;
  sort: number;
  start_date: number;
  end_date: number;
  create_date: number;
}

/** POST 必填 position/type；PUT 是部分更新，只提交变化列 */
export interface AdSlotInput {
  position: string;
  type: 'html' | 'image' | 'adsense';
  config: Record<string, unknown>;
  enabled: number;
  sort: number;
  start_date: number;
  end_date: number;
}

/* ------------------------------------------------------------------ *
 * 支付管理（T5-7，§15.4）行类型
 * 逐字对齐 apps/api/src/modules/admin/payment.ts 的显式投影（planDto/orderDto 与 CardOut）。
 * 注意 DTO 是 snake_case，与 core/order 里内部行的 camelCase（orderNo/amountCents）不同，勿混用。
 * ------------------------------------------------------------------ */

/**
 * GET/POST/PUT /api/admin/vip/plans 的 VIP 计划（无分页，GET 返回 {list}）。
 * perks 服务端已 JSON.parse 成对象；enabled 是 0/1；price_cents 单位是**分**（UI 用元展示/输入）。
 */
export interface VipPlanRow {
  id: number;
  name: string;
  duration_days: number;
  price_cents: number;
  currency: string;
  perks: Record<string, unknown>;
  enabled: number;
  sort: number;
  /** 0004：履约时把买家挂入的用户组（0 = 不关联；服务端仅接受 0 或 gid>=100 的等级/会员组） */
  gid: number;
}

/** 计划表单提交体：price_cents 传分；perks 可直接传对象（服务端会 JSON.stringify） */
export interface VipPlanInput {
  name: string;
  duration_days: number;
  price_cents: number;
  currency?: string;
  perks?: Record<string, unknown>;
  enabled?: number;
  sort?: number;
  /** 0 = 不关联；>0 需为 bbs_group 存在的等级/会员组（服务端校验） */
  gid?: number;
}

/** GET /api/admin/orders 的订单行；status ∈ pending|paid|fulfilled|refunded|closed（见 shared 的 OrderStatus） */
export interface AdminOrderRow {
  order_no: string;
  uid: number;
  plan_id: number;
  amount_cents: number;
  currency: string;
  status: string;
  provider: string;
  provider_ref: string;
  created_date: number;
  paid_date: number;
  fulfilled_date: number;
}

/** GET /api/admin/cards 的卡密行：status 0 未用 / 1 已用 / 2 已作废；redeemed_date/expire_date 为 unix 秒（0 = 无） */
export interface AdminCardRow {
  id: number;
  code: string;
  plan_id: number;
  batch_no: string;
  status: number;
  redeemed_uid: number;
  redeemed_date: number;
  expire_date: number;
  create_date: number;
}

/** POST /api/admin/cards 的返回：cards 的明文卡号是**唯一一次**回显，列表接口只回 code 同样字段但不再强调 */
export interface CardGenResult {
  batch_no: string;
  count: number;
  cards: AdminCardRow[];
}

/* ------------------------------------------------------------------ *
 * 加V认证（后台）
 * ------------------------------------------------------------------ */

/**
 * GET /api/admin/v/applies 行（bbs_v_apply LEFT JOIN 用户名；服务端已把 null 兜成空串）。
 * status：0 待审核 / 1 已通过 / -1 已拒绝（列表口径仅 0/1，-1 行不出现）。
 */
export interface AdminVApplyRow {
  uid: number;
  username: string;
  /** 申请的认证头衔（通过后由服务端写入 bbs_user.v） */
  v: string;
  /** 证明信息 */
  vInfo: string;
  /** 证明图片直链（申请页附件端点上传后回填的 URL，空 = 无） */
  vFile: string;
  status: number;
  /** 拒绝备注（本项目增强，随 reject 入库） */
  remark: string;
  /** 申请时间（unix 秒） */
  createTime: number;
}

/** GET /api/admin/v/user 回显（op=0）；查无此人时服务端回 NOT_FOUND 'NO_SUCH_USER' */
export interface AdminVUser {
  uid: number;
  username: string;
  /** 当前认证头衔；'0' = 未认证 */
  v: string;
}

/** GET/PUT /api/admin/v/setting（op=2 收费参数：type=币种列名，count=单次申请费用，0 = 免费） */
export interface VFeeSetting {
  type: 'credits' | 'golds' | 'rmbs';
  count: number;
}

/** GET /api/admin/notices 行（snake_case，双 JOIN 收发双方名/头像；L JOIN 理论不空，仍按可空处理） */
export interface AdminNoticeRow {
  nid: number;
  fromuid: number;
  recvuid: number;
  create_date: number;
  isread: number;
  /** 0=全部（仅筛选）2=评论 3=系统 99=其他 */
  type: number;
  message: string;
  from_username: string | null;
  from_avatar: number | null;
  recv_username: string | null;
  recv_avatar: number | null;
  /** 关联首页公告（0011）：无关联为 null；有则 aid>0，ann_isshow 0/1 = 隐藏/显示 */
  ann_aid: number | null;
  ann_isshow: number | null;
}
