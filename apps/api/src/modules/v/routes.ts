/**
 * 加V认证接口：
 *  GET  /api/me/v   申请页数据：当前头衔 + 最近一次申请 + 收费参数
 *  POST /api/me/v   提交/重新提交申请：校验 → 落申请 → 扣费 → 头衔置 0 重审
 *
 * 原子性口径（项目增强，同 credits 模块）：D1 batch 单事务 + 随机 nonce 锚定列——申请行由
 * 「INSERT...SELECT FROM bbs_user WHERE 余额>=count」产出（余额不足时锚行不产生），扣费/
 * 置 0 语句以 EXISTS(... nonce=?) 守卫，整批无副作用（等价先查余额后写）。
 * credits(经验) 扣费同批补 bbs_point_log（铁律 §15.1）；golds/rmbs 无账本表。
 * 收费参数存 ext config `idx_verify`（{type:'golds',count:1}）。
 */
import { Hono, type Context } from 'hono';
import { Code } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import type { D1b, Stmt } from '../../core/db';
import { loadViewer } from '../../core/loaders';
import { loadExtConfig } from '../../core/ext-store';
import { creditTypeCol, creditTypeLabel } from '../../core/points';
import { core, readJson, type ReadEnv } from '../shared';

type Ctx = Context<ReadEnv>;
const now = () => Math.floor(Date.now() / 1000);

export const V_EXT_ID = 'idx_verify';

/** 收费参数（type=币种列名 count=单次费用） */
interface VFee {
  type: 'credits' | 'golds' | 'rmbs';
  count: number;
}

export async function loadVFee(db: D1b, cache: import('../../core/cache').Cache): Promise<VFee> {
  const cfg = await loadExtConfig(cache, db, V_EXT_ID);
  const type = cfg.type === 'credits' || cfg.type === 'rmbs' ? cfg.type : 'golds';
  const count = Number(cfg.count);
  return { type, count: Number.isInteger(count) && count > 0 ? count : 0 };
}

const nonceOf = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

interface VApplyRow {
  uid: number;
  create_time: number;
  v: string;
  v_info: string;
  v_file: string;
  status: number;
  remark: string;
}

/* ------------------------------------------------------------------ *
 * GET /api/me/v —— 申请页回显
 * ------------------------------------------------------------------ */
async function myV(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const { db, cache } = core(c);
  const v = await loadViewer(cache, db, c);
  if (v.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));

  const [user, apply, fee] = await Promise.all([
    db.prepare<{ v: string }>('SELECT v FROM bbs_user WHERE uid = ?').bind(v.uid).first<{ v: string }>(),
    db.prepare<VApplyRow>('SELECT uid,create_time,v,v_info,v_file,status,remark FROM bbs_v_apply WHERE uid = ?').bind(v.uid).first<VApplyRow>(),
    loadVFee(db, cache),
  ]);

  return ok(c, 'ok', {
    data: {
      v: String(user?.v ?? '0'),
      apply: apply
        ? {
            v: String(apply.v ?? ''),
            vInfo: String(apply.v_info ?? ''),
            vFile: String(apply.v_file ?? ''),
            status: Number(apply.status),
            remark: String(apply.remark ?? ''),
            createTime: Number(apply.create_time),
          }
        : null,
      fee,
    },
  });
}

/* ------------------------------------------------------------------ *
 * POST /api/me/v —— 提交/重新提交申请
 * ------------------------------------------------------------------ */
async function applyV(c: Ctx): Promise<Response> {
  const t = c.get('t');
  const core0 = core(c);
  const { db, cache } = core0;
  const viewer = await loadViewer(cache, db, c);
  if (viewer.uid <= 0) throw new AppError(Code.NOT_LOGIN, t('common.pleaseLogin'));
  const body = await readJson<{ v?: string; vInfo?: string; vFile?: string }>(c);

  // 长度上限：vTitle 与管理端手动设置 slice(0,200) 同口径（pass 时原样写入 bbs_user.v 随全站接口下发）；
  // vInfo/vFile 为证明文本与附件 key，超长截断，防超大 payload 直入审核链路与列表下发。
  const vTitle = String(body.v ?? '').trim().slice(0, 200);
  const vInfo = String(body.vInfo ?? '').trim().slice(0, 1000);
  const vFile = String(body.vFile ?? '').trim().slice(0, 500);
  if (!vTitle) throw new AppError(Code.VALIDATION_ERROR, t('v.titleRequired'));
  if (!vInfo) throw new AppError(Code.VALIDATION_ERROR, t('v.infoRequired'));
  if (!vFile) throw new AppError(Code.VALIDATION_ERROR, t('v.fileRequired'));

  const fee = await loadVFee(db, cache);
  const col = creditTypeCol(fee.type === 'credits' ? 1 : fee.type === 'golds' ? 2 : 3)!;
  const charge = fee.count > 0;
  const ts = now();
  const nonce = nonceOf();

  // ① 申请行：免费时直插；收费时 SELECT...WHERE 余额>=count（余额不足 → 0 行插入）
  const upsert = charge
    ? `INSERT INTO bbs_v_apply (uid,create_time,v,v_info,v_file,status,nonce)
       SELECT ?,?,?,?,?,0,? FROM bbs_user WHERE uid = ? AND ${col} >= ?
       ON CONFLICT(uid) DO UPDATE SET create_time=excluded.create_time, v=excluded.v, v_info=excluded.v_info,
         v_file=excluded.v_file, status=0, nonce=excluded.nonce
       WHERE EXISTS (SELECT 1 FROM bbs_user WHERE uid = ? AND ${col} >= ?)`
    : `INSERT INTO bbs_v_apply (uid,create_time,v,v_info,v_file,status,nonce)
       VALUES (?,?,?,?,?,0,?)
       ON CONFLICT(uid) DO UPDATE SET create_time=excluded.create_time, v=excluded.v, v_info=excluded.v_info,
         v_file=excluded.v_file, status=0, nonce=excluded.nonce`;

  const stmts: Stmt[] = [
    db
      .prepare(upsert)
      .bind(...(charge ? [viewer.uid, ts, vTitle, vInfo, vFile, nonce, viewer.uid, fee.count, viewer.uid, fee.count] : [viewer.uid, ts, vTitle, vInfo, vFile, nonce])) as unknown as Stmt,
  ];

  if (charge) {
    const anchor = 'EXISTS (SELECT 1 FROM bbs_v_apply WHERE uid = ? AND nonce = ?)';
    // ② 扣费（nonce 锚定本请求的申请行；①未产出锚行时本句 changes=0 无副作用）
    stmts.push(
      db.prepare(`UPDATE bbs_user SET ${col} = ${col} - ? WHERE uid = ? AND ${anchor}`).bind(fee.count, viewer.uid, viewer.uid, nonce) as unknown as Stmt,
    );
    if (col === 'credits') {
      stmts.push(
        db
          .prepare(
            `INSERT INTO bbs_point_log (uid,change,balance,reason,biz_key,create_date)
             SELECT uid,?,credits,'v_apply',?,? FROM bbs_user WHERE uid = ? AND ${anchor}`,
          )
          .bind(-fee.count, `vapply:${viewer.uid}:${ts}`, ts, viewer.uid, viewer.uid, nonce) as unknown as Stmt,
      );
    }
  }
  // ③ 头衔置 0：重新提交即重新审核，旧头衔即时摘除
  stmts.push(
    db
      .prepare(`UPDATE bbs_user SET v = '0' WHERE uid = ? AND EXISTS (SELECT 1 FROM bbs_v_apply WHERE uid = ? AND nonce = ?)`)
      .bind(viewer.uid, viewer.uid, nonce) as unknown as Stmt,
  );

  const results = (await db.batch(stmts)) as unknown as { meta?: { changes?: number } }[];
  if (charge && Number(results[0]?.meta?.changes ?? 0) <= 0) {
    throw new AppError(Code.FORM_INSUFFICIENT_CREDITS, t('v.insufficientFee', { credit: creditTypeLabel(t, fee.type === 'credits' ? 1 : fee.type === 'golds' ? 2 : 3) }), {
      price: fee.count,
      creditType: fee.type === 'credits' ? 1 : fee.type === 'golds' ? 2 : 3,
    });
  }
  return ok(c, t('v.submitted'), { data: { applied: true } });
}

export function vRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();
  app.get('/api/me/v', myV);
  app.post('/api/me/v', applyV);
  return app;
}
