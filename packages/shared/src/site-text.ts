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
