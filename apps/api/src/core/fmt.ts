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

/**
 * favicon 的 `<link>` 标签组（壳页与爬虫预渲染共用，避免两处口径漂移）。
 *
 * 后台上传站点图标时，浏览器侧已把原图按正方形裁切成 32/180/192 三档 PNG
 * （见 admin 的 SettingPage → lib/favicon-payload），存成 `site/favicon-<n>.png` 并以同版本号写进
 * `favicon_url`。这里按同一 base + 同一 `?v=` 派生另外两档：
 *  - 标签页只用 32×32，不再让浏览器为「标签页小图标」下载数百 KB 的原图（实测某站 favicon 830KB，
 *    是首访总流量的 60%，且与首屏 JS/字体抢带宽）；
 *  - apple-touch-icon 180 与 192 供 iOS/Android 桌面图标使用。
 * 旧数据（未走过新上传路径的单文件 `/files/site/favicon.png`、`.ico`）保持原来的一行 link，行为不变。
 */
export function iconLinkTags(url: string): string {
  const m = /^(\/files\/site\/favicon)-32\.png(\?[^\s"'<>]*)?$/.exec(url.trim());
  if (!m) return `<link rel="icon" href="${escAttr(url)}">`;
  const base = m[1]!;
  const ver = m[2] ?? '';
  const one = (rel: string, size: number, extra: string) =>
    `<link rel="${rel}"${extra} sizes="${size}x${size}" href="${escAttr(`${base}-${size}.png${ver}`)}">`;
  return [
    one('icon', 32, ' type="image/png"'),
    one('icon', 192, ' type="image/png"'),
    one('apple-touch-icon', 180, ''),
  ].join('');
}

/**
 * 还原入库时转义的 HTML 实体（公告正文专用）。
 *
 * 公告写侧（admin/notices）为防存储型 XSS 统一 `htmlSpecialChars` 后入库，后台列表以 innerHTML
 * 渲染该转义串；而首页公告条是 React 文本插值（自身会转义），原样下发会把 `&amp;` 当字面字符显示。
 * 只读出口还原为原文，由各消费端按自己的渲染方式负责转义 —— 消费端有两处
 * （GET /api/announcements 与 bootstrap 的 announcements），必须共用本函数，避免规则漂移。
 */
export function unescapeHtmlEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
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

/**
 * 正文图片降级（性能项 16-a）：给 `<img>` 补 `loading="lazy"` 与 `decoding="async"`。
 *
 * 为什么必须放在**写时定稿**：读路径严禁二次过滤（§8.3 硬规则），属性只能写进 message_fmt。
 * 为什么不在 sanitize 的 WHITE_VALUE 里放行这两个属性：放行意味着用户可以传 `loading="eager"`，
 * 一个帖子塞几十张图就能逼所有读者在首屏并发拉原图（实测单张 449KB）。这里统一强制 lazy/async。
 * 幂等：已有同名属性的标签不重复插入；实体/引号内的 `>` 不会被误判为标签结束（见 tagEndOf）。
 */
export function decorateImages(html: string): string {
  if (!html || html.indexOf('<img') < 0) return html;
  let out = '';
  let i = 0;
  for (;;) {
    const start = html.indexOf('<img', i);
    if (start < 0) return out + html.slice(i);
    const after = html.charAt(start + 4);
    /* `<imgx` 这类不是 img 标签：原样跳过 4 个字符继续找 */
    if (after && /[\w-]/.test(after)) {
      out += html.slice(i, start + 4);
      i = start + 4;
      continue;
    }
    const end = tagEndOf(html, start + 4);
    if (end < 0) return out + html.slice(i); // 未闭合：不做任何加工，原样返回
    out += html.slice(i, start) + `<img${imgAttrs(html.slice(start + 4, end))}>`;
    i = end + 1;
  }
}

/** 从属性区起点找到标签真正的 `>`（跳过引号内的内容） */
function tagEndOf(html: string, from: number): number {
  let quote = '';
  for (let j = from; j < html.length; j++) {
    const ch = html.charAt(j);
    if (quote) {
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return j;
  }
  return -1;
}

/** 属性串 → 补上缺失的 lazy/async（保留原属性与自闭合写法） */
function imgAttrs(attrs: string): string {
  const hasLoading = /\sloading\s*=/i.test(attrs);
  const hasDecoding = /\sdecoding\s*=/i.test(attrs);
  if (hasLoading && hasDecoding) return attrs;
  const selfClose = /\/\s*$/.test(attrs);
  const body = selfClose ? attrs.replace(/\/\s*$/, '').replace(/\s+$/, '') : attrs;
  let extra = '';
  if (!hasLoading) extra += ' loading="lazy"';
  if (!hasDecoding) extra += ' decoding="async"';
  return `${body}${extra}${selfClose ? ' /' : ''}`;
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
  /* 图片属性在定稿最后一步补：引用块里的图同样生效，且不依赖前端编辑器是否带属性 */
  return { message, message_fmt: decorateImages(fmt) };
}
