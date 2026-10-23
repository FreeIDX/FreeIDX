/**
 * 数据装载器（T1-4 基础）：forumlist/grouplist/setting 走三层缓存，
 * viewer 走 session 轨（JWT 自动登录在 M2 T2-2 补齐；此处已支持登录用户的权限过滤）。
 */
import {
  FORUM_LANG_UNRESTRICTED,
  RunLevel,
  normalizeForumLang,
  type ContentLang,
  type NavItem,
  type SiteSetting,
} from '@freeidx/shared';
import type { D1b } from './db';
import { FORUM_COLS, USER_SESSION_COLS } from './db/columns';
import type { Cache } from './cache';
import { remember } from './cache';
import type { AccessCtx, AccessRow, ForumForAccess, GroupForAccess } from './access';
import type { Env } from '../types/env';
import { ACCESS_TOKEN_TTL, verifyJwt } from './auth/jwt';
import { createSession, ipToLong, touchSession } from './auth/session';
import { isHttpsRequest } from './site';

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
  /** 绑定内容语言（0024，原始值：'' = 未绑定（子版块继承父版块）；'none' = 显式不限制（仅子版块）；其余 = 强制该语言）
   *  生效值请用 forumLangOf()，不要直接读本字段 */
  lang: string;
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
      /* 绑定语言容错：旧缓存没有该列（undefined）或库里被手工写成 `ja-jp`/`zh-CN` 时，
         统一收敛到 CONTENT_LANGS，避免前台按原生名查表落空、写帖落一个筛选永远匹配不上的值 */
      f.lang = normalizeForumLang(f.lang);
      /* 哨兵只对子版块有意义：顶级版块「空串」与「显式不限制」等价，归一回空串保持单一写法 */
      if (!f.parent_fid && f.lang === FORUM_LANG_UNRESTRICTED) f.lang = '';
      out[f.fid] = { ...f, accesson: Number(f.accesson), accesslist: {} };
    }
    for (const a of access.results) {
      const f = out[a.fid];
      if (f) (f.accesslist ??= {})[a.gid] = a;
    }
    return out;
  });
}

/** forumLangOf 的最小入参形状：ForumRow 与 AccessCtx 的窄化视图（ForumForAccess）都能传入 */
export interface ForumLangNode {
  lang?: unknown;
  parent_fid?: unknown;
}

/**
 * 版块「生效」的内容语言（0024，含继承）：
 * 自身绑定优先；未绑定则沿 parent_fid 逐级继承（结构上只有两级，深度上限兼防脏数据成环）；
 * 绑定值为哨兵 FORUM_LANG_UNRESTRICTED 时立刻中断继承（= 显式不限制）；
 * 一路为空同样是不限制（发帖走自动检测 + 用户自选）。
 * 读写两侧共用本函数，保证「前台锁定的语言」与「服务端强制的语言」永远同一口径。
 */
export function forumLangOf(forumlist: Record<number, unknown>, fid: number): ContentLang | '' {
  const node = (id: number): ForumLangNode | undefined => {
    const v = forumlist[id];
    return v && typeof v === 'object' ? (v as ForumLangNode) : undefined;
  };
  let cur = node(fid);
  for (let depth = 0; cur && depth < 8; depth++) {
    const own = normalizeForumLang(cur.lang);
    /* 显式不限制：中断继承，且不参与自动检测的「强制」语义 */
    if (own === FORUM_LANG_UNRESTRICTED) return '';
    if (own) return own as ContentLang;
    const parent = Number(cur.parent_fid ?? 0);
    cur = parent > 0 ? node(parent) : undefined;
  }
  return '';
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
      /* 内容语言分区模式（0=关闭 1=开启默认全部 2=开启默认跟随界面语言；缺省 0 保持存量行为） */
      contentLang: Math.min(2, Math.max(0, Number(raw.content_lang ?? 0) || 0)),
    } as SiteSetting;
  });
}

interface Viewer {
  uid: number;
  gid: number;
  username: string;
  /** 账号审核状态（tt_check user.OK）：1=正常 0=待审核 -1=未通过；游客恒 1（不受审核闸门约束） */
  ok: number;
}

const GUEST: Viewer = { uid: 0, gid: 0, username: '', ok: 1 };

/** 结构最小化：Hono Context 泛型对 Variables 不变，路由侧具体类型直接结构兼容 */
interface ViewerCtx {
  env: Env;
  req: { url: string; header: (name: string) => string | undefined };
  header: (name: string, value: string) => void;
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

export const reqIp = (c: ViewerCtx): string =>
  c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0';
const reqIpLong = (c: ViewerCtx): number => ipToLong(reqIp(c));

function setSidCookie(c: ViewerCtx, sid: string): void {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${ACCESS_TOKEN_TTL}`];
  // Secure 按当前请求协议判定（多域名/预览域可能未配置 SITE_URL，配置值也可能与请求域不一致）
  if (isHttpsRequest(c)) attrs.push('Secure');
  c.header('Set-Cookie', `sid=${sid}; ${attrs.join('; ')}`);
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
        // 走到 JWT 轨说明 session 行不存在（被 GC/过期清理）或无效，必须重建，
        // 否则 sid Cookie 还在时永远不建行，在线人数/在线列表会漏掉该用户。
        rebuildSession = true;
      }
    }
  }
  if (!uid) return GUEST;
  const viewer = await remember(cache, `user:${uid}`, async () => {
    const u = await db
      .prepare<Viewer & { token_version: number }>(
        `SELECT ${USER_SESSION_COLS}, token_version FROM bbs_user WHERE uid = ?`,
      )
      .bind(uid)
      .first<Viewer & { token_version: number }>();
    return u
      ? { uid: u.uid, gid: u.gid, username: u.username, ok: Number(u.ok ?? 1), tv: Number(u.token_version ?? 0) }
      : { uid: 0, gid: 0, username: '', ok: 1, tv: 0 };
  });
  // 用户已被删除（查无此行）→ 游客：不再下发/写入 session（原实现在此处为空 uid 反复建 bbs_session 行）
  if (viewer.uid <= 0) return GUEST;
  // JWT 轨 tv 复核：与库中 token_version 不符（改密/登出已 bump）→ 游客。
  // session 轨不比对：session 行本身在改密时被 destroyUserSessions 删除，命中即有效。
  if (jwtTv !== null && viewer.tv !== jwtTv) return GUEST;
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

export function makeAccessCtx(v: Viewer, forumlist: Record<number, ForumRow>, grouplist: Record<number, GroupForAccess>): AccessCtx {
  return { uid: v.uid, gid: v.gid, forumlist, grouplist };
}
