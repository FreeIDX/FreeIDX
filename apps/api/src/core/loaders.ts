/**
 * 数据装载器（T1-4 基础）：forumlist/grouplist/setting 走三层缓存，
 * viewer 走 session 轨（JWT 自动登录在 M2 T2-2 补齐；此处已支持登录用户的权限过滤）。
 */
import {
  BanScope,
  Code,
  FORUM_LANG_UNRESTRICTED,
  GroupId,
  RunLevel,
  effectiveBanScope,
  normalizeForumLang,
  type NavItem,
  type SiteSetting,
} from '@freeidx/shared';
import { AppError } from '../middleware/envelope';
import { banMessage } from './ban';
import { t0, type ApiT } from './i18n';
import type { D1b } from './db';
import { FORUM_COLS, USER_SESSION_COLS } from './db/columns';
import type { Cache } from './cache';
import { remember } from './cache';
import type { AccessCtx, AccessRow, ForumForAccess, GroupForAccess } from './access';
import type { Env } from '../types/env';
import { ACCESS_TOKEN_TTL, verifyJwt } from './auth/jwt';
import { createSession, ipToLong, touchSession } from './auth/session';

export interface ForumRow extends ForumForAccess {
  name: string;
  rank: number;
  threads: number;
  todayposts: number;
  todaythreads: number;
  seo_title: string;
  seo_keywords: string;
  brief: string;
  announcement: string;
  icon: number;
  orderby: number;
  accesson: number;
  /** 自定义图标 R2 key（如 forum/3.png），空 = 未上传（0003_forum_icon） */
  icon_file: string;
  /** 图标上传时间戳，兼作 icon_url 缓存版本号 */
  icon_time: number;
  /** 图标直链：有自定义 → /files/{icon_file}?v={icon_time}，否则 ''（前台回退内置默认图） */
  icon_url: string;
  /** 上级版块 fid，0 = 一级版块（0018_forum_parent，仅两级） */
  parent_fid: number;
}

/**
 * 版块生效内容语言（0024）：发帖强制、编辑对齐、后台移动版块三处共用同一口径。
 *
 *   自身绑定具体语言      → 该语言（子版块也以自身为准）
 *   自身 = 'none'（哨兵） → 显式解除继承 → 空串（不限制）
 *   自身 = '' 且二级版块  → 继承父版块（父为哨兵则空串）
 *   其余（顶级空串）      → 空串（不限制）
 *
 * 版块只两级（0018），故不做递归。
 */
export function forumLangOf(forumlist: Record<number, ForumForAccess>, fid: number): string {
  const f = forumlist[fid];
  if (!f) return '';
  const own = normalizeForumLang(f.lang);
  if (own === FORUM_LANG_UNRESTRICTED) return '';
  if (own) return own;
  const parent = Number(f.parent_fid ?? 0);
  if (parent > 0 && parent !== fid) {
    const pLang = normalizeForumLang(forumlist[parent]?.lang);
    return pLang === FORUM_LANG_UNRESTRICTED ? '' : pLang;
  }
  return '';
}

export async function loadGrouplist(cache: Cache, db: D1b): Promise<Record<number, GroupForAccess>> {
  return remember(cache, 'grouplist', async () => {
    const r = await db
      .prepare<Record<string, number | string>>(
        'SELECT * FROM bbs_group', /* 后台低频、行数≈13，唯一豁免显式投影处（无宽列） */
      )
      .all();
    const out: Record<number, GroupForAccess> = {};
    for (const row of r.results) out[Number(row.gid)] = row as unknown as GroupForAccess;
    return out;
  });
}

/** 版块树 + access 矩阵（一次组装进缓存，命中零 D1——§7 forumlist 行） */
export async function loadForumlist(cache: Cache, db: D1b): Promise<Record<number, ForumRow>> {
  return remember(cache, 'forumlist', async () => {
    const [forums, access] = await Promise.all([
      db.prepare<ForumRow>(`SELECT ${FORUM_COLS} FROM bbs_forum ORDER BY rank DESC, fid ASC`).all(),
      db.prepare<{ fid: number; gid: number } & AccessRow>('SELECT fid,gid,allowread,allowthread,allowpost,allowattach,allowdown FROM bbs_forum_access').all(),
    ]);
    const out: Record<number, ForumRow> = {};
    for (const f of forums.results) {
      f.icon_file = String(f.icon_file ?? '');
      f.icon_time = Number(f.icon_time ?? 0);
      f.icon_url = f.icon_file ? `/files/${f.icon_file}?v=${f.icon_time}` : '';
      f.parent_fid = Number(f.parent_fid ?? 0);
      out[f.fid] = { ...f, accesson: Number(f.accesson), accesslist: {} };
    }
    for (const a of access.results) {
      const f = out[a.fid];
      if (f) (f.accesslist ??= {})[a.gid] = a;
    }
    return out;
  });
}

/** kv.setting 存储沿用 snake 键（后台/迁移数据兼容），DTO 归一化为 camelCase */
/** 顶部导航栏项解析：接受数组或 JSON 字符串，逐项归一化；非法输入返回 undefined（前台走默认导航） */
function parseNavItems(raw: unknown): NavItem[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let arr: unknown;
  if (Array.isArray(raw)) {
    arr = raw;
  } else if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return undefined;
    }
  } else {
    return undefined;
  }
  if (!Array.isArray(arr)) return undefined;
  const out: NavItem[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const label = String(o.label ?? '').trim();
    const url = String(o.url ?? '').trim();
    if (!label || !url) continue;
    out.push({ label, url, sort: Number(o.sort ?? 0) || 0, on: o.on === 0 || o.on === '0' ? 0 : 1 });
  }
  return out;
}
export async function loadSetting(cache: Cache, db: D1b): Promise<SiteSetting> {
  return remember(cache, 'setting', async () => {
    const row = await db
      .prepare<{ v: string }>('SELECT v FROM bbs_kv WHERE k = ?')
      .bind('setting')
      .first<{ v: string }>();
    const raw = JSON.parse(row?.v ?? '{}') as Record<string, unknown>;
    return {
      ...raw,
      sitename: String(raw.sitename ?? ''),
      brief: String(raw.brief ?? ''),
      /* runlevel 缺省=正常(5)，raw ?? NORMAL 口径（0 是显式关闭档，不是缺省） */
      runlevel: raw.runlevel === undefined ? RunLevel.NORMAL : Number(raw.runlevel),
      url: String(raw.url ?? ''),
      kw: String(raw.kw ?? ''),
      desc: String(raw.desc ?? ''),
      userCreateOn: !!raw.user_create_on,
      userCreateEmailOn: !!raw.user_create_email_on,
      userResetpwOn: !!raw.user_resetpw_on,
      forumOrderby: raw.forum_orderby === 1 ? 1 : 0,
      updateViewsOn: !!raw.update_views_on,
      uploadMaxSize: Number(raw.upload_max_size ?? 20971520),
      lang: String(raw.lang ?? 'en-us'),
      /* 后台界面语言（与前台站点语言相互独立；缺省跟随站点语言） */
      adminLang: String(raw.admin_lang ?? raw.lang ?? 'en-us'),
      creditThread: Number(raw.credit_thread ?? 0),
      creditReply: Number(raw.credit_reply ?? 0),
      creditDailyFirst: Number(raw.credit_daily_first ?? 0),
      /* 审核两开关（tt_check：kv setting 存 1/0 数字，asBool01 口径） */
      userCheck: raw.user_check === 1 || raw.user_check === '1' || raw.user_check === true,
      recycle: raw.recycle === 1 || raw.recycle === '1' || raw.recycle === true,
      /* 设备访问三开关（键缺省 = 开启，兼容存量数据） */
      devicePhoneOn: raw.device_phone_on === undefined ? true : !!raw.device_phone_on,
      deviceTabletOn: raw.device_tablet_on === undefined ? true : !!raw.device_tablet_on,
      deviceTvOn: raw.device_tv_on === undefined ? true : !!raw.device_tv_on,
      /* 顶部导航栏自定义项（后台「导航栏设置」，kv 存 JSON 字符串；解析失败/缺省回落 undefined = 前台默认导航） */
      nav: parseNavItems(raw.nav),
      /* 内容语言分区模式（kv setting.content_lang：0=关闭 1=开启默认全部 2=开启默认跟随界面语言）
       * 必须显式映射：漏掉这一步会让开关恒为 undefined，语言过滤整体静默失效 */
      contentLang: Number(raw.content_lang ?? 0) || 0,
    } as SiteSetting;
  });
}

interface Viewer {
  uid: number;
  gid: number;
  username: string;
  /** 账号审核状态（tt_check user.OK）：1=正常 0=待审核 -1=未通过；游客恒 1（不受审核闸门约束） */
  ok: number;
  /**
   * 小黑屋（0025）：封禁位掩码 / 到期时间戳 / 理由。
   * 必须随 viewer 一起装载 —— banGuard 与读侧拦截都靠它，
   * 少了这三个字段就等于封禁完全不生效（曾因缺列静默失效）。
   */
  banScope: number;
  banUntil: number;
  banReason: string;
}

/** bbs_user 会话装载的原始行（列名即 SQL 列名，与 Viewer 的驼峰字段一一对应） */
interface ViewerRow {
  uid: number;
  gid: number;
  username: string;
  ok: number;
  token_version: number;
  ban_scope: number;
  ban_until: number;
  ban_reason: string;
}

const GUEST: Viewer = { uid: 0, gid: 0, username: '', ok: 1, banScope: 0, banUntil: 0, banReason: '' };

/** 结构最小化：Hono Context 泛型对 Variables 不变，路由侧具体类型直接结构兼容 */
interface ViewerCtx {
  env: Env;
  req: { url: string; header: (name: string) => string | undefined };
  header: (name: string, value: string) => void;
  /** Hono Context 必有；mock 上下文可缺省（缺省时回退 zh-cn 文案） */
  get?: (key: string) => unknown;
}

function cookieOf(c: ViewerCtx, name: string): string | undefined {
  const raw = c.req.header('cookie') ?? '';
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i >= 0 && part.slice(0, i) === name) {
      // 畸形百分号编码（如 `sid=%`）会抛 URIError：Cookie 完全由客户端控制，
      // 不兜底会让「游客」降级为 500，故解析失败按「无此 cookie」处理。
      try {
        return decodeURIComponent(part.slice(i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

const isHttps = (siteUrl: string | undefined): boolean => (siteUrl ?? '').startsWith('https://');
export const reqIp = (c: ViewerCtx): string =>
  c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0';
const reqIpLong = (c: ViewerCtx): number => ipToLong(reqIp(c));

function setSidCookie(c: ViewerCtx, sid: string): void {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${ACCESS_TOKEN_TTL}`];
  if (isHttps(c.env.SITE_URL)) attrs.push('Secure');
  c.header('Set-Cookie', `sid=${sid}; ${attrs.join('; ')}`);
}

/**
 * 读侧封禁判定（禁访 / 禁登）：禁言（MUTE）只拦写，不在此拦。
 * 管理员直通 —— 与服务端「管理员不可封禁」一致，同时防历史脏数据把管理员锁死在外。
 */
function assertNotReadBanned(viewer: Viewer, c: ViewerCtx): void {
  if (viewer.gid === GroupId.ADMIN) return;
  const scope = effectiveBanScope(viewer.banScope, viewer.banUntil, Math.floor(Date.now() / 1000));
  if (!scope || !(scope & (BanScope.READ | BanScope.LOGIN))) return;
  const t = (c.get?.('t') as ApiT | undefined) ?? t0;
  throw new AppError(Code.BANNED, banMessage(scope, viewer.banUntil, viewer.banReason, t), {
    banScope: scope,
    banUntil: viewer.banUntil,
  });
}

/**
 * 双轨会话（§8.1）：
 *  session 命中 → 用 session；否则验 JWT → 重建 session。
 *  JWT 轨每请求复核 token_version（改密吊销）：tv 比对复用下方 user:{uid} 装载查询
 *  （缓存命中零额外 D1；改密入口均同步 tv+1 与 cache.del，吊销即时生效，无复核豁口）。
 *  last_date 刷新节流 60s 走 waitUntil（在线口径 ±60s，D1 写额度护栏）。
 */
export async function loadViewer(cache: Cache, db: D1b, c: ViewerCtx): Promise<Viewer> {
  const sid = cookieOf(c, 'sid');
  let uid = 0;
  /** JWT 轨有效载荷的 tv（session 轨为 null，不参与比对） */
  let jwtTv: number | null = null;
  /** JWT 有效但无 session：需确认用户仍存在后才重建 session（避免为已删 uid 反复建行） */
  let rebuildSession = false;
  if (sid) {
    const sess = await db
      .prepare<{ uid: number; last_date: number }>('SELECT uid,last_date FROM bbs_session WHERE sid = ?')
      .bind(sid)
      .first<{ uid: number; last_date: number }>();
    if (sess && Number(sess.uid) > 0) {
      uid = Number(sess.uid);
      if (Math.floor(Date.now() / 1000) - Number(sess.last_date) > 60) {
        const url = new URL(c.req.url).pathname;
        const ex = (c as unknown as { executionCtx?: { waitUntil?: (pr: Promise<unknown>) => void } }).executionCtx;
        if (ex?.waitUntil) ex.waitUntil(touchSession(db, sid, url));
      }
    }
  }
  if (!uid) {
    const at = cookieOf(c, 'at');
    const secret = c.env.JWT_SECRET;
    if (at && secret) {
      const p = await verifyJwt(at, secret);
      if (p) {
        uid = p.uid;
        jwtTv = p.tv;
        rebuildSession = !sid;
      }
    }
  }
  if (!uid) return GUEST;
  const cacheKey = `user:${uid}`;
  const loadRow = () =>
    remember(cache, cacheKey, async () => {
      const u = await db
        .prepare<ViewerRow>(`SELECT ${USER_SESSION_COLS}, token_version FROM bbs_user WHERE uid = ?`)
        .bind(uid)
        .first<ViewerRow>();
      return u
        ? {
            uid: Number(u.uid),
            gid: Number(u.gid),
            username: String(u.username ?? ''),
            ok: Number(u.ok ?? 1),
            tv: Number(u.token_version ?? 0),
            banScope: Number(u.ban_scope ?? 0),
            banUntil: Number(u.ban_until ?? 0),
            banReason: String(u.ban_reason ?? ''),
          }
        : { ...GUEST, tv: 0 };
    });
  let viewer = await loadRow();
  /**
   * 结构自愈：本修复之前写入的 `user:{uid}` 缓存条目没有 ban 三字段（undefined）。
   * 不重建的话，刚被封禁的用户会在一个缓存周期内继续通过闸门 —— 安全判定不能依赖「缓存迟早过期」，
   * 故把缺字段视为脏条目：删键重载一次（仅对存量条目发生一次，稳态零额外查询）。
   */
  if (!Number.isFinite(Number(viewer.banScope))) {
    await cache.del(cacheKey);
    viewer = await loadRow();
  }
  // 用户已被删除（查无此行）→ 游客：不再下发/写入 session（原实现在此处为空 uid 反复建 bbs_session 行）
  if (viewer.uid <= 0) return GUEST;
  // JWT 轨 tv 复核：与库中 token_version 不符（改密/登出已 bump）→ 游客。
  // session 轨不比对：session 行本身在改密时被 destroyUserSessions 删除，命中即有效。
  if (jwtTv !== null && viewer.tv !== jwtTv) return GUEST;
  /**
   * 禁访 / 禁登的**读侧**拦截。
   * banGuard 刻意不为 GET 装载 viewer（/api/online 等接口有零查库预算承诺，见 middleware/ban.ts），
   * 因此读侧的闸门落在所有读接口本来就要调用的这里：凡是认得出身份的接口都已装载，零额外查询。
   * /api/auth/* 与 banGuard 同口径豁免（否则被封用户无法登出、看不到封禁原因）。
   */
  if (!new URL(c.req.url).pathname.startsWith('/api/auth/')) assertNotReadBanned(viewer, c);
  if (rebuildSession) {
    // session 缺失由 JWT 重建（已确认用户存在）
    const newSid = await createSession(db, uid, {
      ip: reqIpLong(c),
      useragent: c.req.header('user-agent') ?? '',
      url: new URL(c.req.url).pathname,
    });
    setSidCookie(c, newSid);
  }
  return viewer;
}

/** 访问矩阵只需要 uid/gid：写路径的 AuthorRow 等更宽的身份行可直接传入，无需伪装成 Viewer */
export function makeAccessCtx(
  v: { uid: number; gid: number },
  forumlist: Record<number, ForumRow>,
  grouplist: Record<number, GroupForAccess>,
): AccessCtx {
  return { uid: v.uid, gid: v.gid, forumlist, grouplist };
}
