/** i18n Provider：前台语言 = 用户偏好（右上角切换器，localStorage 持久）> 站点 setting.lang，默认 en-us（§10.3） */
import { createContext, useContext, useEffect, useMemo, useCallback, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import {
  AVAILABLE_LOCALES,
  builtinGroupName,
  createFrontTranslator,
  DEFAULT_LOCALE,
  type FrontKey,
  type LocaleBundles,
} from '@freeidx/shared';
import { EMPTY_BUNDLES, getLoadedBundle, loadLocaleBundle, subscribeBundles } from '@freeidx/shared/i18n/bundles';
import { setUiLocale } from './api';
import { useAuth } from '../store/auth';

type T = (key: FrontKey, params?: Record<string, string | number>) => string;

const I18nCtx = createContext<T>((k) => k);

/* ---------------- 用户语言偏好（前台右上角切换器，浏览器本地持久） ---------------- */

const LANG_PREF_KEY = 'freeidx.lang';

function readLangPref(): string | null {
  try {
    return localStorage.getItem(LANG_PREF_KEY);
  } catch {
    return null;
  }
}

/**
 * 首屏语言：bootstrap 到达前唯一可用的依据（用户偏好，非法值忽略 → 站点缺省 en-us）。
 * main.tsx 据此在渲染前预载词条，使首次渲染即拿到可用词典，不出现「先显示 key 再补文案」的闪烁。
 */
export function initialLocale(): string {
  const pref = readLangPref();
  return pref && AVAILABLE_LOCALES.includes(pref) ? pref : DEFAULT_LOCALE;
}

interface LangPrefState {
  /** null = 跟随站点语言 */
  pref: string | null;
  setPref: (lang: string | null) => void;
}

export const useLangPref = create<LangPrefState>((set) => ({
  pref: readLangPref(),
  setPref: (lang) => {
    try {
      if (lang) localStorage.setItem(LANG_PREF_KEY, lang);
      else localStorage.removeItem(LANG_PREF_KEY);
    } catch {
      /* 隐私模式等 localStorage 不可用时仅本次会话生效 */
    }
    // 同步写 cookie（非 httpOnly，1 年）：同域 API 请求自动携带，后端据此协商
    // API 消息语言（lib/api.ts 无需逐请求附加头）。清除偏好时同步过期 cookie，
    // 使 API 消息回到站点语言，与界面行为一致。
    try {
      if (lang) document.cookie = `lang=${encodeURIComponent(lang)}; path=/; max-age=31536000; samesite=Lax`;
      else document.cookie = 'lang=; path=/; max-age=0; samesite=Lax';
    } catch {
      /* 无 document 环境（SSR）忽略 */
    }
    set({ pref: lang });
  },
}));

/** 前台展示语言：用户偏好（非法值忽略）优先，否则站点语言 */
export function useLang(): string {
  const siteLang = useAuth((s) => s.setting?.lang ?? DEFAULT_LOCALE);
  const pref = useLangPref((s) => s.pref);
  return pref && AVAILABLE_LOCALES.includes(pref) ? pref : siteLang;
}

/**
 * 语言包订阅（词典按需加载，见 @freeidx/shared/i18n/bundles）：渲染期同步返回可用词典。
 *  - 目标语言已加载 → 直接返回；
 *  - 未加载 → 沿用 DEFAULT_LOCALE 并后台发起加载，到位后切到目标语言。
 * 与既有链路一致：站点语言本就来自 bootstrap，首屏同为「先 en-us 再切换」，不新增可见行为。
 *
 * 注意：单语言词典分 bbs / admin 两个分区、**分两批到达**（前台先拉 bbs，进后台才拉 admin）。
 * 因此不能只在 lang 变化时取一次快照——必须订阅分区到位事件重取：
 * 否则早于 admin 分区到达就挂载的组件（后台侧栏/顶栏标题）会一直握着只含 bbs 的旧快照，
 * admin 命名空间词条全部落空，表现为「内容页中文、左侧菜单英文」（回退到代码里的英文 fallback）。
 */
export function useLocaleBundle(lang: string): LocaleBundles {
  /* 目标语言未到位时回落 DEFAULT_LOCALE（bbs 未到则该语言整包视为不可用） */
  const read = useCallback(
    (): LocaleBundles => getLoadedBundle(lang) ?? getLoadedBundle(DEFAULT_LOCALE) ?? EMPTY_BUNDLES,
    [lang],
  );
  const [bundle, setBundle] = useState<LocaleBundles>(read);
  useEffect(() => {
    /* 快照对象按语言缓存，无新分区到达时 read() 返回同一引用 → setBundle 不触发多余渲染 */
    const sync = (): void => setBundle(read());
    sync();
    const off = subscribeBundles(sync);
    if (!getLoadedBundle(lang)) void loadLocaleBundle(lang);
    return off;
  }, [read, lang]);
  return bundle;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const lang = useLang();
  const bundle = useLocaleBundle(lang);
  // <html lang> 与日期格式化 locale 跟随前台展示语言（SPA 壳静态 en-us 由运行时覆盖）
  useEffect(() => {
    document.documentElement.lang = lang;
    setUiLocale(lang);
  }, [lang]);
  const t = useMemo<T>(() => createFrontTranslator(bundle), [bundle]);
  return <I18nCtx.Provider value={t}>{children}</I18nCtx.Provider>;
}

export function useT(): T {
  return useContext(I18nCtx);
}

/**
 * 内置用户组名展示：(gid, name) → 当前语言组名。
 * DB 名未自定义时命中 `group_{gid}` 词条随语言切换；自定义/缺失词条原样返回（见 shared/builtinGroupName）。
 */
export function useGroupName(): (gid: number, name: string) => string {
  const lang = useLang();
  return useCallback((gid: number, name: string) => builtinGroupName(gid, name, lang), [lang]);
}
