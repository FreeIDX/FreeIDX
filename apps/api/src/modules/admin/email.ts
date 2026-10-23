/**
 * 邮箱设置后台接口：SMTP 账号池（§11.3，§19 决策 4）。
 * 整池提交落 kv：
 *   - `ext:email:config{pool:[{from,host,port,user,dailyLimit}]}`（明文，走三层缓存）
 *   - `ext:email:secret{passes:[]}`（AES-GCM 按池下标对应，永不回显）
 *   GET /api/admin/email-setting   池回显（hasPass 标记，密码不出库）
 *   PUT /api/admin/email-setting   整池提交
 * 挂载于 adminGuard 之后（app.use('/api/admin/*') 已先注册）。
 *
 * 密码「留空保持」按账号身份（host+user）而不是下标匹配：后台删掉中间一行或调整顺序后，
 * 按下标会让 A 账号的授权码被写到 B 账号上（保存看似成功、发信全部 535），且无从排查。
 */
import { Hono, type Context } from 'hono';
import { Code } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { loadExtConfig, loadExtSecret, saveExtConfig, saveExtConfigAndSecret } from '../../core/ext-store';
import { getEmailSettingState } from '../../core/email';
import { isEmail } from '../../core/auth/validate';
import type { ApiT } from '../../core/i18n';
import { core, readJsonObject, type ReadEnv } from '../shared';

type Ctx = Context<ReadEnv>;

/** 账号身份键：同一 SMTP 主机 + 登录名 = 同一套凭证（与每日计数口径一致） */
const identOf = (host: string, user: string): string => `${host.toLowerCase()}|${user.toLowerCase()}`;

/** 校验单行池配置，返回规范化后的明文字段；密码单独处理（按身份保持） */
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
  // 发件地址会原样拼进 `MAIL FROM:` 命令与 `From:` 头：必须用严格邮箱正则，
  // 否则含 CRLF 的值可注入额外 SMTP 命令/邮件头（后台表单也不能留这个口子）。
  if (!from || isEmail(from, t) !== null) throw new AppError(Code.VALIDATION_ERROR, t('admin.emailRowFrom', { row: idx + 1 }));
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

    // 既有密码按账号身份（host+user）对应：整池重写时行可删可增可重排，
    // 密码行「留空保持、填了覆盖」；身份变化（换了 SMTP 主机/登录名）必须重填。
    const master = c.env.SECRETS_MASTER_KEY;
    const [oldCfg, oldSec] = await Promise.all([
      loadExtConfig(cache, db, 'email'),
      master ? loadExtSecret(db, 'email', master) : Promise.resolve({} as Record<string, unknown>),
    ]);
    const oldPool = Array.isArray(oldCfg.pool) ? (oldCfg.pool as Record<string, unknown>[]) : [];
    const oldPasses = Array.isArray(oldSec.passes) ? oldSec.passes : [];
    // 同键多行（同一主机+账号配两次）按出现顺序各消费一次，避免两行抢同一份密码
    const held = oldPool
      .map((r, i) => ({
        key: identOf(String(r?.host ?? '').trim(), String(r?.user ?? '').trim()),
        pass: String(oldPasses[i] ?? ''),
        used: false,
      }))
      .filter((h) => h.key !== '|' && h.pass !== '');

    const rows: { from: string; host: string; port: number; user: string; dailyLimit: number }[] = [];
    const passes: string[] = [];
    rawPool.forEach((raw, idx) => {
      const row = validateRow(raw, idx, t);
      let pass = row.pass;
      if (!pass) {
        const hit = held.find((h) => !h.used && h.key === identOf(row.host, row.user));
        if (hit) {
          hit.used = true;
          pass = hit.pass;
        }
      }
      if (!pass) throw new AppError(Code.VALIDATION_ERROR, t('admin.emailRowPass', { row: idx + 1 }));
      if (row.pass && !master) throw new AppError(Code.VALIDATION_ERROR, t('admin.masterKeyMissingPw'));
      rows.push({ from: row.from, host: row.host, port: row.port, user: row.user, dailyLimit: row.dailyLimit });
      passes.push(pass);
    });

    // 池与密码单事务提交（两者按下标对齐，分两次写中间失败会留下错配）
    if (master) await saveExtConfigAndSecret(db, cache, 'email', { pool: rows }, { passes }, master);
    else await saveExtConfig(db, cache, 'email', { pool: rows });

    return ok(c, t('admin.emailSaved'), { data: await getEmailSettingState(c.env, db, cache) });
  });

  return app;
}
