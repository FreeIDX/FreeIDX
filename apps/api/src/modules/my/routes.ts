/**
 * 会员自助接口（T2-9）：头像上传。
 *  POST /api/me/avatar：base64 `data`（≤40000）→ R2 `avatar/{uid补9位前3段}/{uid}.png` + `user.avatar=时间戳`（缓存串接）。
 *  头像即时生效：thread 反规范化 avatar 列经 waitUntil 批量回写（低频，读多写少取舍，§5.2 改头像 ≈ 改名同款代价）。
 *  POST /api/my/avatar/preset：预设头像，与自定义头像互斥。
 * A 组新增：POST /api/user/password 改密；POST /api/favorites/:tid 收藏 toggle；GET /api/my/favorites 收藏列表。
 * 新增：GET /api/my/likes 我赞过的主题；
 *   GET /api/my/following|followers 关注/粉丝用户列表、GET /api/my/following-threads 关注动态流。
 */
import { Hono, type Context } from 'hono';
import { Code, PageSize, type ThreadListItem } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { loadViewer, loadGrouplist, loadForumlist, makeAccessCtx } from '../../core/loaders';
import { threadListAccessFilter } from '../../core/access';
import { remember } from '../../core/cache';
import { USER_PUBLIC_COLS, THREAD_LIST_COLS_T } from '../../core/db/columns';
import { cursorCond } from '../../core/db/paginate';
import { hashPassword, verifyClientPassword } from '../../core/auth';
import { destroyUserSessions } from '../../core/auth/session';
import { isPassword } from '../../core/auth/validate';
import { loadExtConfig } from '../../core/ext-store';
import { LIGHT_EXT_ID, parseLightConfig } from '../../extensions/light';
import type { Stmt } from '../../core/db';
import type { Env } from '../../types/env';
import type { ReadEnv } from '../shared';
import { decodeBase64, intParam, avatarAutoOf } from '../shared';

type Ctx = Context<ReadEnv>;
const AVATAR_MAX_BYTES = 40_000; // 头像字节上限
const now = () => Math.floor(Date.now() / 1000);

/** 头像 R2 key：avatar/{%09d uid 前 3 位}/{uid}.png（/files 直链已放行 avatar/ 前缀） */
export function avatarKey(uid: number): string {
  const dir = String(uid).padStart(9, '0').slice(0, 3);
  return `avatar/${dir}/${uid}.png`;
}

async function updateAvatar(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const cache = c.get('cache');
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));

  let data = '';
  const ct = c.req.header('content-type') ?? '';
  if (ct.includes('multipart/form-data')) {
    const fd = await c.req.formData();
    const file = fd.get('file') as (Blob & { name?: string }) | null;
    if (file && typeof file.arrayBuffer === 'function') {
      const buf = new Uint8Array(await file.arrayBuffer());
      return persist(c, v.uid, buf);
    }
    data = String(fd.get('data') ?? '');
  } else {
    let b: Record<string, unknown>;
    try {
      b = await c.req.json<Record<string, unknown>>();
    } catch {
      throw new AppError(Code.VALIDATION_ERROR, t('common.bodyJsonOrMultipart'));
    }
    data = String(b.data ?? '');
  }
  if (!data) throw new AppError(Code.VALIDATION_ERROR, t('common.fileContentEmpty'));
  const bytes = decodeBase64(data, t);

  return persist(c, v.uid, bytes);
}

/** 反规范化头像时间戳回写（作者名旁路，低频；无 ExecutionContext 时内联等待） */
async function backfillAvatar(c: Ctx, uid: number, avatar: number): Promise<void> {
  const db = c.get('db');
  const q = db.prepare('UPDATE bbs_thread SET avatar = ? WHERE uid = ?').bind(avatar, uid).run();
  let ex: { waitUntil?: (pr: Promise<unknown>) => void } | undefined;
  try {
    ex = (c as unknown as { executionCtx?: { waitUntil?: (pr: Promise<unknown>) => void } }).executionCtx;
  } catch {
    ex = undefined;
  }
  if (ex?.waitUntil) ex.waitUntil(q);
  else await q;
}

async function persist(c: Ctx, uid: number, bytes: Uint8Array): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const cache = c.get('cache');
  if (bytes.length > AVATAR_MAX_BYTES) {
    throw new AppError(Code.FORM_FILE_TOO_LARGE, t('my.avatarTooLarge'), { size: bytes.length });
  }
  const key = avatarKey(uid);
  const ts = now();
  await (c.env as Env).FILES.put(key, bytes as unknown as ArrayBufferView, {
    httpMetadata: { contentType: 'image/png' },
  });
  // avatar_auto 置 '0'：自定义头像与预设头像互斥
  await db.prepare("UPDATE bbs_user SET avatar = ?, avatar_auto = '0' WHERE uid = ?").bind(ts, uid).run();
  await cache.del(`user:${uid}`);
  await backfillAvatar(c, uid, ts);
  return ok(c, t('my.avatarUpdated'), { data: { url: `/files/${key}?v=${ts}`, avatar: ts } });
}

/** 预设头像白名单上限：站内预设图共 57 张（apps/web/public/avatars/0.png … 56.png） */
const AVATAR_PRESET_MAX = 56;

/**
 * POST /api/my/avatar/preset：预设头像。
 *  imgsrc 非空 → 白名单校验（仅 /avatars/0..56.png 形态）→ avatar_auto=imgsrc + avatar=0（互斥：同步删除旧自定义头像文件）；
 *  imgsrc 为空/未传 → 仅清 avatar_auto（置 '0'），不动 avatar。
 */
async function presetAvatar(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const cache = c.get('cache');
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  let b: { imgsrc?: string };
  try {
    b = await c.req.json<{ imgsrc?: string }>();
  } catch {
    throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
  }
  const imgsrc = String(b.imgsrc ?? '').trim();
  if (imgsrc) {
    const m = /^\/avatars\/(\d+)\.png$/.exec(imgsrc);
    if (!m || Number(m[1]) > AVATAR_PRESET_MAX) throw new AppError(Code.VALIDATION_ERROR, t('my.presetInvalid'));
    await db.prepare('UPDATE bbs_user SET avatar_auto = ?, avatar = 0 WHERE uid = ?').bind(imgsrc, v.uid).run();
    await cache.del(`user:${v.uid}`);
    // 互斥：预设生效即删旧自定义头像文件（R2 对象尽力删除，失败不影响一致性）+ 反规范化回写 0
    const files = (c.env as Env).FILES as unknown as { delete?: (k: string) => unknown } | undefined;
    if (files && typeof files.delete === 'function') {
      await Promise.resolve(files.delete(avatarKey(v.uid))).catch(() => undefined);
    }
    await backfillAvatar(c, v.uid, 0);
    return ok(c, t('my.presetSaved'), { data: { avatar_auto: imgsrc } });
  }
  await db.prepare("UPDATE bbs_user SET avatar_auto = '0' WHERE uid = ?").bind(v.uid).run();
  await cache.del(`user:${v.uid}`);
  return ok(c, t('my.presetCleared'), { data: { avatar_auto: '0' } });
}

/**
 * POST /api/my/background（my_background）：主页背景预设。
 *  imgsrc = 预设编号（'0'=默认 bg-0.webp；'1'..light.userBgNum 对应 /theme-light/bgimg/bg-N.png）；
 *  非法/超范围 → 400（白名单口径与 user_bg_num 配置一致）。
 */
async function saveBackground(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const cache = c.get('cache');
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  let b: { imgsrc?: unknown };
  try {
    b = await c.req.json<{ imgsrc?: unknown }>();
  } catch {
    throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
  }
  const cfg = parseLightConfig(await loadExtConfig(cache, db, LIGHT_EXT_ID));
  const n = Math.trunc(Number(b.imgsrc));
  if (!Number.isFinite(n) || n < 0 || n > cfg.userBgNum) {
    throw new AppError(Code.VALIDATION_ERROR, t('my.backgroundInvalid'));
  }
  const bgimg = String(n);
  await db.prepare('UPDATE bbs_user SET bgimg = ? WHERE uid = ?').bind(bgimg, v.uid).run();
  await cache.del(`user:${v.uid}`);
  return ok(c, t('my.backgroundSaved'), { data: { bgimg } });
}

/** long2ip 逆运算（仅版务/管理可见） */
function longToIp(n: number): string {
  const x = n >>> 0;
  return `${(x >>> 24) & 255}.${(x >>> 16) & 255}.${(x >>> 8) & 255}.${x & 255}`;
}
/** 本地时刻格式 Y-n-j H:i */
function lastDateFmt(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

interface OnlineRow {
  uid: number;
  fid: number;
  url: string;
  ip: number;
  last_date: number;
  username: string;
  gid: number;
  avatar: number;
}

/**
 * GET /api/online（T4-2）
 *  - 默认：uid>0 会话按 last_date 倒序 ≤500（list + total），保持既有 API 形状不变；
 *  - `?summary=1`：只回 total —— 首页/发现页只用到在线人数，此前为拿一个数字要下载并解析
 *    约 60KB 的 JSON（500 行）。列表与人数各自读穿自己的缓存，两条路径互不影响。
 * total 为 COUNT(*) session（含游客，GC 后即为在线口径）。ip 仅 gid 1/2 可见。
 */
async function onlineList(c: Ctx): Promise<Response> {
  const db = c.get('db');
  const cache = c.get('cache');
  const totalP = db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_session').first<{ c: number }>();
  // 只要人数：不查 500 行会话，也不必解析访问者（连 gid 都不需要）
  if (c.req.query('summary') === '1') {
    const totalRow = await totalP;
    return ok(c, 'ok', { data: { total: Number(totalRow?.c ?? 0) } });
  }
  // 列表路径：viewer 与两条查询并行（原先 viewer 是串行前置）
  const [rows, totalRow, v] = await Promise.all([
    remember(cache, 'online_list', async () => {
      const r = await db
        .prepare<OnlineRow>(
          `SELECT s.uid, s.fid, s.url, s.ip, s.last_date, u.username, u.gid, u.avatar
           FROM bbs_session s INNER JOIN bbs_user u ON u.uid = s.uid
           WHERE s.uid > 0 ORDER BY s.last_date DESC LIMIT 500`,
        )
        .all();
      return r.results;
    }),
    totalP,
    loadViewer(cache, db, c),
  ]);
  const showIp = v.gid === 1 || v.gid === 2;
  const list = rows.map((o) => ({
    uid: Number(o.uid),
    gid: Number(o.gid),
    username: String(o.username),
    avatar: Number(o.avatar),
    fid: Number(o.fid),
    url: String(o.url),
    last_date: Number(o.last_date),
    last_date_fmt: lastDateFmt(Number(o.last_date)),
    ...(showIp ? { ip_fmt: longToIp(Number(o.ip)) } : {}),
  }));
  return ok(c, 'ok', { data: { total: Number(totalRow?.c ?? 0), list } });
}

/**
 * GET /api/me（T4-2）：本人统计（含 email/golds/rmbs 私域字段）+ 用户组名 + 未读提示。
 * 冻结 schema 无 PM/通知表，未读提示按"我发起主题自上次登录后的新回帖数"由现有 bbs_post/thread 推导。
 */
async function meStats(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const cache = c.get('cache');
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const u = await db
    .prepare<Record<string, number | string>>(
      `SELECT ${USER_PUBLIC_COLS}, email, golds, rmbs, login_ip, logins, vip_expire_at FROM bbs_user WHERE uid = ?`,
    )
    .bind(v.uid)
    .first<Record<string, number | string>>();
  if (!u) throw new AppError(Code.NOT_LOGIN, t('common.accountNotFound'));
  const grouplist = await loadGrouplist(cache, db);
  const gid = Number(u.gid);
  const avatarAuto = avatarAutoOf(Number(u.avatar), u.avatar_auto);
  const newReplies = await db
    .prepare<{ c: number }>(
      `SELECT COUNT(*) AS c FROM bbs_post p INNER JOIN bbs_thread t ON t.tid = p.tid
       WHERE t.uid = ? AND p.isfirst = 0 AND p.create_date > ?`,
    )
    .bind(v.uid, Number(u.login_date ?? 0))
    .first<{ c: number }>();
  return ok(c, 'ok', {
    data: {
      uid: v.uid,
      gid,
      group_name: grouplist[gid]?.name ?? '',
      username: String(u.username),
      email: String(u.email),
      avatar: Number(u.avatar),
      ...(avatarAuto ? { avatar_auto: avatarAuto } : {}),
      /** 认证头衔（'0'=未认证） */
      v: String(u.v ?? '0'),
      /** 主页背景预设编号（'0'=默认 bg-0.webp） */
      bgimg: String(u.bgimg ?? '0'),
      threads: Number(u.threads),
      posts: Number(u.posts),
      credits: Number(u.credits),
      golds: Number(u.golds),
      rmbs: Number(u.rmbs),
      create_date: Number(u.create_date),
      login_date: Number(u.login_date),
      logins: Number(u.logins),
      vip_expire_at: Number(u.vip_expire_at ?? 0),
      new_replies: Number(newReplies?.c ?? 0),
    },
  });
}

/** POST /api/user/password：改密（A 组 A2）。入参均为前端预哈希 32hex（§8.4，与 login/register 口径一致）；旧口令走 verifyClientPassword 兼容存量 md5。 */
async function changePassword(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const cache = c.get('cache');
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  let b: { oldPassword?: string; newPassword?: string };
  try {
    b = await c.req.json<{ oldPassword?: string; newPassword?: string }>();
  } catch {
    throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
  }
  const u = await db
    .prepare<{ password: string; salt: string }>('SELECT password, salt FROM bbs_user WHERE uid = ?')
    .bind(v.uid)
    .first<{ password: string; salt: string }>();
  if (!u) throw new AppError(Code.NOT_LOGIN, t('common.accountNotFound'));
  const chk = await verifyClientPassword(String(b.oldPassword ?? ''), u.password, u.salt);
  if (!chk.ok) throw new AppError(Code.FORM_PASSWORD_MISMATCH, t('auth.oldPasswordWrong'));
  const np = String(b.newPassword ?? '');
  const perr = isPassword(np, t);
  if (perr) throw new AppError(Code.FORM_PASSWORD_MISMATCH, perr);
  const stored = await hashPassword(np);
  await db
    .prepare('UPDATE bbs_user SET password = ?, salt = ?, token_version = token_version + 1 WHERE uid = ?')
    .bind(stored, '', v.uid)
    .run();
  // 改密 = 全端登出（对齐 auth 密码重置三件套）：token_version++ 使 JWT 轨（at/admin_at）失效；
  // 会话轨 sid 读取不校验 tv，须显式删除该用户所有 bbs_session 行；user:{uid} 缓存立即失效。
  await destroyUserSessions(db, v.uid);
  await cache.del(`user:${v.uid}`);
  return ok(c, t('my.passwordChanged'), { data: { uid: v.uid } });
}

/** POST /api/favorites/:tid：收藏/取消收藏 toggle（A 组 A5，bbs_favorite 唯一键防重） */
async function toggleFavorite(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const cache = c.get('cache');
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const tid = intParam(c.req.param('tid'));
  // 可见性口径与其它读路径一致：未过审/回收站主题（ok≠1）不得被收藏，
  // 否则可借收藏成功与否 + /api/my/favorites 反查探测不可见主题是否存在。
  const th = await db.prepare<{ tid: number }>('SELECT tid FROM bbs_thread WHERE tid = ? AND ok = 1').bind(tid).first<{ tid: number }>();
  if (!th) throw new AppError(Code.NOT_FOUND, t('common.threadNotFoundOrDeleted'));
  let existing = await db
    .prepare<{ uid: number }>('SELECT uid FROM bbs_favorite WHERE uid = ? AND tid = ?')
    .bind(v.uid, tid)
    .first<{ uid: number }>();
  if (existing) {
    await db.batch([db.prepare('DELETE FROM bbs_favorite WHERE uid = ? AND tid = ?').bind(v.uid, tid) as unknown as Stmt]);
  } else {
    try {
      await db.prepare('INSERT INTO bbs_favorite (uid, tid, create_date) VALUES (?, ?, ?)').bind(v.uid, tid, now()).run();
    } catch (e) {
      // 并发双击：两请求都查到「未收藏」，第二个撞唯一约束 → 按已收藏幂等成功（不 500、不误取消）
      const msg = e instanceof Error ? e.message : String(e);
      if (!/UNIQUE constraint failed/i.test(msg)) throw e;
      existing = { uid: v.uid };
    }
  }
  const cnt = await db
    .prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_favorite WHERE tid = ?')
    .bind(tid)
    .first<{ c: number }>();
  return ok(c, existing ? t('my.favoriteCancelled') : t('my.favorited'), { data: { favorited: !existing, favorites: Number(cnt?.c ?? 0) } });
}

/** 主题行投影 → 列表 DTO（与首页列表同构：ok/付费/标签/图片组一并对齐，前端 ThreadList 直接复用） */
function toListItem(x: Record<string, unknown>): ThreadListItem & { create_date: number; last_date: number } {
  const s = (k: string) => String(x[k] ?? '');
  const n = (k: string) => Number(x[k] ?? 0);
  return {
    tid: n('tid'),
    fid: n('fid'),
    top: n('top') as ThreadListItem['top'],
    digest: n('digest') as ThreadListItem['digest'],
    closed: n('closed') as ThreadListItem['closed'],
    uid: n('uid'),
    username: s('username'),
    avatar: n('avatar'),
    subject: s('subject'),
    posts: n('posts'),
    views: n('views'),
    images: n('images'),
    files: n('files'),
    lastpid: n('lastpid'),
    lastuid: n('lastuid'),
    lastusername: s('lastusername'),
    createDate: n('create_date'),
    lastDate: n('last_date'),
    create_date: n('create_date'),
    last_date: n('last_date'),
    ok: n('ok'),
    contentBuy: n('content_buy'),
    contentBuyType: n('content_buy_type'),
    ...(s('tags') ? { tags: s('tags') } : {}),
    ...(s('image_urls') ? { imageUrls: s('image_urls') } : {}),
  };
}

/** 「我收藏/我赞过的主题」通用查询：j 表 ∈ {bbs_favorite, bbs_like}，按联结表 rowid 倒序游标（版块权限过滤复用统一口径） */
async function myJoinedThreadList(c: Ctx, table: 'bbs_favorite' | 'bbs_like', ridKey: string) {
  const t = c.get('t');
  const db = c.get('db');
  const cache = c.get('cache');
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const [forumlist, grouplist] = await Promise.all([loadForumlist(cache, db), loadGrouplist(cache, db)]);
  const ctx = makeAccessCtx(v, forumlist, grouplist);
  const size = PageSize.USER_THREAD_LIST;
  const before = intParam(c.req.query('before_rowid')) || undefined;
  const cur = cursorCond({ column: 'j.rowid', size, before, desc: true });
  const r = await db
    .prepare<Record<string, unknown>>(
      `SELECT j.rowid AS ${ridKey}, ${THREAD_LIST_COLS_T} FROM ${table} j INNER JOIN bbs_thread t ON t.tid = j.tid
       WHERE j.uid = ? ${cur.where} ${cur.order} LIMIT ?`,
    )
    .bind(v.uid, ...cur.params, size)
    .all();
  const raw = r.results;
  const list = threadListAccessFilter(ctx, raw.map(toListItem));
  const nextCursor = Number(raw.at(-1)?.[ridKey] ?? 0) || undefined;
  return ok(c, 'ok', { data: { list, size, nextCursor } });
}

/** GET /api/my/favorites：我的收藏主题（游标按 bbs_favorite.rowid 倒序） */
function myFavorites(c: Ctx): Promise<Response> {
  return myJoinedThreadList(c, 'bbs_favorite', 'fav_rid');
}

/** GET /api/my/likes：我赞过的主题（游标按 bbs_like.rowid 倒序） */
function myLikes(c: Ctx): Promise<Response> {
  return myJoinedThreadList(c, 'bbs_like', 'like_rid');
}

/** 关注用户行 → DTO（followed：当前访问者已关注 Ta（按钮态）；mutual：双向关注） */
interface FollowUserItem {
  uid: number;
  username: string;
  avatar: number;
  /** 粉丝数（bbs_follow 实时 COUNT） */
  fans: number;
  followed: boolean;
  mutual: boolean;
  /** 关注备注（仅「我关注的」行下发） */
  remark?: string;
  /** 接收该用户动态（0 时不进关注动态流） */
  dynamic: boolean;
}

/**
 * 关注用户列表（通用）：dir=following 我/Ta 关注的 / dir=followers 关注我/Ta 的。
 * targetUid=0 → 当前登录用户（需登录）；>0 → 公开主页列表（游客可读，followed 按当前访问者计算）。
 * 游标 bbs_follow.rowid 倒序。
 */
async function followUsersOf(c: Ctx, dir: 'following' | 'followers', targetUid: number) {
  const t = c.get('t');
  const db = c.get('db');
  const cache = c.get('cache');
  const viewer = await loadViewer(cache, db, c);
  const uid = targetUid > 0 ? targetUid : viewer.uid;
  if (uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  if (targetUid > 0) {
    const u = await db.prepare<{ uid: number }>('SELECT uid FROM bbs_user WHERE uid = ?').bind(uid).first<{ uid: number }>();
    if (!u) throw new AppError(Code.NOT_FOUND, t('common.userNotFound'));
  }
  const size = 20;
  const selfCol = dir === 'following' ? 'follower_uid' : 'followee_uid';
  const otherCol = dir === 'following' ? 'followee_uid' : 'follower_uid';
  /* 备注/动态开关只属「我关注的」行（f 行是我的关注关系）；粉丝行不下发他人对我的备注 */
  const extraCols = dir === 'following' ? 'f.comment AS remark, f.show_dynamic AS dynamic' : "'' AS remark, 1 AS dynamic";
  const before = intParam(c.req.query('before_rowid')) || undefined;
  const cur = cursorCond({ column: 'f.rowid', size, before, desc: true });
  const r = await db
    .prepare<{
      rid: number;
      uid: number;
      username: string;
      avatar: number;
      fans: number;
      followed: number;
      mutual: number;
      remark: string;
      dynamic: number;
    }>(
      `SELECT f.rowid AS rid, u.uid, u.username, u.avatar, ${extraCols},
              (SELECT COUNT(*) FROM bbs_follow b3 WHERE b3.followee_uid = u.uid) AS fans,
              EXISTS(SELECT 1 FROM bbs_follow b4 WHERE b4.follower_uid = ? AND b4.followee_uid = u.uid) AS followed,
              EXISTS(SELECT 1 FROM bbs_follow b5 WHERE b5.follower_uid = u.uid AND b5.followee_uid = ?) AS mutual
       FROM bbs_follow f INNER JOIN bbs_user u ON u.uid = f.${otherCol}
       WHERE f.${selfCol} = ? ${cur.where} ${cur.order} LIMIT ?`,
    )
    .bind(viewer.uid, viewer.uid, uid, ...cur.params, size)
    .all();
  const list: FollowUserItem[] = r.results.map((x) => ({
    uid: Number(x.uid),
    username: String(x.username),
    avatar: Number(x.avatar),
    fans: Number(x.fans ?? 0),
    followed: Number(x.followed) === 1,
    mutual: Number(x.mutual) === 1,
    /** 关注备注（优先显示） */
    ...(x.remark ? { remark: String(x.remark) } : {}),
    /** 是否接收该用户动态（show_dynamic 开关） */
    dynamic: Number(x.dynamic) === 1,
  }));
  const nextCursor = Number(r.results.at(-1)?.rid ?? 0) || undefined;
  return ok(c, 'ok', { data: { list, size, nextCursor } });
}

/**
 * POST /api/my/follow-remarks：设置关注备注（≤50 字，空串=清除）
 */
async function saveFollowRemark(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const cache = c.get('cache');
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  let b: { uid?: number; remarks?: string };
  try {
    b = await c.req.json<{ uid?: number; remarks?: string }>();
  } catch {
    throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
  }
  const uid = Math.max(0, Math.trunc(Number(b.uid ?? 0)));
  const remarks = String(b.remarks ?? '').trim().slice(0, 50);
  const row = await db
    .prepare<{ follower_uid: number }>('SELECT follower_uid FROM bbs_follow WHERE follower_uid = ? AND followee_uid = ?')
    .bind(v.uid, uid)
    .first<{ follower_uid: number }>();
  if (!row) throw new AppError(Code.NOT_FOUND, t('common.userNotFound'));
  await db.prepare('UPDATE bbs_follow SET comment = ? WHERE follower_uid = ? AND followee_uid = ?').bind(remarks, v.uid, uid).run();
  return ok(c, t('my.followRemarksSaved'), { data: { uid, remarks } });
}

/**
 * POST /api/my/follow-dynamic：是否接收该用户动态（0 → 该用户的帖子不再进入关注动态流）
 */
async function saveFollowDynamic(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const cache = c.get('cache');
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  let b: { uid?: number; dynamic?: number };
  try {
    b = await c.req.json<{ uid?: number; dynamic?: number }>();
  } catch {
    throw new AppError(Code.VALIDATION_ERROR, t('common.invalidJson'));
  }
  const uid = Math.max(0, Math.trunc(Number(b.uid ?? 0)));
  const dynamic = Number(b.dynamic) === 1 ? 1 : 0;
  const row = await db
    .prepare<{ follower_uid: number }>('SELECT follower_uid FROM bbs_follow WHERE follower_uid = ? AND followee_uid = ?')
    .bind(v.uid, uid)
    .first<{ follower_uid: number }>();
  if (!row) throw new AppError(Code.NOT_FOUND, t('common.userNotFound'));
  await db.prepare('UPDATE bbs_follow SET show_dynamic = ? WHERE follower_uid = ? AND followee_uid = ?').bind(dynamic, v.uid, uid).run();
  return ok(c, t('my.followDynamicSaved'), { data: { uid, dynamic } });
}

/** 动态流 HTML 预览截断：按最后一个完整标签边界裁到 max 字符内（原样渲染已净化 message_fmt） */
function sliceHtml(html: string, max = 1500): string {
  if (html.length <= max) return html;
  const cut = html.lastIndexOf('>', max);
  return `${html.slice(0, cut > 0 ? cut + 1 : max)}…`;
}

/**
 * GET /api/my/following-threads：关注动态（被关注用户的新主题/回复流）
 * 仅取已过审的主题与回帖；版块可读性按统一口径过滤；pid 游标倒序。
 */
async function myFollowingStream(c: Ctx) {
  const t = c.get('t');
  const db = c.get('db');
  const cache = c.get('cache');
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const [forumlist, grouplist] = await Promise.all([loadForumlist(cache, db), loadGrouplist(cache, db)]);
  const ctx = makeAccessCtx(v, forumlist, grouplist);
  const size = 20;
  const before = intParam(c.req.query('before_pid')) || undefined;
  const cur = cursorCond({ column: 'p.pid', size, before, desc: true });
  const r = await db
    .prepare<{
      pid: number;
      tid: number;
      uid: number;
      isfirst: number;
      create_date: number;
      message_fmt: string;
      fid: number;
      top: number;
      subject: string;
      thread_username: string;
      thread_avatar: number;
    }>(
      `SELECT p.pid,p.tid,p.uid,p.isfirst,p.create_date,p.message_fmt,t.fid,t.top,t.subject,
              t.username AS thread_username, t.avatar AS thread_avatar
       FROM bbs_post p INNER JOIN bbs_thread t ON t.tid = p.tid
       WHERE p.uid IN (SELECT f.followee_uid FROM bbs_follow f WHERE f.follower_uid = ? AND f.show_dynamic = 1)
         AND p.ok = 1 AND t.ok = 1 ${cur.where} ${cur.order} LIMIT ?`,
    )
    .bind(v.uid, ...cur.params, size)
    .all();
  /* 关注备注映射（作者名优先显示备注，无备注回落用户名） */
  const remarkR = await db
    .prepare<{ followee_uid: number; comment: string }>('SELECT followee_uid, comment FROM bbs_follow WHERE follower_uid = ? AND comment != \'\'')
    .bind(v.uid)
    .all();
  const remarks = new Map(remarkR.results.map((x) => [Number(x.followee_uid), String(x.comment)]));
  const rows = threadListAccessFilter(ctx, r.results);
  // 回帖作者一次性 IN 补查（首帖作者用 thread 反规范化列）
  const uids = [...new Set(rows.filter((x) => x.isfirst !== 1).map((x) => Number(x.uid)))];
  const authors = new Map<number, { username: string; avatar: number }>();
  if (uids.length) {
    const us = await db
      .prepare<{ uid: number; username: string; avatar: number }>(
        `SELECT uid,username,avatar FROM bbs_user WHERE uid IN (${uids.map(() => '?').join(',')})`,
      )
      .bind(...uids)
      .all();
    for (const u of us.results) authors.set(Number(u.uid), { username: u.username, avatar: Number(u.avatar) });
  }
  const list = rows.map((x) => {
    const isFirst = Number(x.isfirst) === 1;
    const author = isFirst ? { username: x.thread_username, avatar: Number(x.thread_avatar) } : authors.get(Number(x.uid));
    return {
      pid: Number(x.pid),
      tid: Number(x.tid),
      uid: Number(x.uid),
      username: String(author?.username ?? ''),
      avatar: Number(author?.avatar ?? 0),
      isfirst: Number(x.isfirst),
      createDate: Number(x.create_date),
      subject: String(x.subject ?? ''),
      /** 我对该作者的关注备注（有则前端优先显示） */
      ...(remarks.get(Number(x.uid)) ? { remark: remarks.get(Number(x.uid))! } : {}),
      /** 回复内容预览（已净化 message_fmt 截断；首帖不下发正文，前端只显示主题标题） */
      ...(isFirst ? {} : { messageFmt: sliceHtml(String(x.message_fmt ?? '')) }),
    };
  });
  const nextCursor = Number(r.results.at(-1)?.pid ?? 0) || undefined;
  return ok(c, 'ok', { data: { list, size, nextCursor } });
}

export function myRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();
  app.post('/api/me/avatar', updateAvatar);
  app.post('/api/my/avatar/preset', presetAvatar);
  app.post('/api/my/background', saveBackground);
  app.post('/api/user/password', changePassword);
  app.post('/api/favorites/:tid', toggleFavorite);
  app.get('/api/my/favorites', myFavorites);
  app.get('/api/my/likes', myLikes);
  app.get('/api/my/following', (c) => followUsersOf(c, 'following', 0));
  app.get('/api/my/followers', (c) => followUsersOf(c, 'followers', 0));
  app.get('/api/users/:uid/following', (c) => followUsersOf(c, 'following', Math.max(1, intParam(c.req.param('uid')))));
  app.get('/api/users/:uid/followers', (c) => followUsersOf(c, 'followers', Math.max(1, intParam(c.req.param('uid')))));
  app.get('/api/my/following-threads', myFollowingStream);
  app.post('/api/my/follow-remarks', saveFollowRemark);
  app.post('/api/my/follow-dynamic', saveFollowDynamic);
  app.get('/api/online', onlineList);
  app.get('/api/me', meStats);
  return app;
}
