/**
 * /api/admin/* 类型化客户端（复用 lib/api 的信封解包 + CSRF 双提交）。
 * 鉴权：HttpOnly Cookie `admin_at`，由 POST /api/auth/login 在 gid=1 时下发、守卫每次成功续期 1h；
 * 守卫失败是 **HTTP 403 + code NO_PERMISSION(-3)**（其余业务错误是 HTTP 200 + 负 code），
 * 两种都会被 apiGet/apiSend 解成 ApiError，故调用侧统一按 code 判定，不看 HTTP status。
 */
import { apiGet, apiSend } from '../lib/api';
import type { ModThreadsReq } from '@freeidx/shared';
import type {
  AdSlotInput,
  AdSlotRow,
  AdminCardRow,
  AdminCheckPostRow,
  AdminCheckSetting,
  AdminCheckThreadRow,
  AdminForumRow,
  AdminOrderRow,
  AdminPointLogRow,
  AdminSettingInput,
  AdminSettingMap,
  AdminThreadDetail,
  AdminThreadRow,
  AdminUserRow,
  AdminVApplyRow,
  AdminVUser,
  CardGenResult,
  ExtensionDetail,
  ExtensionRow,
  EmailSettingView,
  SmtpAccountInput,
  ForumInput,
  GroupFullRow,
  GroupUpsertItem,
  MaintCronResult,
  MaintDbRunResult,
  MaintLangBackfillResult,
  MaintLangStats,
  MaintOverview,
  MaintR2State,
  MaintR2Status,
  ModlogRow,
  PageData,
  RuntimeData,
  VipPlanInput,
  VipPlanRow,
  VFeeSetting,
  AdminNoticeRow,
} from './types';

const qs = (input: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** 站点设置：GET 返回存储态原样 JSON，PUT 是白名单 merge（未提交键与扩展自建键都保留） */
export const getSetting = () => apiGet<AdminSettingMap>('/api/admin/setting');
export const putSetting = (patch: AdminSettingInput) => apiSend<AdminSettingMap>('PUT', '/api/admin/setting', patch);
/** 站点 Logo / Favicon 上传（data URL，服务端落 R2 site/ 并写 kv setting，上传即生效）；delete* 恢复默认 */
export const uploadSiteLogo = (data: string) => apiSend<{ logo_url: string }>('PUT', '/api/admin/setting/logo', { data });
export const deleteSiteLogo = () => apiSend('DELETE', '/api/admin/setting/logo');
export const uploadSiteFavicon = (data: string) => apiSend<{ favicon_url: string }>('PUT', '/api/admin/setting/favicon', { data });
export const deleteSiteFavicon = () => apiSend('DELETE', '/api/admin/setting/favicon');

/** 邮箱设置（§11.3 SMTP 账号池）：密码永不回显，PUT 整池提交、密码留空即保持原值 */
export const getEmailSetting = () => apiGet<EmailSettingView>('/api/admin/email-setting');
export const putEmailSetting = (pool: SmtpAccountInput[]) => apiSend<EmailSettingView>('PUT', '/api/admin/email-setting', { pool });

/** 版块 + 用户组一并返回（编辑页要拿 grouplist 渲染权限矩阵的行） */
export const getForums = () =>
  apiGet<{ forums: AdminForumRow[]; groups: GroupFullRow[] }>('/api/admin/forums');
export const createForum = (input: ForumInput) => apiSend<{ fid: number }>('POST', '/api/admin/forums', input);
export const updateForum = (fid: number, input: ForumInput) =>
  apiSend<{ fid: number }>('PUT', `/api/admin/forums/${fid}`, input);
/** 级联删除该版块全部主题/帖子/附件并回退作者计数——响应里的 threads 是被删主题数 */
export const deleteForum = (fid: number) => apiSend<{ fid: number; threads: number }>('DELETE', `/api/admin/forums/${fid}`);
/** 版块图标上传（data URL，服务端落 R2）；deleteForumIcon 恢复内置默认图 */
export const uploadForumIcon = (fid: number, data: string) =>
  apiSend<{ icon_url: string }>('PUT', `/api/admin/forums/${fid}/icon`, { data });
export const deleteForumIcon = (fid: number) => apiSend<{ fid: number }>('DELETE', `/api/admin/forums/${fid}/icon`);

export const getGroups = () => apiGet<{ groups: GroupFullRow[] }>('/api/admin/groups');
/** 整表批量 upsert：已存在的 gid 走 UPDATE，新 gid 走 INSERT */
export const putGroups = (groups: GroupUpsertItem[]) => apiSend<{ count: number }>('PUT', '/api/admin/groups', { groups });
/** 删组：系统保留组（0-7、101）服务端返回 403 */
export const deleteGroup = (gid: number) => apiSend<{ gid: number }>('DELETE', `/api/admin/groups/${gid}`);

/** keyword 是**精确匹配**（服务端 col = ?），不是 LIKE；type 非法值回退 uid */
export const getUsers = (q: { type?: string; keyword?: string; page?: number; size?: number }) =>
  apiGet<PageData<AdminUserRow>>(`/api/admin/users${qs(q)}`);

/** ---------------- 积分管理（本项目新增） ---------------- */
/** 用户积分台账：与用户列表同款精确匹配（type=uid|username） */
export const getPointUsers = (q: { type?: string; keyword?: string; page?: number; size?: number }) =>
  apiGet<PageData<AdminUserRow>>(`/api/admin/points/users${qs(q)}`);
/** 手工调整：change 非零整数，返回调整后余额 */
export const adjustPoint = (uid: number, change: number) =>
  apiSend<{ granted: boolean; credits: number }>('POST', '/api/admin/points/adjust', { uid, change });
/** 积分流水：uid/reason 可选过滤 */
export const getPointLogs = (q: { uid?: number; reason?: string; page?: number; size?: number }) =>
  apiGet<PageData<AdminPointLogRow>>(`/api/admin/points/logs${qs(q)}`);
/** 注册默认积分（新用户注册即发放的三币种初始值） */
export const getRegisterCredits = () => apiGet<{ credits: number; golds: number; rmbs: number }>('/api/admin/points/register-credits');
export const putRegisterCredits = (input: { credits: number; golds: number; rmbs: number }) =>
  apiSend<{ credits: number; golds: number; rmbs: number }>('PUT', '/api/admin/points/register-credits', input);

/** ---------------- 积分管理扩展（批次 3B：接入后端既有 10 个端点） ---------------- */
/** 积分规则矩阵（3×6 动作×三币）+ 兑换参数；defaults = 服务端出厂默认档 */
export type PointRulesData = Record<string, number> & { defaults?: Record<string, number> };
export const getPointRules = () => apiGet<PointRulesData>('/api/admin/points/rules');
export const putPointRules = (input: Record<string, number>) => apiSend<never>('PUT', '/api/admin/points/rules', input);
/** 按用户名查三币余额（绝对口径） */
export const getPointBalance = (username: string) =>
  apiGet<{ uid: number; username: string; exp: number; golds: number; rmbs: number }>(
    `/api/admin/points/balance?username=${encodeURIComponent(username)}`,
  );
/** 绝对覆盖三币余额（credits 走差额补 point_log） */
export const putPointBalance = (input: { username: string; exp: number; golds: number; rmbs: number }) =>
  apiSend<{ exp: number; golds: number; rmbs: number }>('PUT', '/api/admin/points/balance', input);
/** 购买主题消费记录（bbs_paylist type=1） */
export const getPointPaylog = (page = 1) =>
  apiGet<PageData<{ plid: number; tid: number; subject: string; uid: number; username: string; num: number; credit_type: number; paytime: number }>>(
    `/api/admin/points/paylog?page=${page}`,
  );
/** 可发收费帖组 */
export const getPointSellGroups = () => apiGet<{ list: { gid: number; name: string; allowsell: number }[] }>('/api/admin/points/groups');
export const putPointSellGroups = (gids: number[]) => apiSend<never>('PUT', '/api/admin/points/groups', { gids });
/** 模拟用户购买（写 num=0 购买行，已购幂等跳过） */
export const simulatePurchase = (uid: number, tid: number) => apiSend<never>('POST', '/api/admin/points/simulate', { uid, tid });
/** 强制按经验重算用户组 */
export const forceUpgradeGroup = (username: string) =>
  apiSend<{ oldGid: number; newGid: number } | null>('POST', '/api/admin/points/upgrade', { username });
/** 三币排行（type=credits|golds|rmbs） */
export const getPointRank = (type: 'credits' | 'golds' | 'rmbs', page = 1) =>
  apiGet<PageData<{ uid: number; username: string; credits: number; golds: number; rmbs: number }>>(
    `/api/admin/points/rank?type=${type}&page=${page}`,
  );
/** password 必须是前端预哈希后的 32 位串（与前台登录同口径，见 shared 的 md5Hex）；gid 缺省 101 */
export const createUser = (input: { email: string; username: string; password: string; gid?: number }) =>
  apiSend<{ uid: number; gid: number }>('POST', '/api/admin/users', input);
export const updateUser = (
  uid: number,
  input: { email?: string; username?: string; gid?: number; password?: string; ok?: number },
) => apiSend<{ uid: number }>('PUT', `/api/admin/users/${uid}`, input);
/** 硬删除并级联清理主题/帖子/附件；目标是 gid=1 时返回 code -3 '管理员不可删除' */
export const deleteUser = (uid: number) => apiSend<{ uid: number }>('DELETE', `/api/admin/users/${uid}`);

/**
 * 主题检索：keyword 是 **LIKE 模糊**（与 /api/admin/users 的精确口径相反）；
 * fid/uid 为 0 视为不过滤，create_ip 传点分十进制（服务端转整数打 userip，非法串不过滤），
 * top/closed/digest 传 '0' 有业务含义（=0 是有效值），不传则不写该参数。
 */
export const getAdminThreads = (
  q: {
    keyword?: string;
    fid?: number;
    uid?: number;
    create_ip?: string;
    top?: number;
    closed?: number;
    digest?: number;
    since?: number;
    until?: number;
    page?: number;
    size?: number;
  },
) => apiGet<PageData<AdminThreadRow>>(`/api/admin/threads${qs(q)}`);

/**
 * 主题编辑回显：主题字段 + 首帖原文（message/doctype 库中原样，前端 textarea 直接编辑）。
 * 保存用 updateAdminThread（PUT /api/admin/threads/:tid）。
 */
export const getAdminThread = (tid: number) => apiGet<AdminThreadDetail>(`/api/admin/threads/${tid}`);

/**
 * 编辑主题：subject/message/doctype/fid 传值即改（未传键不动）。
 * fid 变更 = 移动版块，服务端做版块计数双向校准 + thread_top 迁移；正文重提取列表图片组/摘要；
 * 成功写 modlog（action=update），返回 common.saved。
 */
export const updateAdminThread = (
  tid: number,
  body: { subject?: string; message?: string; doctype?: number; fid?: number },
) => apiSend<{ tid: number }>('PUT', `/api/admin/threads/${tid}`, body);

/**
 * 批量版务（复用前台 /api/mod/threads，权限按 forum_access 的 mod 位判定）：
 * close 用 value 区分关闭(1)/打开(0)，delete 是硬删并级联清回帖/附件/mythread。
 * 返回体口径修正：服务端（modules/mod/routes.ts:229）实际是 `{ count, results:[{tid,action}] }`，
 * 之前写的 `{executed}` 与后端不符；调用处不看返回值，故修正不影响别处。
 */
export const modThreads = (body: ModThreadsReq) =>
  apiSend<{ count: number; results: { tid: number; action: string }[] }>('POST', '/api/mod/threads', body);

export const getModlogs = (q: { uid?: number; page?: number; size?: number }) =>
  apiGet<PageData<ModlogRow>>(`/api/admin/modlogs${qs(q)}`);

export const getRuntime = () => apiGet<RuntimeData>('/api/admin/runtime');
/** 只清 forumlist/grouplist/setting/runtime 四个键（user:{uid} 与 ext:*:config 不动；thread_top_list 缓存键已随直查 bbs_thread_top 方案移除） */
export const clearCache = () => apiSend<{ cleared: number }>('POST', '/api/admin/cache/clear');

/* ------------------------------------------------------------------ *
 * 运行维护（T3-11）：数据库孤儿清理 + R2 未使用对象清理
 * 全部为分片执行：done=false 时前端继续调用（服务端单请求最多推进有限批次）。
 * ------------------------------------------------------------------ */

/** 数据库体检：默认读 1 小时缓存；refresh=true 强制全表重扫（成本高，手动触发） */
export const getMaintOverview = (refresh = false) =>
  apiGet<MaintOverview>(`/api/admin/maintenance/db/overview${refresh ? '?refresh=1' : ''}`);
/** 分批清理：dryRun=true 只取样本不写；batches 上限 8（服务端截断） */
export const runMaintDbTask = (task: string, opts: { batches?: number; dryRun?: boolean } = {}) =>
  apiSend<MaintDbRunResult>('POST', '/api/admin/maintenance/db/run', { task, ...opts });
/** 立即执行一次 cron 子任务（session/calibrate/cache_gc/email_code/queue/attach_tmp） */
export const runMaintCronJob = (job: string) => apiSend<MaintCronResult>('POST', '/api/admin/maintenance/cron/run', { job });
/** 存量主题内容语言回填（单批 ≤50 条，前端循环推进直到 done） */
export const backfillMaintContentLang = (limit = 20) =>
  apiSend<MaintLangBackfillResult>('POST', '/api/admin/maintenance/content-lang/backfill', { limit });
/** 内容语言分布（全表聚合，服务端缓存 10 分钟；refresh=1 强制重算） */
export const getMaintLangStats = (refresh = false) =>
  apiGet<MaintLangStats>(`/api/admin/maintenance/content-lang/stats${refresh ? '?refresh=1' : ''}`);

export const getMaintR2Status = () => apiGet<MaintR2Status>('/api/admin/maintenance/r2/status');
/** 开始/重置某前缀的任务；mode='delete' 必须带 confirm 且已有完成的扫描报告 */
export const startMaintR2 = (body: { prefix: string; mode: 'scan' | 'delete'; confirm?: boolean; minAgeHours?: number }) =>
  apiSend<{ state: MaintR2State }>('POST', '/api/admin/maintenance/r2/start', body);
/** 推进一步：scan 模式每轮最多 5 页；delete 模式每轮最多删 20 个对象 */
export const stepMaintR2 = (prefix: string, pages = 5) =>
  apiSend<{ state: MaintR2State }>('POST', '/api/admin/maintenance/r2/step', { prefix, pages });
/** 丢弃进度（删除模式中止后也可用它回到未开始） */
export const resetMaintR2 = (prefix: string) => apiSend<{ prefix: string }>('POST', '/api/admin/maintenance/r2/reset', { prefix });

/**
 * 后台二次验证重签 admin_at。路径挂在 `/api/auth/*` 而非 `/api/admin/*`——
 * adminGuard 覆盖整个 /api/admin 前缀，而本页存在的意义正是 admin_at 已失效，放进去会自锁。
 * password 走前端 md5 预哈希（与前台登录同口径），成功后 Set-Cookie 由服务端下发。
 */
export const postAdminToken = (password: string) => apiSend<{ uid: number }>('POST', '/api/auth/admin-token', { password });

/** 本地扩展清单：name 是 manifest 的多语言 map，由前端按后台语言（setting.adminLang）取词 */
export const getExtensions = () => apiGet<{ extensions: ExtensionRow[] }>('/api/admin/extensions');
/** 详情含 config（明文回显）与 hasSecret/secretKeys（私钥只给布尔与键名，永不回显内容） */
export const getExtension = (id: string) => apiGet<ExtensionDetail>(`/api/admin/extensions/${id}`);
/** enable/installed 改 kv 'extensions'；config 覆盖对应 kv 行；secret 整体覆盖（高级模式），secretPatch 增量合并（null=删键，表单模式） */
export const putExtension = (
  id: string,
  body: {
    enable?: 0 | 1;
    installed?: 0 | 1;
    config?: Record<string, unknown>;
    secret?: Record<string, unknown>;
    secretPatch?: Record<string, unknown>;
  },
) => apiSend<{ id: string }>('PUT', `/api/admin/extensions/${id}`, body);

/** 广告位：默认只回 enabled=1，preview=true 含草稿位（后台编辑必须能看到草稿） */
export const getAdSlots = (preview = true) => apiGet<{ slots: AdSlotRow[] }>(`/api/admin/ad-slots${preview ? '?ad_preview=1' : ''}`);
export const createAdSlot = (body: AdSlotInput) => apiSend<{ id: number }>('POST', '/api/admin/ad-slots', body);
export const updateAdSlot = (id: number, body: Partial<AdSlotInput>) => apiSend<{ id: number }>('PUT', `/api/admin/ad-slots/${id}`, body);
export const deleteAdSlot = (id: number) => apiSend<{ id: number }>('DELETE', `/api/admin/ad-slots/${id}`);

/* ------------------------------------------------------------------ *
 * 主题管理：后端只持有「启用主题 id」（kv `theme`），主题清单由前端构建期自动发现
 * ------------------------------------------------------------------ */

/** 当前启用主题 id 与内置兜底 id（清单本身在前端 registry，不进接口） */
export const getAdminTheme = () => apiGet<{ active: string; default: string }>('/api/admin/theme');
/** 切换启用主题：只写 kv theme，前台整页刷新后生效 */
export const putAdminTheme = (id: string) => apiSend<{ active: string }>('PUT', '/api/admin/theme', { id });

/* ------------------------------------------------------------------ *
 * 支付管理（T5-7，§15.4）：VIP 计划 / 订单 / 卡密
 * 三个 GET 都返回 `{list}` 或 `{list,page,size}`，**没有 total**（不同 PageData），故不与 PageData 复用。
 * ------------------------------------------------------------------ */

/** VIP 计划：计划数量少，服务端 listAllPlans 全量返回，**无分页** */
export const getVipPlans = () => apiGet<{ list: VipPlanRow[] }>('/api/admin/vip/plans');
export const createVipPlan = (input: VipPlanInput) => apiSend<VipPlanRow>('POST', '/api/admin/vip/plans', input);
/** PUT 是整体替换（normalizePlan 要求 name 必填），调用方需带上全部字段 */
export const updateVipPlan = (id: number, input: VipPlanInput) => apiSend<VipPlanRow>('PUT', `/api/admin/vip/plans/${id}`, input);
export const deleteVipPlan = (id: number) => apiSend<{ id: number }>('DELETE', `/api/admin/vip/plans/${id}`);

/** 订单：status 空 = 全部；无 total，下一页靠“返回条数 === size”判断（size 默认 20、上限 100） */
export const getAdminOrders = (q: { status?: string; page?: number; size?: number }) =>
  apiGet<{ list: AdminOrderRow[]; page: number; size: number }>(`/api/admin/orders${qs(q)}`);
/** 退款：编排通道退款 + 状态机回写，仅 paid/fulfilled 合法 */
export const refundOrder = (no: string) => apiSend<AdminOrderRow>('POST', `/api/admin/orders/${encodeURIComponent(no)}/refund`);
/** 人工补单：pending→paid→fulfilled（幂等） */
export const settleOrder = (no: string) => apiSend<AdminOrderRow>('POST', `/api/admin/orders/${encodeURIComponent(no)}/settle`);

/** 卡密列表：status '' = 全部 / '0' = 未用 / '1' = 已用 / '2' = 已作废；无 total（size 默认 50、上限 200） */
export const getAdminCards = (q: { batch?: string; status?: string; page?: number; size?: number }) =>
  apiGet<{ list: AdminCardRow[]; page: number; size: number }>(`/api/admin/cards${qs(q)}`);
/** 批量生成卡密：返回的 cards 明文是**唯一一次**回显，生成后请立即复制保存 */
export const generateCards = (input: { planId: number; count: number; expire_date?: number; batch_no?: string }) =>
  apiSend<CardGenResult>('POST', '/api/admin/cards', input);
/** 批量作废卡密（仅未使用卡生效）：返回实际作废张数 */
export const voidCards = (ids: number[]) => apiSend<{ voided: number }>('POST', '/api/admin/cards/void', { ids });
/** 批量删除卡密（仅未使用/已作废卡生效，已使用卡保留账目）：返回实际删除张数 */
export const deleteCards = (ids: number[]) => apiSend<{ deleted: number }>('POST', '/api/admin/cards/delete', { ids });

/* ------------------------------------------------------------------ *
 * 消息管理：全部消息 / 发送系统通知
 * ------------------------------------------------------------------ */

/** 全部消息列表（nid 倒序，页码分页；含收发双方名/头像） */
export const getAdminNotices = (q: { page?: number; size?: number }) =>
  apiGet<PageData<AdminNoticeRow>>(`/api/admin/notices${qs(q)}`);
/** 发送系统通知：type=3，fromuid=当前管理员（服务端取 admin_at token）；announcement=true 同步发首页公告 */
export const sendNotice = (input: { recvuid: number; message: string; announcement?: boolean }) =>
  apiSend<{ nid: number; aid: number }>('POST', '/api/admin/notices', input);
/** 切换关联首页公告显示开关（0011）：isshow 0 隐藏 / 1 显示 */
export const toggleNoticeAnnouncement = (nid: number, isshow: 0 | 1) =>
  apiSend<{ nid: number; isshow: number }>('PUT', `/api/admin/notices/${nid}/announcement`, { isshow });
export const deleteAdminNotice = (nid: number) => apiSend<{ nid: number }>('DELETE', `/api/admin/notices/${nid}`);

/* ------------------------------------------------------------------ *
 * 内容审核 + 回收站：
 * 列表为页码分页（page/size，默认 20）；审核动作不在此重复实现——复用前台
 * POST /api/check 与 POST /api/recycle（见 lib/api 的 checkAudit/recycleThread）。
 * ------------------------------------------------------------------ */

/** 主题审核队列：ok=0 待审 / -1 未通过 */
export const getCheckThreads = (q: { ok: 0 | -1; page?: number; size?: number }) =>
  apiGet<PageData<AdminCheckThreadRow>>(`/api/admin/check/threads${qs(q)}`);
/** 回帖审核队列：ok=0 待审 / -1 未通过（isfirst=0） */
export const getCheckPosts = (q: { ok: 0 | -1; page?: number; size?: number }) =>
  apiGet<PageData<AdminCheckPostRow>>(`/api/admin/check/posts${qs(q)}`);
/** 用户审核队列：ok=0 待审 / -1 未通过（行投影同后台用户列表） */
export const getCheckUsers = (q: { ok: 0 | -1; page?: number; size?: number }) =>
  apiGet<PageData<AdminUserRow>>(`/api/admin/check/users${qs(q)}`);
/** 主题回收站：ok=-2 */
export const getCheckRecycle = (q: { page?: number; size?: number }) =>
  apiGet<PageData<AdminCheckThreadRow>>(`/api/admin/check/recycle${qs(q)}`);
export const getCheckSetting = () => apiGet<AdminCheckSetting>('/api/admin/check/setting');
/** 保存审核设置：开关 + 组/板块矩阵（服务端先全清后置选中） */
export const putCheckSetting = (body: {
  user_check: 0 | 1;
  recycle: 0 | 1;
  groups: { gid: number; thread_check: number; post_check: number; see_check: number; edit_check: number }[];
  forums: { fid: number; thread_check: number; post_check: number; edit_check: number }[];
}) => apiSend<unknown>('PUT', '/api/admin/check/setting', body);
/** 清空回收站：服务端受 D1 语句预算限制每次只清 2 条，next=true 时前端继续调用 */
export const truncateRecycle = () => apiSend<{ count: number; next: boolean }>('POST', '/api/admin/check/truncate');

/* ------------------------------------------------------------------ *
 * 加V认证：两列审核 + 手动加V + 收费参数
 * ------------------------------------------------------------------ */

/** 审核两列表（status=0 待审核 / 1 已通过；create_time 倒序，20/页，带 total/totalPage） */
export const getVApplies = (q: { status: 0 | 1; page?: number }) =>
  apiGet<PageData<AdminVApplyRow>>(`/api/admin/v/applies${qs(q)}`);
/** 通过：user.v=申请头衔 + status=1，「恭喜！加V认证成功！」系统通知由服务端发 */
export const passV = (uid: number) => apiSend<{ uid: number }>('POST', '/api/admin/v/pass', { uid });
/** 拒绝：status=-1 + remark 入库 +「很抱歉！…」系统通知（remark 为本项目增强，可空） */
export const rejectV = (uid: number, remark?: string) =>
  apiSend<{ uid: number }>('POST', '/api/admin/v/reject', { uid, remark });
/** 手动加V查询（op=0）：按用户名精确匹配，回当前头衔（'0' = 未认证） */
export const getVUser = (username: string) => apiGet<AdminVUser>(`/api/admin/v/user${qs({ username })}`);
/** 手动加V设置（op=1）：v 传 '0' 即取消认证 */
export const setVUser = (input: { username: string; v: string }) =>
  apiSend<{ uid: number; v: string }>('PUT', '/api/admin/v/user', input);
/** 收费参数（op=2 读取侧） */
export const getVSetting = () => apiGet<VFeeSetting>('/api/admin/v/setting');
/** 保存收费参数（op=2）：count 为非负整数，0 = 申请免费 */
export const putVSetting = (input: VFeeSetting) => apiSend<VFeeSetting>('PUT', '/api/admin/v/setting', input);
