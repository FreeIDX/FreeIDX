/**
 * 写时定稿（T2-5）：发帖/回帖内容的写时定稿与 HTML 化。
 * 仅写路径（发帖/回帖/编辑）调用；读路径直接取库中 message_fmt，严禁二次过滤（§8.3 硬规则）。
 * doctype：0=HTML 白名单、1=txt 转义、2=md、3=ubb（2/3 无源码转换器 → 回落转义通道，前端兼容渲染）。
 */
import { xnHtmlSafe } from './sanitize';

/** 正文截取上限 2028000：UTF-8 按码点计 */
export const MESSAGE_MAX_CHARS = 2_028_000;

/**
 * PHP htmlspecialchars 等价（ENT_QUOTES|ENT_SUBSTITUTE，对齐 PHP≥8.1 默认 flags；
 * 旧 7.x 部署为 ENT_COMPAT 不转义单引号——取更严格分支，渲染等价、更安全）。
 */
export function htmlSpecialChars(s: string): string {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** HTML 属性值转义（SEO 模板/OG/JSON-LD 属性拼接用） */
export function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** HTML 化顺序敏感（空格→&nbsp; 先于 tab，tab 展开内的空格不再二次替换） */
export function xnTxtToHtml(s: string): string {
  let out = htmlSpecialChars(s);
  out = out.split(' ').join('&nbsp;');
  out = out.split('\t').join(' &nbsp; &nbsp; &nbsp; &nbsp;');
  out = out.split('\r\n').join('\n');
  out = out.split('\n').join('<br>');
  return out;
}

interface MessageInput {
  message: string;
  doctype: number;
  quotepid?: number;
}

interface FinalizedMessage {
  message: string;
  message_fmt: string;
}

/**
 * 入库前生成 message_fmt（原地修改 & 前置引用块）。
 * quoteHtml 由调用方（T2-6）以引用块构造结果传入；缺省空串（无引用场景）。
 * gid=1 管理员 doctype=0 原文放行（管理员特权，§8.3）。
 */
export function postMessageFmt(input: MessageInput, gid: number, quoteHtml = ''): FinalizedMessage {
  const message =
    input.message.length > MESSAGE_MAX_CHARS ? [...input.message].slice(0, MESSAGE_MAX_CHARS).join('') : input.message;

  let fmt = htmlSpecialChars(message); // 默认通道（2/3 及兜底）
  if (input.doctype === 0) fmt = gid === 1 ? message : xnHtmlSafe(message);
  else if (input.doctype === 1) fmt = xnTxtToHtml(message);

  if ((input.quotepid ?? 0) > 0) fmt = quoteHtml + fmt;
  return { message, message_fmt: fmt };
}
