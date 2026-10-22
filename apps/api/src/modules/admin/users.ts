/**
 * 用户 / 用户组管理后台接口（T3-6，§14.4）：
 *   GET    /api/admin/users      用户列表（?type=uid|username|email|gid|create_ip &keyword &page，uid 倒序；
 *                                投影额外带 email + create_ip/create_ip_fmt，仅后台可见，公开接口不变）
 *   POST   /api/admin/users      admin 建号：email/username 唯一校验 + PBKDF2 口令（复用 T2-1 hashPassword）
 *   PUT    /api/admin/users/:uid 改资料：仅更新变化字段，可选重置口令
 *   DELETE /api/admin/users/:uid 硬删（gid=1 保护；级联 = thread/post 计数回退）
 *   GET    /api/admin/groups     用户组（12 项权限矩阵）
 *   PUT    /api/admin/groups     批量 upsert（新增/编辑）
 *   DELETE /api/admin/groups/:gid 删组（系统组 {0..7,101} 拒绝 + 清该 gid 的版块访问记录）
 * 铁律（§D.8#5，显式保留 + 标注）：group upsert 仅当 1≤gid≤5 时持久化 7 项版务位
 *   （allowtop/update/delete/move/banuser/deleteuser/viewip）；自定义组（如 101）静默丢弃版务位——
 *   这是本实现的既有行为（修复需走决策，非静默改语义）。
 * 写后失效：group → cache.del('grouplist')（权限立即影响 forumAccessUser 读过滤）；user gid/资料变 → del('user:{uid}')。
 * 全部路由挂在 adminGuard 之后（app.use('/api/admin/*')）。
 */
import { Hono, type Context } from 'hono';
import { Code, GroupId, MOD_PERMS, USER_PERMS } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { D1b, Stmt } from '../../core/db';
import { loadGrouplist, reqIp } from '../../core/loaders';
import { USER_ADMIN_LIST_COLS } from '../../core/db/columns';
import { hashPassword } from '../../core/auth';
import { isEmail, isPassword, isUsername } from '../../core/auth/validate';
import { destroyUserSessions, ipToLong, ipToStr } from '../../core/auth/session';

import { as01, core, getExecCtx, intParam, patchRuntime, randomPresetAvatar, readJson, totalPageOf, type ReadEnv } from '../shared';
import { attachKeysForUserPurge, purgeR2Objects, userPurgeStmts } from '../../core/purge';
import { enqueueSeoRename } from '../seo/generate';
import type { Cache } from '../../core/cache';

type Ctx = Context<ReadEnv>;
const now = () => Math.floor(Date.now() / 1000);

/** 改名反规范化回写（§5.2/§20 设计承诺落地，照 backfillAvatar 模式）：
  *  username 按 uid、lastusername 按 lastuid 各一条全量 UPDATE，`<> 新值` 守卫使
 *  rows_written = 实际需改行（改名极低频，5000 帖作者一次改名 ≈ 5000 行，占免费层
 *  10 万行写/天 5%）。waitUntil 旁路不占请求时长；失败尽力而为——cronDaily 校准批
 *  中的 lastusername 自愈语句每日兜底。
 *  SEO 队列：seo/{tid}.html 烧录旧楼主名，随改名入队（seo:rename-pending），
 *  由 cron 每小时档 seoRebuildRenamed 分批重建（§20.2 C 档）。 */
async function backfillUsername(c: Context<ReadEnv>, uid: number, username: string): Promise<void> {
  const db = c.get('db');
  const q = Promise.all([
    db.prepare('UPDATE bbs_thread SET username = ? WHERE uid = ? AND username <> ?').bind(username, uid, username).run(),
    db.prepare('UPDATE bbs_thread SET lastusername = ? WHERE lastuid = ? AND lastusername <> ?').bind(username, uid, username).run(),
    enqueueSeoRename(db, uid),
  ]);
  const ex = await getExecCtx(c);
  if (ex?.waitUntil) ex.waitUntil(q);
  else await q;
}

export function adminUserRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  // ---------------- 用户列表 ----------------
  app.get('/api/admin/users', async (c) => {
    const { db } = core(c);
    const keyword = String(c.req.query('keyword') ?? '').trim();
    const type = String(c.req.query('type') ?? 'uid');
    const page = Math.max(1, intParam(c.req.query('page'), 1));
    const size = Math.min(100, Math.max(1, intParam(c.req.query('size'), 20)));
    const allowType: Record<string, string> = { uid: 'uid', username: 'username', email: 'email', gid: 'gid', create_ip: 'create_ip' };
    const col = allowType[type] ?? 'uid';

    const where: string[] = [];
    const params: (number | string)[] = [];
    if (keyword) {
      where.push(`${col} = ?`); // 精确等值条件
      params.push(col === 'create_ip' ? ipToLong(keyword) : col === 'uid' || col === 'gid' ? Number(keyword) : keyword);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';

    const cnt = await db.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM bbs_user${whereSql}`).bind(...params).first<{ c: number }>();
    const total = Number(cnt?.c ?? 0);
    // 后台专用投影：USER_PUBLIC_COLS + email/create_ip（前台公开接口不带）
    const rows = await db
      .prepare<Record<string, unknown>>(`SELECT ${USER_ADMIN_LIST_COLS} FROM bbs_user${whereSql} ORDER BY uid DESC LIMIT ? OFFSET ?`)
      .bind(...params, size, (page - 1) * size)
      .all();
    const list = rows.results.map((r) => ({ ...r, create_ip_fmt: ipToStr(Number(r.create_ip ?? 0)) }));
    return ok(c, 'ok', { data: { total, page, size, totalPage: totalPageOf(total, size), list } });
  });

  // ---------------- 建号 ----------------
  app.post('/api/admin/users', async (c) => {
    const { db } = core(c);
    const t = c.get('t');
    const b = await readJson(c);
    const email = String(b.email ?? '').trim().toLowerCase();
    const username = String(b.username ?? '').trim();
    const gidRaw = Number(b.gid);
    const gid = Number.isInteger(gidRaw) && gidRaw >= 0 ? gidRaw : GroupId.LEVEL1;
    const password = String(b.password ?? '');
    if (!email) throw new AppError(Code.FORM_INVALID_EMAIL, t('auth.emailRequired'));
    const eerr = isEmail(email, t);
    if (eerr) throw new AppError(Code.FORM_INVALID_EMAIL, eerr);
    const uerr = isUsername(username, t);
    if (uerr) throw new AppError(Code.FORM_INVALID_USERNAME, uerr);
    // gid 必须指向已存在的用户组（原实现仅校验整数，可落出负数/不存在组的孤儿用户）
    const grp = await db.prepare<{ gid: number }>('SELECT gid FROM bbs_group WHERE gid = ?').bind(gid).first<{ gid: number }>();
    if (!grp) throw new AppError(Code.NOT_FOUND, t('common.groupNotFound'));
    const derr = await db.prepare<{ uid: number }>('SELECT uid FROM bbs_user WHERE email = ?').bind(email).first<{ uid: number }>();
    if (derr) throw new AppError(Code.FORM_EMAIL_EXISTS, t('auth.emailExists'));
    const dname = await db.prepare<{ uid: number }>('SELECT uid FROM bbs_user WHERE username = ?').bind(username).first<{ uid: number }>();
    if (dname) throw new AppError(Code.FORM_USERNAME_EXISTS, t('auth.usernameExists'));
    const prer = isPassword(password, t);
    if (prer) throw new AppError(Code.FORM_PASSWORD_MISMATCH, prer);

    const ts = now();
    const stored = await hashPassword(password);
    const r = await db
      .prepare<{ uid: number }>(
        'INSERT INTO bbs_user (gid,email,username,password,salt,create_ip,create_date,logins,login_date,login_ip,avatar,avatar_auto) VALUES (?,?,?,?,?,?,?,0,?,?,0,?) RETURNING uid',
      )
      .bind(gid, email, username, stored, '', ipToLong(reqIp(c)), ts, ts, 0, randomPresetAvatar())
      .first<{ uid: number }>();
    const uid = Number(r?.uid ?? 0);
    if (!uid) throw new AppError(Code.SYSTEM_ERROR, t('admin.createFailed'));
    return ok(c, t('common.created'), { data: { uid, gid } });
  });

  // ---------------- 改资料（仅更新变化字段） ----------------
  app.put('/api/admin/users/:uid', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const uid = intParam(c.req.param('uid'));
    if (!uid) throw new AppError(Code.VALIDATION_ERROR, t('common.uidInvalid'));
    const old = await db
      .prepare<{ uid: number; gid: number; email: string; username: string; ok: number }>('SELECT uid,gid,email,username,ok FROM bbs_user WHERE uid = ?')
      .bind(uid)
      .first<{ uid: number; gid: number; email: string; username: string; ok: number }>();
    if (!old) throw new AppError(Code.NOT_FOUND, t('common.userNotFound'));

    const b = await readJson(c);
    const set: string[] = [];
    const vals: (number | string)[] = [];
    let renamedTo = '';

    if ('email' in b) {
      const email = String(b.email ?? '').trim().toLowerCase();
      const eerr = isEmail(email, t);
      if (eerr) throw new AppError(Code.FORM_INVALID_EMAIL, eerr);
      if (email !== old.email) {
        const dup = await db.prepare<{ uid: number }>('SELECT uid FROM bbs_user WHERE email = ? AND uid <> ?').bind(email, uid).first<{ uid: number }>();
        if (dup) throw new AppError(Code.FORM_EMAIL_EXISTS, t('auth.emailExists'));
        set.push('email = ?');
        vals.push(email);
      }
    }
    if ('username' in b) {
      const username = String(b.username ?? '').trim();
      const uerr = isUsername(username, t);
      if (uerr) throw new AppError(Code.FORM_INVALID_USERNAME, uerr);
      if (username !== old.username) {
        const dup = await db.prepare<{ uid: number }>('SELECT uid FROM bbs_user WHERE username = ? AND uid <> ?').bind(username, uid).first<{ uid: number }>();
        if (dup) throw new AppError(Code.FORM_USERNAME_EXISTS, t('auth.usernameExists'));
        set.push('username = ?');
        vals.push(username);
        renamedTo = username;
      }
    }
    if ('gid' in b) {
      const gid = Number(b.gid);
      if (!Number.isInteger(gid)) throw new AppError(Code.VALIDATION_ERROR, t('admin.groupInvalid'));
      if (gid !== Number(old.gid)) {
        set.push('gid = ?');
        vals.push(gid);
      }
    }
    if ('ok' in b) {
      // 审核状态（收敛为三态，-2/删除走审核队列按钮）
      const okv = Number(b.ok);
      if (okv !== 0 && okv !== 1 && okv !== -1) {
        throw new AppError(Code.VALIDATION_ERROR, t('admin.okStatusInvalid'));
      }
      if (okv !== Number(old.ok)) {
        set.push('ok = ?');
        vals.push(okv);
      }
    }
    let resetSessions = false;
    if ('password' in b) {
      const password = String(b.password ?? '');
      const prer = isPassword(password, t);
      if (prer) throw new AppError(Code.FORM_PASSWORD_MISMATCH, prer);
      set.push('password = ?', 'salt = ?', 'token_version = token_version + 1');
      vals.push(await hashPassword(password), '');
      resetSessions = true;
    }
    if (!set.length) throw new AppError(Code.VALIDATION_ERROR, t('common.noFieldsToUpdate'));

    vals.push(uid);
    await db.prepare(`UPDATE bbs_user SET ${set.join(', ')} WHERE uid = ?`).bind(...vals).run();
    if (resetSessions) await destroyUserSessions(db, uid);
    await cache.del(`user:${uid}`);
    if (renamedTo) await backfillUsername(c, uid, renamedTo);
    return ok(c, t('common.updated'), { data: { uid } });
  });

  // ---------------- 硬删（gid=1 保护 + 级联计数回退） ----------------
  app.delete('/api/admin/users/:uid', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const uid = intParam(c.req.param('uid'));
    if (!uid) throw new AppError(Code.VALIDATION_ERROR, t('common.uidInvalid'));
    const target = await db
      .prepare<{ uid: number; gid: number }>('SELECT uid,gid FROM bbs_user WHERE uid = ?')
      .bind(uid)
      .first<{ uid: number; gid: number }>();
    if (!target) throw new AppError(Code.NOT_FOUND, t('common.userNotFound'));
    if (Number(target.gid) === GroupId.ADMIN) throw new AppError(Code.NO_PERMISSION, t('admin.adminUndeletable'));

    await deleteUserCascade(db, cache, uid, c);
    return ok(c, t('common.deleted'), { data: { uid } });
  });

  // ---------------- 用户组列表 ----------------
  app.get('/api/admin/groups', async (c) => {
    const { db, cache } = core(c);
    const grouplist = await loadGrouplist(cache, db);
    return ok(c, 'ok', { data: { groups: Object.values(grouplist) } });
  });

  // ---------------- 用户组批量 upsert（§D.8#5） ----------------
  app.put('/api/admin/groups', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const b = await readJson(c);
    const items = Array.isArray(b.groups) ? (b.groups as Record<string, unknown>[]) : [];
    if (!items.length) throw new AppError(Code.VALIDATION_ERROR, t('admin.groupItemsRequired'));
    const grouplist = await loadGrouplist(cache, db);
    const stmts: Stmt[] = [];

    for (const it of items) {
      const gid = Number(it.gid);
      if (!Number.isInteger(gid) || gid < 0) continue;
      const name = String(it.name ?? '').trim();
      if (!name) continue;
      const creditsfrom = Number(it.creditsfrom ?? 0) || 0;
      const creditsto = Number(it.creditsto ?? 0) || 0;
      const row: Record<string, number> = { creditsfrom, creditsto };
      for (const p of USER_PERMS) row[p] = as01(it[p]);
      // §D.8#5：仅 gid 1-5 保存版务位，自定义组静默丢弃
      if (gid >= 1 && gid <= 5) for (const p of MOD_PERMS) row[p] = as01(it[p]);

      if (grouplist[gid]) {
        const cols = Object.keys(row);
        stmts.push(
          db.prepare(`UPDATE bbs_group SET name = ?, ${cols.map((k) => `${k} = ?`).join(', ')} WHERE gid = ?`).bind(name, ...cols.map((k) => row[k]!), gid) as unknown as Stmt,
        );
      } else {
        const cols = ['gid', 'name', ...Object.keys(row)];
        const values = [gid, name, ...Object.values(row)];
        stmts.push(
          db.prepare(`INSERT INTO bbs_group (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...values) as unknown as Stmt,
        );
      }
    }
    if (!stmts.length) throw new AppError(Code.VALIDATION_ERROR, t('admin.groupDataInvalid'));
    await db.batch(stmts);
    await cache.del('grouplist');
    return ok(c, t('common.saved'), { data: { count: stmts.length } });
  });

  // ---------------- 删除用户组 ----------------
  /**
   * 删组语义：删除 bbs_group 行 + 清该 gid 的版块访问记录 + 失效 grouplist/forumlist 缓存。
   * PUT /api/admin/groups 是显式 upsert（用户组编辑页只提交单组），删除拆为这个显式接口。
   * 与既有口径相同、且**刻意不修**的一点：组删掉后原成员的 gid 不回退（用户仍挂着已失效的 gid），
   * 这是用户组编辑页警告提示的场景。
   */
  app.delete('/api/admin/groups/:gid', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const raw = c.req.param('gid') ?? '';
    // intParam 会把非数字静默归 0，而 gid=0（游客组）合法存在 → 必须严格校验入参，否则 'abc' 会被当成删 0 组
    if (!/^\d+$/.test(raw)) throw new AppError(Code.VALIDATION_ERROR, t('admin.gidInvalid'));
    const gid = Number.parseInt(raw, 10);
    if (SYSTEM_GROUP_IDS.includes(gid)) throw new AppError(Code.NO_PERMISSION, t('admin.systemGroupProtected'));
    const found = await db.prepare<{ gid: number }>('SELECT gid FROM bbs_group WHERE gid = ?').bind(gid).first<{ gid: number }>();
    if (!found) throw new AppError(Code.NOT_FOUND, t('common.groupNotFound'));

    await db.batch([
      db.prepare('DELETE FROM bbs_group WHERE gid = ?').bind(gid) as unknown as Stmt,
      db.prepare('DELETE FROM bbs_forum_access WHERE gid = ?').bind(gid) as unknown as Stmt,
    ]);
    await cache.del('grouplist');
    await cache.del('forumlist');
    return ok(c, t('common.deleted'), { data: { gid } });
  });

  return app;
}

/** 系统保护组集合（删组保护同集合） */
const SYSTEM_GROUP_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 101];

/** 用户硬删级联（复用 core/purge.ts userPurgeStmts：主题级联删 + 计数回退 + 孤儿清理 + session/notice；附件/头像 R2 尽力清理） */
async function deleteUserCascade(db: D1b, cache: Cache, uid: number, c: Ctx): Promise<void> {
  const { stmts, tids } = await userPurgeStmts(db, uid);
  // 附件 R2 对象 key 须在删除语句执行前读取（本人上传 + 本人主题内他人上传）
  const attachKeys = await attachKeysForUserPurge(db, uid, tids);
  // 自定义头像对象一并清理（avatar>0；与 mod/check 删用户路径口径一致，否则 R2 孤儿头像永久残留）
  const avatarRow = await db.prepare<{ avatar: number }>('SELECT avatar FROM bbs_user WHERE uid = ?').bind(uid).first<{ avatar: number }>();
  if (avatarRow && Number(avatarRow.avatar) > 0) {
    attachKeys.push(`avatar/${String(uid).padStart(9, '0').slice(0, 3)}/${uid}.png`);
  }
  await db.batch(stmts);
  purgeR2Objects(c.env, await getExecCtx(c), attachKeys);
  // runtime.users 无校准兜底（calibrate 不改 users）→ 删用户即时回退，避免永久虚高
  await patchRuntime(cache, { users: -1, threads: -tids.length });
  await cache.del(`user:${uid}`);
  await cache.del('forumlist');
}
