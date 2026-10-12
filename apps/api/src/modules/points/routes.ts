/**
 * 积分流水接口（T5-1，§15.4）：GET /api/me/points —— 当前余额 + point_log 分页流水（需登录）。
 * 列表走显式投影 + LIMIT/OFFSET（§7 禁 SELECT *）；余额直读 user.credits（账本唯一写入源为 core/points）。
 */
import { Hono, type Context } from 'hono';
import { Code } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { loadViewer } from '../../core/loaders';
import { intParam, totalPageOf, type ReadEnv } from '../shared';

type Ctx = Context<ReadEnv>;

interface PointLogRow {
  id: number;
  change: number;
  balance: number;
  reason: string;
  biz_key: string;
  create_date: number;
}

const PAGE_SIZE = 20;
const PAGE_MAX = 100;

async function myPoints(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const db = c.get('db');
  const cache = c.get('cache');
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));

  const size = Math.min(PAGE_MAX, Math.max(1, intParam(c.req.query('size'), PAGE_SIZE)));
  const page = Math.max(1, intParam(c.req.query('page'), 1));
  const offset = (page - 1) * size;

  const [balanceRow, countRow, list] = await Promise.all([
    db.prepare<{ credits: number }>('SELECT credits FROM bbs_user WHERE uid = ?').bind(v.uid).first<{ credits: number }>(),
    db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_point_log WHERE uid = ?').bind(v.uid).first<{ c: number }>(),
    db
      .prepare<PointLogRow>(
        'SELECT id,change,balance,reason,biz_key,create_date FROM bbs_point_log WHERE uid = ? ORDER BY id DESC LIMIT ? OFFSET ?',
      )
      .bind(v.uid, size, offset)
      .all()
      .then((r) => r.results),
  ]);

  const total = Number(countRow?.c ?? 0);
  return ok(c, 'ok', {
    data: {
      credits: Number(balanceRow?.credits ?? 0),
      total,
      page,
      size,
      total_page: totalPageOf(total, size),
      list: list.map((r) => ({
        id: Number(r.id),
        change: Number(r.change),
        balance: Number(r.balance),
        reason: String(r.reason),
        biz_key: String(r.biz_key),
        create_date: Number(r.create_date),
      })),
    },
  });
}

export function pointsRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();
  app.get('/api/me/points', myPoints);
  return app;
}
