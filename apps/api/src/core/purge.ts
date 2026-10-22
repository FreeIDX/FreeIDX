/**
 * 内容真删 stmts 构造 + 附件 R2 对象清理，
 * 由三条路径共用：版务删除（mod delete）、审核队列删除（tt_check opt=-2）、回收站彻底删除/清空。
 * 与回收站软删除（仅改 OK=-2、不重算计数）语义严格区分。
 * 调用方负责 db.batch / 缓存失效 / runtime / SEO / 事件副作用 / 积分回扣；
 * 附件 R2 对象由调用方在 batch 前用 attachKeysBy* 收集、batch 后经 purgeR2Objects 尽力删除。
 */
import type { D1b, Stmt } from './db';

/** 今日统计口径（B5）：daily cron 于每日 03:00 UTC 重置 today*；「当日」= 距最近一次重置以来的窗口。 */
export function dailyResetBoundary(ts: number): number {
  const dayStart = Math.floor(ts / 86400) * 86400;
  const today3 = dayStart + 3 * 3600;
  return ts >= today3 ? today3 : today3 - 86400;
}

/**
 * 主题级联删：
 * 删回帖→撤计数（forum.threads / user.threads，回帖按作者聚合回退 user.posts）→删主题与倒排。
 */
export async function threadPurgeStmts(
  db: D1b,
  t: { tid: number; fid: number; uid: number },
  stmts: Stmt[],
): Promise<void> {
  const authorCounts = await db
    .prepare<{ uid: number; c: number }>('SELECT uid, COUNT(*) AS c FROM bbs_post WHERE tid = ? AND isfirst = 0 GROUP BY uid')
    .bind(t.tid)
    .all();
  // B5：当日创建的主题真删时回退 forum.todaythreads（与 threads 回退合并为同条 UPDATE）
  const th = await db
    .prepare<{ create_date: number }>('SELECT create_date FROM bbs_thread WHERE tid = ?')
    .bind(t.tid)
    .first<{ create_date: number }>();
  const isToday = th !== null && Number(th.create_date) >= dailyResetBoundary(Math.floor(Date.now() / 1000));
  stmts.push(
    db.prepare('DELETE FROM bbs_post WHERE tid = ?').bind(t.tid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_mypost WHERE tid = ?').bind(t.tid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_mythread WHERE tid = ?').bind(t.tid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_thread_top WHERE tid = ?').bind(t.tid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_attach WHERE tid = ?').bind(t.tid) as unknown as Stmt,
    // B3：主题级社交/购买记录随主题真删（点赞/收藏/楼层点赞/付费购买），否则孤儿行永久残留
    db.prepare('DELETE FROM bbs_like WHERE tid = ?').bind(t.tid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_favorite WHERE tid = ?').bind(t.tid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_post_like WHERE tid = ?').bind(t.tid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_paylist WHERE tid = ?').bind(t.tid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_thread WHERE tid = ?').bind(t.tid) as unknown as Stmt,
    db.prepare(`UPDATE bbs_forum SET threads = threads - 1${isToday ? ', todaythreads = todaythreads - 1' : ''} WHERE fid = ?`).bind(t.fid) as unknown as Stmt,
    db.prepare('UPDATE bbs_user SET threads = threads - 1 WHERE uid = ?').bind(t.uid) as unknown as Stmt,
  );
  for (const row of authorCounts.results) {
    const u = Number(row.uid);
    if (u > 0) stmts.push(db.prepare('UPDATE bbs_user SET posts = posts - ? WHERE uid = ?').bind(Number(row.c), u) as unknown as Stmt);
  }
}

/**
 * 回帖真删（post_delete：posts-1 + user.posts-1 + mypost 撤 + 帖删 + lastpid 回退）。
 * 首帖（isfirst=1）不走此路径（主题级联由 threadPurgeStmts 负责）；无此 pid 返回 null。
 * lastpid 回退查询用 `pid <> ?` 排除自身，与 batch 执行顺序解耦。
 */
export async function postPurgeStmts(db: D1b, pid: number): Promise<{ stmts: Stmt[]; tid: number; uid: number } | null> {
  const post = await db
    .prepare<{ pid: number; tid: number; uid: number; isfirst: number; ok: number; create_date: number; fid: number }>(
      'SELECT p.pid,p.tid,p.uid,p.isfirst,p.ok,p.create_date,t.fid FROM bbs_post p INNER JOIN bbs_thread t ON t.tid = p.tid WHERE p.pid = ?',
    )
    .bind(pid)
    .first<{ pid: number; tid: number; uid: number; isfirst: number; ok: number; create_date: number; fid: number }>();
  if (!post || Number(post.isfirst) === 1) return null;
  const tid = Number(post.tid);
  const uid = Number(post.uid);

  const stmts: Stmt[] = [
    db.prepare('UPDATE bbs_user SET posts = posts - 1 WHERE uid = ?').bind(uid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_mypost WHERE uid = ? AND pid = ?').bind(uid, pid) as unknown as Stmt,
    // B3：楼层点赞随楼层真删，否则孤儿行永久残留
    db.prepare('DELETE FROM bbs_post_like WHERE pid = ?').bind(pid) as unknown as Stmt,
    // 回帖附件随楼层真删（bbs_attach 同时带 tid 与 pid）：否则附件行与 R2 对象无回收路径，
    // 付费附件在楼层删除后仍可按 aid 下载。
    db.prepare('DELETE FROM bbs_attach WHERE pid = ?').bind(pid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_post WHERE pid = ?').bind(pid) as unknown as Stmt,
  ];
  // B1 连带：仅已过审回帖（ok=1）曾计入 thread.posts/todayposts（待审回帖过审时才补列），
  // 未过审回帖真删不回退主题列，否则计数虚低；user.posts 为发帖行为计数，不区分审核位。
  if (Number(post.ok) === 1) {
    stmts.push(db.prepare('UPDATE bbs_thread SET posts = posts - 1 WHERE tid = ?').bind(tid) as unknown as Stmt);
    // B5：当日创建的回帖真删时回退 forum.todayposts（与发帖时无条件 +1 对齐）
    if (Number(post.create_date) >= dailyResetBoundary(Math.floor(Date.now() / 1000))) {
      stmts.push(db.prepare('UPDATE bbs_forum SET todayposts = todayposts - 1 WHERE fid = ?').bind(Number(post.fid)) as unknown as Stmt);
    }
  }

  const thread = await db.prepare<{ lastpid: number }>('SELECT lastpid FROM bbs_thread WHERE tid = ?').bind(tid).first<{ lastpid: number }>();
  if (pid === Number(thread?.lastpid ?? 0)) {
    // 尾列回退取「剩余最新已过审回帖」（ok=1 过滤；待审楼层本不会成为 lastpid，历史脏尾下次回退自愈）
    const last = await db
      .prepare<{ pid: number; uid: number; create_date: number }>(
        'SELECT pid,uid,create_date FROM bbs_post WHERE tid = ? AND pid <> ? AND ok = 1 ORDER BY pid DESC LIMIT 1',
      )
      .bind(tid, pid)
      .first<{ pid: number; uid: number; create_date: number }>();
    if (last) {
      stmts.push(
        db
          .prepare('UPDATE bbs_thread SET lastpid = ?, lastuid = ?, last_date = ?, lastusername = (SELECT username FROM bbs_user WHERE uid = ?) WHERE tid = ?')
          .bind(Number(last.pid), Number(last.uid), Number(last.create_date), Number(last.uid), tid) as unknown as Stmt,
      );
    } else {
      // 无剩余过审回帖 → 尾列回退到首帖（与主题创建时 lastpid=firstpid 同口径）
      const first = await db
        .prepare<{ pid: number; uid: number; create_date: number }>(
          'SELECT pid,uid,create_date FROM bbs_post WHERE tid = ? AND isfirst = 1',
        )
        .bind(tid)
        .first<{ pid: number; uid: number; create_date: number }>();
      if (first) {
        stmts.push(
          db
            .prepare('UPDATE bbs_thread SET lastpid = ?, lastuid = ?, last_date = ?, lastusername = (SELECT username FROM bbs_user WHERE uid = ?) WHERE tid = ?')
            .bind(Number(first.pid), Number(first.uid), Number(first.create_date), Number(first.uid), tid) as unknown as Stmt,
        );
      }
    }
  }
  return { stmts, tid, uid };
}

/**
 * 用户级联删（user_delete）：其主题（含回帖/倒排/顶置）与散落回帖全清，
 * forum.threads / 主题内他人 posts / 他主题内该用户回帖的 thread.posts 全部回退。
 * 返回 stmts 与受影响 tid 列表（缓存/SEO 失效用）。
 */
export async function userPurgeStmts(db: D1b, uid: number): Promise<{ stmts: Stmt[]; tids: number[] }> {
  const stmts: Stmt[] = [];
  const tids: number[] = [];

  // 用户主题（tid,fid）→ 级联删回帖/主题 + forum.threads 回退
  const myThreads = await db
    .prepare<{ tid: number; fid: number }>('SELECT tid,fid FROM bbs_thread WHERE uid = ?')
    .bind(uid)
    .all();
  const fidCounts = new Map<number, number>();
  for (const row of myThreads.results) {
    tids.push(Number(row.tid));
    const fid = Number(row.fid);
    fidCounts.set(fid, (fidCounts.get(fid) ?? 0) + 1);
  }

  // 他人在这批主题里的回帖数（作者 posts 回退，排除被删用户自身——其计数随行消失）
  if (tids.length) {
    const inList = tids.map(() => '?').join(',');
    const otherAuthors = await db
      .prepare<{ uid: number; c: number }>(
        `SELECT uid, COUNT(*) AS c FROM bbs_post WHERE tid IN (${inList}) AND uid <> ? GROUP BY uid`,
      )
      .bind(...tids, uid)
      .all();
    for (const row of otherAuthors.results) {
      const u = Number(row.uid);
      if (u > 0) stmts.push(db.prepare('UPDATE bbs_user SET posts = posts - ? WHERE uid = ?').bind(Number(row.c), u) as unknown as Stmt);
    }
  }

  // 用户在他主题中的回帖：thread.posts 回退（排除自身主题——整主题将删）。
  // B1 连带：仅统计 ok=1 回帖——待审回帖从未计入 thread.posts（过审时才补列），回退须同口径。
  const ownTidSet = new Set(tids);
  const replyAgg = await db
    .prepare<{ tid: number; c: number }>('SELECT tid, COUNT(*) AS c FROM bbs_post WHERE uid = ? AND isfirst = 0 AND ok = 1 GROUP BY tid')
    .bind(uid)
    .all();
  for (const row of replyAgg.results) {
    const tid = Number(row.tid);
    if (ownTidSet.has(tid)) continue;
    stmts.push(db.prepare('UPDATE bbs_thread SET posts = posts - ? WHERE tid = ?').bind(Number(row.c), tid) as unknown as Stmt);
  }

  // forum.threads 回退
  for (const [fid, n] of fidCounts) {
    stmts.push(db.prepare('UPDATE bbs_forum SET threads = threads - ? WHERE fid = ?').bind(n, fid) as unknown as Stmt);
  }

  // 清理主题/回帖/倒排/收藏/附件/用户行（空 IN 列表跳过，避免非法 SQL）。
  // 遗漏 bbs_mypost/bbs_mythread 会留下指向已删主题的孤儿行；遗漏 bbs_attach 会让
  // 他人上传的正式附件行（status=1，cron 只回收 status=0）与 R2 对象永久残留。
  if (tids.length) {
    const inList = tids.map(() => '?').join(',');
    stmts.push(
      db.prepare(`DELETE FROM bbs_post WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
      db.prepare(`DELETE FROM bbs_mypost WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
      db.prepare(`DELETE FROM bbs_mythread WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
      db.prepare(`DELETE FROM bbs_thread_top WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
      db.prepare(`DELETE FROM bbs_attach WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
      // B3：主题级社交/购买记录随主题真删（他人点赞/收藏/楼层点赞/付费购买）
      db.prepare(`DELETE FROM bbs_like WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
      db.prepare(`DELETE FROM bbs_favorite WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
      db.prepare(`DELETE FROM bbs_post_like WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
      db.prepare(`DELETE FROM bbs_paylist WHERE tid IN (${inList})`).bind(...tids) as unknown as Stmt,
    );
  }
  stmts.push(
    db.prepare('DELETE FROM bbs_post WHERE uid = ?').bind(uid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_thread WHERE uid = ?').bind(uid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_mythread WHERE uid = ?').bind(uid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_mypost WHERE uid = ?').bind(uid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_attach WHERE uid = ?').bind(uid) as unknown as Stmt,
    // B3：用户级社交/购买/申请记录随用户真删（点赞/收藏/楼层点赞/关注双向/付费购买/加V申请）
    db.prepare('DELETE FROM bbs_like WHERE uid = ?').bind(uid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_favorite WHERE uid = ?').bind(uid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_post_like WHERE uid = ?').bind(uid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_follow WHERE follower_uid = ? OR followee_uid = ?').bind(uid, uid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_paylist WHERE uid = ?').bind(uid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_v_apply WHERE uid = ?').bind(uid) as unknown as Stmt,
    // B4：会话与通知——bbs_session 虽有 5min GC 兜底仍显式清理；bbs_notice 无 GC，不删则永久悬挂
    db.prepare('DELETE FROM bbs_session WHERE uid = ?').bind(uid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_notice WHERE recvuid = ? OR fromuid = ?').bind(uid, uid) as unknown as Stmt,
    db.prepare('DELETE FROM bbs_user WHERE uid = ?').bind(uid) as unknown as Stmt,
  );

  return { stmts, tids };
}

/* ------------------------------------------------------------------ *
 * R2 对象清理（真删附件的对象侧）
 * 附件行删除只解决 D1 一致性；R2 对象没有 GC 路径（cron 仅回收 status=0 且超 24h 的行），
 * 故真删前先收集 key，batch 后经 waitUntil 尽力而为删除，失败不影响 D1 一致性。
 * ------------------------------------------------------------------ */

/** 主题内全部附件 key（thread_delete 前调用） */
export async function attachKeysByTid(db: D1b, tid: number): Promise<string[]> {
  const r = await db
    .prepare<{ filename: string }>('SELECT filename FROM bbs_attach WHERE tid = ?')
    .bind(tid)
    .all();
  return r.results.map((x) => String(x.filename)).filter(Boolean);
}

/** 多主题内全部附件 key（删版块等批量真删前调用） */
export async function attachKeysByTids(db: D1b, tids: number[]): Promise<string[]> {
  if (!tids.length) return [];
  const inList = tids.map(() => '?').join(',');
  const r = await db
    .prepare<{ filename: string }>(`SELECT filename FROM bbs_attach WHERE tid IN (${inList})`)
    .bind(...tids)
    .all();
  return r.results.map((x) => String(x.filename)).filter(Boolean);
}

/** 楼层附件 key（post_delete 前调用） */
export async function attachKeysByPid(db: D1b, pid: number): Promise<string[]> {
  const r = await db
    .prepare<{ filename: string }>('SELECT filename FROM bbs_attach WHERE pid = ?')
    .bind(pid)
    .all();
  return r.results.map((x) => String(x.filename)).filter(Boolean);
}

/** 用户级联删的附件 key：本人上传 + 本人主题内他人上传（与 userPurgeStmts 的删除范围一致） */
export async function attachKeysForUserPurge(db: D1b, uid: number, tids: number[]): Promise<string[]> {
  if (!tids.length) {
    const only = await db.prepare<{ filename: string }>('SELECT filename FROM bbs_attach WHERE uid = ?').bind(uid).all();
    return only.results.map((x) => String(x.filename)).filter(Boolean);
  }
  const inList = tids.map(() => '?').join(',');
  const r = await db
    .prepare<{ filename: string }>(`SELECT filename FROM bbs_attach WHERE uid = ? OR tid IN (${inList})`)
    .bind(uid, ...tids)
    .all();
  return r.results.map((x) => String(x.filename)).filter(Boolean);
}

/** 尽力而为删除 R2 对象（有 waitUntil 则旁路，否则原地 await；单个失败静默） */
export function purgeR2Objects(
  env: { FILES?: unknown },
  exec: { waitUntil?: (pr: Promise<unknown>) => void } | undefined,
  keys: string[],
): void {
  if (!keys.length) return;
  const bucket = env.FILES as { delete?: (k: string) => unknown } | undefined;
  if (!bucket || typeof bucket.delete !== 'function') return;
  const work = Promise.all(keys.map((k) => Promise.resolve(bucket.delete!(k)).catch(() => undefined)));
  if (exec?.waitUntil) exec.waitUntil(work);
  else void work;
}