/**
 * 首屏预载清单读取（构建期产物 `dist/assets/preload-map.json`，生成见 apps/web/vite.config.ts）。
 *
 * 用途：SPA 壳注入时给「入口 chunk 执行后才发起的动态 import」补一条 `<link rel="modulepreload">`，
 * 让它与入口 chunk 并行下载。当前清单里只有**前台词条包**（第 1 项就阻塞 createRoot 的那一个）：
 *   - 基底主题 light 是静态引入的（lib/theme/registry.ts），随入口 chunk 到达，无需预载；
 *   - 页面 chunk 在入口执行后立刻并行发起，预载收益可以忽略。
 *
 * 读取时机：只在壳页**未命中边缘缓存**时（每 60s 一台机柜最多一次），不做 isolate 级记忆 ——
 * 记忆会让新版本部署后的首次请求仍读到旧 hash（旧 chunk 不存在 → modulepreload 静默失败，
 * 不致命但白下），而省下的这一次子请求本来也只在 miss 路径上。
 *
 * 失败一律返回 null（本地 dev、旧产物、资产层 404）：调用方退化为「不预载」，功能零影响。
 */
import type { Env } from '../types/env';

export interface PreloadMap {
  /** 站点语言（locale）→ 前台词条 chunk 的文件名（相对站点根，如 `assets/i18n-bbs-zh-cn-abc.js`） */
  i18n?: Record<string, string>;
}

const MANIFEST_PATH = '/assets/preload-map.json';

export async function loadPreloadMap(env: Env, baseUrl: string): Promise<PreloadMap | null> {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL(MANIFEST_PATH, baseUrl)));
    if (!res.ok) return null;
    const json = (await res.json()) as PreloadMap;
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

/**
 * 生成壳页要插入的预载标签（纯函数，便于单测）。
 *  - 词条包：只在清单里有当前站点语言时输出；访客语言与站点语言不同时由前端自行加载（不预载，避免白下）。
 *  - `/api/bootstrap`：入口 chunk 一执行就会请求它，从 HTML 里预载可让它与入口 chunk 并行
 *    （`crossorigin="use-credentials"` 与前端 `fetch(..., { credentials: 'include' })` 同模式，
 *    浏览器才能复用这份预载；少了这个属性会退化成两次请求）。
 */
export function shellPreloadTags(map: PreloadMap | null, siteLang: string): string {
  const out: string[] = [`<link rel="preload" as="fetch" href="/api/bootstrap" crossorigin="use-credentials">`];
  const i18nFile = map?.i18n?.[siteLang];
  if (i18nFile) out.push(`<link rel="modulepreload" crossorigin href="/${i18nFile}">`);
  return out.join('');
}
