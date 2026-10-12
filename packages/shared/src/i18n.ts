/**
 * i18n provider（T1-5）：文案字典由 gen/*.json 维护，
 * 加载策略由消费端决定（web: import.meta.glob 按 locale 载入；zh-cn 默认兜底）。
 * 占位符：{name} 形式。
 */
type LangDict = Record<string, string>;

export interface LocaleBundles {
  bbs: LangDict;
  admin: LangDict;
}

function createTranslator(dict: LangDict, fallback?: LangDict) {
  return (key: string, params: Record<string, string | number> = {}): string => {
    const tpl = dict[key] ?? fallback?.[key] ?? key;
    return tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
  };
}

/** 前后台字典合并入口（后台页优先命中 admin 命名空间） */
export function createAdminTranslator(b: LocaleBundles, zhFallback?: LocaleBundles) {
  return createTranslator({ ...b.bbs, ...b.admin }, zhFallback ? { ...zhFallback.bbs, ...zhFallback.admin } : undefined);
}

export function createFrontTranslator(b: LocaleBundles, zhFallback?: LocaleBundles) {
  return createTranslator(b.bbs, zhFallback?.bbs);
}
