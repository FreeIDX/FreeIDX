/**
 * 邮箱设置后台接口：HTTP 邮件 API 账号池（§11.3）。
 * 整池提交落 kv：
 *   - `ext:email:config{pool:[{provider,from,url,dailyLimit}]}`（明文，走三层缓存）
 *   - `ext:email:secret{keys:[]}`（AES-GCM，按下标对应，永不回显）
 *   GET  /api/admin/email-setting        池回显（hasKey 标记，Key 不出库）+ 最近一次发信结果
 *   PUT  /api/admin/email-setting        整池提交（池与 Key 单事务）
 *   POST /api/admin/email-setting/test   实发一封测试邮件（同步返回逐账号的失败原因）
 * 挂载于 adminGuard 之后（app.use('/api/admin/*') 已先注册）。
 *
 * 只支持 HTTP 通道：部分 Worker 出站环境把到 SMTP 的 TCP 连接判为「TCP Loop」直接拒绝
 * （DNS 正常、465/587 全败，与授权码无关），此时只有 443 的 HTTPS API 能发信。
 * 多账号轮询可把各服务商/各账号的每日额度叠加，单账号失败自动顺延下一个。
 *
 * Key「留空保持」按账号身份（provider+from）而不是下标匹配：后台删掉中间一行或调整顺序后，
 * 按下标会让 A 账号的 Key 被写到 B 账号上（保存看似成功、发信全部 401），且无从排查。
 */
import { Hono, type Context } from 'hono';
import { Code } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { hasSecretsKey, saveExtConfig, saveExtConfigAndSecret } from '../../core/ext-store';
import { getEmailSettingState, loadPoolRaw, sendTestMail } from '../../core/email';
import { HTTP_PROVIDERS, type HttpProvider } from '../../core/email-http';
import { isEmail } from '../../core/auth/validate';
import { loadSetting } from '../../core/loaders';
import type { ApiT } from '../../core/i18n';
import { core, readJsonObject, type ReadEnv } from '../shared';

type Ctx = Context<ReadEnv>;

/** 账号身份键：同一服务商 + 同一发件地址 = 同一套凭证（与每日计数口径一致） */
const identOf = (provider: string, from: string): string => `${provider.toLowerCase()}|${from.toLowerCase()}`;

/** 校验单行池配置，返回规范化后的明文字段；Key 单独处理（按身份保持） */
function validateRow(
  raw: unknown,
  idx: number,
  t: ApiT,
): { provider: HttpProvider; from: string; url: string; dailyLimit: number; key: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const provider = String(r.provider ?? '').trim().toLowerCase();
  if (!(HTTP_PROVIDERS as readonly string[]).includes(provider))
    throw new AppError(Code.VALIDATION_ERROR, t('admin.emailRowProvider', { row: idx + 1 }));
  // 发件地址会原样发给服务商，必须用严格邮箱正则（后台表单也不能留坏值口子）
  const from = String(r.from ?? '').trim();
  const ferr = isEmail(from, t);
  if (!from || ferr) throw new AppError(Code.VALIDATION_ERROR, t('admin.emailRowFrom', { row: idx + 1 }));
  const url = String(r.url ?? '').trim();
  // custom 必须是 https 地址：Worker 到 http:// 的出站既不安全也常被拦，没必要支持
  if (provider === 'custom' && !/^https:\/\/[^\s]+$/i.test(url))
    throw new AppError(Code.VALIDATION_ERROR, t('admin.emailRowUrl', { row: idx + 1 }));
  const dailyLimit = Math.floor(Number(r.dailyLimit ?? 0));
  if (!(dailyLimit >= 0 && dailyLimit <= 100000))
    throw new AppError(Code.VALIDATION_ERROR, t('admin.emailRowLimit', { row: idx + 1 }));
  return { provider: provider as HttpProvider, from, url: provider === 'custom' ? url : '', dailyLimit, key: String(r.key ?? '').trim() };
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

    // 既有 Key 按账号身份（provider+from）对应：整池重写时行可删可增可重排，
    // Key 行「留空保持、填了覆盖」；身份变化（换了服务商/发件地址）必须重填。
    // 主密钥解析：显式 SECRETS_MASTER_KEY 优先，缺省/非法时由 JWT_SECRET 派生（见 core/ext-store.keyCandidates），
    // 于是「只部署不配额外 Secret」也能保存 Key。
    const canEncrypt = await hasSecretsKey(c.env);
    const old = await loadPoolRaw(c.env, db, cache);
    // 同键多行（同一服务商+发件地址配两次）按出现顺序各消费一份 Key，避免两行抢同一个 Key
    const held = old.rows
      .map((r, i) => ({
        key: identOf(String(r?.provider ?? '').trim(), String(r?.from ?? '').trim()),
        val: String(old.keys[i] ?? ''),
        used: false,
      }))
      .filter((h) => h.key !== '|' && h.val !== '');

    const rows: { provider: HttpProvider; from: string; url: string; dailyLimit: number }[] = [];
    const keys: string[] = [];
    rawPool.forEach((raw, idx) => {
      const row = validateRow(raw, idx, t);
      let key = row.key;
      if (!key) {
        const hit = held.find((h) => !h.used && h.key === identOf(row.provider, row.from));
        if (hit) {
          hit.used = true;
          key = hit.val;
        }
      }
      if (!key) throw new AppError(Code.VALIDATION_ERROR, t('admin.emailRowKey', { row: idx + 1 }));
      if (row.key && !canEncrypt) throw new AppError(Code.VALIDATION_ERROR, t('admin.masterKeyMissingKey'));
      rows.push({ provider: row.provider, from: row.from, url: row.url, dailyLimit: row.dailyLimit });
      keys.push(key);
    });

    // 池与 Key 单事务提交（按下标对齐的两份数据，分两次写中间失败会留下错配）；
    // 连 JWT_SECRET 都没有（canEncrypt=false）时只有空池能走到这里，此时不碰加密、只落明文配置
    if (canEncrypt) {
      await saveExtConfigAndSecret(db, cache, 'email', { pool: rows }, { keys }, c.env);
    } else {
      await saveExtConfig(db, cache, 'email', { pool: rows });
    }
    // bootstrap 用 `email:on`（60s 读穿）下发「邮件通道是否可用」，前台据此决定注册表单渲不渲染验证码框；
    // 池刚存好时必须主动失效，否则最长 60s 内前台仍按「无邮件」隐藏整块验证码（保存成功却看不到输入框）。
    await cache.del('email:on');

    return ok(c, t('admin.emailSaved'), { data: await getEmailSettingState(c.env, db, cache) });
  });

  /**
   * 测试发信：给「注册收不到验证码」提供一条可自证的链路。
   *
   * 为什么必须同步：正式发信走 waitUntil + failover，失败只落 console.error，
   * 前台永远回「已发送」，管理员无法区分「Key 无效」「发件域名未验证」「限流」。
   * 这里按已保存的池逐个账号实发（≤3 个），把阶段与服务商原文直接回给管理员。
   *
   * 收件人留空 → 发给池中第一个**合法**发件地址（自己发自己，最少输入）。
   * 失败不抛错误码：报告本身是数据（前端按行展示每个账号的原因），
   * 抛错会让附带的 attempts 只能塞进 error extra，前端反而拿不到。
   */
  app.post('/api/admin/email-setting/test', async (c: Ctx) => {
    const { db, cache } = core(c);
    const t = c.get('t');
    const body = await readJsonObject(c);
    const [state, setting] = await Promise.all([getEmailSettingState(c.env, db, cache), loadSetting(cache, db)]);
    if (!state.pool.length) throw new AppError(Code.VALIDATION_ERROR, t('admin.emailPoolEmpty'));
    // 默认收件人：池中第一个合法发件地址（坏行不参与，否则一按测试就报「邮箱格式不对」而不是真正的发信问题）
    const dflt = state.pool.map((p) => p.from).find((f) => f !== '' && isEmail(f, t) === null) ?? '';
    const to = String(body.to ?? '').trim().toLowerCase() || dflt;
    if (!to) throw new AppError(Code.VALIDATION_ERROR, t('admin.emailPoolEmpty'));
    const ferr = isEmail(to, t);
    if (ferr) throw new AppError(Code.FORM_INVALID_EMAIL, ferr);

    const report = await sendTestMail(c.env, db, cache, to, { site: setting.sitename });
    const first = report.attempts.find((a) => !a.ok);
    const message = report.ok
      ? t('admin.emailTestOk', { to })
      : t('admin.emailTestFail', { err: first?.error ?? '' });
    return ok(c, message, { data: report });
  });

  return app;
}
