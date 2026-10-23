/**
 * 版务批量接口（T3-1，§14.4）：
 *  action = top/untop（thread_top_change）· close（thread_update closed，复用 allowtop，§D.8#1）
 *           · delete（thread_delete 级联）· move（thread_update fid + 版块计数互换 + thread_top 迁移）
 *           · digest（精华，0-3 级，复用 allowtop）
 *  每条成功动作写 bbs_modlog（uid,tid,pid=firstpid,subject,comment,create_date,action，§D.5）。
 *  权限：forumAccessMod(fid, perm)——top/close/digest→allowtop，delete→allowdelete，move→allowmove+版块存在；
 *        全站置顶 top=3 额外要求 gid∈{1,2}。

 *  deleteuser 归 T3-2（不走 forumAccessMod）；mod:executed 事件（契约②）逐条发射。
 */
import { Hono } from 'hono';
import { Code, GroupId, type ModThreadsReq } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { Stmt } from '../../core/db';
import { forumAccessMod } from '../../core/access';
import { forumLangOf, loadForumlist, loadGrouplist, loadSetting, loadViewer, makeAccessCtx, type ForumRow } from '../../core/loaders';
import { CheckStatus, hasSeeCheck } from '../../core/check';
import { attachKeysByTid, attachKeysForUserPurge, purgeR2Objects, threadPurgeStmts, userPurgeStmts } from '../../core/purge';
import { getExtensions } from '../../core/extensions';
import { revokeAffectedUids, revokeForPostDelete, settleDigestChanges, threadRevokeEntries, upgradeGroupsByCredits, type RevokeEntry } from '../../core/points';
import { NoticeType, noticeModHtml, noticeSendMany } from '../../core/notice';
import { invalidateThreadSeo } from '../seo/generate';
import { core, getExecCtx, intParam, patchRuntime, readJson, type ReadEnv } from '../shared';

const now = () => Math.floor(Date.now() / 1000);

interface ModThread {
  tid: number;
  fid: number;
  uid: number;
  subject: string;
  firstpid: number;
  top: number;
  closed: number;
  digest: number;
  /** 审核位（tt_check）：回收站软删除判定（ok=-2 且 see_check → 真删） */
  ok: number;
}

interface ModlogRow {
  uid: number;
  tid: number;
  pid: number;
  subject: string;
  comment: string;
  create_date: number;
  action: string;
}

export function modRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  /**
   * GET /api/mod/forums/:fid（mod-{fid} 版务页）：服务端计算当前访问者对该版块的版务权限，
   *  前端据此决定是否渲染版务操作台（不做权限推断）。perms.allowmod=置顶/关闭/精华，allowdelete=删除，allowmove=移动。
   */
  app.get('/api/mod/forums/:fid', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const v = await loadViewer(cache, db, c);
    if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
    const fid = intParam(c.req.param('fid'));
    const [forumlist, grouplist] = await Promise.all([loadForumlist(cache, db), loadGrouplist(cache, db)]);
    const forum = (forumlist as Record<number, ForumRow>)[fid];
    if (!forum) throw new AppError(Code.NOT_FOUND, t('common.forumNotFound'));
    const ctx = makeAccessCtx(v, forumlist, grouplist);
    return ok(c, 'ok', {
      data: {
        fid,
        name: forum.name,
        perms: {
          allowmod: forumAccessMod(ctx, fid, 'allowtop'),
          allowdelete: forumAccessMod(ctx, fid, 'allowdelete'),
          allowmove: forumAccessMod(ctx, fid, 'allowmove'),
        },
      },
    });
  });

  app.post('/api/mod/threads', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const v = await loadViewer(cache, db, c);
    if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
    const [forumlist, grouplist, setting] = await Promise.all([
      loadForumlist(cache, db),
      loadGrouplist(cache, db),
      loadSetting(cache, db),
    ]);
    const ctx = makeAccessCtx(v, forumlist, grouplist);
    const group = grouplist[v.gid];
    const seeCheck = hasSeeCheck(group);

    const b = await readJson<ModThreadsReq>(c);
    const tids = (Array.isArray(b.tids) ? b.tids : []).map(Number).filter((x) => Number.isFinite(x) && x > 0);
    if (!tids.length) throw new AppError(Code.VALIDATION_ERROR, t('mod.selectThreads'));
    const action = b.action;

    const placeholders = tids.map(() => '?').join(',');
    const threads = await db
      .prepare<ModThread>(
        `SELECT tid,fid,uid,subject,firstpid,top,closed,digest,ok FROM bbs_thread WHERE tid IN (${placeholders})`,
      )
      .bind(...tids)
      .all();

    const value = Number(b.value ?? 0);
    // 置顶值域校验（top ∈ {0,1,2,3}）：任意值落库会破坏 top 语义，
    // 且列表快照查询按 `top BETWEEN 1 AND 2` / `= 3` 取数，非法值会让主题从所有列表消失。
    if (action === 'top' && ![0, 1, 2, 3].includes(value)) {
      throw new AppError(Code.VALIDATION_ERROR, t('common.paramError'));
    }
    const perm: 'allowtop' | 'allowdelete' | 'allowmove' =
      action === 'delete' ? 'allowdelete' : action === 'move' ? 'allowmove' : 'allowtop';

    const stmts: Stmt[] = [];
    const modlogs: ModlogRow[] = [];
    const executed: { tid: number; action: string }[] = [];
    /* 版务消息：type=3 系统，操作者→主题作者（自操作不发） */
    const notices: { recvuid: number; message: string }[] = [];
    /** 真删的 tid（runtime threads 回退 + SEO 失效）；软删除只进 seoTids（主题对公众不可见） */
    const purgedTids: number[] = [];
    /** 真删主题内附件的 R2 key（batch 后尽力而为清理） */
    const purgeAttachKeys: string[] = [];
    const seoTids: number[] = [];
    /** 精华差额结算与真删积分回扣 */
    const digestSettlements: { uid: number; tid: number; before: number; after: number }[] = [];
    const revokeEntries: RevokeEntry[] = [];
    const groupChanges: { uid: number; oldGid: number; newGid: number }[] = [];

    let touchedForumlist = false;
    const ts = now();

    // move 目标版块存在性校验
    const newFid = value;
    if (action === 'move' && !(forumlist as Record<number, ForumRow>)[newFid]) {
      throw new AppError(Code.NOT_FOUND, t('common.forumNotFound'));
    }

    /* 移动目标版块的生效语言（含父版块继承）：与发帖强制 / 前台编辑首帖 / 后台编辑主题同一口径；
       整批同目标，循环外算一次 */
    const moveLang = action === 'move' ? forumLangOf(forumlist, newFid) : '';

    for (const thread of threads.results) {
      const tid = Number(thread.tid);
      const fid = Number(thread.fid);
      if (!forumAccessMod(ctx, fid, perm)) continue;
      // 跨版移动还需具备【目标版块】版务权限，防止把主题移入无权管理的版块（含私密版块）
      if (action === 'move' && !forumAccessMod(ctx, newFid, perm)) continue;

      if (action === 'top') {
        const top = value;
        if (top === 3 && ctx.gid !== GroupId.ADMIN && ctx.gid !== GroupId.SUPER_MOD) continue;
        if (top === Number(thread.top)) continue; // thread_top_change：值未变不动
        stmts.push(
          db.prepare('UPDATE bbs_thread SET top = ? WHERE tid = ?').bind(top, tid) as unknown as Stmt,
          db.prepare('INSERT OR REPLACE INTO bbs_thread_top (tid,fid,top) VALUES (?,?,?)').bind(tid, fid, top) as unknown as Stmt,
        );

        modlogs.push(logRow(v.uid, thread, 'top', ts));
        executed.push({ tid, action: 'top' });
        notices.push({
          recvuid: Number(thread.uid),
          message: noticeModHtml({ action: value === 3 ? 'top3' : value === 1 ? 'top1' : 'top0', tid, subject: String(thread.subject) }, t),
        });
      } else if (action === 'untop') {
        if (Number(thread.top) === 0) continue;
        stmts.push(
          db.prepare('UPDATE bbs_thread SET top = 0 WHERE tid = ?').bind(tid) as unknown as Stmt,
          db.prepare('INSERT OR REPLACE INTO bbs_thread_top (tid,fid,top) VALUES (?,?,?)').bind(tid, fid, 0) as unknown as Stmt,
        );

        modlogs.push(logRow(v.uid, thread, 'top', ts));
        executed.push({ tid, action: 'untop' });
        notices.push({ recvuid: Number(thread.uid), message: noticeModHtml({ action: 'top0', tid, subject: String(thread.subject) }, t) });
      } else if (action === 'close') {
        const closed = value ? 1 : 0;
        stmts.push(db.prepare('UPDATE bbs_thread SET closed = ? WHERE tid = ?').bind(closed, tid) as unknown as Stmt);

        modlogs.push(logRow(v.uid, thread, 'close', ts));
        executed.push({ tid, action: 'close' });
        /* 值与现值不同才发通知 */
        if (closed !== Number(thread.closed)) {
          notices.push({ recvuid: Number(thread.uid), message: noticeModHtml({ action: closed ? 'close1' : 'close0', tid, subject: String(thread.subject) }, t) });
        }
      } else if (action === 'digest') {
        const digest = Math.max(0, Math.min(3, value));
        stmts.push(db.prepare('UPDATE bbs_thread SET digest = ? WHERE tid = ?').bind(digest, tid) as unknown as Stmt);
        // 精华差额结算登记（新级别奖励 − 旧级别奖励，三币种各补差额），待主批次落库后统一结算
        digestSettlements.push({ uid: Number(thread.uid), tid, before: Number(thread.digest), after: digest });

        modlogs.push(logRow(v.uid, thread, 'digest', ts));
        executed.push({ tid, action: 'digest' });
      } else if (action === 'delete') {
        modlogs.push(logRow(v.uid, thread, 'delete', ts));
        executed.push({ tid, action: 'delete' });
        seoTids.push(tid);
        // 回收站：recycle=1 时软删除（ok=-2，不改计数）；
        // 已是回收站状态且操作者含 see_check → 真删
        if (setting.recycle && !(Number(thread.ok) === CheckStatus.RECYCLE && seeCheck)) {
          stmts.push(
            db.prepare('UPDATE bbs_thread SET ok = ? WHERE tid = ?').bind(CheckStatus.RECYCLE, tid) as unknown as Stmt,
            db.prepare('UPDATE bbs_post SET ok = ? WHERE tid = ? AND isfirst = 1').bind(CheckStatus.RECYCLE, tid) as unknown as Stmt,
          );

          // 软删除不发版务通知（通知挂在真删路径）
        } else {
          await threadPurgeStmts(db, thread, stmts);
          // 积分回扣条目与附件 R2 key 须在删除语句执行前读取
          revokeEntries.push(...(await threadRevokeEntries(db, tid, Number(thread.uid))));
          purgeAttachKeys.push(...(await attachKeysByTid(db, tid)));
          purgedTids.push(tid);

          touchedForumlist = true;
          notices.push({ recvuid: Number(thread.uid), message: noticeModHtml({ action: 'delete', tid, subject: String(thread.subject) }, t) });
        }
      } else if (action === 'move') {
        if (fid === newFid) continue;
        stmts.push(
          db.prepare('UPDATE bbs_thread SET fid = ? WHERE tid = ?').bind(newFid, tid) as unknown as Stmt,
          db.prepare('UPDATE bbs_forum SET threads = threads + 1 WHERE fid = ?').bind(newFid) as unknown as Stmt,
          db.prepare('UPDATE bbs_forum SET threads = threads - 1 WHERE fid = ?').bind(fid) as unknown as Stmt,
          db.prepare('UPDATE bbs_thread_top SET fid = ? WHERE tid = ?').bind(newFid, tid) as unknown as Stmt,
        );
        /* 移入绑定版块：主题语言对齐到绑定值（移出保持原值，不反向猜测） */
        if (moveLang) {
          stmts.push(db.prepare('UPDATE bbs_thread SET lang = ? WHERE tid = ?').bind(moveLang, tid) as unknown as Stmt);
        }
        touchedForumlist = true;

        modlogs.push(logRow(v.uid, thread, 'move', ts));
        executed.push({ tid, action: 'move' });
        notices.push({
          recvuid: Number(thread.uid),
          message: noticeModHtml(
            {
              action: 'move',
              tid,
              subject: String(thread.subject),
              newFid,
              newForumName: (forumlist as Record<number, ForumRow>)[newFid]?.name ?? '',
            },
            t,
          ),
        });
      }
    }

    if (!executed.length) throw new AppError(Code.NO_PERMISSION, t('mod.noPermOrNothing'));

    // modlog 批量写
    for (const m of modlogs) {
      stmts.push(
        db
          .prepare('INSERT INTO bbs_modlog (uid,tid,pid,subject,comment,create_date,action) VALUES (?,?,?,?,?,?,?)')
          .bind(m.uid, m.tid, m.pid, m.subject, m.comment, m.create_date, m.action) as unknown as Stmt,
      );
    }
    await db.batch(stmts);

    // 真删主题内附件的 R2 对象尽力清理（waitUntil 旁路；失败不影响 D1 一致性）
    purgeR2Objects(c.env, await getExecCtx(c), purgeAttachKeys);

    // 精华差额结算（不触发组重算）：一次 DB.batch 结清全部精华变动
    await settleDigestChanges({ db, cache }, digestSettlements);
    // 真删积分回扣 + 批量按新经验重算等级组（1 次 SELECT + 1 次 batch，取代逐 uid 往返）
    if (revokeEntries.length) {
      await revokeForPostDelete({ db, cache }, revokeEntries);
      groupChanges.push(...(await upgradeGroupsByCredits({ db, cache }, revokeAffectedUids(revokeEntries), grouplist)));
    }

    /* 版务消息同步发送（noticeSendMany 内部兜底：操作者即作者时不发），合并为单次 DB.batch */
    await noticeSendMany(
      db,
      notices.map((n) => ({ fromuid: v.uid, recvuid: n.recvuid, type: NoticeType.SYSTEM, message: n.message, ts })),
    );

    if (touchedForumlist) await cache.del('forumlist');


    if (purgedTids.length) await patchRuntime(cache, { threads: -purgedTids.length });
    if (seoTids.length) await invalidateThreadSeo({ db, cache }, c, seoTids);

    const rt = await getExtensions(cache, db, undefined, { preloadConfigs: false });
    for (const e of executed) await rt.bus.emit('mod:executed', { uid: v.uid, tid: e.tid, action: e.action });
    for (const gc of groupChanges) await rt.bus.emit('user:group-changed', gc);

    return ok(c, t('mod.done'), { data: { count: executed.length, results: executed } });
  });

  // 删用户（T3-2）：不走 forumAccessMod，读 group.allowdeleteuser + 硬 gid<6 保护
  app.delete('/api/mod/users/:uid', async (c) => {
    const t = c.get('t');
    const { db, cache } = core(c);
    const v = await loadViewer(cache, db, c);
    if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
    const grouplist = await loadGrouplist(cache, db);
    const group = grouplist[v.gid];
    if (!group?.allowdeleteuser) throw new AppError(Code.NO_PERMISSION, t('mod.deleteUserDenied'));

    const uid = intParam(c.req.param('uid'));
    if (!uid) throw new AppError(Code.VALIDATION_ERROR, t('common.uidInvalid'));
    const target = await db
      .prepare<{ uid: number; gid: number; avatar: number }>('SELECT uid,gid,avatar FROM bbs_user WHERE uid = ?')
      .bind(uid)
      .first<{ uid: number; gid: number; avatar: number }>();
    if (!target) throw new AppError(Code.NOT_FOUND, t('common.userNotFoundOrDeleted'));
    if (Number(target.gid) < 6) throw new AppError(Code.NO_PERMISSION, t('mod.cannotDeleteAdmin'));

    // 级联构建（core/purge.ts：user_delete stmts，与审核队列的 opt=-2 删除共用）
    const { stmts, tids } = await userPurgeStmts(db, uid);
    // 附件 R2 对象 key（本人上传 + 本人主题内他人上传）须在删除语句执行前读取
    const attachKeys = await attachKeysForUserPurge(db, uid, tids);
    // 积分回扣（user_delete 逐主题走 thread_delete → post_delete_by_tid → 主题内他人楼层各扣一次 post_*；
    // 被删用户自身的 thread_*/post_* 回扣随其用户行删除自然消失，跳过）
    let revokeEntries: RevokeEntry[] = [];
    if (tids.length) {
      const inList = tids.map(() => '?').join(',');
      const floors = await db
        .prepare<{ pid: number; uid: number }>(`SELECT pid,uid FROM bbs_post WHERE tid IN (${inList}) AND isfirst = 0 AND uid <> ?`)
        .bind(...tids, uid)
        .all();
      revokeEntries = floors.results.map((f) => ({ uid: Number(f.uid), isfirst: 0 as const, pid: Number(f.pid) }));
    }
    await db.batch(stmts);
    if (revokeEntries.length) {
      await revokeForPostDelete({ db, cache }, revokeEntries);
      const ups = await upgradeGroupsByCredits({ db, cache }, revokeAffectedUids(revokeEntries), grouplist);
      if (ups.length) {
        const rt = await getExtensions(cache, db, undefined, { preloadConfigs: false });
        for (const gc of ups) await rt.bus.emit('user:group-changed', gc);
      }
    }

    await cache.del(`user:${uid}`);
    await cache.del('forumlist');

    if (tids.length) await patchRuntime(cache, { threads: -tids.length });
    await patchRuntime(cache, { users: -1 });
    await invalidateThreadSeo({ db, cache }, c, tids);

    // R2 对象尽力删除（失败不影响一致性）：附件（本人上传 + 本人主题内他人上传）+ 头像（键可由 uid 推导）
    const ex = await getExecCtx(c);
    purgeR2Objects(c.env, ex, attachKeys);
    if (Number(target.avatar) > 0) {
      purgeR2Objects(c.env, ex, [`avatar/${String(uid).padStart(9, '0').slice(0, 3)}/${uid}.png`]);
    }

    return ok(c, t('common.deleted'), { data: { uid, threads: tids.length } });
  });

  return app;
}

function logRow(uid: number, t: ModThread, action: string, ts: number): ModlogRow {
  return { uid, tid: Number(t.tid), pid: Number(t.firstpid), subject: String(t.subject), comment: '', create_date: ts, action };
}
