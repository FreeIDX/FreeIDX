/**
 * 基础设置文案多语言（后台「基础设置」：站点名称 / 站点介绍 / 关闭原因 / 关键词 / 站点描述）。
 *
 * 存储：kv setting 的 `sitename_i18n` / `brief_i18n` / `runlevel_reason_i18n` / `kw_i18n` / `desc_i18n`，
 * 值形如 `{"zh-cn":"…","en-us":"…"}`（与版块名、导航项名同一套 NameI18nMap）。
 * 主字段（sitename 等）仍是缺省文案：未配置当前语言时回退它。
 */
import { nameI18nOf } from './forum-name';
import type { SiteSetting } from './api-types';

/** 可多语言的基础设置文本字段（SiteSetting 字段名） */
export const SITE_TEXT_FIELDS = ['sitename', 'brief', 'runlevelReason', 'kw', 'desc'] as const;
export type SiteTextField = (typeof SITE_TEXT_FIELDS)[number];

/** 展示用取词：5 个文本字段按 lang 覆盖，其余字段（图片/开关/语言等）原样透传 */
export function localizedSetting(setting: SiteSetting, lang: string): SiteSetting {
  return {
    ...setting,
    sitename: nameI18nOf(setting.sitename, setting.sitenameI18n, lang),
    brief: nameI18nOf(setting.brief, setting.briefI18n, lang),
    kw: nameI18nOf(setting.kw, setting.kwI18n, lang),
    desc: nameI18nOf(setting.desc, setting.descI18n, lang),
    runlevelReason: nameI18nOf(setting.runlevelReason ?? '', setting.runlevelReasonI18n, lang),
  };
}

/* ---------------- 站点级 title / description（SEO、GEO 与标签页标题共用口径） ----------------
 *
 * 两个字段的分工（改动前 title 只用了 sitename、description 直接塞 brief，两处都不对）：
 *  - `desc`（站点描述）：SEO 专用、纯文本、本来就是「一句话说清本站」→ 进 `<title>` 后缀与 `<meta description>`；
 *  - `brief`（站点介绍）：允许 HTML / 多行 / 长段落，属于页面正文 → 只在 desc 缺失时兜底，且必须先脱标签。
 *
 * 服务端预渲染（newPageMeta）、SPA 壳（injectShell）与前端首帧（Layout）都调这里，
 * 保证「爬虫拿到的 title」与「用户看到的标签页标题」逐字一致。
 */

/** title 后缀（定位短语）字数上限：中文超过约 30 字会被 SERP 与标签页截断，留出站点名的位置 */
export const SITE_TITLE_TAIL_MAX = 24;

/** meta description 字数上限（Google 桌面约 155 字符、中文约 78 字，超出被截断） */
export const SITE_DESC_MAX = 120;

/** 富文本 → 单行纯文本：brief 允许 HTML，进 title/属性前必须脱标签并压缩空白 */
export function plainText(html: string): string {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 按字数上限收尾，优先断在标点/空格处（避免把词切成两半） */
export function clipText(s: string, max: number): string {
  const text = s.trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf('，'), cut.lastIndexOf('、'), cut.lastIndexOf(','), cut.lastIndexOf(' '));
  return (at >= max / 2 ? cut.slice(0, at) : cut).trim();
}

/** 站点的「一句话定位」：desc 优先，缺失时退回 brief 的纯文本；两者皆空返回空串 */
export function siteTaglineOf(setting: Pick<SiteSetting, 'desc' | 'brief'>): string {
  return plainText(setting.desc) || plainText(setting.brief);
}

/**
 * 站点级 `<title>`：`站点名称 - 一句话定位`。
 * 定位短语取 desc（不是 brief）：brief 是展示用富文本，进 title 会带标签、被截断。
 * 站名为空、或定位短语与站名重复时只返回其一，避免 `FreeIDX - FreeIDX` 这类无信息标题。
 */
export function siteTitleOf(setting: Pick<SiteSetting, 'sitename' | 'desc' | 'brief'>): string {
  const name = plainText(setting.sitename);
  const tagline = clipText(siteTaglineOf(setting), SITE_TITLE_TAIL_MAX);
  if (!tagline || tagline === name) return name || tagline;
  return name ? `${name} - ${tagline}` : tagline;
}

/** 站点级 `<meta description>`：desc 优先，缺失时退回 brief 的纯文本，再压缩到上限 */
export function siteDescriptionOf(setting: Pick<SiteSetting, 'desc' | 'brief'>): string {
  return clipText(siteTaglineOf(setting), SITE_DESC_MAX);
}
