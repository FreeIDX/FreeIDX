/**
 * 输入校验（is_email/is_username/is_password，铁律 2）。
 * 口令入参为前端预哈希串（md5 32 hex）；is_password 的原文长度检查等效省略。
 * t 缺省 t0（zh-cn）：路由侧传 c.get('t')，单测直调不传参兼容。
 */
import { t0, type ApiT } from '../i18n';

const EMAIL_RE = /^[\w\-.]+@[\w\-.]+(\.\w+)+$/i;
// PHP /u \w 含 Unicode 字母数字 + 显式中日韩朝文段
const USERNAME_RE = /^[\p{L}\p{N}_\u4E00-\u9FA5\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]+$/u;
const MD5_EMPTY = 'd41d8cd98f00b204e9800998ecf8427e';

export function isEmail(x: string, t: ApiT = t0): string | null {
  if (!EMAIL_RE.test(x)) return t('validate.emailFormat');
  return null;
}

export function isUsername(x: string, t: ApiT = t0): string | null {
  if ([...x].length > 16) return t('validate.usernameTooLong');
  if (x.includes(' ') || x.includes('\u3000')) return t('validate.usernameNoSpace');
  if (!USERNAME_RE.test(x)) return t('validate.usernameFormat');
  return null;
}

export function isPassword(x: string, t: ApiT = t0): string | null {
  if (x.length === 0) return t('validate.passwordEmpty');
  if (x.length !== 32) return t('validate.passwordLength');
  if (x === MD5_EMPTY) return t('validate.passwordEmpty');
  return null;
}
