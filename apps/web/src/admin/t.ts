/**
 * 后台文案：`createAdminTranslator` 合并 `{...bbs, ...admin}` 两个命名空间（admin 优先），
 * 因此通用词（确定/返回/编辑/删除/搜索）命中 bbs 字典，后台专有名命中 admin 字典——
 * 两份字典都由 scripts/gen-i18n.mjs 从语言词条源生成，界面文案以字典为准。
 */
import { useMemo } from 'react';
import { createAdminTranslator, DEFAULT_LOCALE, type AdminKey } from '@freeidx/shared';
import { useLocaleBundle } from '../lib/i18n';
import { useAuth } from '../store/auth';

/**
 * `createAdminTranslator` 未命中键时**回显键名**，这里把这行为用作缺失兜底：
 * 字典由脚本生成，个别键可能缺失（如 no_privilege），第二参给中文回退比让界面显示 `admin_xxx` 好。
 * 注意 fallback 与 params 分列两位，不能像底层 translate 那样把参数对象当第二参传。
 */
export type AdminT = (key: AdminKey, fallback?: string, params?: Record<string, string | number>) => string;

/**
 * 后台界面语言（setting.adminLang 优先，缺省回落站点语言 lang）。
 * 后台界面文案与插件自声明文案（名称/简介/schema）统一取此语言，与前台站点语言相互独立。
 */
export function useAdminLang(): string {
  return useAuth((s) => s.setting?.adminLang ?? s.setting?.lang ?? DEFAULT_LOCALE);
}

export function useAdminT(): AdminT {
  const lang = useAdminLang();
  /* 词典按需加载（见 lib/i18n 的 useLocaleBundle）：后台语言包未就绪时先回落 DEFAULT_LOCALE 词典，
     到位后自动切换；两者同一实例时不重复作为缺词兜底。 */
  const bundle = useLocaleBundle(lang);
  const fallbackBundle = useLocaleBundle(DEFAULT_LOCALE);
  return useMemo<AdminT>(() => {
    const tr = createAdminTranslator(bundle, fallbackBundle === bundle ? undefined : fallbackBundle);
    return (key, fallback, params) => {
      const s = tr(key, params);
      // 未命中时底层回显键名，这里换 fallback；fallback 也可能是 `{n}` 模板，同样要代入
      if (s !== key) return s;
      if (fallback === undefined) return s;
      return fallback.replace(/\{(\w+)\}/g, (m, k: string) => (params && k in params ? String(params[k]) : m));
    };
  }, [bundle, fallbackBundle]);
}
