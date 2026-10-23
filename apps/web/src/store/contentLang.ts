/**
 * 内容语言筛选偏好（与界面语言偏好 useLangPref 相互独立）。
 *
 * 取值：
 *   ''    未选择 —— 由站点设置决定默认（contentLang=2 时跟随界面语言，否则全部）
 *   'all' 显式「全部语言」——即使站点默认跟随界面语言也保持全部
 *   zh/en/ja/ko/ru/th/de/fr/es/other  指定语言
 *
 * 只存 localStorage、**不发 cookie**：内容过滤必须由前端显式拼进查询串（?lang=），
 * 这样边缘缓存键天然按语言隔离；若依赖服务端读 cookie 做默认值，不同语言的用户
 * 会命中同一份缓存副本（edge.ts 的 fi-lang 只编界面语言，不含内容过滤维度）。
 */
import { create } from 'zustand';
import { contentLangOfLocale, normalizeContentLang } from '@freeidx/shared';
import { useAuth } from './auth';
import { useLang } from '../lib/i18n';

const KEY = 'freeidx.contentLang';

/** 读取本地偏好并归一化（非法值视为未选择；'all' 保留） */
function readPref(): string {
  try {
    const raw = localStorage.getItem(KEY) ?? '';
    if (raw === 'all') return 'all';
    return normalizeContentLang(raw);
  } catch {
    return '';
  }
}

export const useContentLang = create<{ pref: string; setPref: (v: string) => void }>((set) => ({
  pref: readPref(),
  setPref: (v) => {
    const next = v === 'all' ? 'all' : normalizeContentLang(v);
    try {
      if (next) localStorage.setItem(KEY, next);
      else localStorage.removeItem(KEY);
    } catch {
      /* 隐私模式：忽略持久化失败，本次会话仍生效 */
    }
    set({ pref: next });
  },
}));

/** 站点开关：0=关闭（不显示筛选条、不传 lang） 1=开启默认全部 2=开启默认跟随界面语言 */
export function useContentLangMode(): number {
  const setting = useAuth((s) => s.setting);
  return Math.min(2, Math.max(0, Number(setting?.contentLang ?? 0) || 0));
}

/**
 * 实际生效的内容语言（'' = 全部）。
 * 站点关闭时恒为 ''（后端同样会忽略 ?lang=，双保险）。
 */
export function useContentLangFilter(): string {
  const mode = useContentLangMode();
  const pref = useContentLang((s) => s.pref);
  const uiLang = useLang();
  if (mode <= 0) return '';
  if (pref === 'all') return '';
  if (pref) return pref;
  return mode === 2 ? contentLangOfLocale(uiLang) : '';
}
