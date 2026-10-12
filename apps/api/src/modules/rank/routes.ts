/**
 * 排行榜：
 *  - GET /api/rank/threads?range=all|week  首页右栏「总排行 / 周排行」（主题按浏览量倒序 top N）
 *      all = 全站主题按浏览量倒序（缓存 1 天）；
 *      week = 最近一周创建的主题按 views 倒序（缓存 1 小时）。
 *  - GET /api/rank/users?type=new|active|posts|wealth  首页右栏「新会员 / 活跃榜 / 帖子榜 / 财富榜」（16 人）
 *      new = uid 倒序（缓存 600s）、active = login_date 倒序、posts = posts 倒序、wealth = rmbs 倒序（缓存 1 天）。
 *  - GET /api/rank/list?sort=...&page=  个人中心「排行榜单」（全站用户 5 维分页表，实时查询无缓存）
 *  - GET /api/rank/forum?fid=  版块页「版块热门」（本版块主题按 views 倒序 top 10）
 *  可见性：全部只读公开接口，过滤未过审内容（ok=1）。
 */
import { Hono, type Context } from 'hono';
import { Code } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { Cache } from '../../core/cache';
import { core, type ReadEnv } from '../shared';

type Ctx = Context<ReadEnv>;

/** 主题榜行（列表卡：序号徽章 + 主题链接，仅需 tid/subject） */
interface RankThreadRow {
  tid: number;
  subject: string;
}

/** 用户榜行（头像网格：uid/username/avatar） */
interface RankUserRow {
  uid: number;
  username: string;
  avatar: number;
}

const intQuery = (c: Ctx, key: string, def: number, min: number, max: number): number => {
  const n = Number(c.req.query(key));
  if (!Number.isInteger(n)) return def;
  return Math.min(max, Math.max(min, n));
};

/** 读穿缓存（TTL 独立于 §7 键表：排行榜是只读聚合，未知键默认走 L0+L2） */
async function cached<T>(cache: Cache, key: string, ttl: number, loader: () => Promise<T>): Promise<T> {
  const hit = await cache.get<T>(key);
  if (hit !== null) return hit;
  const v = await loader();
  await cache.set(key, v, ttl);
  return v;
}

export function rankRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  /** 主题榜：all = 全站浏览量倒序（缓存 1 天）；week = 最近一周创建（缓存 1h） */
  app.get('/api/rank/threads', async (c) => {
    const { db, cache } = core(c);
    const range = c.req.query('range') === 'week' ? 'week' : 'all';
    const limit = intQuery(c, 'limit', 10, 1, 20);
    const rows = await cached(cache, `rank:threads:${range}:${limit}`, range === 'all' ? 86400 : 3600, async () => {
      if (range === 'week') {
        const since = Math.floor(Date.now() / 1000) - 7 * 86400;
        return (
          await db
            .prepare<RankThreadRow>('SELECT tid, subject FROM bbs_thread WHERE ok = 1 AND create_date > ? ORDER BY views DESC LIMIT ?')
            .bind(since, limit)
            .all()
        ).results;
      }
      return (
        await db
          .prepare<RankThreadRow>('SELECT tid, subject FROM bbs_thread WHERE ok = 1 ORDER BY views DESC LIMIT ?')
          .bind(limit)
          .all()
      ).results;
    });
    return ok(c, 'ok', { data: { list: rows } });
  });

  /** 用户榜 4 档：new（uid 倒序 600s）/ active（login_date）/ posts / wealth（rmbs）——后三档缓存 1 天 */
  app.get('/api/rank/users', async (c) => {
    const { db, cache } = core(c);
    const type = (['new', 'active', 'posts', 'wealth'] as const).includes(c.req.query('type') as never)
      ? (c.req.query('type') as 'new' | 'active' | 'posts' | 'wealth')
      : 'new';
    const limit = intQuery(c, 'limit', 16, 1, 24);
    const orderCol = { new: 'uid', active: 'login_date', posts: 'posts', wealth: 'rmbs' }[type];
    const ttl = type === 'new' ? 600 : 86400;
    const rows = await cached(cache, `rank:users:${type}:${limit}`, ttl, async () =>
      (
        await db
          .prepare<RankUserRow>(`SELECT uid, username, avatar FROM bbs_user WHERE ok = 1 AND uid > 0 ORDER BY ${orderCol} DESC, uid ASC LIMIT ?`)
          .bind(limit)
          .all()
      ).results,
    );
    return ok(c, 'ok', { data: { list: rows } });
  });

  /** 个人中心「排行榜单」：全站用户 5 维分页表（实时查询无缓存） */
  app.get('/api/rank/list', async (c) => {
    const { db } = core(c);
    const sortMap = { threads: 'threads', posts: 'posts', credits: 'credits', golds: 'golds', rmbs: 'rmbs' } as const;
    const sort = (Object.keys(sortMap) as (keyof typeof sortMap)[]).includes(c.req.query('sort') as never)
      ? (c.req.query('sort') as keyof typeof sortMap)
      : 'threads';
    const page = intQuery(c, 'page', 1, 1, 99999);
    const size = intQuery(c, 'size', 20, 1, 100);
    const offset = (page - 1) * size;
    const cnt = await db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_user WHERE ok = 1 AND uid > 0').first<{ c: number }>();
    const total = Number(cnt?.c ?? 0);
    const list = (
      await db
        .prepare<{ uid: number; username: string; threads: number; posts: number; credits: number; golds: number; rmbs: number }>(
          `SELECT uid, username, threads, posts, credits, golds, rmbs FROM bbs_user
           WHERE ok = 1 AND uid > 0 ORDER BY ${sortMap[sort]} DESC, uid ASC LIMIT ? OFFSET ?`,
        )
        .bind(size, offset)
        .all()
    ).results;
    return ok(c, 'ok', { data: { total, page, size, totalPage: Math.max(1, Math.ceil(total / size)), list } });
  });

  /** 版块热门（版块页右栏）：本版块主题按 views 倒序 top N */
  app.get('/api/rank/forum', async (c) => {
    const t = c.get('t');
    const { db } = core(c);
    const fid = Number(c.req.query('fid'));
    if (!Number.isInteger(fid) || fid <= 0) throw new AppError(Code.VALIDATION_ERROR, t('common.paramError'));
    const limit = intQuery(c, 'limit', 10, 1, 20);
    const rows = (
      await db
        .prepare<RankThreadRow>('SELECT tid, subject FROM bbs_thread WHERE fid = ? AND ok = 1 ORDER BY views DESC LIMIT ?')
        .bind(fid, limit)
        .all()
    ).results;
    return ok(c, 'ok', { data: { list: rows } });
  });

  return app;
}