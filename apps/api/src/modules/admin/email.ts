/**
 * 邮箱设置后台接口：SMTP 账号池（§11.3，§19 决策 4）。
 * 整池提交落 kv：
 *   - `ext:email:config{pool:[{from,host,port,user,dailyLimit}]}`（明文，走三层缓存）
 *   - `ext:email:secret{passes:[]}`（AES-GCM 按池下标对应，永不回显；留空即保持该行原密码）
 *   GET /api/admin/email-setting   池回显（hasPass 标记，密码不出库）
 *   PUT /api/admin/email-setting   整池提交
 * 挂载于 adminGuard 之后（app.use('/api/admin/*') 已先注册）。
 */
import { Hono, type Context } from 'hono';
import { Code } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { loadExtSecret, saveExtConfig, saveExtSecret } from '../../core/ext-store';
import { getEmailSettingState } from '../../core/email';
import type { ApiT } from '../../core/i18n';
import { core, readJsonObject, type ReadEnv } from '../shared';

type Ctx = Context<ReadEnv>;

/** 校验单行池配置，返回规范化后的明文字段；密码单独处理（增量保持） */
function validateRow(raw: unknown, idx: number, t: ApiT): {
  from: string;
  host: string;
  port: number;
  user: string;
  dailyLimit: number;
  pass: string;
} {
  const r = (raw ?? {}) as Record<string, unknown>;
  const from = String(r.from ?? '').trim();
  const host = String(r.host ?? '').trim();
  const port = Math.floor(Number(r.port ?? 0));
  const user = String(r.user ?? '').trim();
  const dailyLimit = Math.floor(Number(r.dailyLimit ?? 0));
  const pass = String(r.pass ?? '').trim();
  if (!from || !from.includes('@')) throw new AppError(Code.VALIDATION_ERROR, t('admin.emailRowFrom', { row: idx + 1 }));
  if (!host) throw new AppError(Code.VALIDATION_ERROR, t('admin.emailRowHost', { row: idx + 1 }));
  if (!(port > 0 && port <= 65535)) throw new AppError(Code.VALIDATION_ERROR, t('admin.emailRowPort', { row: idx + 1 }));
  if (!user) throw new AppError(Code.VALIDATION_ERROR, t('admin.emailRowUser', { row: idx + 1 }));
  if (!(dailyLimit >= 0 && dailyLimit <= 100000)) throw new AppError(Code.VALIDATION_ERROR, t('admin.emailRowLimit', { row: idx + 1 }));
  return { from, host, port, user, dailyLimit, pass };
}

export function adminEmailRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  app.get('/api/admin/email-setting', async (c) => {
    const { db, cache } = core(c);
    return ok(c, 'ok', { data: await getEmailSettingState(c.env, db, cache) });
  });

  app.put('/api/admin/email-setting', async (c: Ctx) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const body = await readJsonObject(c);
    const rawPool = 'pool' in body ? body.pool : undefined;
    if (!Array.isArray(rawPool)) throw new AppError(Code.VALIDATION_ERROR, t('admin.poolInvalid'));

    // 既有密码按下标对应：整池重写时行可删可增，密码行「留空保持、填了覆盖」；全新行必须给密码
    const master = c.env.SECRETS_MASTER_KEY;
    const oldSec = master ? await loadExtSecret(db, 'email', master) : {};
    const oldPasses = Array.isArray(oldSec.passes) ? oldSec.passes : [];

    const rows: { from: string; host: string; port: number; user: string; dailyLimit: number }[] = [];
    const passes: string[] = [];
    rawPool.forEach((raw, idx) => {
      const row = validateRow(raw, idx, t);
      const pass = row.pass || String(oldPasses[idx] ?? '');
      if (!pass) throw new AppError(Code.VALIDATION_ERROR, t('admin.emailRowPass', { row: idx + 1 }));
      if (row.pass && !master) throw new AppError(Code.VALIDATION_ERROR, t('admin.masterKeyMissingPw'));
      rows.push({ from: row.from, host: row.host, port: row.port, user: row.user, dailyLimit: row.dailyLimit });
      passes.push(pass);
    });

    await saveExtConfig(db, cache, 'email', { pool: rows });
    if (master) await saveExtSecret(db, 'email', { passes }, master);

    return ok(c, t('admin.emailSaved'), { data: await getEmailSettingState(c.env, db, cache) });
  });

  return app;
}
