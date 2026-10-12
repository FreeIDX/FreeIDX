/** 业务常量（§4 constants.ts） */

export const Top = {
  NORMAL: 0,
  FORUM: 1,
  FORUM2: 2,
  GLOBAL: 3,
} as const;

export const Digest = {
  NORMAL: 0,
  LEVEL1: 1,
  LEVEL2: 2,
  LEVEL3: 3,
} as const;

export const Closed = { OPEN: 0, CLOSED: 1 } as const;

/** post.doctype：0=HTML(白名单) 1=txt 2=md 3=ubb(仅存量展示) */
export const DocType = { HTML: 0, TXT: 1, MD: 2, UBB: 3 } as const;

/** 用户组 gid（预置组，§5.4） */
export const GroupId = {
  GUEST: 0,
  ADMIN: 1,
  SUPER_MOD: 2,
  MOD: 4,
  TRIAL_MOD: 5,
  PENDING: 6,
  BANNED: 7,
  LEVEL1: 101,
  LEVEL5: 105,
  VIP: 106,
} as const;

/** 等级组自动升级判定起点（user_update_group：gid<100 直接 return） */
export const LEVEL_GROUP_MIN = 100;

/** runlevel 0-5（0 正常 … 5 仅管理员） */
/**
 * 站点运行级别——与 lang runlevel_N 一一对应：
 * 0 站点关闭 / 1 管理员可读写 / 2 会员只读 / 3 会员可读写 / 4 所有人只读 / 5 所有人可读写（正常）
 */
export const RunLevel = {
  CLOSED_SITE: 0,
  ADMIN_ONLY: 1,
  MEMBER_READ_ONLY: 2,
  MEMBER_READ_WRITE: 3,
  ALL_READ_ONLY: 4,
  NORMAL: 5,
} as const;

/** 分页尺寸（§6.1：首页/版块 30，用户主题 20；消息列表 20） */
export const PageSize = {
  THREAD_LIST: 30,
  USER_THREAD_LIST: 20,
  POST_PAGE: 10,
  NOTICE_LIST: 20,
} as const;

/** 后台 admin_at TTL 1h */
export const ADMIN_TOKEN_TTL = 3600;
