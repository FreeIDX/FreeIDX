/**
 * 后台扩展管理 + 广告位管理（T3-9，§17.5）。挂载于 adminGuard 之后（已强制 gid=1）。
 *  启停/配置只改 kv、零部署、插件间互不影响：
 *   - GET/PUT /api/admin/extensions[/:id]  读写 kv 'extensions' + ext:{id}:config/secret（secret AES-GCM）
 *   - GET/POST/PUT/DELETE /api/admin/ad-slots（?ad_preview=1 含草稿位）
 * 私钥永不回显（仅返回是否已配置的元信息），不进日志。
 */
import { Hono } from 'hono';
import { Code } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { ADMIN_CATALOG, extSchemaOf } from '../../core/extensions';
import { loadExtensionsState } from '../../core/extensions/registry';
import { loadExtConfig, loadExtSecret, saveExtConfig, saveExtSecret, extSecretKey } from '../../core/ext-store';
import type { ApiT } from '../../core/i18n';
import { core, readJsonObject, type ReadEnv } from '../shared';

const nowSec = (): number => Math.floor(Date.now() / 1000);

const SLOT_TYPES = new Set(['html', 'image', 'adsense']);

/** 合并写回 kv 'extensions'（仅改动传入的 id），失效缓存使下次请求即热插拔。
 *  首次落 kv 的缺省值取目录 manifest（本地扩展随 Worker 部署、installed 恒为 1），
 *  不得硬编码 0——否则首次启停会写入 installed:0，令「启用」的插件因 installed!==1 而实际不运行。 */
async function patchExtensionsState(db: ReturnType<typeof core>['db'], cache: ReturnType<typeof core>['cache'], id: string, patch: { installed?: 0 | 1; enable?: 0 | 1 }, t: ApiT): Promise<void> {
  const mod = ADMIN_CATALOG.find((m) => m.manifest.id === id);
  if (!mod) throw new AppError(Code.NOT_FOUND, t('common.extNotFound'));
  const state = await loadExtensionsState(cache, db);
  const cur = state[id] ?? { installed: mod.manifest.installed, enable: mod.manifest.enable };
  const next = { ...cur, ...patch };
  state[id] = next;
  await db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind('extensions', JSON.stringify(state)).run();
  await cache.del('extensions');
}

function asFlag(v: unknown): 0 | 1 | undefined {
  if (v === undefined) return undefined;
  return v === 1 || v === true || v === '1' || v === 'true' ? 1 : 0;
}

function normalizeSlot(body: Record<string, unknown>, partial: boolean, t: ApiT): { position?: string; type?: string; config?: string; enabled?: number; sort?: number; start_date?: number; end_date?: number } {
  const out: ReturnType<typeof normalizeSlot> = {};
  if (!partial || 'position' in body) {
    const p = String(body.position ?? '').trim();
    if (!p) throw new AppError(Code.VALIDATION_ERROR, t('admin.positionRequired'));
    out.position = p;
  }
  if (!partial || 'type' in body) {
    const type = String(body.type ?? 'html');
    if (!SLOT_TYPES.has(type)) throw new AppError(Code.VALIDATION_ERROR, t('admin.slotTypeInvalid'));
    out.type = type;
  }
  if ('config' in body) {
    const cfg = body.config;
    if (cfg && (typeof cfg !== 'object' || Array.isArray(cfg))) throw new AppError(Code.VALIDATION_ERROR, t('admin.configInvalid'));
    out.config = JSON.stringify(cfg ?? {});
  }
  if (!partial || 'enabled' in body) out.enabled = asFlag(body.enabled) ?? 0;
  if ('sort' in body) out.sort = Math.trunc(Number(body.sort) || 0);
  if ('start_date' in body) out.start_date = Math.trunc(Number(body.start_date) || 0);
  if ('end_date' in body) out.end_date = Math.trunc(Number(body.end_date) || 0);
  return out;
}

interface SlotRow {
  id: number;
  position: string;
  type: string;
  config: string;
  enabled: number;
  sort: number;
  start_date: number;
  end_date: number;
  create_date: number;
}

function slotView(r: SlotRow): Record<string, unknown> {
  let cfg: unknown = {};
  try {
    cfg = JSON.parse(r.config || '{}');
  } catch {
    cfg = {};
  }
  return {
    id: Number(r.id),
    position: String(r.position),
    type: String(r.type),
    config: cfg,
    enabled: Number(r.enabled),
    sort: Number(r.sort),
    start_date: Number(r.start_date),
    end_date: Number(r.end_date),
    create_date: Number(r.create_date),
  };
}

export function adminExtensionsRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  app.get('/api/admin/extensions', async (c) => {
    const { db, cache } = core(c);
    const state = await loadExtensionsState(cache, db);
    // 隐藏项（如简蓝主题 light：已由「主题管理」统一呈现）不进列表，但详情/配置接口仍按 id 可用
    const list = ADMIN_CATALOG.filter((m) => !m.manifest.hiddenInCatalog).map((m) => {
      const s = state[m.manifest.id];
      return {
        id: m.manifest.id,
        name: m.manifest.name,
        version: m.manifest.version,
        installed: (s?.installed ?? m.manifest.installed) as 0 | 1,
        enable: (s?.enable ?? m.manifest.enable) as 0 | 1,
        // 插件自声明 schema 的轻量投影：卡片简介
        brief: extSchemaOf(m)?.brief,
      };
    });
    return ok(c, 'ok', { data: { extensions: list } });
  });

  app.get('/api/admin/extensions/:id', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const id = c.req.param('id');
    const mod = ADMIN_CATALOG.find((m) => m.manifest.id === id);
    if (!mod) throw new AppError(Code.NOT_FOUND, t('common.extNotFound'));
    const state = await loadExtensionsState(cache, db);
    const s = state[id];
    const config = await loadExtConfig(cache, db, id);
    const secretRow = await db
      .prepare<{ v: string }>('SELECT v FROM bbs_kv WHERE k = ?')
      .bind(extSecretKey(id))
      .first<{ v: string }>();
    // 结构化表单用：只回已配置的键名（绝不回值），master key 缺失/解密失败 → 空
    const secretKeys = Object.keys(await loadExtSecret(db, id, c.env.SECRETS_MASTER_KEY));
    return ok(c, 'ok', {
      data: {
        manifest: { id: mod.manifest.id, name: mod.manifest.name, version: mod.manifest.version },
        installed: (s?.installed ?? mod.manifest.installed) as 0 | 1,
        enable: (s?.enable ?? mod.manifest.enable) as 0 | 1,
        config,
        hasSecret: !!secretRow?.v,
        secretKeys,
        // 插件自声明的结构化表单 schema（target 已归一化）；无 schema 的插件不带该键，前端降级裸 JSON
        schema: extSchemaOf(mod),
      },
    });
  });

  app.put('/api/admin/extensions/:id', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const id = c.req.param('id');
    const mod = ADMIN_CATALOG.find((m) => m.manifest.id === id);
    if (!mod) throw new AppError(Code.NOT_FOUND, t('common.extNotFound'));
    const body = await readJsonObject(c);

    const patch: { installed?: 0 | 1; enable?: 0 | 1 } = {};
    const enable = asFlag(body.enable);
    const installed = asFlag(body.installed);
    if (enable !== undefined) patch.enable = enable;
    if (installed !== undefined) patch.installed = installed;
    // 启用即视为已安装（本地扩展随 Worker 部署，无独立安装动作）——顺带自愈历史 kv 里的 installed:0
    if (patch.enable === 1) patch.installed = 1;
    if (Object.keys(patch).length) await patchExtensionsState(db, cache, id, patch, t);

    if (body.config !== undefined) {
      const cfg = body.config;
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new AppError(Code.VALIDATION_ERROR, t('admin.configInvalid'));
      await saveExtConfig(db, cache, id, cfg as Record<string, unknown>);
    }

    if (body.secret !== undefined) {
      const sec = body.secret;
      if (!sec || typeof sec !== 'object' || Array.isArray(sec)) throw new AppError(Code.VALIDATION_ERROR, t('admin.secretInvalid'));
      const master = c.env.SECRETS_MASTER_KEY;
      if (!master) throw new AppError(Code.VALIDATION_ERROR, t('admin.masterKeyMissing'));
      await saveExtSecret(db, id, sec as Record<string, unknown>, master);
    }

    // 结构化表单用的增量合并：只改提交的键，值为 null 表示删除该键；未提交的键原样保留
    if (body.secretPatch !== undefined) {
      const patch = body.secretPatch;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new AppError(Code.VALIDATION_ERROR, t('admin.secretPatchInvalid'));
      const master = c.env.SECRETS_MASTER_KEY;
      if (!master) throw new AppError(Code.VALIDATION_ERROR, t('admin.masterKeyMissing'));
      const merged = await loadExtSecret(db, id, master);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete merged[k];
        else merged[k] = v;
      }
      await saveExtSecret(db, id, merged, master);
    }

    return ok(c, t('common.saved'), { data: { id } });
  });

  // 广告位：预览模式含草稿位（enabled=0），普通列表仅启用位
  app.get('/api/admin/ad-slots', async (c) => {
    const { db } = core(c);
    const preview = c.req.query('ad_preview') === '1';
    const sql = preview
      ? 'SELECT id,position,type,config,enabled,sort,start_date,end_date,create_date FROM bbs_ad_slot ORDER BY sort DESC, id ASC LIMIT 200'
      : 'SELECT id,position,type,config,enabled,sort,start_date,end_date,create_date FROM bbs_ad_slot WHERE enabled = 1 ORDER BY sort DESC, id ASC LIMIT 200';
    const r = await db.prepare<SlotRow>(sql).all();
    return ok(c, 'ok', { data: { slots: r.results.map(slotView) } });
  });

  app.post('/api/admin/ad-slots', async (c) => {
    const { db } = core(c);
    const t = c.get('t');
    const body = await readJsonObject(c);
    const s = normalizeSlot(body, false, t);
    const row = await db
      .prepare<{ id: number }>(
        'INSERT INTO bbs_ad_slot (position,type,config,enabled,sort,start_date,end_date,create_date) VALUES (?,?,?,?,?,?,?,?) RETURNING id',
      )
      .bind(s.position!, s.type!, s.config ?? '{}', s.enabled ?? 0, s.sort ?? 0, s.start_date ?? 0, s.end_date ?? 0, nowSec())
      .first<{ id: number }>();
    return ok(c, t('common.created'), { data: { id: Number(row?.id ?? 0) } });
  });

  app.put('/api/admin/ad-slots/:id', async (c) => {
    const { db } = core(c);
    const t = c.get('t');
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.idInvalid'));
    const exists = await db.prepare<{ id: number }>('SELECT id FROM bbs_ad_slot WHERE id = ?').bind(id).first<{ id: number }>();
    if (!exists) throw new AppError(Code.NOT_FOUND, t('common.adSlotNotFound'));
    const body = await readJsonObject(c);
    const s = normalizeSlot(body, true, t);
    const cols: string[] = [];
    const params: (number | string)[] = [];
    for (const key of ['position', 'type', 'config', 'enabled', 'sort', 'start_date', 'end_date'] as const) {
      if (s[key] !== undefined) {
        cols.push(`${key} = ?`);
        params.push(s[key] as number | string);
      }
    }
    if (!cols.length) throw new AppError(Code.VALIDATION_ERROR, t('common.noFieldsToUpdate'));
    params.push(id);
    await db.prepare(`UPDATE bbs_ad_slot SET ${cols.join(', ')} WHERE id = ?`).bind(...params).run();
    return ok(c, t('common.updated'), { data: { id } });
  });

  app.delete('/api/admin/ad-slots/:id', async (c) => {
    const { db } = core(c);
    const t = c.get('t');
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.idInvalid'));
    await db.prepare('DELETE FROM bbs_ad_slot WHERE id = ?').bind(id).run();
    return ok(c, t('common.deleted'), { data: { id } });
  });

  return app;
}
