/**
 * 内容语言（content language）——与界面语言（i18n locale）相互独立的第二套体系。
 *
 * · 界面语言（AVAILABLE_LOCALES，10 种）决定按钮/菜单/提示等 UI 文案，不碰数据；
 * · 内容语言描述「帖子正文由哪种语言写成」，写时定稿、读时过滤，**不翻译任何内容**。
 *
 * 取值刻意收敛为 10 个（简繁合并为 zh）：本模块只做脚本级判别，简繁区分不可靠且
 * 内容互通，细分没有收益。`other` 兜底无法判别的正文；空串表示未指定（存量数据）。
 *
 * 本模块为纯同步函数、零依赖，前端（预填发帖语言）与后端（写时定稿）共用同一实现，
 * 避免「前端显示一种、服务端落库另一种」的漂移。
 */
import contentLangNativeNames from './i18n/content-lang-names.json';

export const CONTENT_LANGS = ['zh', 'en', 'ja', 'ko', 'ru', 'th', 'de', 'fr', 'es', 'other'] as const;

export type ContentLang = (typeof CONTENT_LANGS)[number];

const CONTENT_LANG_SET: ReadonlySet<string> = new Set(CONTENT_LANGS);

/**
 * 语言原生名（筛选器 / 列表徽标展示用）。
 * 原生名是语言自身的「专名」，不随界面语言翻译，故为固定数据而非 i18n 词条；
 * 放在 JSON 里与 group-names.json 同口径（check-hardcoded-zh 只扫 .ts/.tsx）。
 */
export const CONTENT_LANG_NATIVE_NAMES: Record<ContentLang, string> = contentLangNativeNames as Record<
  ContentLang,
  string
>;

/**
 * 归一化为合法内容语言。
 * 兼容界面 locale 形式（`zh-cn` / `en-us` / `ja-jp` → `zh` / `en` / `ja`）；
 * `all`、空串与非法值一律返回空串（= 不过滤）。
 */
export function normalizeContentLang(v: unknown): ContentLang | '' {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  if (!s || s === 'all') return '';
  if (CONTENT_LANG_SET.has(s)) return s as ContentLang;
  const base = s.split('-')[0] ?? '';
  return CONTENT_LANG_SET.has(base) ? (base as ContentLang) : '';
}

/** 界面 locale → 内容语言（`zh-cn` / `zh-tw` 均 → `zh`） */
export function contentLangOfLocale(locale: string): ContentLang | '' {
  return normalizeContentLang(locale);
}

/**
 * 版块绑定语言的哨兵值：显式「不限制」（0024）。
 *
 * 与空串的区别只在**子版块**上有意义：
 *   空串   = 未绑定 → 子版块继承父版块的绑定；顶级版块即不限制；
 *   'none' = 显式解除继承 → 本版块不限制，忽略父版块的绑定。
 * 顶级版块空串与哨兵等价，故服务端会把顶级版块的哨兵归一回空串（不保留两种写法）。
 */
export const FORUM_LANG_UNRESTRICTED = 'none';

/**
 * 归一化版块绑定值：哨兵原样保留（大小写/空白容错），其余按内容语言归一化。
 * `''` 表示未绑定，`ContentLang` 表示强制，`FORUM_LANG_UNRESTRICTED` 表示显式不限制。
 */
export function normalizeForumLang(v: unknown): string {
  const s = String(v ?? '')
    .trim()
    .toLowerCase();
  return s === FORUM_LANG_UNRESTRICTED ? FORUM_LANG_UNRESTRICTED : normalizeContentLang(s);
}

/** 去标签取纯文本（检测前必做：HTML 标签名/属性里的拉丁字母会污染计数） */
function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** 拉丁语系特征停用词（只做粗分；判不准回落 en，用户可手动覆盖） */
const LATIN_STOPWORDS: Record<'en' | 'fr' | 'de' | 'es', ReadonlySet<string>> = {
  en: new Set([
    'the', 'and', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'for', 'with', 'that', 'this', 'it',
    'on', 'as', 'be', 'or', 'from', 'at', 'by', 'an', 'not', 'have', 'has', 'will', 'can', 'you', 'they',
  ]),
  fr: new Set([
    'les', 'des', 'une', 'est', 'pour', 'dans', 'avec', 'sur', 'pas', 'plus', 'aux', 'cette', 'nous',
    'vous', 'ils', 'elles', 'du', 'au', 'ce', 'qui', 'ne', 'par', 'mais', 'son', 'ses', 'leur', 'être',
  ]),
  de: new Set([
    'der', 'die', 'das', 'und', 'ist', 'nicht', 'ein', 'eine', 'mit', 'für', 'auf', 'sich', 'dem', 'den',
    'des', 'ich', 'wir', 'sie', 'zu', 'von', 'auch', 'als', 'bei', 'nach', 'werden', 'wird', 'sind',
  ]),
  es: new Set([
    'el', 'los', 'las', 'que', 'por', 'para', 'con', 'una', 'es', 'del', 'al', 'como', 'más', 'pero',
    'este', 'esta', 'son', 'muy', 'sin', 'sobre', 'hay', 'fue', 'ser', 'sus', 'nos', 'ya', 'también',
  ]),
};

function detectLatin(text: string): ContentLang {
  const low = text.toLowerCase();
  const words = low.match(/[a-zà-ÿœæß]+/g) ?? [];
  const score: Record<'en' | 'fr' | 'de' | 'es', number> = { en: 0, fr: 0, de: 0, es: 0 };
  for (const w of words) {
    for (const k of ['en', 'fr', 'de', 'es'] as const) {
      if (LATIN_STOPWORDS[k].has(w)) score[k] += 1;
    }
  }
  /* 变音符号加权：德语 äöüß / 西语 ñ¿¡ / 法语 àâçéèêëîïôùûÿœæ */
  if (/[äöüß]/i.test(low)) score.de += 1;
  if (/[ñ¿¡]/i.test(low)) score.es += 1;
  if (/[àâçéèêëîïôùûÿœæ]/i.test(low)) score.fr += 1;

  let best: ContentLang = 'en';
  let bestScore = score.en;
  for (const k of ['fr', 'de', 'es'] as const) {
    /* 阈值 2 + 领先英语：短文本（"Hello" / "Hola"）不足以判非英语，宁可回落 en */
    if (score[k] >= 2 && score[k] > bestScore) {
      best = k;
      bestScore = score[k];
    }
  }
  return best;
}

/** 检测窗口：主题标题 + 正文前 N 字符足够判别，避免超长正文的 O(n) 扫描成本 */
const DETECT_MAX_CHARS = 2000;

/**
 * 自动检测内容语言（写时调用）。
 *
 * 判定顺序即置信度顺序：
 *   假名 → ja（日语必含假名，汉字可能全部来自日语）
 *   谚文 → ko；泰文 → th；西里尔 → ru；
 *   汉字占比高 → zh；拉丁字母 → en/fr/de/es 粗分；
 *   空文本/纯符号 → 空串。
 *
 * 返回空串表示「无法判别」，调用方可落库为空（= 不参与语言过滤）。
 */
export function detectContentLang(text: string): ContentLang | '' {
  const s = plainText(String(text ?? '')).slice(0, DETECT_MAX_CHARS);
  if (!s.trim()) return '';

  let han = 0;
  let kana = 0;
  let hangul = 0;
  let cyrillic = 0;
  let thai = 0;
  let latin = 0;

  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x4e00 && c <= 0x9fff) han += 1;
    else if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff)) kana += 1;
    else if (c >= 0xac00 && c <= 0xd7af) hangul += 1;
    else if (c >= 0x0400 && c <= 0x04ff) cyrillic += 1;
    else if (c >= 0x0e00 && c <= 0x0e7f) thai += 1;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0xc0 && c <= 0x24f)) latin += 1;
  }

  /* 高置信度脚本：出现少量即可判定 */
  if (kana >= 2) return 'ja';
  if (hangul >= 2) return 'ko';
  if (thai >= 3) return 'th';
  if (cyrillic >= 3) return 'ru';
  if (han >= 3 && han >= kana * 3) return 'zh';
  if (latin >= 3 && latin > han) return detectLatin(s);

  /* 稀疏文本兜底：按计数取最大，避免「你好」「Hello」这类短文本被判空 */
  if (han > 0 && han >= latin) return 'zh';
  if (kana > 0) return 'ja';
  if (hangul > 0) return 'ko';
  if (thai > 0) return 'th';
  if (cyrillic > 0) return 'ru';
  if (latin > 0) return detectLatin(s);
  return '';
}
