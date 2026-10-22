/**
 * 启用主题（内置完整主题）的读写。
 *
 * 口径：主题是**参与构建的前端代码**（`apps/web/src/themes/<id>/`），后端不持有主题清单，
 * 只记住一个 id（kv `theme`），因此新增主题不需要任何后端改动。
 * 主题 id 的合法性由前端主题管理页（构建期自动发现的列表）约束，后端只做格式校验；
 * 写入未知 id 时前端 resolveActiveTheme 会回落 light，不会白屏。
 */
import type { Cache } from './cache';
import { remember } from './cache';
import type { D1b } from './db';

/** 兜底主题 id：kv 无值 / 损坏 / 主题缺失时前端回落它（内置简蓝，零覆写） */
export const DEFAULT_THEME_ID = 'light';

/** 主题 id 格式：小写字母数字开头，允许 - _，最长 32（等同文件夹名约束） */
const THEME_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function isThemeId(v: unknown): v is string {
  return typeof v === 'string' && THEME_ID_RE.test(v);
}

/** 读取启用主题 id（kv `theme`，经 L0+L1 读穿；缺省/非法 → DEFAULT_THEME_ID） */
export async function loadThemeId(cache: Cache, db: D1b): Promise<string> {
  return remember(cache, 'theme', async () => {
    const row = await db.prepare<{ v: string }>('SELECT v FROM bbs_kv WHERE k = ?').bind('theme').first<{ v: string }>();
    try {
      const parsed: unknown = JSON.parse(row?.v ?? '');
      return isThemeId(parsed) ? parsed : DEFAULT_THEME_ID;
    } catch {
      return DEFAULT_THEME_ID;
    }
  });
}

/** 写入启用主题 id：落 kv 主体 + 失效缓存（下次请求即生效） */
export async function saveThemeId(cache: Cache, db: D1b, id: string): Promise<void> {
  await db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind('theme', JSON.stringify(id)).run();
  await cache.del('theme');
}
