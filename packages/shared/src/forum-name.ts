/**
 * 版块名多语言（0027_forum_name_i18n）。
 *
 * 事实源仍是 `bbs_forum.name`（主名称，后台列表 / SEO / 缺省回退都用它），
 * 本模块只处理 `name_i18n`（JSON 对象 `{"zh-cn":"综合","en-us":"General"}`）：
 *  - 存储侧：`normForumNameI18n` 收敛为「仅受支持语言 + 非空串」的对象；
 *  - 展示侧：`forumNameOf(name, i18n, lang)` 命中当前语言则覆盖，否则回退主名称。
 *
 * 与「内容语言」（bbs_forum.lang，只过滤主题、不翻译文案）刻意分离：
 * 本字段只影响版块名的展示取词，与前台语言切换同步，不改变任何发帖/查询口径。
 */
import { AVAILABLE_LOCALES } from './i18n/locales';

/** 版块名多语言映射：locale → 名称 */
export type ForumNameMap = Record<string, string>;

/**
 * 任意输入（JSON 字符串 / 对象 / 空）→ 规范化的多语言名称映射。
 * 只保留 AVAILABLE_LOCALES 内的语言、去首尾空白、丢弃空值（空 = 该语言未翻译，展示回退主名称）。
 */
export function normForumNameI18n(raw: unknown): ForumNameMap {
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
  const out: ForumNameMap = {};
  for (const loc of AVAILABLE_LOCALES) {
    const v = (src as Record<string, unknown>)[loc];
    if (typeof v !== 'string') continue;
    const name = v.trim();
    if (name) out[loc] = name;
  }
  return out;
}

/** 规范化后的映射 → 入库字符串（空映射存空串，与「未配置」同义） */
export function stringifyForumNameI18n(raw: unknown): string {
  const map = normForumNameI18n(raw);
  return Object.keys(map).length ? JSON.stringify(map) : '';
}

/** 展示取词：当前语言有译文用译文，否则回退主名称（name 本身可以是任意语言） */
export function forumNameOf(name: string, i18n: ForumNameMap | null | undefined, lang: string): string {
  const hit = i18n?.[lang];
  return hit && hit.trim() ? hit : name;
}
