/**
 * 统一响应信封错误码：
 * code < 0 全局错误；code === 0 成功；code > 0 表单级业务错误。
 * -1 为通用系统错误、-2 为写入失败级；此处细分但保持 -1 语义不变。
 */
export const Code = {
  OK: 0,

  /** 未登录 / 通用系统错误（-1） */
  NOT_LOGIN: -1,
  /** 目录/文件写入失败级系统错误（-2，如 directory_create_failed） */
  SYSTEM_ERROR: -2,
  /** 权限不足（对应 user_group_insufficient_privilege） */
  NO_PERMISSION: -3,
  /** 资源不存在 */
  NOT_FOUND: -4,
  /** runlevel 限制导致站点关闭（对应 check_runlevel） */
  RUNLEVEL_CLOSED: -5,
  /** CSRF 校验失败 */
  CSRF_FAILED: -6,
  /** 频控：验证码 60s / 登录失败锁定 / 日上限 */
  RATE_LIMITED: -7,
  /** Turnstile 人机验证未通过 */
  CAPTCHA_FAILED: -8,
  /** 方法不允许 */
  METHOD_ERROR: -9,
  /** 请求参数校验失败（Zod） */
  VALIDATION_ERROR: -10,
  /** 账号处于小黑屋（封禁/禁言/禁访/禁登），文案含范围、到期与理由 */
  BANNED: -11,

  // ---- 表单级业务错误（code > 0，字段级提示） ----
  FORM_SUBJECT_TOO_SHORT: 1001,
  FORM_MESSAGE_TOO_LONG: 1002,
  FORM_INVALID_EMAIL: 1003,
  FORM_INVALID_USERNAME: 1004,
  FORM_PASSWORD_MISMATCH: 1005,
  FORM_EMAIL_EXISTS: 1006,
  FORM_USERNAME_EXISTS: 1007,
  FORM_EMAIL_CODE_ERROR: 1008,
  FORM_FILE_TOO_LARGE: 1009,
  FORM_FILE_TYPE_NOT_ALLOWED: 1010,
  /** 付费附件：积分不足（§15.1 付费墙） */
  FORM_INSUFFICIENT_CREDITS: 1011,
} as const;
