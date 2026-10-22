/**
 * 后台文案：`createAdminTranslator` 合并 `{...bbs, ...admin}` 两个命名空间（admin 优先），
 * 因此通用词（确定/返回/编辑/删除/搜索）命中 bbs 字典，后台专有名命中 admin 字典——
 * 两份字典都由 scripts/gen-i18n.mjs 从语言词条源生成，界面文案以字典为准。
 */
import { useEffect, useMemo, useState } from 'react';
import { createAdminTranslator, DEFAULT_LOCALE, type AdminKey } from '@freeidx/shared';
import { isAdminLoaded, isAdminUnavailable, loadAdminBundle, subscribeBundles } from '@freeidx/shared/i18n/bundles';
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

/**
 * 后台词典按需加载：admin 命名空间单独成 chunk（见 @freeidx/shared/i18n/bundles），
 * 前台访客永不下载，进入后台（或切换后台语言）才拉取；bbs 走 useLocaleBundle 同一条链路。
 * 返回「是否可以渲染后台内容」：词典到位 → true；拉取失败/语言未知 → 也返回 true（降级渲染，
 * 退回词条 key 与中文兜底，而不是永久占位）。
 */
export function useAdminDictReady(): boolean {
  const lang = useAdminLang();
  const settled = (): boolean => isAdminLoaded(lang) || isAdminUnavailable(lang);
  const [ready, setReady] = useState(settled);

  useEffect(() => {
    let alive = true;
    const check = (): void => {
      if (alive) setReady(isAdminLoaded(lang) || isAdminUnavailable(lang));
    };
    const off = subscribeBundles(check);
    if (!isAdminLoaded(lang) && !isAdminUnavailable(lang)) void loadAdminBundle(lang).then(check);
    /* 缺词兜底用的是 DEFAULT_LOCALE 的合并词典（bbs ∪ admin），故兜底词典同样需要 admin 分区 */
    if (lang !== DEFAULT_LOCALE && !isAdminLoaded(DEFAULT_LOCALE)) void loadAdminBundle(DEFAULT_LOCALE);
    return () => {
      alive = false;
      off();
    };
  }, [lang]);

  return ready;
}

export function useAdminT(): AdminT {
  const lang = useAdminLang();
  /* 词典按需加载（见 lib/i18n 的 useLocaleBundle）：后台语言包未就绪时先回落 DEFAULT_LOCALE 词典，
     到位后自动切换；两者同一实例时不重复作为缺词兜底。 */
  const bundle = useLocaleBundle(lang);
  const fallbackBundle = useLocaleBundle(DEFAULT_LOCALE);
  /* 触发 admin 分区加载；useLocaleBundle 已订阅词典到位事件，加载完成后本组件随 bundle 引用变化重渲染 */
  useAdminDictReady();
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
