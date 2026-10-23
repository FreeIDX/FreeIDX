import type {
  ApiEnvelope,
  BootstrapPayload,
  CreatePostReq,
  CreateThreadReq,
  LoginReq,
  ModThreadsReq,
  PostRepliesData,
  RegisterReq,
  ThreadListItem,
} from '@freeidx/shared';
import { Code, createFrontTranslator, DEFAULT_LOCALE, type FrontKey } from '@freeidx/shared';
import { getLoadedBundle } from '@freeidx/shared/i18n/bundles';

export class ApiError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/* ---------------- 请求超时（稳定性项 D2） ----------------
 * 浏览器 fetch 默认没有超时：边缘节点抖动或 D1 慢查询时请求会一直挂着，
 * 表现为「转圈不止」，且 React Query 的 retry 永远等不到一次失败。
 * 15s 覆盖冷启动 + 慢查询的尾部；上传给更宽的窗口（大文件传一半被误杀比失败更糟）。 */
const API_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

async function request(url: string, init?: RequestInit, timeoutMs = API_TIMEOUT_MS): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    // 超时归一成信封错误：上层（apiErrorMessage / React Query 的 error 态）按 ApiError 处理即可
    if (ctl.signal.aborted) throw new ApiError(Code.SYSTEM_ERROR, uiT('err_system_busy'));
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 会话失效通知（auth store 注册，避免 api ↔ store 循环依赖）：
 * 界面自认登录态却收到 NOT_LOGIN（服务端已吊销：改密/登出/100 天过期/管理员强制下线）时
 * 通知 store 刷新为游客态，让顶栏/操作与真实态一致，而不是每个请求各自报「请登录」。
 */
let sessionExpiredNotify: (() => void) | null = null;
export function onSessionExpired(fn: () => void): void {
  sessionExpiredNotify = fn;
}

/** 信封解包（§6.1）：code<0 抛出；data 平铺返回；NOT_LOGIN 顺带触发会话失效通知 */
function unwrap<T>(body: ApiEnvelope & { data?: T }): T {
  if (body.code === Code.NOT_LOGIN) sessionExpiredNotify?.();
  if (body.code !== Code.OK) throw new ApiError(body.code, body.message);
  return body.data as T;
}

/** 读取 JSON 信封：Worker/反代返回 HTML 5xx 时不能直接 res.json()（SyntaxError 会绕过会话失效兜底） */
async function envelopeOf(res: Response): Promise<ApiEnvelope & { data?: unknown }> {
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('application/json')) {
    throw new ApiError(res.status >= 500 ? Code.SYSTEM_ERROR : res.status, res.statusText || `HTTP ${res.status}`);
  }
  return (await res.json()) as ApiEnvelope & { data?: unknown };
}

/** 写请求：CSRF Cookie 丢失（浏览器重启/存储清理）时先 GET 刷新再重试一次，避免「已登录但所有写操作失败」 */
async function sendWithCsrf<T>(doFetch: () => Promise<Response>): Promise<T> {
  let body = await envelopeOf(await doFetch());
  if (body.code === Code.CSRF_FAILED) {
    await request('/api/health', { credentials: 'include' });
    body = await envelopeOf(await doFetch());
  }
  return unwrap<T>(body as ApiEnvelope & { data?: T });
}

/** 信封解包（§6.1）：code<0 抛出；data 平铺返回 */
export async function apiGet<T>(path: string): Promise<T> {
  const res = await request(path, { credentials: 'include' });
  return unwrap<T>((await envelopeOf(res)) as ApiEnvelope & { data?: T });
}

function csrfToken(): string {
  const m = /(?:^|;\s*)csrf=([^;]+)/.exec(document.cookie);
  const v = m?.[1];
  return v ? decodeURIComponent(v) : '';
}

/** 写请求（T2-3 双提交）：非 GET 自动携带 X-CSRF-Token */
export function apiSend<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, payload?: unknown): Promise<T> {
  return sendWithCsrf<T>(() =>
    request(path, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    }),
  );
}

export function bootstrap(): Promise<BootstrapPayload> {
  return apiGet<BootstrapPayload>('/api/bootstrap');
}

/** 表单写请求：不设 Content-Type（浏览器带 multipart boundary），保留 CSRF + credentials，解信封同 apiSend */
function apiSendForm<T>(method: 'POST' | 'PUT', path: string, form: FormData): Promise<T> {
  return sendWithCsrf<T>(() =>
    request(
      path,
      {
        method,
        credentials: 'include',
        headers: { 'X-CSRF-Token': csrfToken() },
        body: form,
      },
      UPLOAD_TIMEOUT_MS,
    ),
  );
}

export interface LoginResult {
  uid: number;
  gid: number;
  username: string;
  avatar: number;
  upgradeNeeded: boolean;
}
export interface RegisterResult {
  uid: number;
  username: string;
  gid: number;
}
interface ThreadCreated {
  tid: number;
  pid: number;
}
interface PostMutationResult {
  pid: number;
  tid: number;
}
interface AvatarResult {
  url: string;
  avatar: number;
}
interface UploadResult {
  aid: number;
  url: string;
  orgfilename: string;
  filetype: string;
  filesize: number;
  width: number;
  height: number;
  isimage: number;
  downloads: number;
  status: number;
}
interface UpdatePostReq {
  subject?: string;
  fid?: number;
  message: string;
  doctype: number;
  attachAids?: number[];
  /** 首帖收费设置（仅 allowsell 组且仅首帖生效；0/空数 = 取消收费） */
  contentBuy?: number;
  contentBuyType?: number;
}

export function login(req: LoginReq): Promise<LoginResult> {
  return apiSend<LoginResult>('POST', '/api/auth/login', req);
}
export function register(req: RegisterReq): Promise<RegisterResult> {
  return apiSend<RegisterResult>('POST', '/api/auth/register', req);
}
export function logout(): Promise<unknown> {
  return apiSend('DELETE', '/api/auth/logout');
}
export function sendEmailCode(req: { scene: string; email: string; turnstileToken?: string }): Promise<unknown> {
  return apiSend('POST', '/api/auth/email-code', req);
}
export function requestPasswordReset(req: { email: string; turnstileToken?: string }): Promise<unknown> {
  return apiSend('POST', '/api/auth/password-reset/request', req);
}
export function confirmPasswordReset(req: { email: string; token: string; password: string }): Promise<unknown> {
  // password 为前端预哈希 md5(明文)（§8.4），与 login/register 口径一致
  return apiSend('POST', '/api/auth/password-reset/confirm', req);
}

export function createThread(req: CreateThreadReq): Promise<ThreadCreated> {
  return apiSend<ThreadCreated>('POST', '/api/threads', req);
}
export function createReply(tid: number, req: CreatePostReq): Promise<PostMutationResult> {
  return apiSend<PostMutationResult>('POST', `/api/threads/${tid}/posts`, req);
}
export function updatePost(pid: number, req: UpdatePostReq): Promise<PostMutationResult> {
  return apiSend<PostMutationResult>('PUT', `/api/posts/${pid}`, req);
}
export function deletePost(pid: number): Promise<unknown> {
  return apiSend('DELETE', `/api/posts/${pid}`);
}

/** 版务批量操作（§6.2）：top/untop/close/digest/delete/move；value = top|digest 级别或 move 目标 fid。
 * 权限服务端逐条判定（forumAccessMod），返回实际执行条数。 */
export function modThreads(req: ModThreadsReq): Promise<{ count: number; results: { tid: number; action: string }[] }> {
  return apiSend('POST', '/api/mod/threads', req);
}

/** 附件上传走 multipart：File → FormData，返回 aid + 预览 URL（图片插入正文用 /api/attachments/:aid/preview） */
export function uploadAttachment(
  file: File,
  opts?: { isImage?: boolean; width?: number; height?: number },
): Promise<UploadResult> {
  const form = new FormData();
  form.append('file', file);
  form.append('name', file.name);
  form.append('is_image', opts?.isImage ? '1' : '0');
  if (opts?.width) form.append('width', String(opts.width));
  if (opts?.height) form.append('height', String(opts.height));
  return apiSendForm<UploadResult>('POST', '/api/attachments', form);
}

export function uploadAvatar(data: string): Promise<AvatarResult> {
  return apiSend<AvatarResult>('POST', '/api/me/avatar', { data });
}

/** 撤销误传附件（DELETE /api/attachments/:aid）：仅 status=0 的暂存附件可由上传者删除（R2 对象 + 行同步清）；失败由 attachGc 兜底 */
export function deleteAttachment(aid: number): Promise<{ aid: number }> {
  return apiSend<{ aid: number }>('DELETE', `/api/attachments/${aid}`);
}

/** 用户回帖条目（GET /api/users/:uid/posts / /api/me/posts；字段为后端 snake_case 原样投影） */
export interface UserReplyItem {
  pid: number;
  tid: number;
  fid: number;
  top: number;
  uid: number;
  subject: string;
  message_fmt: string;
  create_date: number;
}
interface UserReplyPage {
  list: UserReplyItem[];
  size: number;
  nextCursor?: number;
}
export function fetchUserReplies(uid: number, beforePid?: number): Promise<UserReplyPage> {
  return apiGet<UserReplyPage>(`/api/users/${uid}/posts${beforePid ? `?before_pid=${beforePid}` : ''}`);
}
export function fetchMyReplies(beforePid?: number): Promise<UserReplyPage> {
  return apiGet<UserReplyPage>(`/api/me/posts${beforePid ? `?before_pid=${beforePid}` : ''}`);
}

/** 改密（§8.4）：入参为前端预哈希 md5(明文)，与 login/register 口径一致 */
export function changePassword(req: { oldPassword: string; newPassword: string }): Promise<unknown> {
  return apiSend('POST', '/api/user/password', req);
}

export function toggleLike(tid: number): Promise<{ likes: number; liked: boolean }> {
  return apiSend('POST', `/api/threads/${tid}/like`);
}

export function toggleFavorite(tid: number): Promise<{ favorites: number; favorited: boolean }> {
  return apiSend('POST', `/api/favorites/${tid}`);
}

export function togglePostLike(pid: number): Promise<{ likes: number; liked: boolean }> {
  return apiSend('POST', `/api/posts/${pid}/like`);
}

export function toggleFollow(uid: number): Promise<{ followed: boolean; followers: number }> {
  return apiSend('POST', `/api/users/${uid}/follow`);
}

interface FavoritePage {
  list: ThreadListItem[];
  size: number;
  nextCursor?: number;
}
export function fetchMyFavorites(beforeRowid?: number): Promise<FavoritePage> {
  return apiGet<FavoritePage>(`/api/my/favorites${beforeRowid ? `?before_rowid=${beforeRowid}` : ''}`);
}

/** 我赞过的主题（游标口径与收藏一致） */
export function fetchMyLikes(beforeRowid?: number): Promise<FavoritePage> {
  return apiGet<FavoritePage>(`/api/my/likes${beforeRowid ? `?before_rowid=${beforeRowid}` : ''}`);
}

/** 关注用户行（GET /api/my/following|followers 与 GET /api/users/:uid/following|followers） */
export interface FollowUserItem {
  uid: number;
  username: string;
  avatar: number;
  fans: number;
  /** 当前访问者已关注 Ta（按钮态） */
  followed: boolean;
  /** 双向关注 */
  mutual: boolean;
  /** 关注备注（仅「我关注的」行下发；有则优先显示） */
  remark?: string;
  /** 接收该用户动态（0 = 不进关注动态流） */
  dynamic: boolean;
}
interface FollowUserPage {
  list: FollowUserItem[];
  size: number;
  nextCursor?: number;
}
/** 关注用户列表通用读取（url 由调用方给出：/api/my/{following|followers} 或 /api/users/:uid/…；游标 before_rowid 翻页） */
export function fetchFollowUserPage(url: string, beforeRowid?: number): Promise<FollowUserPage> {
  return apiGet<FollowUserPage>(`${url}${beforeRowid ? `?before_rowid=${beforeRowid}` : ''}`);
}

/** 设置关注备注（≤50 字，空串=清除） */
export function saveFollowRemark(uid: number, remarks: string): Promise<{ uid: number; remarks: string }> {
  return apiSend('POST', '/api/my/follow-remarks', { uid, remarks });
}
/** 设置是否接收该用户动态 */
export function saveFollowDynamic(uid: number, dynamic: number): Promise<{ uid: number; dynamic: number }> {
  return apiSend('POST', '/api/my/follow-dynamic', { uid, dynamic });
}

/** 关注动态流条目（GET /api/my/following-threads；首帖无 messageFmt，回帖带 HTML 预览） */
export interface FollowStreamItem {
  pid: number;
  tid: number;
  uid: number;
  username: string;
  avatar: number;
  isfirst: number;
  createDate: number;
  subject: string;
  /** 我对该作者的关注备注（有则前端优先显示） */
  remark?: string;
  messageFmt?: string;
}
interface FollowStreamPage {
  list: FollowStreamItem[];
  size: number;
  nextCursor?: number;
}
export function fetchMyFollowingStream(beforePid?: number): Promise<FollowStreamPage> {
  return apiGet<FollowStreamPage>(`/api/my/following-threads${beforePid ? `?before_pid=${beforePid}` : ''}`);
}

/** 最新评论（发现页「互动评论」列，GET /api/posts/latest） */
export interface LatestComment {
  pid: number;
  tid: number;
  uid: number;
  username: string;
  avatar: number;
  /** 去标签正文摘要（≤25 字） */
  text: string;
  createDate: number;
}
export function fetchLatestComments(): Promise<{ list: LatestComment[]; size: number }> {
  return apiGet<{ list: LatestComment[]; size: number }>('/api/posts/latest');
}

/** 发送私信（type=7 进对方消息中心） */
export function sendPm(uid: number, message: string): Promise<{ nid: number; uid: number }> {
  return apiSend('POST', '/api/my/notices/pm', { uid, message });
}

/** 热门收藏（窗口内按收藏数倒序） */
interface HotFavoriteItem {
  tid: number;
  subject: string;
  favorites: number;
}
export function fetchHotFavorites(days: number, limit: number): Promise<{ list: HotFavoriteItem[]; days: number; limit: number }> {
  return apiGet<{ list: HotFavoriteItem[]; days: number; limit: number }>(`/api/threads/hot-favorites?days=${days}&limit=${limit}`);
}

/* ---------------- 我的消息 ---------------- */

interface NoticeItem {
  nid: number;
  fromUid: number;
  fromUsername: string;
  fromAvatar: number;
  /** 0=全部（仅筛选）2=评论 3=系统 99=其他 */
  type: number;
  name: string;
  isRead: boolean;
  createDate: number;
  /** 服务端生成的受限 HTML（用户输入已转义），前端 dangerouslySetInnerHTML 渲染 */
  message: string;
}
interface NoticePage {
  list: NoticeItem[];
  size: number;
  nextCursor?: number;
  unread: number;
}
/** type=0 全部 / 2 评论 / 3 系统 / 99 其他；游标 before_nid（nid 倒序） */
export function fetchMyNotices(type: number, beforeNid?: number): Promise<NoticePage> {
  const q = new URLSearchParams();
  if (type) q.set('type', String(type));
  if (beforeNid) q.set('before_nid', String(beforeNid));
  const s = q.toString();
  return apiGet<NoticePage>(`/api/my/notices${s ? `?${s}` : ''}`);
}
export function readAllNotices(): Promise<{ unread: number }> {
  return apiSend('POST', '/api/my/notices/read-all');
}
export function readNotice(nid: number): Promise<{ nid: number; unread: number }> {
  return apiSend('POST', `/api/my/notices/${nid}/read`);
}
export function deleteNotice(nid: number): Promise<{ nid: number; unread: number }> {
  return apiSend('DELETE', `/api/my/notices/${nid}`);
}
/** 删除本页消息（只删归属本人的 nid 集合） */
export function deleteNotices(nids: number[]): Promise<{ deleted: number; unread: number }> {
  return apiSend('POST', '/api/my/notices/delete-batch', { nids });
}

/* ---------------- 内容审核 + 回收站 ---------------- */

/** 现场审核：act 0=主题 1=回帖 2=用户；opt 1=通过 -1=拒绝 -2=删除（真删） */
export function checkAudit(act: number, id: number, opt: number): Promise<unknown> {
  return apiSend('POST', '/api/check', { act, id, opt });
}
/** 回收站：opt -1=恢复 1=彻底删除 */
export function recycleThread(tid: number, opt: number): Promise<unknown> {
  return apiSend('POST', '/api/recycle', { tid, opt });
}

/* ---------------- 排行榜 ---------------- */

export interface RankThreadItem {
  tid: number;
  subject: string;
}
export interface RankUserItem {
  uid: number;
  username: string;
  avatar: number;
}
/** 个人中心排行榜单行（五维：主题/帖子/积分/金币/人民币） */
interface RankListRow {
  uid: number;
  username: string;
  threads: number;
  posts: number;
  credits: number;
  golds: number;
  rmbs: number;
}
export interface RankListData {
  total: number;
  page: number;
  size: number;
  totalPage: number;
  list: RankListRow[];
}

/** 首页右栏主题榜：range all=总排行（全站浏览量倒序）/ week=周排行（最近一周创建） */
export function getRankThreads(range: 'all' | 'week', limit = 10): Promise<{ list: RankThreadItem[] }> {
  return apiGet<{ list: RankThreadItem[] }>(`/api/rank/threads?range=${range}&limit=${limit}`);
}
/** 首页右栏用户榜：new 新会员 / active 活跃榜 / posts 帖子榜 / wealth 财富榜 */
export function getRankUsers(type: 'new' | 'active' | 'posts' | 'wealth', limit = 16): Promise<{ list: RankUserItem[] }> {
  return apiGet<{ list: RankUserItem[] }>(`/api/rank/users?type=${type}&limit=${limit}`);
}
/** 个人中心排行榜单（全站用户分页，实时查询） */
export function getRankList(sort: 'threads' | 'posts' | 'credits' | 'golds' | 'rmbs', page = 1, size = 20): Promise<RankListData> {
  return apiGet<RankListData>(`/api/rank/list?sort=${sort}&page=${page}&size=${size}`);
}
/** 版块热门（版块页右栏：本版块浏览量倒序 top N） */
export function getRankForum(fid: number, limit = 10): Promise<{ list: RankThreadItem[] }> {
  return apiGet<{ list: RankThreadItem[] }>(`/api/rank/forum?fid=${fid}&limit=${limit}`);
}

/**
 * 附件下载（付费附件走此入口：allowdown + 积分扣减在服务端强校验，业务错误保持 HTTP 200 + 信封）。
 * blob 触发浏览器保存；文件名取 RFC 5987 filename*（UTF-8 精确），缺失回退 aid。
 */
export async function downloadAttachment(aid: number): Promise<void> {
  const res = await request(`/api/attachments/${aid}/download`, { credentials: 'include' }, DOWNLOAD_TIMEOUT_MS);
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const body = (await res.json()) as ApiEnvelope;
    if (body.code === Code.NOT_LOGIN) sessionExpiredNotify?.();
    throw new ApiError(body.code, body.message || uiT('download_failed'));
  }
  if (!res.ok) throw new ApiError(res.status, uiT('download_failed'));
  const blob = await res.blob();
  const dispo = res.headers.get('content-disposition') ?? '';
  const m = /filename\*=UTF-8''([^;]+)/i.exec(dispo);
  const name = m?.[1] ? decodeURIComponent(m[1]) : `file-${aid}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------------- 积分交易 ---------------- */

/** 付费主题购买（thread-cPay）：已购/作者返回 message「付费成功」且无 data（幂等） */
interface PayThreadResult {
  tid: number;
  purchased: boolean;
  price: number;
  creditType: number;
}
export function payThread(tid: number): Promise<PayThreadResult | undefined> {
  return apiSend<PayThreadResult | undefined>('POST', `/api/threads/${tid}/pay`);
}

/** 购买记录页（thread-sPay）：主题信息 + 逐笔买家清单 */
interface PaylistRow {
  uid: number;
  username: string;
  avatar: number;
  paytime: number;
}
interface PaylistData {
  thread: { tid: number; subject: string; uid: number; username: string; avatar: number };
  count: number;
  contentBuy: number;
  contentBuyType: number;
  page: number;
  size: number;
  totalPage: number;
  list: PaylistRow[];
}
export function getThreadPaylist(tid: number, page = 1): Promise<PaylistData> {
  return apiGet<PaylistData>(`/api/threads/${tid}/paylist?page=${page}`);
}

/** 积分面板（my-credits）：三币余额/组徽章/升级进度 + 兑换参数 */
interface MyCreditsData {
  uid: number;
  username: string;
  avatar: number;
  gid: number;
  groupName: string;
  credits: number;
  golds: number;
  rmbs: number;
  progress: number;
  trade: { convertExchange: boolean; exchangeN: number; exchangeC: number; min: number };
}
export function getMyCredits(): Promise<MyCreditsData> {
  return apiGet<MyCreditsData>('/api/me/credits');
}

/** 兑换（my-trade op=n 人民币→金币；op=c 反向需后台开启 convert_exchange） */
export function exchangeCredits(req: { op: 'n' | 'c'; e_rmb?: number; e_golds_c?: number }): Promise<unknown> {
  return apiSend('POST', '/api/me/credits/exchange', req);
}

/** 转账（my-trade op=t）：creditType 1=经验 2=金币 3=人民币（分） */
export function transferCredits(req: { username: string; num: number; creditType: number }): Promise<unknown> {
  return apiSend('POST', '/api/me/credits/transfer', req);
}

/** 积分变动记录（my-record）：user_pay 流水，人民币已折算为元 */
interface CreditRecordRow {
  cid: number;
  time: number;
  type: number;
  typeName: string;
  status: number;
  statusName: string;
  num: number;
  displayNum: number;
  creditType: number;
  creditName: string;
  code: string;
}
interface CreditRecordData {
  total: number;
  page: number;
  size: number;
  totalPage: number;
  list: CreditRecordRow[];
}
export function getMyCreditRecord(page = 1): Promise<CreditRecordData> {
  return apiGet<CreditRecordData>(`/api/me/credits/record?page=${page}`);
}

/** 经验积分流水（my-points）：bbs_point_log 权威账本（签到/发帖奖励/精华结算/管理员调整等 15 类 reason） */
interface PointLogItem {
  id: number;
  change: number;
  balance: number;
  reason: string;
  biz_key: string;
  create_date: number;
}
interface MyPointsData {
  credits: number;
  total: number;
  page: number;
  size: number;
  total_page: number;
  list: PointLogItem[];
}
export function getMyPoints(page = 1): Promise<MyPointsData> {
  return apiGet<MyPointsData>(`/api/me/points?page=${page}`);
}

/* ---------------- 加V认证 ---------------- */

/** 申请页回显（my-vapply GET）：v=当前头衔（'0'=未认证）；apply=最近一次申请；fee=单次收费参数 */
interface MyVData {
  v: string;
  apply: {
    v: string;
    vInfo: string;
    vFile: string;
    /** 0=审核中（服务端 status 直接透出） */
    status: number;
    remark: string;
    createTime: number;
  } | null;
  fee: { type: 'credits' | 'golds' | 'rmbs'; count: number };
}
export function getMyV(): Promise<MyVData> {
  return apiGet<MyVData>('/api/me/v');
}

/** 提交/重新提交申请（my-vapply POST）：服务端校验→落申请→扣费→头衔置 0 重审 */
export function applyV(req: { v: string; vInfo: string; vFile: string }): Promise<unknown> {
  return apiSend('POST', '/api/me/v', req);
}

/** 已购主题（my-purchased）：套主题列表卡（与 /api/threads 同列集） */
interface PurchasedData {
  total: number;
  page: number;
  size: number;
  totalPage: number;
  list: ThreadListItem[];
}
export function getMyPurchased(page = 1): Promise<PurchasedData> {
  return apiGet<PurchasedData>(`/api/me/credits/purchased?page=${page}`);
}

/** UI 日期格式化 locale（跟随站点语言，I18nProvider 启动时注入；默认 en-us） */
let uiLocaleState = 'en-us';
export function setUiLocale(lang: string): void {
  uiLocaleState = lang || 'en-us';
}
export function uiLocale(): string {
  return uiLocaleState;
}

export function uiT(key: FrontKey, params?: Record<string, string | number>): string {
  /* 词典按需加载：目标语言未就绪时回落 DEFAULT_LOCALE，两者都未加载则回显 key（不阻断错误提示链路） */
  const bundle = getLoadedBundle(uiLocaleState) ?? getLoadedBundle(DEFAULT_LOCALE);
  if (!bundle) return key;
  return createFrontTranslator(bundle)(key, params);
}

export function fmtDate(ts: number): string {
  if (!ts) return '';
  return new Intl.DateTimeFormat(uiLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ts * 1000));
}

/** 无符号整数 → 点分 IPv4（long2ip 语义，0 → '0.0.0.0'；帖子楼层 IP 展示用） */
export function fmtIp(n: number): string {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

/* ---------------- 前台扩展端点（快速回复 / 插入代码 / 预设头像） ---------------- */

/** 快速回复下拉数据：[默认回复语, ...# 分隔备选语]；enabled=false 或空数组不渲染 */
export function fetchQuickReplyMessage(): Promise<{ enabled: boolean; options: string[] }> {
  return apiGet<{ enabled: boolean; options: string[] }>('/api/quick-reply-message');
}

/** 插入代码八个注入位键（后台注入码存储键，各注入位直出原始 HTML） */
export const INSERT_CODE_KEYS = [
  'footer_end_htm',
  'footer_footer_left_end_htm',
  'footer_footer_right_end_htm',
  'footer_start_htm',
  'index_main_start_htm',
  'index_site_brief_after_htm',
  'thread_user_after_htm',
  'thread_message_after_htm',
] as const;
type InsertCodeKey = (typeof INSERT_CODE_KEYS)[number];
export type InsertCodes = Record<InsertCodeKey, string>;

/** GET /api/insert-codes：八个注入位原始 HTML，未配置/插件停用一律空串（前端据此零残留） */
export function fetchInsertCodes(): Promise<InsertCodes> {
  return apiGet<InsertCodes>('/api/insert-codes');
}

/** 预设头像：imgsrc=/avatars/0..56.png（服务端白名单校验）；空串=取消预设恢复默认 */
export function applyPresetAvatar(imgsrc: string): Promise<{ avatar_auto: string }> {
  return apiSend('POST', '/api/my/avatar/preset', { imgsrc });
}

/** 主页背景：imgsrc=预设编号（'0'=默认 bg-0.png，1..user_bg_num）；服务端按配置白名单校验 */
export function saveBackground(imgsrc: string): Promise<{ bgimg: string }> {
  return apiSend('POST', '/api/my/background', { imgsrc });
}

/** 楼层「查看所有回复」（show_all_reply）：某楼层 pid 的全部直接回复（quotepid=pid，每页 20） */
export function fetchPostReplies(pid: number, page = 1): Promise<PostRepliesData> {
  return apiGet<PostRepliesData>(`/api/posts/${pid}/replies?page=${page}`);
}

/* ---------------- VIP 收银台（后端 6 端点接线） ---------------- */

/** VIP 套餐（公开）：perks 已 JSON.parse，已知键 credits=履约发放积分 */
export interface VipPlan {
  id: number;
  name: string;
  duration_days: number;
  price_cents: number;
  currency: string;
  perks: { credits?: number } & Record<string, unknown>;
  gid: number;
}
export function fetchVipPlans(): Promise<{ list: VipPlan[] }> {
  return apiGet<{ list: VipPlan[] }>('/api/vip/plans');
}

/** 可用支付通道（公开）：currencies 空 = 不限币种；通道显示名由前端按 id 映射词条 */
export interface PaymentProviderView {
  id: string;
  capabilities: { currencies: string[]; modes: ('redirect' | 'qrcode' | 'redeem')[]; refund: boolean };
}
export function fetchPaymentProviders(currency?: string): Promise<{ list: PaymentProviderView[] }> {
  const q = currency ? `?currency=${encodeURIComponent(currency)}` : '';
  return apiGet<{ list: PaymentProviderView[] }>(`/api/payment-providers${q}`);
}

/** 下单（需登录）：金额为计划快照（分，INTEGER 最小货币单位） */
export interface PlacedOrder {
  order_no: string;
  plan_id: number;
  amount_cents: number;
  currency: string;
  status: string;
  provider: string;
}
export function placeOrder(planId: number, provider: string): Promise<PlacedOrder> {
  return apiSend<PlacedOrder>('POST', '/api/orders', { planId, provider });
}

/** 订单查询（需登录 + 本人）：前端轮询兜底 webhook 延迟（服务端设计内行为） */
export interface MyOrder {
  order_no: string;
  plan_id: number;
  amount_cents: number;
  currency: string;
  status: 'pending' | 'paid' | 'fulfilled' | 'refunded' | 'closed';
  created_date: number;
  paid_date: number;
  fulfilled_date: number;
}
export function fetchOrder(orderNo: string): Promise<MyOrder> {
  return apiGet<MyOrder>(`/api/orders/${encodeURIComponent(orderNo)}`);
}

/** 收银台装配（需登录 + 本人）：mode 四态——redirect 跳三方 / qrcode 展内容 / redeem 卡密输入 / pending 降级轮询 */
export interface CheckoutData {
  order_no: string;
  status: string;
  mode: 'redirect' | 'qrcode' | 'redeem' | 'pending';
  url?: string;
  content?: string;
}
export function checkoutOrder(orderNo: string): Promise<CheckoutData> {
  return apiSend<CheckoutData>('POST', `/api/orders/${encodeURIComponent(orderNo)}/checkout`);
}

/** 卡密兑换（需登录 + 本人）：成功即 fulfilled（挂组/续期/积分在服务端同事务完成） */
export function redeemOrder(orderNo: string, code: string): Promise<{ order_no: string; status: string }> {
  return apiSend<{ order_no: string; status: string }>('POST', `/api/orders/${encodeURIComponent(orderNo)}/redeem`, { code });
}

/** 后台列表的日期列口径：YYYY-MM-DD（date('Y-m-d') 格式），空值给 0000-00-00 */
export function fmtDay(ts: number): string {
  if (!ts) return '0000-00-00';
  return new Intl.DateTimeFormat(uiLocale(), { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts * 1000));
}

/** 头像直链：avatar/{uid 补 9 位取前 3 段}/{uid}.png?v={avatar}；v=0 表示未设头像 */
export function avatarUrl(uid: number, v: number): string {
  if (!v) return '';
  const dir = String(uid).padStart(9, '0').slice(0, 3);
  return `/files/avatar/${dir}/${uid}.png?v=${v}`;
}
