/**
 * 主题管理接口。
 *  - GET  /api/theme/active        公开：启用主题 id（SPA 首屏引导用，边缘缓存 30s）
 *  - GET  /api/admin/theme         后台：当前启用主题 + 内置兜底 id
 *  - PUT  /api/admin/theme         后台：切换启用主题（只写 kv `theme`，整页刷新前台即生效）
 *
 * 主题清单在前端构建期自动发现（apps/web/src/lib/theme/registry.ts），后端不复制清单；
 * 这里只做 id 格式校验，未知 id 由前端回落 light。
 */
import { Hono } from 'hono';
import { Code } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { DEFAULT_THEME_ID, isThemeId, loadThemeId, saveThemeId } from '../../core/theme';
import { core, readJsonObject, type ReadEnv } from '../shared';

export function themeRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  app.get('/api/theme/active', async (c) => {
    const { db, cache } = core(c);
    const id = await loadThemeId(cache, db);
    return ok(c, 'ok', { data: { id } });
  });

  app.get('/api/admin/theme', async (c) => {
    const { db, cache } = core(c);
    const id = await loadThemeId(cache, db);
    return ok(c, 'ok', { data: { active: id, default: DEFAULT_THEME_ID } });
  });

  app.put('/api/admin/theme', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const body = await readJsonObject(c);
    const id = body.id;
    if (!isThemeId(id)) throw new AppError(Code.VALIDATION_ERROR, t('admin.themeInvalid'));
    await saveThemeId(cache, db, id);
    return ok(c, t('common.saved'), { data: { active: id } });
  });

  return app;
}
