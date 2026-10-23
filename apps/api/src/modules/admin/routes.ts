/**
 * 站点设置后台接口（T3-4，§5.3）：读写 kv 'setting' JSON。
 *  GET /api/admin/setting   返回存储态（snake 键，供后台表单回显/编辑）
 *  PUT  /api/admin/setting   白名单合并写回 + 失效 L1 'setting'（前台 bootstrap/读路径下次即生效，零部署）
 *  PUT/DELETE /api/admin/setting/logo|favicon   站点 Logo / Favicon 上传与恢复（base64 → R2 site/，写 kv setting logo_url/favicon_url）
 *  runlevel 闸门中间件每请求直读 kv 'setting'（不走缓存），故改 runlevel 即时影响全站访问控制。
 *  挂载在 adminGuard 之后（app.use('/api/admin/*') 已先注册，守卫覆盖本模块所有路由）。
 */
import { Hono, type Context } from 'hono';
import { Code, RunLevel } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { ApiT } from '../../core/i18n';
import type { D1b } from '../../core/db';
import { filesBucket } from '../attach/core';
import { core, readJson, type ReadEnv } from '../shared';

type Ctx = Context<ReadEnv>;

/** 允许后台编辑的键（其余键如自定义扩展设置原样保留，避免误删） */
const EDITABLE: readonly string[] = [
  'sitename', 'brief', 'url', 'kw', 'desc',
  'runlevel', 'runlevel_reason',
  'user_create_on', 'user_create_email_on', 'user_resetpw_on',
  'forum_orderby', 'update_views_on', 'upload_max_size', 'lang', 'admin_lang',
  /* 积分奖励三键（本项目新增「积分」后台页；grantForPost 读 creditThread/Reply/DailyFirst） */
  'credit_thread', 'credit_reply', 'credit_daily_first',
  /* 内容审核两开关（tt_check：注册审核 user_check / 回收站 recycle；矩阵在 admin/check 模块单独保存） */
  'user_check', 'recycle',
  /* 设备访问三开关（本项目新增：手机/平板/电视端是否允许访问前台） */
  'device_phone_on', 'device_tablet_on', 'device_tv_on',
  /* 顶部导航栏自定义项（本项目新增「导航栏设置」；validate 特殊处理为 JSON 字符串） */
  'nav',
  /* 内容语言分区模式（0=关闭 1=开启默认全部 2=开启默认跟随界面语言） */
  'content_lang',
];

/** 非负整数键（积分奖励值，0=关闭） */
const INT_KEYS = new Set(['credit_thread', 'credit_reply', 'credit_daily_first', 'content_lang']);
const BOOL_KEYS = new Set(['user_create_on', 'user_create_email_on', 'user_resetpw_on', 'update_views_on', 'user_check', 'recycle', 'device_phone_on', 'device_tablet_on', 'device_tv_on']);
const asBool01 = (v: unknown): number => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);

function validate(input: Record<string, unknown>, cur: Record<string, unknown>, t: ApiT): Record<string, unknown> {
  const out = { ...cur };
  for (const k of EDITABLE) {
    if (!(k in input)) continue;
    const v = input[k];
    if (k === 'runlevel') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < RunLevel.CLOSED_SITE || n > RunLevel.NORMAL) {
        throw new AppError(Code.VALIDATION_ERROR, t('admin.runlevelInvalid'));
      }
      out.runlevel = n;
    } else if (k === 'upload_max_size') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.uploadMaxInvalid'));
      out.upload_max_size = n;
    } else if (k === 'forum_orderby') {
      out.forum_orderby = Number(v) === 1 ? 1 : 0;
    } else if (k === 'nav') {
      /* 顶部导航栏：接受数组或 JSON 字符串，归一化为 JSON 字符串存储（loadSetting 解析下发） */
      let arr: unknown = v;
      if (typeof v === 'string') {
        try {
          arr = JSON.parse(v);
        } catch {
          throw new AppError(Code.VALIDATION_ERROR, t('admin.navInvalid'));
        }
      }
      if (!Array.isArray(arr)) throw new AppError(Code.VALIDATION_ERROR, t('admin.navInvalid'));
      const items = [];
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue;
        const o = it as Record<string, unknown>;
        const label = String(o.label ?? '').trim();
        const url = String(o.url ?? '').trim();
        if (!label || !url) continue;
        items.push({ label, url, sort: Number(o.sort ?? 0) || 0, on: o.on === 0 || o.on === '0' ? 0 : 1 });
      }
      out.nav = JSON.stringify(items);
    } else if (k === 'url') {
      /* 主域名（多域名绑定时唯一对外地址）：必须 https，只保留 origin（路径/查询/尾斜杠一律丢弃）；
         留空表示未配置 —— 对外地址回落 SITE_URL，再回落当前请求域 */
      const raw = String(v ?? '').trim();
      if (!raw) {
        out.url = '';
      } else {
        let u: URL | null = null;
        try {
          u = new URL(raw);
        } catch {
          u = null;
        }
        if (!u || u.protocol !== 'https:') throw new AppError(Code.VALIDATION_ERROR, t('admin.siteUrlInvalid'));
        out.url = u.origin;
      }
    } else if (INT_KEYS.has(k)) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new AppError(Code.VALIDATION_ERROR, t('admin.fieldNonNegative', { k }));
      out[k] = n;
    } else if (BOOL_KEYS.has(k)) {
      out[k] = asBool01(v);
    } else {
      out[k] = String(v ?? '');
    }
  }
  return out;
}

/** 读 kv 'setting' 存储态 JSON（解析失败视为空对象） */
async function readSettingRaw(db: D1b): Promise<Record<string, unknown>> {
  const row = await db.prepare<{ v: string }>('SELECT v FROM bbs_kv WHERE k = ?').bind('setting').first<{ v: string }>();
  try {
    return JSON.parse(row?.v ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

/* ---------------- 站点 Logo / Favicon 上传（base64 提交 → 落盘 R2 site/） ---------------- */

const SITE_ICON_MAX_BYTES = 1024 * 1024; // 1MB：顶栏/标签页展示足够，防 base64 大包
/** ext → R2 httpMetadata contentType */
const SITE_ICON_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** data URL（data:image/…;base64,xxx）→ { bytes, ext }；favicon 额外放行 ico。非白名单格式/解码失败抛错 */
function decodeSiteIcon(raw: string, t: ApiT, allowIco: boolean): { bytes: Uint8Array; ext: string } {
  const m = new RegExp(`^data:image\\/(png|jpe?g|gif|webp|bmp${allowIco ? '|x-icon|vnd\\.microsoft\\.icon' : ''});base64,(.+)$`, 'is').exec(raw.trim());
  if (!m) throw new AppError(Code.VALIDATION_ERROR, t('admin.iconFormat'));
  const rawExt = m[1]!.toLowerCase();
  const ext = rawExt === 'jpeg' ? 'jpg' : rawExt === 'x-icon' || rawExt === 'vnd.microsoft.icon' ? 'ico' : rawExt;
  try {
    const bin = atob(m[2]!);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!bytes.length) throw new Error('empty');
    if (bytes.length > SITE_ICON_MAX_BYTES) throw new AppError(Code.FORM_FILE_TOO_LARGE, t('admin.iconTooLarge'), { size: bytes.length });
    return { bytes, ext };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(Code.VALIDATION_ERROR, t('admin.iconDecodeFailed'));
  }
}

/** setting 里存的 URL 键 / R2 key 前缀，按 kind 取 */
const SITE_ICON_FIELDS = { logo: 'logo_url', favicon: 'favicon_url' } as const;
type SiteIconKind = keyof typeof SITE_ICON_FIELDS;
/** 从存储的 /files/site/xxx?v=… 里解析出 R2 key（无值/格式不符回 null） */
function siteIconR2Key(url: string): string | null {
  const m = /^\/files\/(site\/[^\s?#]+)/.exec(url.trim());
  return m ? m[1]! : null;
}

/** PUT /api/admin/setting/:kind（logo|favicon）：上传即生效（写 kv setting + 失效 L1） */
async function putSiteIcon(c: Ctx, kind: SiteIconKind) {
  const { db, cache } = core(c);
  const t = c.get('t');
  const input = await readJson(c);
  const { bytes, ext } = decodeSiteIcon(String(input.data ?? ''), t, kind === 'favicon');

  const key = `site/${kind}.${ext}`;
  const cur = await readSettingRaw(db);
  const field = SITE_ICON_FIELDS[kind];
  const bucket = filesBucket(c.env);
  // 换格式（png→jpg 等）时清掉旧对象，不留孤儿；同 ext 覆盖写无需删
  const oldKey = siteIconR2Key(String(cur[field] ?? ''));
  if (oldKey && oldKey !== key) await bucket.delete(oldKey).catch(() => undefined);
  await bucket.put(key, bytes, { httpMetadata: { contentType: SITE_ICON_MIME[ext] } });

  const next = { ...cur, [field]: `/files/${key}?v=${Math.floor(Date.now() / 1000)}` };
  await db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind('setting', JSON.stringify(next)).run();
  await cache.del('setting'); // 前台 bootstrap / SEO 读路径下次即取新值
  return ok(c, t('common.saved'), { data: next });
}

/** DELETE /api/admin/setting/:kind：清 R2 对象 + 清 setting 键，恢复内置默认（logo 用字标 / favicon 无） */
async function deleteSiteIcon(c: Ctx, kind: SiteIconKind) {
  const { db, cache } = core(c);
  const t = c.get('t');
  const cur = await readSettingRaw(db);
  const field = SITE_ICON_FIELDS[kind];
  const oldKey = siteIconR2Key(String(cur[field] ?? ''));
  if (oldKey) await filesBucket(c.env).delete(oldKey).catch(() => undefined);
  const next = { ...cur, [field]: '' };
  await db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind('setting', JSON.stringify(next)).run();
  await cache.del('setting');
  return ok(c, t('admin.iconReset'), { data: next });
}

export function adminRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  app.get('/api/admin/setting', async (c) => {
    const { db } = core(c);
    return ok(c, 'ok', { data: await readSettingRaw(db) });
  });

  app.put('/api/admin/setting', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const input = await readJson(c);
    const cur = await readSettingRaw(db);
    const next = validate(input, cur, t);
    const json = JSON.stringify(next);
    await db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind('setting', json).run();
    await cache.del('setting'); // L1 失效，前台下次读取即取新值（§5.3 零部署生效）
    return ok(c, t('common.saved'), { data: next });
  });

  // PUT/DELETE /api/admin/setting/logo|favicon —— 站点 Logo / Favicon 上传与恢复（上传即生效）
  app.put('/api/admin/setting/logo', (c) => putSiteIcon(c, 'logo'));
  app.put('/api/admin/setting/favicon', (c) => putSiteIcon(c, 'favicon'));
  app.delete('/api/admin/setting/logo', (c) => deleteSiteIcon(c, 'logo'));
  app.delete('/api/admin/setting/favicon', (c) => deleteSiteIcon(c, 'favicon'));

  return app;
}
