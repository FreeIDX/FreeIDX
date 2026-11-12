/**
 * 站点设置后台接口（T3-4，§5.3）：读写 kv 'setting' JSON。
 *  GET /api/admin/setting   返回存储态（snake 键，供后台表单回显/编辑）
 *  PUT  /api/admin/setting   白名单合并写回 + 失效 L1 'setting'（前台 bootstrap/读路径下次即生效，零部署）
 *  PUT/DELETE /api/admin/setting/logo|favicon   站点 Logo / Favicon 上传与恢复（base64 → R2 site/，写 kv setting logo_url/favicon_url）
 *  PUT /api/admin/setting/nav-icon             导航项自定义图标上传（base64 → R2 site/nav/，只回直链，由 nav 项的 iconUrl 保存）
 *  runlevel 闸门中间件每请求直读 kv 'setting'（不走缓存），故改 runlevel 即时影响全站访问控制。
 *  挂载在 adminGuard 之后（app.use('/api/admin/*') 已先注册，守卫覆盖本模块所有路由）。
 */
import { Hono, type Context } from 'hono';
import { Code, RunLevel, normNameI18n } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { ApiT } from '../../core/i18n';
import type { D1b } from '../../core/db';
import { filesBucket } from '../attach/core';
import { core, readJson, type ReadEnv } from '../shared';

type Ctx = Context<ReadEnv>;

/** 允许后台编辑的键（其余键如自定义扩展设置原样保留，避免误删） */
const EDITABLE: readonly string[] = [
  'sitename',
  'brief',
  'url',
  'kw',
  'desc',
  'runlevel',
  'runlevel_reason',
  'user_create_on',
  'user_create_email_on',
  'user_resetpw_on',
  'forum_orderby',
  'update_views_on',
  'upload_max_size',
  'lang',
  'admin_lang',
  /* 积分奖励三键（本项目新增「积分」后台页；grantForPost 读 creditThread/Reply/DailyFirst） */
  'credit_thread',
  'credit_reply',
  'credit_daily_first',
  /* 内容审核两开关（tt_check：注册审核 user_check / 回收站 recycle；矩阵在 admin/check 模块单独保存） */
  'user_check',
  'recycle',
  /* 设备访问三开关（本项目新增：手机/平板/电视端是否允许访问前台） */
  'device_phone_on',
  'device_tablet_on',
  'device_tv_on',
  /* 顶部导航栏自定义项（本项目新增「导航栏设置」；validate 特殊处理为 JSON 字符串） */
  'nav',
  /* 内容语言分区模式（0=关闭 1=开启默认全部 2=开启默认跟随界面语言） */
  'content_lang',
  /* 基础设置五个文本的多语言覆盖（sitename/brief/kw/desc/runlevel_reason；值为 locale → 文本 对象） */
  'sitename_i18n',
  'brief_i18n',
  'kw_i18n',
  'desc_i18n',
  'runlevel_reason_i18n',
];

/** 基础设置文案多语言键：validate 存对象（空映射删除该键） */
const I18N_KEYS = new Set([
  'sitename_i18n',
  'brief_i18n',
  'kw_i18n',
  'desc_i18n',
  'runlevel_reason_i18n',
]);

/** 非负整数键（积分奖励值，0=关闭） */
const INT_KEYS = new Set(['credit_thread', 'credit_reply', 'credit_daily_first', 'content_lang']);
const BOOL_KEYS = new Set([
  'user_create_on',
  'user_create_email_on',
  'user_resetpw_on',
  'update_views_on',
  'user_check',
  'recycle',
  'device_phone_on',
  'device_tablet_on',
  'device_tv_on',
]);
const asBool01 = (v: unknown): number =>
  v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
/**
 * 导航项自定义图标直链（「导航栏设置」上传）：只认 site/nav/ 下的本站文件。
 * 保存时用它做白名单校验 —— 后台不提供「填链接」入口，外链也不会被写进 nav。
 */
const NAV_ICON_URL_RE = /^\/files\/(site\/nav\/[A-Za-z0-9_-]+\.(?:png|jpe?g|gif|webp|bmp))$/;

function validate(
  input: Record<string, unknown>,
  cur: Record<string, unknown>,
  t: ApiT,
): Record<string, unknown> {
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
      if (!Number.isFinite(n) || n < 0)
        throw new AppError(Code.VALIDATION_ERROR, t('admin.uploadMaxInvalid'));
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
        /* labels/icon/iconUrl 必须原样透传：丢一个字段，后台配的多语言名称与图标保存后即消失，
           前台（loaders.parseNavItems）自然永远读不到，表现为「设了不生效」。 */
        const labels = normNameI18n(o.labels);
        const icon = String(o.icon ?? '').trim();
        /* 自定义图标只认本系统「导航项图标上传」落库的 site/nav/ 直链：外部 URL 一律丢弃
           （顶栏图标由站长上传维护，避免外链失效/被当作图床） */
        const iconFile = NAV_ICON_URL_RE.exec(String(o.iconUrl ?? '').trim())?.[1] ?? '';
        items.push({
          label,
          ...(Object.keys(labels).length ? { labels } : {}),
          ...(icon ? { icon } : {}),
          ...(iconFile ? { iconUrl: `/files/${iconFile}` } : {}),
          url,
          sort: Number(o.sort ?? 0) || 0,
          on: o.on === 0 || o.on === '0' ? 0 : 1,
        });
      }
      out.nav = JSON.stringify(items);
    } else if (I18N_KEYS.has(k)) {
      /* 基础设置文案多语言：接受对象或 JSON 字符串，归一化为「仅受支持语言 + 非空值」的对象；
         全部为空 = 未配置 → 删除该键（前台回退主字段） */
      const map = normNameI18n(v);
      if (Object.keys(map).length) out[k] = map;
      else delete out[k];
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
        if (!u || u.protocol !== 'https:')
          throw new AppError(Code.VALIDATION_ERROR, t('admin.siteUrlInvalid'));
        out.url = u.origin;
      }
    } else if (INT_KEYS.has(k)) {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0)
        throw new AppError(Code.VALIDATION_ERROR, t('admin.fieldNonNegative', { k }));
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
  const row = await db
    .prepare<{ v: string }>('SELECT v FROM bbs_kv WHERE k = ?')
    .bind('setting')
    .first<{ v: string }>();
  try {
    return JSON.parse(row?.v ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

/* ---------------- 站点 Logo / Favicon 上传（base64 提交 → 落盘 R2 site/） ---------------- */

const SITE_ICON_MAX_BYTES = 1024 * 1024; // 1MB：顶栏/标签页展示足够，防 base64 大包
/**
 * favicon 三档产物的单张上限：上传端已在浏览器里裁成正方形并压成 PNG（32/180/192），
 * 正常只有几 KB；64KB 是「浏览器没转换成功却硬塞原图」的兜底闸门。
 */
const FAVICON_VARIANT_MAX_BYTES = 64 * 1024;
/** favicon 多尺寸的固定 key（边长即 key，壳页与 SEO 按同一 base 派生，见 core/fmt.ts 的 iconLinkTags） */
const FAVICON_SIZES = [32, 180, 192] as const;
const faviconKey = (n: number): string => `site/favicon-${n}.png`;
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
function decodeSiteIcon(
  raw: string,
  t: ApiT,
  allowIco: boolean,
  maxBytes = SITE_ICON_MAX_BYTES,
): { bytes: Uint8Array; ext: string } {
  const m = new RegExp(
    `^data:image\\/(png|jpe?g|gif|webp|bmp${allowIco ? '|x-icon|vnd\\.microsoft\\.icon' : ''});base64,(.+)$`,
    'is',
  ).exec(raw.trim());
  if (!m) throw new AppError(Code.VALIDATION_ERROR, t('admin.iconFormat'));
  const rawExt = m[1]!.toLowerCase();
  const ext =
    rawExt === 'jpeg'
      ? 'jpg'
      : rawExt === 'x-icon' || rawExt === 'vnd.microsoft.icon'
        ? 'ico'
        : rawExt;
  try {
    const bin = atob(m[2]!);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (!bytes.length) throw new Error('empty');
    if (bytes.length > maxBytes)
      throw new AppError(Code.FORM_FILE_TOO_LARGE, t('admin.iconTooLarge'), { size: bytes.length });
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

/**
 * favicon 多尺寸载荷：`variants` 必须同时带 180 与 192（缺一即视为老客户端，回落单文件路径，
 * 避免壳页派生出 404 的 apple-touch-icon）。
 */
function faviconVariantMap(input: Record<string, unknown>): Record<string, unknown> | null {
  const v = input.variants;
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return String(o['180'] ?? '') && String(o['192'] ?? '') ? o : null;
}

/**
 * PUT /api/admin/setting/:kind（logo|favicon）：上传即生效（写 kv setting + 失效 L1）。
 *
 * favicon 两种载荷：
 *  - `{ data, variants: { "180": …, "192": … } }`：后台已把原图裁成正方形并压成 PNG，
 *    这里落 `site/favicon-{32,180,192}.png`，`favicon_url` 指向 32 档，另两档由壳页/SEO 按
 *    key 派生（core/fmt.ts 的 iconLinkTags）。标签页图标从此只下 32×32，不再拉原图。
 *  - `{ data }`：老客户端或 .ico，保持单文件 `site/favicon.{ext}`，行为与改动前完全一致。
 */
async function putSiteIcon(c: Ctx, kind: SiteIconKind) {
  const { db, cache } = core(c);
  const t = c.get('t');
  const input = await readJson(c);
  const cur = await readSettingRaw(db);
  const field = SITE_ICON_FIELDS[kind];
  const bucket = filesBucket(c.env);

  /** 本次要写的对象：favicon 多尺寸时 3 个，其余 1 个 */
  const writes: Array<{ key: string; bytes: Uint8Array; ext: string }> = [];
  const variants = kind === 'favicon' ? faviconVariantMap(input) : null;
  if (variants) {
    const main = decodeSiteIcon(String(input.data ?? ''), t, false, FAVICON_VARIANT_MAX_BYTES);
    if (main.ext !== 'png') throw new AppError(Code.VALIDATION_ERROR, t('admin.iconFormat'));
    writes.push({ key: faviconKey(32), bytes: main.bytes, ext: 'png' });
    for (const size of FAVICON_SIZES) {
      if (size === 32) continue;
      const v = decodeSiteIcon(String(variants[String(size)] ?? ''), t, false, FAVICON_VARIANT_MAX_BYTES);
      if (v.ext !== 'png') throw new AppError(Code.VALIDATION_ERROR, t('admin.iconFormat'));
      writes.push({ key: faviconKey(size), bytes: v.bytes, ext: 'png' });
    }
  } else {
    const { bytes, ext } = decodeSiteIcon(String(input.data ?? ''), t, kind === 'favicon');
    writes.push({ key: `site/${kind}.${ext}`, bytes, ext });
  }

  // 换格式（png→jpg）/ 换尺寸方案时清掉旧对象，不留孤儿；同 key 覆盖写无需删
  const stale = new Set<string>();
  const oldKey = siteIconR2Key(String(cur[field] ?? ''));
  if (oldKey && !writes.some((w) => w.key === oldKey)) stale.add(oldKey);
  if (kind === 'favicon') {
    for (const size of FAVICON_SIZES) {
      const k = faviconKey(size);
      if (!writes.some((w) => w.key === k)) stale.add(k);
    }
  }
  if (stale.size) await bucket.delete([...stale]).catch(() => undefined);
  await Promise.all(
    writes.map((w) => bucket.put(w.key, w.bytes, { httpMetadata: { contentType: SITE_ICON_MIME[w.ext] } })),
  );

  const next = { ...cur, [field]: `/files/${writes[0]!.key}?v=${Math.floor(Date.now() / 1000)}` };
  await db
    .prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)')
    .bind('setting', JSON.stringify(next))
    .run();
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
  /* favicon 的三档产物都要清：只删 favicon_url 指向的那一张，另两档会变成孤儿对象，
     被存储维护按 site/ 前缀回收前一直是可访问的残留。 */
  const keys = [
    ...(oldKey ? [oldKey] : []),
    ...(kind === 'favicon' ? FAVICON_SIZES.map(faviconKey) : []),
  ];
  if (keys.length)
    await filesBucket(c.env)
      .delete(keys)
      .catch(() => undefined);
  const next = { ...cur, [field]: '' };
  await db
    .prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)')
    .bind('setting', JSON.stringify(next))
    .run();
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

  /**
   * PUT /api/admin/setting/nav-icon —— 导航项自定义图标上传（base64 提交，仅落 R2 不写 setting）。
   * 与 logo/favicon 的区别：图标属于「某一导航项」，故返回直链由前端写进该行的 iconUrl，
   * 随 PUT /api/admin/setting 的 nav 一起保存（未保存的直链就是孤儿对象，由存储维护按 site/ 前缀回收）。
   * key 带随机段 ⇒ 同一项反复更换不会覆盖旧文件，线上已保存的顶栏图标不会被换图牵连。
   */
  app.put('/api/admin/setting/nav-icon', async (c) => {
    const t = c.get('t');
    const input = await readJson(c);
    const { bytes, ext } = decodeSiteIcon(String(input.data ?? ''), t, false);
    const key = `site/nav/${crypto.randomUUID().replace(/-/g, '')}.${ext}`;
    await filesBucket(c.env).put(key, bytes, { httpMetadata: { contentType: SITE_ICON_MIME[ext] } });
    return ok(c, t('admin.iconUpdated'), { data: { icon_url: `/files/${key}` } });
  });

  return app;
}
