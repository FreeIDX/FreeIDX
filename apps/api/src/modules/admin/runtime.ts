/**
 * 版务日志面板 + 运行时统计面板（T3-7，§14.4 / §14.8）：
 *   GET  /api/admin/runtime      统计面板：全站/今日计数 + 在线数 + 管理组 + 用户分布 + 服务器信息 + 三预算实测（子请求/D1 查询/rows_read/CPU）上墙
 *   GET  /api/admin/modlogs      modlog 分页（?uid 过滤，logid 倒序），供版务审计回溯
 *   POST /api/admin/cache/clear  一键失效三层缓存核心键（forumlist/grouplist/setting/runtime）
 * runtime 面板是 §14.8 度量落点：budget 段直读 D1b 请求内计数器（本请求真实累计），DoD = 面板数值与 D1 实测一致。
 * 后台首页的 4 个小盒 + 2 个 info-box +
 * 管理组表 + 用户分布环形图 + 服务器信息卡一次给齐：不做「每组一条 COUNT + 一条 find」（≈20 条查询），
 * 免费层 50 条/invocation 下必须压成「一条标量聚合 + 一条 GROUP BY + 一条 top-N」，口径与取舍见各段注释。
 * 全部路由挂在 adminGuard 之后。
 */
import { Hono } from 'hono';
import { Code } from '@freeidx/shared';
import { ok } from '../../middleware/envelope';
import { BUDGET } from '../../core/db/budget';
import { loadGrouplist, reqIp } from '../../core/loaders';
import { core, intParam, totalPageOf, type ReadEnv } from '../shared';

const now = () => Math.floor(Date.now() / 1000);
/** 在线窗口：与 §11.1 Cron 每 5min 刷新节奏对齐 */
const ONLINE_WINDOW = 300;
/** 管理组表口径（gid <= 7 && gid > 0）：gid 上限 + 每组展示会员数（6 人） */
const MANAGE_GROUP_MAX_GID = 7;
const GROUP_TOP_USERS = 6;
/**
 * 今日口径：UTC 日界（`Math.floor(t/86400)*86400`），与 auth 验证码日上限、积分 dayNo 同源。
 * workerd 恒 UTC 无服务端时区零点语义；
 * threads/posts 另走 forum.todaythreads/todayposts 存量列（cronDaily 每日清零，§11.1），
 * users 无对应存量列 → 只能按 create_date 现算。
 */
const dayStartOf = (t: number): number => Math.floor(t / 86400) * 86400;

/** 管理组表行 / 用户分布环形图扇区（gid>100 的普通组 users 恒为空，图表只取 name+人数） */
interface RuntimeGroupRow {
  gid: number;
  name: string;
  count: number;
  users: { uid: number; username: string; avatar: number }[];
}

export function adminRuntimeRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  app.get('/api/admin/modlogs', async (c) => {
    const { db } = core(c);
    const uid = intParam(c.req.query('uid'));
    const page = Math.max(1, intParam(c.req.query('page'), 1));
    const size = Math.min(100, Math.max(1, intParam(c.req.query('size'), 20)));
    const where = uid > 0 ? ' WHERE uid = ?' : '';
    const params = uid > 0 ? [uid] : [];

    const cnt = await db.prepare<{ c: number }>(`SELECT COUNT(*) AS c FROM bbs_modlog${where}`).bind(...params).first<{ c: number }>();
    const total = Number(cnt?.c ?? 0);
    const list = await db
      .prepare<Record<string, unknown>>(
        `SELECT logid,uid,tid,pid,subject,comment,action,create_date FROM bbs_modlog${where} ORDER BY logid DESC LIMIT ? OFFSET ?`,
      )
      .bind(...params, size, (page - 1) * size)
      .all();
    return ok(c, 'ok', { data: { total, page, size, totalPage: totalPageOf(total, size), list: list.results } });
  });

  app.get('/api/admin/runtime', async (c) => {
    const { db, cache } = core(c);
    const t = now();
    const [totals, today, online, runtimeCache, panel, gidCounts, topUsers, grouplist] = await Promise.all([
      db
        .prepare<{ users: number | null; threads: number | null; posts: number | null }>(
          'SELECT (SELECT COUNT(*) FROM bbs_user) AS users, (SELECT COUNT(*) FROM bbs_thread) AS threads, (SELECT COUNT(*) FROM bbs_post) AS posts',
        )
        .first<{ users: number | null; threads: number | null; posts: number | null }>(),
      db
        .prepare<{ todaythreads: number | null; todayposts: number | null }>(
          'SELECT SUM(todaythreads) AS todaythreads, SUM(todayposts) AS todayposts FROM bbs_forum',
        )
        .first<{ todaythreads: number | null; todayposts: number | null }>(),
      db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_session WHERE last_date > ?').bind(t - ONLINE_WINDOW).first<{ c: number }>(),
      cache.get<Record<string, number>>('runtime'),
      // 三个纯标量值合并成 1 条语句（同 totals 的写法）：D1 按语句计额度，拆开就是白送 1 条查询。
      // 注：不查 sqlite_version()——D1 明确禁用该函数（本地 miniflare 与远端都报
      //   "not authorized to use function: sqlite_version"），版本改由前端常量给。
      db
        .prepare<{ attachs: number | null; todayusers: number | null }>(
          'SELECT (SELECT COUNT(*) FROM bbs_attach) AS attachs, (SELECT COUNT(*) FROM bbs_user WHERE create_date >= ?) AS todayusers',
        )
        .bind(dayStartOf(t))
        .first<{ attachs: number | null; todayusers: number | null }>(),
      // 用户分布 + 管理组人数：一条 GROUP BY 覆盖所有 gid，内存分桶（免逐组 COUNT，13 组 = 13 条查询）
      db.prepare<{ gid: number; c: number }>('SELECT gid, COUNT(*) AS c FROM bbs_user GROUP BY gid').all(),
      // 管理组 top 会员：一条取回 gid 1..7 的最近 42 条（7 组 × 6 人），再按 gid 各截前 6。
      // 取舍：极端偏态（如 gid 7 近期批量注册）会挤占 LIMIT 42 使靠后的组取不满 6 人——
      // 逐组一条 find 不会漏，但那是 7 条查询；后台首页展示位可接受此近似。
      db
        .prepare<{ uid: number; username: string; avatar: number; gid: number }>(
          'SELECT uid,username,avatar,gid FROM bbs_user WHERE gid BETWEEN 1 AND ? ORDER BY uid DESC LIMIT ?',
        )
        .bind(MANAGE_GROUP_MAX_GID, MANAGE_GROUP_MAX_GID * GROUP_TOP_USERS)
        .all(),
      // 组名/组序复用 grouplist 读穿缓存（L1，命中零 D1）——不再另发一次 bbs_group 查询
      loadGrouplist(cache, db),
    ]);
    const stats = db.stats;

    const countByGid = new Map<number, number>();
    for (const r of gidCounts.results) countByGid.set(Number(r.gid), Number(r.c));
    const usersByGid = new Map<number, RuntimeGroupRow['users']>();
    for (const r of topUsers.results) {
      const gid = Number(r.gid);
      const list = usersByGid.get(gid) ?? [];
      if (list.length < GROUP_TOP_USERS) {
        list.push({ uid: Number(r.uid), username: String(r.username), avatar: Number(r.avatar) });
        usersByGid.set(gid, list);
      }
    }

    // 收录范围：管理组表 gid∈(0,7]，环形图 gid>100（普通等级组）
    const groups: RuntimeGroupRow[] = [];
    for (const g of Object.values(grouplist)) {
      const gid = Number(g.gid);
      const manage = gid > 0 && gid <= MANAGE_GROUP_MAX_GID;
      if (!manage && gid <= 100) continue;
      groups.push({ gid, name: String(g.name ?? ''), count: countByGid.get(gid) ?? 0, users: manage ? (usersByGid.get(gid) ?? []) : [] });
    }
    groups.sort((a, b) => a.gid - b.gid);

    return ok(c, 'ok', {
      data: {
        totals: {
          users: Number(totals?.users ?? 0),
          threads: Number(totals?.threads ?? 0),
          posts: Number(totals?.posts ?? 0),
          attachs: Number(panel?.attachs ?? 0),
        },
        today: {
          threads: Number(today?.todaythreads ?? 0),
          posts: Number(today?.todayposts ?? 0),
          users: Number(panel?.todayusers ?? 0),
        },
        online: Number(online?.c ?? 0),
        online_window: ONLINE_WINDOW,
        runtime_cache: runtimeCache ?? {},
        groups,
        server: {
          // D1 禁 sqlite_version()，只标注引擎，不编造版本号
          client_ip: reqIp(c),
        },
        // 三预算实测（本请求 D1b 计数器真实累计，§14.8 落点）
        budget: {
          d1_queries: stats.d1Queries,
          subrequests: stats.subrequests,
          rows_read_estimate: stats.rowsReadEstimate,
          cpu_ms_estimate: Number(stats.cpuMsEstimate.toFixed(2)),
          limits: {
            hard_d1_queries: BUDGET.HARD_D1_QUERIES,
            ci_d1_queries_max: BUDGET.CI_D1_QUERIES_MAX,
            ci_subrequests_max: BUDGET.CI_SUBREQUESTS_MAX,
            ci_cpu_ms_max: BUDGET.CI_CPU_MS_MAX,
            ci_rows_read_max: BUDGET.CI_ROWS_READ_MAX,
          },
        },
      },
    });
  });

  app.post('/api/admin/cache/clear', async (c) => {
    const { cache } = core(c);
    const t = c.get('t');
    for (const key of ['forumlist', 'grouplist', 'setting', 'runtime']) {
      await cache.del(key);
    }
    return ok(c, t('admin.cacheCleared'), { data: { cleared: Code.OK } });
  });

  return app;
}
