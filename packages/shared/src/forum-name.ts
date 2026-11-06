/**
 * 可配置名称的多语言（0027_forum_name_i18n 起）：
 *  - 版块名：`bbs_forum.name` + `name_i18n`（JSON `{"zh-cn":"综合","en-us":"General"}`）；
 *  - 导航项名：kv setting.nav 每项的 `label` + `labels`（同一结构）。
 *
 * 事实源始终是主名称（版块 name / 导航 label）：后台列表、SEO、缺省回退都用它；
 * 多语言映射只覆盖「展示取词」，前台按当前界面语言命中则用之，未命中回退主名称。
 *
 * 与「内容语言」（bbs_forum.lang，只过滤主题、不翻译文案）刻意分离：
 * 本模块不改变任何查询/发帖口径，只影响展示。
 */
import { AVAILABLE_LOCALES } from './i18n/locales';

/** 多语言名称映射：locale → 名称 */
export type NameI18nMap = Record<string, string>;

/** 版块名映射（语义别名，与 NameI18nMap 同构） */
export type ForumNameMap = NameI18nMap;

/**
 * 任意输入（JSON 字符串 / 对象 / 空）→ 规范化的多语言名称映射。
 * 只保留 AVAILABLE_LOCALES 内的语言、去首尾空白、丢弃空值（空 = 该语言未翻译，展示回退主名称）。
 */
export function normNameI18n(raw: unknown): NameI18nMap {
  let src: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return {};
    try {
      src = JSON.parse(text);
    } catch {
      return {};
    }
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) return {};
  const out: NameI18nMap = {};
  for (const loc of AVAILABLE_LOCALES) {
    const v = (src as Record<string, unknown>)[loc];
    if (typeof v !== 'string') continue;
    const name = v.trim();
    if (name) out[loc] = name;
  }
  return out;
}

/** 规范化后的映射 → 入库字符串（空映射存空串，与「未配置」同义） */
export function stringifyNameI18n(raw: unknown): string {
  const map = normNameI18n(raw);
  return Object.keys(map).length ? JSON.stringify(map) : '';
}

/** 展示取词：当前语言有译文用译文，否则回退主名称（主名称可以是任意语言） */
export function nameI18nOf(
  base: string,
  map: NameI18nMap | null | undefined,
  lang: string,
): string {
  const hit = map?.[lang];
  return hit && hit.trim() ? hit : base;
}

/* ---------------- 版块名语义的兼容别名（既有调用点不改名） ---------------- */
export const normForumNameI18n = normNameI18n;
export const stringifyForumNameI18n = stringifyNameI18n;
export const forumNameOf = nameI18nOf;
