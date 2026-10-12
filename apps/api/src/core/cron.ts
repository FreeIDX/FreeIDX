/**
 * Cron Triggers（§11.1）。
 * 每 5min 档：sess_gc(online_hold_time) 清过期 session → online_count 刷新写 runtime.onlines。
 * 每日凌晨档：计数校准（forum/thread/user 计数全量重算）+ today* 清零（缓存 + forum 表）+ forumlist 失效、临时附件 GC（status=0 超 24h，含 R2 对象）、queue GC。
 * Workers 单触发模型下无需跨实例锁去重（每次调度单 invocation），故不实现 cron_lock。
 * online_hold_time 无独立 setting 字段 → 读 kv setting，缺省 300s（与 runtime 面板在线窗口一致）。
 */
import type { Env } from '../types/env';
import { D1b } from './db';
import type { Stmt } from './db';
import { Cache } from './cache';
import { queueGc } from './queue';
import { getExtensions } from './extensions';
import { reconcilePending } from './payment/orchestrator';
import { demoteExpiredVip } from './order';

export const ONLINE_HOLD_TIME_DEFAULT = 300;
const DAY = 86400;
/**
 * 单次 GC 最多处理的临时附件行数。
 * 每删一个对象 = 1 次 R2 调用 = 1 个子请求，免费层单次调用上限 50（BUDGET.CI_SUBREQUESTS_MAX 取 40 留余量），
 * 故批量必须 ≤40：超出部分此前会被逐条 try/catch 静默吞掉，而 D1 行已先删 → R2 孤儿对象永久残留。
 * 配合每小时档执行（40 × 24 = 960/天），并在桶上配 `tmp/` 前缀生命周期规则作为最终兜底。
 */
const ATTACH_GC_BATCH = 40;

interface CronDeps {
  db: D1b;
  cache: Cache;
  files?: { delete?: (key: string) => unknown } | undefined;
  now: number;
  /** 插件 cron 需要（SITE_URL/Secret 主密钥）；内建档不依赖 */
  env?: Env;
}

interface CronFiveMinResult {
  sessExpiry: number;
  onlines: number;
}
interface CronDailyResult {
  forumReset: boolean;
  /** 计数校准后的全站主题/回帖总数（写入 runtime） */
  calibrated: { threads: number; posts: number };
  /** 本次校准实际改写的行数（= 检出漂移量；正常为 0，非 0 说明增量维护出过偏差） */
  driftRows: number;
}

async function onlineHoldTime(db: D1b): Promise<number> {
  const row = await db.prepare<{ v: string }>('SELECT v FROM bbs_kv WHERE k = ?').bind('setting').first<{ v: string }>();
  try {
    const raw = JSON.parse(row?.v ?? '{}') as { online_hold_time?: number };
    const n = Number(raw.online_hold_time);
    return Number.isFinite(n) && n > 0 ? n : ONLINE_HOLD_TIME_DEFAULT;
  } catch {
    return ONLINE_HOLD_TIME_DEFAULT;
  }
}

export async function cronFiveMin(deps: CronDeps): Promise<CronFiveMinResult> {
  const { db, cache, now } = deps;
  const hold = await onlineHoldTime(db);
  const sessExpiry = now - hold;
  // sess_gc：本 schema 无 session_data 表（§D.8），仅清 session
  await db.prepare('DELETE FROM bbs_session WHERE last_date <= ?').bind(sessExpiry).run();
  // 在线数刷新
  const cnt = await db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_session').first<{ c: number }>();
  const onlines = Math.max(1, Number(cnt?.c ?? 0));
  const runtime = (await cache.get<Record<string, number>>('runtime')) ?? {};
  await cache.set('runtime', { ...runtime, onlines });
  return { sessExpiry, onlines };
}

export async function cronDaily(deps: CronDeps): Promise<CronDailyResult> {
  const { db, cache, now } = deps;
  // 计数校准：forum.threads / thread.posts / user.threads|posts 是增量维护的反规范化列，
  // 删除/迁移异常中断会造成漂移；每日重算兜底（后台「计数校准」入口已并入本档）。
  //
  // 每条 UPDATE 都带 `WHERE 现值 <> 重算值`：SQLite 的 UPDATE 按「被更新行数」计 D1 rows_written
  // （值未变也照样计），全量重算在 10 万主题的库上单晚就会写掉 10 万+ 行 —— 直接吃光免费层
  // 「10 万行写/天」，当天发帖/积分/会话落库全部失败。加 WHERE 后写行数 = 检出漂移量（正常为 0），
  // 读仍是索引扫描（bbs_thread_fid_tid / bbs_post_tid_pid / bbs_thread_uid / bbs_post_uid），
  // 与哨兵探测同量级，故不再额外跑探测查询。
  const calibratedRes = await db.batch([
    db.prepare(
      'UPDATE bbs_forum SET threads = (SELECT COUNT(*) FROM bbs_thread WHERE bbs_thread.fid = bbs_forum.fid) WHERE threads <> (SELECT COUNT(*) FROM bbs_thread WHERE bbs_thread.fid = bbs_forum.fid)',
    ) as unknown as Stmt,
    db.prepare(
      'UPDATE bbs_thread SET posts = (SELECT COUNT(*) FROM bbs_post WHERE bbs_post.tid = bbs_thread.tid AND bbs_post.isfirst = 0) WHERE posts <> (SELECT COUNT(*) FROM bbs_post WHERE bbs_post.tid = bbs_thread.tid AND bbs_post.isfirst = 0)',
    ) as unknown as Stmt,
    db.prepare(
      'UPDATE bbs_user SET threads = (SELECT COUNT(*) FROM bbs_thread WHERE bbs_thread.uid = bbs_user.uid) WHERE threads <> (SELECT COUNT(*) FROM bbs_thread WHERE bbs_thread.uid = bbs_user.uid)',
    ) as unknown as Stmt,
    db.prepare(
      'UPDATE bbs_user SET posts = (SELECT COUNT(*) FROM bbs_post WHERE bbs_post.uid = bbs_user.uid AND bbs_post.isfirst = 0) WHERE posts <> (SELECT COUNT(*) FROM bbs_post WHERE bbs_post.uid = bbs_user.uid AND bbs_post.isfirst = 0)',
    ) as unknown as Stmt,
  ]);
  const driftRows = calibratedRes.reduce((n, r) => n + Number((r as D1Result | undefined)?.meta?.changes ?? 0), 0);
  const totals = await db
    .prepare<{ threads: number; posts: number }>(
      'SELECT (SELECT COUNT(*) FROM bbs_thread) AS threads, (SELECT COUNT(*) FROM bbs_post WHERE isfirst = 0) AS posts',
    )
    .first<{ threads: number; posts: number }>();
  const calibrated = { threads: Number(totals?.threads ?? 0), posts: Number(totals?.posts ?? 0) };

  // today* 清零（缓存 + forum 表，单语句批刷）；runtime 一并写回校准后的全站数
  const runtime = (await cache.get<Record<string, number>>('runtime')) ?? {};
  await cache.set('runtime', { ...runtime, todayposts: 0, todaythreads: 0, todayusers: 0, threads: calibrated.threads, posts: calibrated.posts });
  await db.prepare('UPDATE bbs_forum SET todayposts = 0, todaythreads = 0').run();
  await cache.del('forumlist');

  // queue GC
  await queueGc(db, now);

  return { forumReset: true, calibrated, driftRows };
}

/**
 * 临时附件 GC（status=0 且超 24h）：先删 R2 对象、成功后才删 D1 行，由每小时档调用。
 *
 * 顺序刻意如此：对象删除失败时保留 D1 行留待下轮重试；旧实现反序（先删行再逐条尽力删对象），
 * 一旦对象删除失败就再也找不到这个 key → R2 孤儿对象永久残留（且 500 批量必然超出免费层
 * 单次 50 子请求上限，被逐条 try/catch 静默吞掉）。
 * 批量上限与子请求预算对齐；桶上再配 `tmp/` 前缀生命周期规则做最终兜底。
 */
export async function attachGc(deps: CronDeps, now: number, limit = ATTACH_GC_BATCH): Promise<number> {
  const { db, files } = deps;
  const stale = await db
    .prepare<{ aid: number; filename: string }>('SELECT aid,filename FROM bbs_attach WHERE status = 0 AND create_date < ? LIMIT ?')
    .bind(now - DAY, limit)
    .all();
  if (!stale.results.length) return 0;

  const removed: number[] = [];
  for (const r of stale.results) {
    try {
      if (files && typeof files.delete === 'function') await Promise.resolve(files.delete(String(r.filename)));
      removed.push(Number(r.aid));
    } catch {
      /* 尽力而为：对象没删掉就保留行，下轮重试（桶上 tmp/ 生命周期规则兜底） */
    }
  }
  if (!removed.length) return 0;
  const placeholders = removed.map(() => '?').join(',');
  await db.prepare(`DELETE FROM bbs_attach WHERE aid IN (${placeholders})`).bind(...removed).run();
  return removed.length;
}

/** 读取上次水位算出本次推送窗口（只读，不落水位；成功执行后才落，见 dispatchPluginCrons） */
async function cronWindow(db: D1b, name: string, now: number): Promise<number> {
  const row = await db.prepare<{ v: string }>('SELECT v FROM bbs_kv WHERE k = ?').bind(`cron:last:${name}`).first<{ v: string }>();
  const last = Number(row?.v ?? 0);
  return last > 0 && now > last ? now - last : DEFAULT_PUSH_WINDOW;
}

/** 落水位：仅在插件任务成功后调用，失败时下轮仍覆盖同一窗口（避免推送集合被永久跳过） */
async function cronMarkRun(db: D1b, name: string, now: number): Promise<void> {
  await db.prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)').bind(`cron:last:${name}`, String(now)).run();
}

/** 首次推送窗口（无历史水位时向前覆盖的范围，避免全量或空推） */
const DEFAULT_PUSH_WINDOW = 86400;

/**
 * 插件 cron 分发（契约 ④）：装配带 ctx 的运行时，运行 pattern 命中本次触发的插件任务。
 * 单个任务失败隔离（try/catch），不影响内建档与其他任务；私钥等敏感信息不得入日志（由插件侧保证）。
 */
async function dispatchPluginCrons(
  cron: string,
  deps: CronDeps,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<void> {
  const { db, cache } = deps;
  const rt = await getExtensions(cache, db, deps.env);
  for (const c of rt.crons) {
    if (c.pattern !== cron) continue;
    const sinceLastSec = await cronWindow(db, c.name, deps.now);
    try {
      await c.run({ sinceLastSec, now: deps.now, waitUntil });
      await cronMarkRun(db, c.name, deps.now); // 仅成功推进水位，失败下轮重覆盖同一窗口
    } catch (err) {
      console.warn(`[cron:${c.name}] failed:`, err instanceof Error ? err.message : err);
    }
  }
}

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const db = D1b.of(env.DB);
  const cache = new Cache(env, db);
  const deps: CronDeps = { db, cache, files: env.FILES as unknown as CronDeps['files'], now: Math.floor(Date.now() / 1000), env };
  const waitUntil = (p: Promise<unknown>): void => ctx.waitUntil(p);
  switch (controller.cron) {
    case '*/5 * * * *': {
      const r = await cronFiveMin(deps);
      console.log(`[cron:5min] sess_gc<=${r.sessExpiry} onlines=${r.onlines}`);
      break;
    }
    case '0 3 * * *': {
      const r = await cronDaily(deps);
      console.log(
        `[cron:daily] forum_reset=${r.forumReset} calibrated_threads=${r.calibrated.threads} calibrated_posts=${r.calibrated.posts} drift_rows=${r.driftRows}`,
      );
      await dispatchPluginCrons('0 3 * * *', deps, waitUntil);
      break;
    }
    case '0 * * * *': {
      // 掉单对账（§15.3 T5-7）：每小时复核近 24h pending 外部单，命中已付补 markPaid+fulfillOrder；卡密除外。
      // 报告仅计数，不含通道/密钥信息（私钥不入日志）。
      try {
        const r = await reconcilePending({ db, cache }, env, deps.now);
        console.log(`[cron:reconcile] scanned=${r.scanned} recovered=${r.recovered} failed=${r.failed}`);
      } catch (err) {
        console.warn('[cron:reconcile] failed:', err instanceof Error ? err.message : err);
      }
      // 会员到期回落（0005）：过期且仍挂组的会员降回 vip_from_gid 原组并清标记（闭环「到期=出组」）。
      try {
        const rows = await demoteExpiredVip(db, deps.now);
        for (const r of rows) await cache.del(`user:${r.uid}`);
        if (rows.length) console.log(`[cron:vip-fallback] demoted=${rows.length}`);
      } catch (err) {
        console.warn('[cron:vip-fallback] failed:', err instanceof Error ? err.message : err);
      }
      // 临时附件 GC：挪到每小时档（40 × 24 = 960/天），批量≤子请求预算，先删对象再删行。
      try {
        const removed = await attachGc(deps, deps.now);
        if (removed) console.log(`[cron:attach-gc] removed=${removed}`);
      } catch (err) {
        console.warn('[cron:attach-gc] failed:', err instanceof Error ? err.message : err);
      }
      break;
    }
    default:
      console.warn(`[cron] unknown schedule: ${controller.cron}`);
  }
}
