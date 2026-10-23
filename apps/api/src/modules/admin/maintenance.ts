/**
 * 运行维护 · 数据库维护 + R2 存储维护（T3-11）。
 *
 * 设计前提（§7 三预算，免费层硬限）：
 *  - 单 invocation ≤50 条 D1 查询、≤50 子请求、≤10ms CPU、账户级 10 万行写/天。
 *  - 因此**任何清理都不能「一次点完清全站」**：所有写路径都按小批量执行，返回 done/remaining，
 *    由前端循环推进或管理员重复点击。单请求内最多推进 MAINT_MAX_BATCHES 批。
 *  - SQLite 不支持 `DELETE ... LIMIT`（未开 SQLITE_ENABLE_UPDATE_DELETE_LIMIT），
 *    故分批一律写成 `DELETE ... WHERE rowid IN (SELECT rowid ... LIMIT n)`。
 *
 * 口径与安全边界：
 *  - 孤儿判定用「实体存在性」而不是 `ok=1`，故回收站（ok=-2）内容**不会**被误清。
 *  - `bbs_point_log` / `bbs_order` / `bbs_paylist` / `bbs_modlog` / `bbs_user_pay` 属财务与审计数据，
 *    **永不提供删除任务**（即使存在 uid 孤儿行）——只在前端文案里说明。
 *  - `bbs_attach` 只清 status=1（已关联）且 tid/pid 均不存在的行，并排除付费附件
 *    （credits/golds/rmbs>0，删了等于剥夺买家下载权）；删除顺序沿用 attachGc：先删 R2 再删行。
 *  - R2 侧只枚举白名单前缀（avatar/forum/site/attach/seo），绝不触碰未知前缀与 `tmp/`
 *    （`tmp/` 由 cron + 桶生命周期规则负责）。删除前必须有一次完成的 scan 报告 + 显式 confirm。
 *
 * 状态存储：不新建表。R2 扫描进度与 DB 体检快照分别落 `bbs_cache`（前者 7 天 TTL），
 * 审计走 `bbs_modlog`（action='maint.db' / 'maint.r2'）。
 */
import { Hono } from 'hono';
import { Code, detectContentLang } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { BUDGET } from '../../core/db/budget';
import type { D1b } from '../../core/db';
import { attachGc, calibrateCounters, cronFiveMin } from '../../core/cron';
import { queueGc } from '../../core/queue';
import { filesBucket } from '../attach/core';
import { adminUidOf, core, intParam, readJsonObject, type ReadEnv } from '../shared';

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;

/** 单请求内最多推进的 DB 清理批数（每批 1 条查询，留足预算给体检与审计写） */
const MAINT_MAX_BATCHES = 8;
/** 体检计数上限：命中数封顶在 501，避免「无孤儿时全表扫描」把 rows_read 放大 */
const PROBE_CAP = 500;
/** 体检结果缓存时长（秒）：体检本身是全表扫描，页面默认不自动跑，命中缓存零 D1 */
const OVERVIEW_TTL = 3600;
/** 内容语言回填单批条数：20 条 = 3 次 D1 查询（JOIN 取文本 + CASE 批量更新 + COUNT 剩余） */
const LANG_BACKFILL_BATCH = 20;
/** 语言分布统计缓存时长（秒）：聚合是全表扫描，页面默认不自动跑，按需点击且复用缓存 */
const LANG_STATS_TTL = 600;
/** 语言分布统计的「近期」窗口（天） */
const LANG_STATS_RECENT_DAYS = 30;

/**
 * 孤儿删除任务表。risk 1 = 社交/倒排类（无 R2 副作用）；risk 2 = 附件（需先删对象）。
 * 每条的 where 都是「指向已不存在实体」的判定式，别名与条件写死在此处，避免运行时拼 SQL。
 */
interface DbTask {
  risk: 1 | 2;
  /** 每批上限（risk 1 走纯 SQL；risk 2 受 R2 子请求预算约束） */
  batch: number;
  /** 命中数探测（封顶 PROBE_CAP+1） */
  probe: string;
  /** dryRun 取样 */
  sample: string;
  /** 批量删除（risk 1 用 LIMIT ?；risk 2 用 aid IN (...) 见 runAttachOrphan） */
  remove: string;
}

const LIKE_ORPHAN = 'NOT EXISTS (SELECT 1 FROM bbs_thread t WHERE t.tid = l.tid)';
const FAV_ORPHAN = 'NOT EXISTS (SELECT 1 FROM bbs_thread t WHERE t.tid = f.tid)';
const POST_LIKE_ORPHAN = 'NOT EXISTS (SELECT 1 FROM bbs_post p WHERE p.pid = pl.pid)';
const MYPOST_ORPHAN = 'NOT EXISTS (SELECT 1 FROM bbs_post p WHERE p.pid = mp.pid)';
const MYTHREAD_ORPHAN = 'NOT EXISTS (SELECT 1 FROM bbs_thread t WHERE t.tid = mt.tid)';
const THREAD_TOP_ORPHAN = 'NOT EXISTS (SELECT 1 FROM bbs_thread t WHERE t.tid = tt.tid)';
/**
 * 通知孤儿：收件人或发件人已不存在。
 * `recvuid = 0` / `fromuid = 0` 是系统侧占位（广播/系统通知），无法判定归属，一律跳过。
 */
const NOTICE_ORPHAN =
  '(n.recvuid > 0 AND NOT EXISTS (SELECT 1 FROM bbs_user u WHERE u.uid = n.recvuid)) ' +
  'OR (n.fromuid > 0 AND NOT EXISTS (SELECT 1 FROM bbs_user u2 WHERE u2.uid = n.fromuid))';
/** 附件孤儿：已关联（status=1）但主题与楼层都不存在；付费附件一律排除 */
const ATTACH_ORPHAN =
  'a.status = 1 AND a.credits = 0 AND a.golds = 0 AND a.rmbs = 0 ' +
  'AND NOT EXISTS (SELECT 1 FROM bbs_thread t WHERE t.tid = a.tid) ' +
  'AND NOT EXISTS (SELECT 1 FROM bbs_post p WHERE p.pid = a.pid)';

const DB_TASKS: Record<string, DbTask> = {
  like: {
    risk: 1,
    batch: 200,
    probe: `SELECT COUNT(*) AS c FROM (SELECT 1 FROM bbs_like l WHERE ${LIKE_ORPHAN} LIMIT ${PROBE_CAP + 1})`,
    sample: `SELECT l.uid, l.tid, l.create_date FROM bbs_like l WHERE ${LIKE_ORPHAN} LIMIT ?`,
    remove: `DELETE FROM bbs_like WHERE rowid IN (SELECT l.rowid FROM bbs_like l WHERE ${LIKE_ORPHAN} LIMIT ?)`,
  },
  favorite: {
    risk: 1,
    batch: 200,
    probe: `SELECT COUNT(*) AS c FROM (SELECT 1 FROM bbs_favorite f WHERE ${FAV_ORPHAN} LIMIT ${PROBE_CAP + 1})`,
    sample: `SELECT f.uid, f.tid, f.create_date FROM bbs_favorite f WHERE ${FAV_ORPHAN} LIMIT ?`,
    remove: `DELETE FROM bbs_favorite WHERE rowid IN (SELECT f.rowid FROM bbs_favorite f WHERE ${FAV_ORPHAN} LIMIT ?)`,
  },
  post_like: {
    risk: 1,
    batch: 200,
    probe: `SELECT COUNT(*) AS c FROM (SELECT 1 FROM bbs_post_like pl WHERE ${POST_LIKE_ORPHAN} LIMIT ${PROBE_CAP + 1})`,
    sample: `SELECT pl.uid, pl.pid, pl.tid, pl.create_date FROM bbs_post_like pl WHERE ${POST_LIKE_ORPHAN} LIMIT ?`,
    remove: `DELETE FROM bbs_post_like WHERE rowid IN (SELECT pl.rowid FROM bbs_post_like pl WHERE ${POST_LIKE_ORPHAN} LIMIT ?)`,
  },
  mypost: {
    risk: 1,
    batch: 200,
    probe: `SELECT COUNT(*) AS c FROM (SELECT 1 FROM bbs_mypost mp WHERE ${MYPOST_ORPHAN} LIMIT ${PROBE_CAP + 1})`,
    sample: `SELECT mp.uid, mp.pid, mp.tid FROM bbs_mypost mp WHERE ${MYPOST_ORPHAN} LIMIT ?`,
    remove: `DELETE FROM bbs_mypost WHERE rowid IN (SELECT mp.rowid FROM bbs_mypost mp WHERE ${MYPOST_ORPHAN} LIMIT ?)`,
  },
  mythread: {
    risk: 1,
    batch: 200,
    probe: `SELECT COUNT(*) AS c FROM (SELECT 1 FROM bbs_mythread mt WHERE ${MYTHREAD_ORPHAN} LIMIT ${PROBE_CAP + 1})`,
    sample: `SELECT mt.uid, mt.tid FROM bbs_mythread mt WHERE ${MYTHREAD_ORPHAN} LIMIT ?`,
    remove: `DELETE FROM bbs_mythread WHERE rowid IN (SELECT mt.rowid FROM bbs_mythread mt WHERE ${MYTHREAD_ORPHAN} LIMIT ?)`,
  },
  thread_top: {
    risk: 1,
    batch: 200,
    probe: `SELECT COUNT(*) AS c FROM (SELECT 1 FROM bbs_thread_top tt WHERE ${THREAD_TOP_ORPHAN} LIMIT ${PROBE_CAP + 1})`,
    sample: `SELECT tt.tid, tt.fid, tt.top FROM bbs_thread_top tt WHERE ${THREAD_TOP_ORPHAN} LIMIT ?`,
    remove: `DELETE FROM bbs_thread_top WHERE tid IN (SELECT tt.tid FROM bbs_thread_top tt WHERE ${THREAD_TOP_ORPHAN} LIMIT ?)`,
  },
  notice: {
    risk: 1,
    batch: 200,
    probe: `SELECT COUNT(*) AS c FROM (SELECT 1 FROM bbs_notice n WHERE ${NOTICE_ORPHAN} LIMIT ${PROBE_CAP + 1})`,
    sample: `SELECT n.nid, n.fromuid, n.recvuid, n.create_date FROM bbs_notice n WHERE ${NOTICE_ORPHAN} LIMIT ?`,
    remove: `DELETE FROM bbs_notice WHERE nid IN (SELECT n.nid FROM bbs_notice n WHERE ${NOTICE_ORPHAN} LIMIT ?)`,
  },
  attach_orphan: {
    risk: 2,
    // 每批 20：先删 R2 对象（1 key = 1 子请求）再删行，超 40 会顶穿免费层子请求预算
    batch: 20,
    probe: `SELECT COUNT(*) AS c FROM (SELECT 1 FROM bbs_attach a WHERE ${ATTACH_ORPHAN} LIMIT ${PROBE_CAP + 1})`,
    sample: `SELECT a.aid, a.uid, a.tid, a.pid, a.filename, a.filesize FROM bbs_attach a WHERE ${ATTACH_ORPHAN} LIMIT ?`,
    remove: '',
  },
};

const DB_TASK_IDS = Object.keys(DB_TASKS);

/** 立即执行的 cron 子任务（复用现成实现，不重写逻辑，避免两套口径漂移） */
const CRON_JOBS = ['session', 'calibrate', 'cache_gc', 'email_code', 'queue', 'attach_tmp'] as const;
type CronJob = (typeof CRON_JOBS)[number];

async function probeCount(db: D1b, sql: string): Promise<{ count: number; capped: boolean }> {
  const row = await db.prepare<{ c: number }>(sql).first<{ c: number }>();
  const n = Number(row?.c ?? 0);
  return { count: Math.min(n, PROBE_CAP), capped: n > PROBE_CAP };
}

/** 单批删除（risk 1）。返回本批实删行数 */
async function removeBatch(db: D1b, def: DbTask, limit: number): Promise<number> {
  const r = await db.prepare(def.remove).bind(limit).run();
  return Number(r.meta?.changes ?? 0);
}

/**
 * 单批删除（risk 2 附件）：先取一批 key → 逐个删 R2 → 仅对删成功的行执行 DELETE。
 * 顺序与 attachGc 一致：对象删失败就保留行，下轮重试（宁留孤儿行，不留孤儿对象）。
 */
async function removeAttachBatch(
  db: D1b,
  env: ReadEnv['Bindings'],
  limit: number,
): Promise<{ deleted: number; objectFailed: number }> {
  const rows = await db
    .prepare<{ aid: number; filename: string }>(
      `SELECT a.aid, a.filename FROM bbs_attach a WHERE ${ATTACH_ORPHAN} LIMIT ?`,
    )
    .bind(limit)
    .all();
  if (!rows.results.length) return { deleted: 0, objectFailed: 0 };

  const bucket = filesBucket(env);
  const removed: number[] = [];
  let objectFailed = 0;
  for (const r of rows.results) {
    try {
      await bucket.delete(String(r.filename));
      removed.push(Number(r.aid));
    } catch {
      objectFailed++;
    }
  }
  if (!removed.length) return { deleted: 0, objectFailed };
  const placeholders = removed.map(() => '?').join(',');
  await db.prepare(`DELETE FROM bbs_attach WHERE aid IN (${placeholders})`).bind(...removed).run();
  return { deleted: removed.length, objectFailed };
}

/** 审计落库（modlog）：subject 是任务 id，comment 放结果摘要 */
async function audit(db: D1b, uid: number, action: 'maint.db' | 'maint.r2', subject: string, comment: string): Promise<void> {
  await db
    .prepare('INSERT INTO bbs_modlog (uid,tid,pid,subject,comment,create_date,action) VALUES (?,0,0,?,?,?,?)')
    .bind(uid, subject, comment, now(), action)
    .run();
}

/* ------------------------------------------------------------------ *
 * R2 存储维护：前缀白名单 + 扫描/删除状态机
 * ------------------------------------------------------------------ */

const R2_PREFIXES = ['avatar', 'forum', 'site', 'attach', 'seo'] as const;
type R2Prefix = (typeof R2_PREFIXES)[number];

/**
 * 单页枚举条数。
 * 取 100 而不是 1000：反查 D1 要用 `IN (?,?,…)`，D1 单语句绑定参数上限 100，
 * 且 100 条 key 的 JSON 解析在免费层 10ms CPU 预算内更安全。
 */
const R2_PAGE = 100;
/**
 * 删除模式每轮最多删的对象数。
 *
 * 走 R2 的批量删除（`bucket.delete(string[])`，官方文档「Up to 1000 keys may be deleted per call」）：
 * 一次调用销毁多个对象，按 1 个 subrequest 计。若批量删除不可用（抛错），自动回落到
 * R2_DELETE_SAFE_BATCH 的逐 key 模式（最坏情况 1 key = 1 subrequest），并持久化该降级决定。
 */
const R2_DELETE_PER_STEP = 200;
/** 批量删除不可用时的保守档：1 key = 1 子请求，20 个 + list/判定/写状态仍在 50 预算内 */
const R2_DELETE_SAFE_BATCH = 20;
/** R2 批量删除的硬上限（超出会被 R2 拒绝，见官方文档） */
const R2_DELETE_MAX_KEYS = 1000;
const R2_DELETE_BATCH_MAX = Math.min(R2_DELETE_PER_STEP, R2_DELETE_MAX_KEYS);
/** 扫描模式每轮最多推进的页数（每页 = 1 list + 1 查询） */
const R2_SCAN_PAGES = 5;
/** 宽限期（小时）：上传不足此时长的对象一律跳过，防「刚上传尚未关联」被误删 */
const R2_MIN_AGE_HOURS = 24;
/** 任务状态保留时长（秒）：bbs_cache 每日 cron 会物理回收过期行 */
const R2_STATE_TTL = 7 * DAY;

interface R2State {
  prefix: R2Prefix;
  mode: 'scan' | 'delete';
  /** R2 分页游标（'' = 从头开始） */
  cursor: string;
  scanned: number;
  hits: number;
  deleted: number;
  kept: number;
  skipped: number;
  /** 删除模式下已判定但尚未删完的 key（保证游标不会越过待删对象） */
  pending: string[];
  done: boolean;
  minAgeHours: number;
  /** 是否仍走批量删除（false = 已降级为逐 key，持久化以免每轮重复失败） */
  bulk: boolean;
  /** 本轮每步实际可删的对象数 */
  deleteBatch: number;
  updated: number;
}

const r2StateKey = (p: R2Prefix): string => `maint:r2:${p}`;

function emptyState(prefix: R2Prefix, mode: 'scan' | 'delete', minAgeHours: number): R2State {
  return {
    prefix,
    mode,
    cursor: '',
    scanned: 0,
    hits: 0,
    deleted: 0,
    kept: 0,
    skipped: 0,
    pending: [],
    done: false,
    minAgeHours,
    bulk: true,
    deleteBatch: R2_DELETE_BATCH_MAX,
    updated: now(),
  };
}

/** 兼容升级前落库的旧 state（无 bulk/deleteBatch 字段） */
function normalizeState(s: R2State): R2State {
  return {
    ...s,
    bulk: s.bulk !== false,
    deleteBatch: Number(s.deleteBatch) > 0 ? Math.min(Number(s.deleteBatch), R2_DELETE_MAX_KEYS) : R2_DELETE_BATCH_MAX,
  };
}

/** 从 key 尾部解析数字 id：avatar/001/42.png → 42、forum/3.png → 3、seo/88.html → 88 */
function idOfKey(key: string): number {
  const m = /(\d+)\.[a-z0-9]+$/i.exec(key);
  const n = m ? Number(m[1]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** site/ 前缀：setting 里 logo_url / favicon_url 指向的 key 即「在用」 */
async function siteKeysInUse(db: D1b): Promise<Set<string>> {
  const row = await db.prepare<{ v: string }>("SELECT v FROM bbs_kv WHERE k = 'setting'").first<{ v: string }>();
  if (!row) return new Set();
  try {
    const raw = JSON.parse(row.v) as Record<string, unknown>;
    const out = new Set<string>();
    for (const field of ['logo_url', 'favicon_url']) {
      const m = /\/files\/(site\/[^\s?#]+)/.exec(String(raw[field] ?? ''));
      if (m) out.add(m[1]!);
    }
    return out;
  } catch {
    // setting 解析失败 → 无法判定，返回「全部在用」由调用方整体跳过本页
    return new Set();
  }
}

/**
 * 判定一页 key 中哪些「未被引用」。
 * 只做 key → D1 的单向反查（绝不按 D1 反推 R2），且每次只发 1 条查询。
 * 返回 null 表示本页无法判定（数据异常/查询失败），调用方必须整页跳过。
 */
async function judgePage(db: D1b, prefix: R2Prefix, keys: string[]): Promise<{ unused: string[]; used: number } | null> {
  if (!keys.length) return { unused: [], used: 0 };

  if (prefix === 'forum') {
    const rows = await db.prepare<{ icon_file: string }>('SELECT icon_file FROM bbs_forum').all();
    const used = new Set(rows.results.map((r) => String(r.icon_file ?? '')).filter(Boolean));
    return { unused: keys.filter((k) => !used.has(k)), used: keys.length - keys.filter((k) => !used.has(k)).length };
  }

  if (prefix === 'site') {
    const used = await siteKeysInUse(db);
    if (!used.size) return { unused: [], used: keys.length };
    return { unused: keys.filter((k) => !used.has(k)), used: keys.filter((k) => used.has(k)).length };
  }

  if (prefix === 'avatar') {
    const ids = keys.map(idOfKey).filter((x) => x > 0);
    if (ids.length !== keys.length) return null; // 出现无法解析的 key，整页跳过（不猜）
    const placeholders = ids.map(() => '?').join(',');
    const rows = await db
      .prepare<{ uid: number; avatar: number }>(`SELECT uid,avatar FROM bbs_user WHERE uid IN (${placeholders})`)
      .bind(...ids)
      .all();
    const alive = new Set(rows.results.filter((r) => Number(r.avatar) > 0).map((r) => Number(r.uid)));
    const unused = keys.filter((k) => !alive.has(idOfKey(k)));
    return { unused, used: keys.length - unused.length };
  }

  if (prefix === 'attach') {
    const placeholders = keys.map(() => '?').join(',');
    const rows = await db
      .prepare<{ filename: string }>(`SELECT filename FROM bbs_attach WHERE filename IN (${placeholders})`)
      .bind(...keys)
      .all();
    const alive = new Set(rows.results.map((r) => String(r.filename)));
    const unused = keys.filter((k) => !alive.has(k));
    return { unused, used: keys.length - unused.length };
  }

  // seo：只按「主题是否还存在」判定（ok=0 的待审主题仍可能生成，属在用）
  const ids = keys.map(idOfKey).filter((x) => x > 0);
  if (ids.length !== keys.length) return null;
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db.prepare<{ tid: number }>(`SELECT tid FROM bbs_thread WHERE tid IN (${placeholders})`).bind(...ids).all();
  const alive = new Set(rows.results.map((r) => Number(r.tid)));
  const unused = keys.filter((k) => !alive.has(idOfKey(k)));
  return { unused, used: keys.length - unused.length };
}

/**
 * 推进分页游标。
 * truncated=true 但没有 cursor 时直接判定收尾 —— 否则下一轮会用 '' 从头再取，形成死循环。
 */
function advanceCursor(state: R2State, truncated: boolean | undefined, cursor: string | undefined): void {
  if (!truncated) {
    state.cursor = '';
    state.done = true;
    return;
  }
  const next = String(cursor ?? '');
  if (!next) state.done = true;
  else state.cursor = next;
}

/** 判断对象是否在宽限期内（uploaded 缺失时按「不确定」处理 → 跳过，宁可少删） */
function tooYoung(uploaded: Date | string | undefined, minAgeHours: number): boolean {
  if (!uploaded) return true;
  const ts = uploaded instanceof Date ? uploaded.getTime() : Date.parse(String(uploaded));
  if (!Number.isFinite(ts)) return true;
  return Date.now() - ts < minAgeHours * 3600 * 1000;
}

/** 批量删除：一次调用销毁多个对象。失败时返回 false，由调用方降级为逐 key。 */
async function deleteObjects(bucket: { delete: (k: string | string[]) => Promise<unknown> }, keys: string[]): Promise<boolean> {
  if (!keys.length) return true;
  try {
    await bucket.delete(keys.slice(0, R2_DELETE_MAX_KEYS));
    return true;
  } catch {
    return false;
  }
}

export function adminMaintenanceRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  /* -------------------- 数据库维护：体检 -------------------- */
  app.get('/api/admin/maintenance/db/overview', async (c) => {
    const { db, cache } = core(c);
    const refresh = intParam(c.req.query('refresh')) === 1;

    if (!refresh) {
      const cached = await cache.get<{ tasks: unknown[]; generated: number }>('maint:db:overview');
      if (cached) return ok(c, 'ok', { data: { ...cached, cached: true, budget: budgetOf(db) } });
    }

    const tasks: { id: string; risk: 1 | 2; count: number; capped: boolean }[] = [];
    for (const id of DB_TASK_IDS) {
      const { count, capped } = await probeCount(db, DB_TASKS[id]!.probe);
      tasks.push({ id, risk: DB_TASKS[id]!.risk, count, capped });
    }

    const data = { tasks, generated: now(), probeCap: PROBE_CAP, cached: false };
    // 体检是全表扫描，缓存 1 小时；手动「重新体检」(refresh=1) 才重跑
    await cache.set('maint:db:overview', data, OVERVIEW_TTL);
    return ok(c, 'ok', { data: { ...data, budget: budgetOf(db) } });
  });

  /* -------------------- 数据库维护：分批清理 -------------------- */
  app.post('/api/admin/maintenance/db/run', async (c) => {
    const { db } = core(c);
    const t = c.get('t');
    const body = await readJsonObject(c);
    const task = String(body.task ?? '');
    const def = DB_TASKS[task];
    if (!def) throw new AppError(Code.VALIDATION_ERROR, t('admin.maintTaskInvalid'));
    const dryRun = body.dryRun === true;
    const batches = Math.min(MAINT_MAX_BATCHES, Math.max(1, intParam(String(body.batches ?? ''), 1)));

    if (dryRun) {
      const rows = await db.prepare(def.sample).bind(def.batch).all();
      const { count, capped } = await probeCount(db, def.probe);
      return ok(c, 'ok', {
        data: { task, dryRun: true, deleted: 0, batches: 0, done: false, remaining: count, capped, samples: rows.results, budget: budgetOf(db) },
      });
    }

    let deleted = 0;
    let done = false;
    let objectFailed = 0;
    for (let i = 0; i < batches; i++) {
      if (def.risk === 2) {
        const r = await removeAttachBatch(db, c.env, def.batch);
        deleted += r.deleted;
        objectFailed += r.objectFailed;
        if (r.deleted < def.batch) {
          done = true;
          break;
        }
      } else {
        const n = await removeBatch(db, def, def.batch);
        deleted += n;
        if (n < def.batch) {
          done = true;
          break;
        }
      }
    }

    const { count, capped } = await probeCount(db, def.probe);
    if (deleted > 0) await audit(db, await adminUidOf(c), 'maint.db', task, JSON.stringify({ deleted, objectFailed, remaining: count }));
    return ok(c, t('common.saved'), {
      data: { task, dryRun: false, deleted, batches, done: done || count === 0, remaining: count, capped, objectFailed, budget: budgetOf(db) },
    });
  });

  /* -------------------- 内容语言回填（存量帖） -------------------- */
  /**
   * 回填口径与发帖时完全一致（同一个 detectContentLang）：
   *  - 只处理 lang = '' 的存量帖，新帖由写入链路直接定稿，不进队列；
   *  - 单批 20 条：1 条 JOIN 查询取标题+首帖正文，1 条 CASE 批量 UPDATE，1 条 COUNT 剩余，
   *    单请求 3 条 D1 查询，远低于免费层预算；
   *  - 判不出语言的（纯图片/符号）落 'other' 而不是留空，保证队列可收敛，不会无限循环。
   */
  app.get('/api/admin/maintenance/content-lang/status', async (c) => {
    const { db } = core(c);
    const row = await db
      .prepare<{ c: number }>("SELECT COUNT(*) AS c FROM bbs_thread WHERE lang = ''")
      .first<{ c: number }>();
    return ok(c, 'ok', { data: { remaining: Number(row?.c ?? 0) } });
  });

  /**
   * 语言分布统计：一条聚合查询同时拿到「总量」与「近 30 天新增」。
   * 全表扫描（rows_read ≈ 主题数），故默认走缓存、仅 refresh=1 或首次点击时真查；
   * 返回按总量降序，lang='' 同时返回（前端显示为「未标注」，用于判断回填进度）。
   */
  app.get('/api/admin/maintenance/content-lang/stats', async (c) => {
    const { db, cache } = core(c);
    const refresh = intParam(c.req.query('refresh')) === 1;
    const key = 'maint:content_lang:stats';

    if (!refresh) {
      const hit = await cache.get<Record<string, unknown>>(key);
      if (hit) return ok(c, 'ok', { data: { ...hit, cached: true } });
    }

    const since = now() - LANG_STATS_RECENT_DAYS * DAY;
    const rows = await db
      .prepare<{ lang: string; total: number; recent: number }>(
        `SELECT lang, COUNT(*) AS total, SUM(CASE WHEN create_date >= ? THEN 1 ELSE 0 END) AS recent
         FROM bbs_thread GROUP BY lang ORDER BY total DESC, lang ASC`,
      )
      .bind(since)
      .all();
    const list = rows.results.map((r) => ({
      lang: String(r.lang ?? ''),
      total: Number(r.total ?? 0),
      recent: Number(r.recent ?? 0),
    }));
    const total = list.reduce((n, r) => n + r.total, 0);
    const data = { rows: list, total, since, recentDays: LANG_STATS_RECENT_DAYS, generated: now(), cached: false };
    await cache.set(key, data, LANG_STATS_TTL);
    return ok(c, 'ok', { data: { ...data, budget: budgetOf(db) } });
  });

  app.post('/api/admin/maintenance/content-lang/backfill', async (c) => {
    const { db } = core(c);
    const t = c.get('t');
    const body = await readJsonObject(c);
    const limit = Math.min(50, Math.max(1, intParam(String(body.limit ?? ''), LANG_BACKFILL_BATCH)));

    const rows = await db
      .prepare<{ tid: number; subject: string; message: string }>(
        `SELECT t.tid, t.subject, p.message FROM bbs_thread t JOIN bbs_post p ON p.pid = t.firstpid
         WHERE t.lang = '' ORDER BY t.tid LIMIT ?`,
      )
      .bind(limit)
      .all();

    const scanned = rows.results.length;
    const updates = rows.results.map((r) => ({
      tid: Number(r.tid),
      lang: detectContentLang(`${r.subject ?? ''} ${r.message ?? ''}`) || 'other',
    }));

    if (updates.length) {
      /* 单语句批量更新：CASE tid WHEN ? THEN ? … 参数顺序 = (tid,lang)* + tid IN (…) */
      const cases = updates.map(() => 'WHEN ? THEN ?').join(' ');
      const ids = updates.map((u) => u.tid);
      const sql = `UPDATE bbs_thread SET lang = CASE tid ${cases} END WHERE tid IN (${ids.map(() => '?').join(',')})`;
      await db
        .prepare(sql)
        .bind(...updates.flatMap((u) => [u.tid, u.lang]), ...ids)
        .run();
    }

    const left = await db
      .prepare<{ c: number }>("SELECT COUNT(*) AS c FROM bbs_thread WHERE lang = ''")
      .first<{ c: number }>();
    const remaining = Number(left?.c ?? 0);
    const done = remaining === 0;
    if (updates.length) {
      await audit(db, await adminUidOf(c), 'maint.db', 'content_lang_backfill', JSON.stringify({ scanned, updated: updates.length, remaining }));
    }
    return ok(c, t('common.saved'), {
      data: { scanned, updated: updates.length, remaining, done, batch: limit, budget: budgetOf(db) },
    });
  });

  /* -------------------- 立即执行 cron 子任务 -------------------- */
  app.post('/api/admin/maintenance/cron/run', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const body = await readJsonObject(c);
    const job = String(body.job ?? '') as CronJob;
    if (!CRON_JOBS.includes(job)) throw new AppError(Code.VALIDATION_ERROR, t('admin.maintTaskInvalid'));
    const ts = now();
    let affected = 0;
    let detail: Record<string, unknown> = {};

    const files = c.env.FILES as unknown as { delete?: (key: string) => unknown };

    if (job === 'session') {
      const r = await cronFiveMin({ db, cache, files, now: ts, env: c.env });
      affected = r.onlines;
      detail = { onlines: r.onlines, sessExpiry: r.sessExpiry };
    } else if (job === 'calibrate') {
      const r = await calibrateCounters(db);
      affected = r.driftRows;
      detail = { driftRows: r.driftRows, threads: r.threads, posts: r.posts };
    } else if (job === 'cache_gc') {
      const r = await db.prepare('DELETE FROM bbs_cache WHERE expiry > 0 AND expiry <= ?').bind(ts).run();
      affected = Number(r.meta?.changes ?? 0);
    } else if (job === 'email_code') {
      const r = await db.prepare('DELETE FROM bbs_email_code WHERE expiry > 0 AND expiry < ?').bind(ts - DAY).run();
      affected = Number(r.meta?.changes ?? 0);
    } else if (job === 'queue') {
      const before = await probeQueue(db);
      await queueGc(db, ts);
      affected = before;
    } else {
      affected = await attachGc({ db, cache, files, now: ts, env: c.env }, ts);
    }

    await audit(db, await adminUidOf(c), 'maint.db', `cron:${job}`, JSON.stringify(detail));
    return ok(c, t('common.saved'), { data: { job, affected, detail, budget: budgetOf(db) } });
  });

  /* -------------------- R2 存储维护 -------------------- */
  app.get('/api/admin/maintenance/r2/status', async (c) => {
    const { db, cache } = core(c);
    const states: (R2State | null)[] = [];
    for (const p of R2_PREFIXES) states.push(await cache.get<R2State>(r2StateKey(p)));
    return ok(c, 'ok', {
      data: {
        prefixes: R2_PREFIXES,
        pendingDeletePerStep: R2_DELETE_PER_STEP,
        pageSize: R2_PAGE,
        minAgeHours: R2_MIN_AGE_HOURS,
        states,
        budget: budgetOf(db),
      },
    });
  });

  app.post('/api/admin/maintenance/r2/start', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const body = await readJsonObject(c);
    const prefix = String(body.prefix ?? '') as R2Prefix;
    const mode = body.mode === 'delete' ? 'delete' : 'scan';
    if (!R2_PREFIXES.includes(prefix)) throw new AppError(Code.VALIDATION_ERROR, t('admin.maintTaskInvalid'));
    const bucket = filesBucket(c.env);
    if (typeof bucket.list !== 'function') throw new AppError(Code.VALIDATION_ERROR, t('admin.maintR2Unavailable'));

    const prevRaw = await cache.get<R2State>(r2StateKey(prefix));
    const prev = prevRaw ? normalizeState(prevRaw) : null;
    if (mode === 'delete') {
      // 删除前置门槛：必须已有一次「跑到末尾且命中 >0」的扫描报告，且本次显式 confirm
      if (body.confirm !== true || !prev || prev.mode !== 'scan' || !prev.done || prev.hits <= 0) {
        throw new AppError(Code.VALIDATION_ERROR, t('admin.maintNeedScan'));
      }
    }

    const minAgeHours = Math.min(720, Math.max(1, intParam(String(body.minAgeHours ?? ''), R2_MIN_AGE_HOURS)));
    const state = emptyState(prefix, mode, minAgeHours);
    await cache.set(r2StateKey(prefix), state, R2_STATE_TTL);
    if (mode === 'delete') await audit(db, await adminUidOf(c), 'maint.r2', prefix, JSON.stringify({ mode, hits: prev?.hits ?? 0 }));
    return ok(c, t('common.saved'), { data: { state } });
  });

  app.post('/api/admin/maintenance/r2/step', async (c) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const body = await readJsonObject(c);
    const prefix = String(body.prefix ?? '') as R2Prefix;
    if (!R2_PREFIXES.includes(prefix)) throw new AppError(Code.VALIDATION_ERROR, t('admin.maintTaskInvalid'));
    const raw = await cache.get<R2State>(r2StateKey(prefix));
    if (!raw) throw new AppError(Code.VALIDATION_ERROR, t('admin.maintNeedScan'));
    const state = normalizeState(raw);

    const bucket = filesBucket(c.env);
    // 绑定到 bucket，保证真实 R2Bucket 的 list 方法拿到正确 this
    const list = bucket.list ? bucket.list.bind(bucket) : undefined;
    if (typeof list !== 'function') throw new AppError(Code.VALIDATION_ERROR, t('admin.maintR2Unavailable'));

    if (state.mode === 'scan') {
      const pages = Math.min(R2_SCAN_PAGES, Math.max(1, intParam(String(body.pages ?? ''), 1)));
      for (let i = 0; i < pages && !state.done; i++) {
        const page = await list({ prefix: `${prefix}/`, cursor: state.cursor || undefined, limit: R2_PAGE });
        const keys = page.objects.map((o) => String(o.key));
        state.scanned += keys.length;
        const young: string[] = [];
        const judged: { key: string; uploaded?: Date | string }[] = [];
        for (const o of page.objects) {
          if (tooYoung(o.uploaded, state.minAgeHours)) young.push(String(o.key));
          else judged.push({ key: String(o.key), uploaded: o.uploaded });
        }
        state.skipped += young.length;
        const verdict = await judgePage(db, prefix, judged.map((x) => x.key));
        if (!verdict) {
          state.skipped += judged.length;
        } else {
          state.hits += verdict.unused.length;
          state.kept += verdict.used;
        }
        advanceCursor(state, page.truncated, page.cursor);
      }
    } else if (state.pending.length) {
      const batch = state.bulk ? state.deleteBatch : R2_DELETE_SAFE_BATCH;
      const take = state.pending.slice(0, batch);

      if (state.bulk) {
        // 批量：一次调用删多个 key（1 次 R2 操作，而不是 N 次）
        if (await deleteObjects(bucket, take)) {
          state.pending.splice(0, take.length);
          state.deleted += take.length;
        } else {
          // 批量不可用（绑定不支持数组 / 运行时报错）→ 持久化降级，下一轮改逐 key。
          // 本轮不强删：避免在未知失败原因下继续消耗子请求预算。
          state.bulk = false;
          state.deleteBatch = R2_DELETE_SAFE_BATCH;
        }
      } else {
        // 逐 key（保守档）：1 key = 1 子请求，故每轮最多 20 个
        let okCount = 0;
        for (const key of take) {
          try {
            await bucket.delete(key);
            state.pending.shift();
            okCount++;
          } catch {
            /* 单对象失败不影响后续；未删的 key 留在 pending，下次继续 */
            break;
          }
        }
        state.deleted += okCount;
      }
    } else if (!state.done) {
      // 删除模式每轮只取一页：判定出待删集合后立刻开始删，绝不越过未删对象推进游标
      const page = await list({ prefix: `${prefix}/`, cursor: state.cursor || undefined, limit: R2_PAGE });
      state.scanned += page.objects.length;
      const judged: string[] = [];
      for (const o of page.objects) {
        if (tooYoung(o.uploaded, state.minAgeHours)) state.skipped++;
        else judged.push(String(o.key));
      }
      const verdict = await judgePage(db, prefix, judged);
      if (!verdict) state.skipped += judged.length;
      else {
        state.hits += verdict.unused.length;
        state.kept += verdict.used;
        state.pending = verdict.unused.slice();
      }
      advanceCursor(state, page.truncated, page.cursor);
    }

    state.updated = now();
    await cache.set(r2StateKey(prefix), state, R2_STATE_TTL);
    return ok(c, t('common.saved'), { data: { state, budget: budgetOf(db) } });
  });

  app.post('/api/admin/maintenance/r2/reset', async (c) => {
    const { cache } = core(c);
    const t = c.get('t');
    const body = await readJsonObject(c);
    const prefix = String(body.prefix ?? '') as R2Prefix;
    if (!R2_PREFIXES.includes(prefix)) throw new AppError(Code.VALIDATION_ERROR, t('admin.maintTaskInvalid'));
    await cache.del(r2StateKey(prefix));
    return ok(c, t('common.saved'), { data: { prefix, reset: true } });
  });

  return app;
}

/** bbs_queue 行数（「立即执行 queue GC」的受影响数；表通常很小，COUNT 成本可忽略） */
async function probeQueue(db: D1b): Promise<number> {
  const row = await db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_queue WHERE expiry > 0 AND expiry < ?').bind(now()).first<{ c: number }>();
  return Number(row?.c ?? 0);
}

/** 预算实测（本请求真实累计，与 runtime 面板同口径） */
function budgetOf(db: D1b): Record<string, number> {
  const s = db.stats;
  return {
    d1_queries: s.d1Queries,
    subrequests: s.subrequests,
    rows_read_estimate: s.rowsReadEstimate,
    cpu_ms_estimate: Number(s.cpuMsEstimate.toFixed(2)),
    limits_hard_d1_queries: BUDGET.HARD_D1_QUERIES,
    limits_ci_d1_queries_max: BUDGET.CI_D1_QUERIES_MAX,
    limits_ci_subrequests_max: BUDGET.CI_SUBREQUESTS_MAX,
  };
}
