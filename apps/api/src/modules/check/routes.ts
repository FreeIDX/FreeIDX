/**
 * 前台审核接口（tt_check）：
 *  POST /api/check    { act: 0=主题 1=回帖 2=用户, id, opt: 1=通过 -1=拒绝 -2=删除 }
 *  POST /api/recycle  { tid, opt: -1=恢复 1=彻底删除 }
 *  权限：登录 + 组 see_check——后台审核列表按钮复用本路由；
 *        act=2 用户真删（opt=-2）另需组 allowdeleteuser + 目标 gid>=6（与 mod 删用户同口径）；
 *        recycle 另需 kv setting.recycle=1（'未开启回收站功能！'）。
 *  opt=-2 为真删：thread_delete / post_delete / user_delete 真删（core/purge.ts 级联）。
 *  校准：recycle 分支同样要求登录（游客组误配 see_check 不再可操作）。
 */
import { Hono, type Context } from 'hono';
import { Code } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { D1b, Stmt } from '../../core/db';
import type { Cache } from '../../core/cache';
import { CheckStatus, hasSeeCheck } from '../../core/check';
import { forumAccessMod, type AccessCtx, type GroupForAccess } from '../../core/access';
import { loadForumlist, loadGrouplist, makeAccessCtx, loadSetting, loadViewer } from '../../core/loaders';
import {
  attachKeysByPid,
  attachKeysByTid,
  attachKeysForUserPurge,
  postPurgeStmts,
  purgeR2Objects,
  threadPurgeStmts,
  userPurgeStmts,
} from '../../core/purge';
import { revokeAffectedUids, revokeForPostDelete, threadRevokeEntries, upgradeGroupByCredits, upgradeGroupsByCredits } from '../../core/points';
import { getExtensions } from '../../core/extensions';
import { scheduleSeo } from '../seo/generate';
import { core, getExecCtx, patchRuntime, readJson, type ReadEnv } from '../shared';

type Ctx = Context<ReadEnv>;

/**
 * 主题真删（审核 opt=-2 / 回收站彻底删除/清空共用）：
 * 级联 stmts + 积分回扣/等级组重算（与 write/mod 真删同口径）+ 计数 + 缓存/SEO + R2 对象 + 事件。
 */
export async function purgeThread(
  db: D1b,
  cache: Cache,
  c: Ctx,
  tid: number,
  grouplist: Record<number, GroupForAccess>,
  /** 前台审核/回收站调用时必传：真删按主题所在版块校验版务删除权（后台 adminGuard 不传） */
  guard?: { ctx: AccessCtx },
): Promise<boolean> {
  const t = await db
    .prepare<{ tid: number; fid: number; uid: number }>('SELECT tid,fid,uid FROM bbs_thread WHERE tid = ?')
    .bind(tid)
    .first<{ tid: number; fid: number; uid: number }>();
  if (!t) return false; // 对不存在 tid 静默（幂等）
  // 跨版块真删防护：see_check 只授予「审核」资格，不可据此删除无版务权的板块内容
  if (guard && !forumAccessMod(guard.ctx, Number(t.fid), 'allowdelete')) {
    throw new AppError(Code.NO_PERMISSION, c.get('t')('common.permDenied'));
  }
  const stmts: Stmt[] = [];
  await threadPurgeStmts(db, t, stmts);
  // 积分回扣条目与附件 key 须在删除语句执行前读取
  const revokeEntries = await threadRevokeEntries(db, tid, Number(t.uid));
  const attachKeys = await attachKeysByTid(db, tid);
  await db.batch(stmts);
  // 与 write/mod 真删一致：真删要回扣已发放积分并重算等级组，否则作者/回帖者经验虚高
  if (revokeEntries.length) {
    await revokeForPostDelete({ db, cache }, revokeEntries);
    const ups = await upgradeGroupsByCredits({ db, cache }, revokeAffectedUids(revokeEntries), grouplist);
    if (ups.length) {
      const rt = await getExtensions(cache, db, undefined, { preloadConfigs: false });
      for (const gc of ups) await rt.bus.emit('user:group-changed', gc);
    }
  }
  await patchRuntime(cache, { threads: -1 });
  await cache.del('forumlist');
  await scheduleSeo({ db, cache }, c, tid, 'del');
  purgeR2Objects(c.env, await getExecCtx(c), attachKeys);
  const rt = await getExtensions(cache, db, undefined, { preloadConfigs: false });
  await rt.bus.emit('thread:deleted', { tid, fid: Number(t.fid) });
  return true;
}

export function checkRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  app.post('/api/check', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const v = await loadViewer(cache, db, c);
    if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('check.fetchFailed'));
    const grouplist = await loadGrouplist(cache, db);
    if (!hasSeeCheck(grouplist[v.gid])) throw new AppError(Code.NO_PERMISSION, t('check.noPerm'));

    const b = await readJson<{ act: number; id: number; opt: number }>(c);
    const act = Number(b.act);
    const id = Number(b.id);
    const opt = Number(b.opt);
    if (![0, 1, 2].includes(act) || !Number.isInteger(id) || id <= 0 || ![1, -1, -2].includes(opt)) {
      throw new AppError(Code.VALIDATION_ERROR, t('common.paramError'));
    }

    if (act === 0) {
      // 主题：check_set_thread_check（topic 与首帖同步置位；opt=-2 → 真删）
      if (opt === -2) {
        const forumlist = await loadForumlist(cache, db);
        await purgeThread(db, cache, c, id, grouplist, { ctx: makeAccessCtx(v, forumlist, grouplist) });
      } else {
        await db.batch([
          db.prepare('UPDATE bbs_thread SET ok = ? WHERE tid = ?').bind(opt, id) as unknown as Stmt,
          db.prepare('UPDATE bbs_post SET ok = ? WHERE tid = ? AND isfirst = 1').bind(opt, id) as unknown as Stmt,
        ]);
      }
    } else if (act === 1) {
      // 回帖：check_set_post_check（仅 isfirst=0；opt=-2 → 真删）
      if (opt === -2) {
        const purge = await postPurgeStmts(db, id);
        if (purge) {
          // 积分回扣条目与附件 key 须在删除语句执行前读取
          const attachKeys = await attachKeysByPid(db, id);
          await db.batch(purge.stmts);
          await patchRuntime(cache, { posts: -1 });
          await cache.del(`user:${purge.uid}`);
          // 与 write 真删同口径：回帖真删要回扣作者已发放的 post_* 积分并按新经验重算等级组
          await revokeForPostDelete({ db, cache }, [{ uid: purge.uid, isfirst: 0, pid: id }]);
          const up = await upgradeGroupByCredits({ db, cache }, purge.uid, grouplist);
          if (up) {
            const rt = await getExtensions(cache, db, undefined, { preloadConfigs: false });
            await rt.bus.emit('user:group-changed', { uid: purge.uid, oldGid: up.oldGid, newGid: up.newGid });
          }
          await scheduleSeo({ db, cache }, c, purge.tid, 'gen');
          purgeR2Objects(c.env, await getExecCtx(c), attachKeys);
          const rt = await getExtensions(cache, db, undefined, { preloadConfigs: false });
          await rt.bus.emit('post:deleted', { pid: id, tid: purge.tid, uid: purge.uid });
        }
      } else {
        const p = await db
          .prepare<{ tid: number; uid: number; ok: number; create_date: number }>(
            'SELECT tid,uid,ok,create_date FROM bbs_post WHERE pid = ? AND isfirst = 0',
          )
          .bind(id)
          .first<{ tid: number; uid: number; ok: number; create_date: number }>();
        if (!p) throw new AppError(Code.NOT_FOUND, t('common.postNotFound'));
        const stmts: Stmt[] = [
          db.prepare('UPDATE bbs_post SET ok = ? WHERE pid = ? AND isfirst = 0').bind(opt, id) as unknown as Stmt,
        ];
        // 待审/被拒回帖过审 → 补主题反规范化列（发帖待审时未计入 posts/尾列；ok≠1 守卫幂等，重复通过不重复计数）。
        // 尾列用 lastpid < pid 条件：仅当该回帖比当前尾部新才覆盖（乱序过审不回退尾部）。
        // lastusername 用标量子查询取回帖者当前用户名（SQLite 无 UPDATE JOIN；D1 支持，cronDaily 校准同款）。
        if (opt === 1 && Number(p.ok) !== 1) {
          stmts.push(
            db.prepare('UPDATE bbs_thread SET posts = posts + 1 WHERE tid = ?').bind(p.tid) as unknown as Stmt,
            db.prepare('UPDATE bbs_thread SET lastpid = ?, lastuid = ?, last_date = ?, lastusername = (SELECT username FROM bbs_user WHERE uid = ?) WHERE tid = ? AND lastpid < ?')
              .bind(id, p.uid, p.create_date, p.uid, p.tid, id) as unknown as Stmt,
          );
        } else if (opt !== 1 && Number(p.ok) === 1) {
          // 已过审回帖被拒绝/打回：同步回退主题回帖数，避免再次过审时二次 +1（拒绝→通过 = 虚增一条）
          stmts.push(db.prepare('UPDATE bbs_thread SET posts = MAX(0, posts - 1) WHERE tid = ?').bind(p.tid) as unknown as Stmt);
        }
        await db.batch(stmts);
      }
    } else {
      // 用户：check_set_user_check（opt=-2 → user_delete 级联）
      if (opt === -2) {
        // 用户真删与 mod 删用户同口径：allowdeleteuser 权限 + 禁止删除管理组（gid<6）。
        // 仅要求 see_check 会让任何获授审核位的组级联真删管理员（userPurgeStmts 含 DELETE bbs_user）。
        if (!grouplist[v.gid]?.allowdeleteuser) throw new AppError(Code.NO_PERMISSION, t('mod.deleteUserDenied'));
        const target = await db
          .prepare<{ uid: number; gid: number; avatar: number }>('SELECT uid,gid,avatar FROM bbs_user WHERE uid = ?')
          .bind(id)
          .first<{ uid: number; gid: number; avatar: number }>();
        if (target) {
          if (Number(target.gid) < 6) throw new AppError(Code.NO_PERMISSION, t('mod.cannotDeleteAdmin'));
          const { stmts, tids } = await userPurgeStmts(db, id);
          // 附件 R2 对象 key 须在删除语句执行前读取（含本人主题内他人上传的附件）
          const attachKeys = await attachKeysForUserPurge(db, id, tids);
          await db.batch(stmts);
          await cache.del(`user:${id}`);
          await cache.del('forumlist');
          if (tids.length) await patchRuntime(cache, { threads: -tids.length });
          await patchRuntime(cache, { users: -1 });
          for (const tid of tids) await scheduleSeo({ db, cache }, c, tid, 'del');
          const ex = await getExecCtx(c);
          purgeR2Objects(c.env, ex, attachKeys);
          // 头像 R2 对象尽力删除（与 mod 删用户一致；失败不影响一致性）
          const files = c.env.FILES as unknown as { delete?: (k: string) => unknown } | undefined;
          if (files && typeof files.delete === 'function' && Number(target.avatar) > 0) {
            const key = `avatar/${String(id).padStart(9, '0').slice(0, 3)}/${id}.png`;
            purgeR2Objects(c.env, ex, [key]);
          }
        }
      } else {
        await db.prepare('UPDATE bbs_user SET ok = ? WHERE uid = ?').bind(opt, id).run();
        await cache.del(`user:${id}`);
      }
    }

    return ok(c, t('check.done'));
  });

  app.post('/api/recycle', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const v = await loadViewer(cache, db, c);
    if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
    const setting = await loadSetting(cache, db);
    if (!setting.recycle) throw new AppError(Code.NO_PERMISSION, t('check.recycleDisabled'));
    const grouplist = await loadGrouplist(cache, db);
    if (!hasSeeCheck(grouplist[v.gid])) throw new AppError(Code.NO_PERMISSION, t('check.recycleNoPerm'));

    const b = await readJson<{ tid: number; opt: number }>(c);
    const tid = Number(b.tid);
    const opt = Number(b.opt);
    if (!Number.isInteger(tid) || tid <= 0 || ![1, -1].includes(opt)) {
      throw new AppError(Code.VALIDATION_ERROR, t('common.paramError'));
    }

    if (opt === 1) {
      // recycle_thread_delete_true：彻底删除（thread_delete 级联 + 积分回扣 + R2 对象清理）
      // 与审核 opt=-2 同口径：需目标版块 allowdelete，see_check 本身不等于版务删除权
      const forumlist = await loadForumlist(cache, db);
      await purgeThread(db, cache, c, tid, grouplist, { ctx: makeAccessCtx(v, forumlist, grouplist) });
    } else {
      // recycle_thread_recovery：恢复（主题与首帖 ok=1）
      await db.batch([
        db.prepare('UPDATE bbs_thread SET ok = ? WHERE tid = ?').bind(CheckStatus.NORMAL, tid) as unknown as Stmt,
        db.prepare('UPDATE bbs_post SET ok = ? WHERE tid = ? AND isfirst = 1').bind(CheckStatus.NORMAL, tid) as unknown as Stmt,
      ]);
      await scheduleSeo({ db, cache }, c, tid, 'gen');
    }

    return ok(c, t('check.recycleDone'));
  });

  return app;
}