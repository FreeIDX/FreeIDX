/** 信封业务码（§6.1 / Code）→ i18n key；未知码回退服务端 message。 */
import { Code, type FrontKey } from '@freeidx/shared';
import { ApiError, uiT } from './api';

const KEY_MAP: Partial<Record<number, FrontKey>> = {
  [Code.NOT_LOGIN]: 'err_not_login',
  [Code.SYSTEM_ERROR]: 'err_system_busy',
  [Code.NO_PERMISSION]: 'insufficient_privilege',
  [Code.NOT_FOUND]: 'err_content_not_found',
  [Code.RUNLEVEL_CLOSED]: 'err_site_closed',
  [Code.CSRF_FAILED]: 'err_csrf_failed',
  [Code.RATE_LIMITED]: 'err_rate_limited',
  [Code.CAPTCHA_FAILED]: 'err_captcha_failed',
  [Code.METHOD_ERROR]: 'err_method_not_allowed',
  [Code.VALIDATION_ERROR]: 'err_invalid_content',
  [Code.FORM_SUBJECT_TOO_SHORT]: 'err_subject_too_short',
  [Code.FORM_MESSAGE_TOO_LONG]: 'err_message_too_long',
  [Code.FORM_INVALID_EMAIL]: 'email_format_mismatch',
  [Code.FORM_INVALID_USERNAME]: 'err_invalid_username',
  [Code.FORM_PASSWORD_MISMATCH]: 'err_password_mismatch',
  [Code.FORM_EMAIL_EXISTS]: 'err_email_exists',
  [Code.FORM_USERNAME_EXISTS]: 'err_username_exists',
  [Code.FORM_EMAIL_CODE_ERROR]: 'err_email_code_error',
  [Code.FORM_FILE_TOO_LARGE]: 'err_file_too_large',
  [Code.FORM_FILE_TYPE_NOT_ALLOWED]: 'err_file_type_not_allowed',
  [Code.FORM_INSUFFICIENT_CREDITS]: 'err_insufficient_credits_download',
};

function errMessage(code: number, fallback?: string): string {
  const key = KEY_MAP[code];
  if (key) return uiT(key);
  return fallback ?? uiT('err_operation_failed');
}

export function apiErrorMessage(e: unknown, fallback?: string): string {
  if (e instanceof ApiError) {
    // 服务端 message 已按具体场景定制（如 1005 复用于密码格式/缺失/错误），优先透出；缺失才回落 KEY_MAP 通用文案
    const serverMsg = e.message?.trim();
    return serverMsg || errMessage(e.code, fallback);
  }
  if (e instanceof Error) return e.message || (fallback ?? uiT('err_operation_failed'));
  return fallback ?? uiT('err_operation_failed');
}
