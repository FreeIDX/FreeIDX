/**
 * HTTP 邮件 API 账号池 EmailProvider（§11.3）。
 *
 * 为什么只有 HTTP 通道：Workers 直连 SMTP 依赖 `cloudflare:sockets` 的出站 TCP，部分出站环境会把
 * 到邮件服务器的连接判为「TCP Loop」直接拒绝（DNS 正常、465/587 都失败，与授权码无关），
 * 只有 443 的 `fetch` 稳定可用。因此发信统一走服务商 REST API，SMTP 客户端与端口/凭证池已整体移除。
 *
 *  - 多账号 **round-robin 轮询**：N 个账号/服务商把每日额度叠加，单账号失败自动顺延下一个。
 *    轮询指针存 D1 kv `ext:email:rr`（单语句自增 RETURNING；竞态下偶发重复选号无害，仅轮转偏移）。
 *  - **每账号每日发送上限**（dailyLimit，0 不限）：达到上限的账号当天轮询自动跳过（顺延下一账号），
 *    当日计数存 D1 kv `ext:email:cnt:{ymd}:{provider}:{from}`（UTC 日切；**发前预约、失败归还**，
 *    条件自增保证并发不超发）；读计数时顺带清理历史日期行。
 *  - **失败语义**：服务商回 4xx/5xx 说明没有受理 → 顺延下一账号；超时/网络中断属「结果未知」→
 *    判失败且**不再换号**，否则同一封信会被第二个账号重发（收件人收到两封）。
 *  - 池配置：kv `ext:email:config{pool:[{provider,from,url,dailyLimit}]}`（明文，三层缓存）
 *    + `ext:email:secret{keys:[]}`（AES-GCM 按下标对应，永不回显）；后台「邮箱设置」整池提交（池与
 *    Key 单事务），零部署生效。历史单通道配置（`http{...}` + `httpKey`）读时自动迁移成单元素池。
 *  - 发送由 auth 路由经 waitUntil 旁路调用（绝不请求内阻塞发信，§D.6）；降级：池为空返回 null，
 *    等价 user_create_email_on=0（bootstrap 以 `setting.mailOn` 把该降级同步给前端）。
 *  - 可观测性：正式发信（验证码/找回密码）与后台测试信都把「逐账号尝试结果」写 kv `ext:email:last`，
 *    后台「邮箱设置」页回显最近一次结果；POST /api/admin/email-setting/test 同步实发一封并回服务商原文。
 *    旁路发信失败对用户不可见（前端一律「已发送」），没有这条链路就无从判断是 Key、发件域名还是限流。
 */
import type { Env } from '../types/env';
import type { Cache } from './cache';
import type { D1b } from './db';
import { loadExtConfig, loadExtSecret } from './ext-store';
import { HTTP_PROVIDERS, HttpSendError, sendViaHttp, type HttpMailConfig, type HttpProvider } from './email-http';
import { t0 } from './i18n';

const EMAIL_EXT_ID = 'email';
/** 轮询指针 kv 行 key（bbs_kv，k 为主键） */
const RR_KEY = 'ext:email:rr';

interface EmailProvider {
  readonly name: string;
  send(to: string, subject: string, text: string): Promise<boolean>;
}

/** 后台「邮箱设置」回显行（Key 永不回显，只回 hasKey；坏行 provider 为 ''，便于管理员看见并修正） */
export interface MailAccountView {
  provider: HttpProvider | '';
  /** 发件地址（需在服务商侧已验证） */
  from: string;
  /** provider=custom 时的接口地址 */
  url: string;
  /** 每日发送上限（0 = 不限）；达到上限的账号当天轮询自动跳过 */
  dailyLimit: number;
  hasKey: boolean;
}

interface MailAccount extends MailAccountView {
  provider: HttpProvider;
  key: string;
}

/**
 * 单账号一次投递尝试的诊断结果。
 * 「用户点了发送验证码却一直收不到」这类问题在旁路发信下完全不可见：发信走 waitUntil，
 * 失败只落 console.error（普通管理员看不到），前台一律回「已发送」。故把每次尝试的原因留下来。
 */
export interface MailAttempt {
  /** 账号标识 http:{provider}:{from}（不含 Key） */
  account: string;
  ok: boolean;
  /** 失败阶段：config / http / rate-limit / timeout / network */
  stage?: string;
  /** 失败原因（含服务商返回的原文行，如 HTTP 403: domain is not verified） */
  error?: string;
}

/** 一次发信报告（成功即止；全部失败则列出每个账号的原因） */
export interface MailReport {
  ok: boolean;
  to: string;
  /** 发起时间（秒） */
  at: number;
  /** true = 后台「测试邮箱」手动触发 */
  test: boolean;
  attempts: MailAttempt[];
}

/** 最近一次发信报告落 bbs_kv（单行覆盖，无历史累积） */
const LAST_KEY = 'ext:email:last';

const str = (v: unknown): string => String(v ?? '').trim();

const isProvider = (v: string): v is HttpProvider => (HTTP_PROVIDERS as readonly string[]).includes(v);

/** 账号标签：http:provider:from（诊断展示用，不含 Key） */
const labelOf = (a: { provider: string; from: string }): string => `http:${a.provider}:${a.from}`;

const cfgOf = (a: MailAccount): HttpMailConfig => ({ provider: a.provider, from: a.from, url: a.url });

/** 记录最近一次发信结果（best-effort：诊断信息绝不能把发信本身搞失败） */
async function recordMailReport(db: D1b, report: MailReport): Promise<void> {
  try {
    await db
      .prepare('REPLACE INTO bbs_kv (k,v,expiry) VALUES (?,?,0)')
      .bind(LAST_KEY, JSON.stringify(report))
      .run();
  } catch (e) {
    console.warn(`[email] record report failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 是否为当前通道写下的报告：账号标签必须是 `http:{provider}:{from}`。
 * 旧 SMTP 版写入的记录（`user@host:port` + connect/TCP Loop）在新面板上没有意义，
 * 且会让「最近一次发信」长期挂着一批与现状无关的失败行，读到即丢弃。
 */
function isCurrentReport(o: MailReport): boolean {
  return o.attempts.every((a) => typeof a?.account === 'string' && a.account.startsWith('http:'));
}

/** 清掉过期的发信报告（旧 SMTP 记录；best-effort） */
async function clearMailReport(db: D1b): Promise<void> {
  try {
    await db.prepare('DELETE FROM bbs_kv WHERE k = ?').bind(LAST_KEY).run();
  } catch (e) {
    console.warn(`[email] clear report failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 读最近一次发信报告（无记录/解析失败/旧 SMTP 记录返回 null，后台按「暂无记录」展示） */
async function readMailReport(db: D1b): Promise<MailReport | null> {
  try {
    const row = await db.prepare<{ v: string }>('SELECT v FROM bbs_kv WHERE k = ?').bind(LAST_KEY).first<{ v: string }>();
    if (!row?.v) return null;
    const o = JSON.parse(row.v) as MailReport;
    if (!o || typeof o !== 'object' || !Array.isArray(o.attempts)) return null;
    if (!isCurrentReport(o)) {
      await clearMailReport(db);
      return null;
    }
    return o;
  } catch {
    return null;
  }
}

const limitOf = (v: unknown): number => Math.max(0, Math.floor(Number(v ?? 0)) || 0);

/**
 * 池的原始数据：config.pool 与 secret.keys **按下标对齐**。
 * 历史版本存的是单通道（config.http + secret.httpKey），读时映射成单元素池，升级不丢已保存的 Key；
 * 更早的 SMTP 行（没有 provider 字段）在这里自然被忽略。
 */
function poolSource(cfg: Record<string, unknown>, sec: Record<string, unknown>): {
  rows: Record<string, unknown>[];
  keys: unknown[];
} {
  const rows = Array.isArray(cfg.pool) ? (cfg.pool as Record<string, unknown>[]) : [];
  const keys = Array.isArray(sec.keys) ? (sec.keys as unknown[]) : [];
  if (rows.some((r) => isProvider(str(r?.provider).toLowerCase()))) return { rows, keys };
  const legacy = (cfg.http ?? {}) as Record<string, unknown>;
  if (isProvider(str(legacy.provider).toLowerCase())) return { rows: [legacy], keys: [sec.httpKey] };
  return { rows: [], keys: [] };
}

/** 回显用：不按「有 Key 才可用」过滤，缺 Key 的行也要照常显示并标 hasKey=false（否则一保存就被整行删掉） */
function toView(raw: Record<string, unknown>, key: unknown): MailAccountView {
  const provider = str(raw?.provider).toLowerCase();
  const url = str(raw?.url);
  return {
    provider: isProvider(provider) ? provider : '',
    from: str(raw?.from),
    url: provider === 'custom' ? url : '',
    dailyLimit: limitOf(raw?.dailyLimit),
    hasKey: str(key) !== '',
  };
}

/** 发信路径：缺 provider/from/Key（或 custom 缺地址）的行不可用，静默剔除 */
function toAccount(raw: Record<string, unknown>, key: unknown): MailAccount | null {
  const provider = str(raw?.provider).toLowerCase();
  const from = str(raw?.from);
  const url = str(raw?.url);
  const k = str(key);
  if (!isProvider(provider) || !from || !k) return null;
  if (provider === 'custom' && !url) return null;
  return { provider, from, url: provider === 'custom' ? url : '', dailyLimit: limitOf(raw?.dailyLimit), hasKey: true, key: k };
}

/** 读取并规范化池：坏行静默剔除（缺 provider/from/Key 即不可用） */
async function readPool(env: Env, db: D1b, cache: Cache): Promise<MailAccount[]> {
  const [cfg, sec] = await Promise.all([loadExtConfig(cache, db, EMAIL_EXT_ID), loadExtSecret(db, EMAIL_EXT_ID, env)]);
  const { rows, keys } = poolSource(cfg, sec);
  return rows.map((r, i) => toAccount(r, keys[i])).filter((a): a is MailAccount => a !== null);
}

/**
 * 后台保存时用：读当前池的原始行与按下标对应的 Key（含历史单通道配置的迁移）。
 * 暴露原始数据是为了「留空保持」按账号身份（provider+from）匹配，而不是按下标 ——
 * 后台删掉中间一行或调整顺序后，按下标会把 A 账号的 Key 写到 B 账号上（保存看似成功、发信全部 401）。
 */
export async function loadPoolRaw(
  env: Env,
  db: D1b,
  cache: Cache,
): Promise<{ rows: Record<string, unknown>[]; keys: unknown[] }> {
  const [cfg, sec] = await Promise.all([loadExtConfig(cache, db, EMAIL_EXT_ID), loadExtSecret(db, EMAIL_EXT_ID, env)]);
  return poolSource(cfg, sec);
}

/** 后台「邮箱设置」页状态：池行回显（Key 只回 hasKey）+ 最近一次发信结果 */
export async function getEmailSettingState(
  env: Env,
  db: D1b,
  cache: Cache,
): Promise<{ pool: MailAccountView[]; last: MailReport | null }> {
  const [cfg, sec] = await Promise.all([loadExtConfig(cache, db, EMAIL_EXT_ID), loadExtSecret(db, EMAIL_EXT_ID, env)]);
  const { rows, keys } = poolSource(cfg, sec);
  return { pool: rows.map((r, i) => toView(r, keys[i])), last: await readMailReport(db) };
}

/** 无可用账号 → null（调用方按 §11.3 降级，而非报错） */
export async function getEmailProvider(env: Env, db: D1b, cache: Cache): Promise<EmailProvider | null> {
  const pool = await readPool(env, db, cache);
  return pool.length ? new HttpPoolProvider(db, pool) : null;
}

/** 轮询指针自增（原子单语句；行不存在则初始化为 1），返回本次应使用的账号下标。
 *  注意：RR_KEY 为代码常量故直接内插字面量——D1 在 ON CONFLICT upsert 中混用 bind 参数会报
 *  "Wrong number of parameter bindings"（平台怪癖，CLI 字面量版验证正常）。 */
async function nextRoundRobin(db: D1b, n: number): Promise<number> {
  if (n <= 1) return 0;
  const r = await db
    .prepare<{ n: number }>(
      `INSERT INTO bbs_kv (k, v) VALUES ('${RR_KEY}', '1')
       ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)
       RETURNING CAST(v AS INTEGER) AS n`,
    )
    .first<{ n: number }>();
  const v = Math.max(1, Number(r?.n ?? 1));
  return (v - 1) % n;
}

/** 当日计数行 key 前缀（bbs_kv） */
const CNT_PREFIX = 'ext:email:cnt:';

/** 当日计数 key：`ext:email:cnt:{ymd}:{provider}:{from}`，UTC 日切（0 点整池计数清零）。
 *  provider+from 是账号身份：同一个发件地址配在两个服务商下是两个独立额度桶，互不影响。
 *  两者来自后台配置且仅用于代码内插字面量（见 D1 upsert bind 怪癖），净化为安全字符集防 SQL 注入。 */
function cntKey(provider: string, from: string): string {
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safe = (v: string) => v.replace(/[^A-Za-z0-9@._+-]/g, '_').slice(0, 64);
  return `${CNT_PREFIX}${ymd}:${safe(provider)}:${safe(from)}`;
}

/**
 * 批量读当日已发送计数（仅存在限额账号时才产生查询，全部不限额 0 查询）；
 * 顺带删除历史日期的计数行（k 按日期前缀有序，`< 今日前缀` 即昨日及更早），防 bbs_kv 无限累积。
 *
 * 计数只是额度保护（best-effort），D1 抖动不能让整封信发不出去：查询失败按空计数继续，
 * 最坏结果只是当天多消耗几个名额；若在这里抛出，`send()` 会整体失败 → 用户收不到任何邮件。
 */
async function readDailyCounts(db: D1b, accounts: MailAccount[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!accounts.some((a) => a.dailyLimit > 0)) return map;
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  try {
    await db.prepare(`DELETE FROM bbs_kv WHERE k LIKE '${CNT_PREFIX}%' AND k < '${CNT_PREFIX}${ymd}'`).run();
    const keys = accounts.filter((a) => a.dailyLimit > 0).map((a) => `'${cntKey(a.provider, a.from)}'`);
    const r = await db.prepare<{ k: string; v: string }>(`SELECT k, v FROM bbs_kv WHERE k IN (${keys.join(',')})`).all();
    for (const row of r.results ?? []) map.set(row.k, Number(row.v) || 0);
  } catch (e) {
    console.warn(`[email] daily count read failed: ${e instanceof Error ? e.message : String(e)}`);
    map.clear();
  }
  return map;
}

/**
 * 预约一个发送名额（race-safe 额度闸）：原子条件自增 `WHERE v < limit`，返回是否抢到。
 *
 * 语义是「发前预约、失败归还」：旧实现「先查后加」在两个 isolate 同时取号时会各自认为
 * 还剩 1 个名额 → 双双发出，日上限被突破。预约失败 = 该账号额度已满，直接跳过换号。
 * 代价是极端情况下（isolate 在请求中途被回收）会漏归还 1 个名额，方向上只会少发、不会超发。
 * 未限额账号（limit=0）不计数。
 */
async function tryReserveDailyCount(db: D1b, provider: string, from: string, limit: number): Promise<boolean> {
  if (!(limit > 0)) return true;
  const r = await db
    .prepare(
      `INSERT INTO bbs_kv (k, v) VALUES ('${cntKey(provider, from)}', '1')
       ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)
       WHERE CAST(v AS INTEGER) < ${Math.floor(limit)}`,
    )
    .run();
  return Number(r.meta?.changes ?? 0) > 0;
}

/** 归还名额（发送失败/未发出时调用；余额不为负） */
async function releaseDailyCount(db: D1b, provider: string, from: string): Promise<void> {
  await db
    .prepare(
      `UPDATE bbs_kv SET v = CAST(CAST(v AS INTEGER) - 1 AS TEXT)
       WHERE k = '${cntKey(provider, from)}' AND CAST(v AS INTEGER) > 0`,
    )
    .run();
}

class HttpPoolProvider implements EmailProvider {
  readonly name = 'http-pool';

  constructor(
    private readonly db: D1b,
    private readonly accounts: MailAccount[],
  ) {}

  /** 从轮询位起依次尝试：超每日限额的账号直接跳过，确定性失败顺延下一个；
   *  全败或全部账号达限额返回 false（上层按投递失败静默，原因落日志与 kv） */
  async send(to: string, subject: string, text: string): Promise<boolean> {
    const n = this.accounts.length;
    // 轮询指针只影响「从哪台开始试」，D1 抖动时退化为固定从 0 开始，不能因此不发信
    const start = await nextRoundRobin(this.db, n).catch((e: unknown) => {
      console.warn(`[email] round-robin failed: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    });
    const used = await readDailyCounts(this.db, this.accounts);
    const attempts: MailAttempt[] = [];
    const at = Math.floor(Date.now() / 1000);
    let overLimit = 0;
    for (let i = 0; i < n; i++) {
      const acct = this.accounts[(start + i) % n]!;
      const limited = acct.dailyLimit > 0;
      // 先按批量读数粗筛（省掉明显发不出去的一次 API 调用），真正的闸门是下面的原子预约
      if (limited && (used.get(cntKey(acct.provider, acct.from)) ?? 0) >= acct.dailyLimit) {
        overLimit++;
        attempts.push({ account: labelOf(acct), ok: false, stage: 'quota', error: t0('email.acctOverLimit', { limit: acct.dailyLimit }) });
        continue;
      }
      if (limited) {
        let reserved = true;
        try {
          reserved = await tryReserveDailyCount(this.db, acct.provider, acct.from, acct.dailyLimit);
        } catch (e) {
          // 计数行读写异常不阻断发信（额度保护是 best-effort）
          console.warn(`[email] daily reserve failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!reserved) {
          overLimit++;
          attempts.push({ account: labelOf(acct), ok: false, stage: 'quota', error: t0('email.acctOverLimit', { limit: acct.dailyLimit }) });
          continue;
        }
      }
      try {
        await sendViaHttp(cfgOf(acct), acct.key, to, subject, text);
      } catch (e) {
        const err =
          e instanceof HttpSendError
            ? e
            : new HttpSendError(e instanceof Error ? e.message : String(e), 'http');
        attempts.push({ account: labelOf(acct), ok: false, stage: err.stage, error: err.message });
        console.error(`[email] ${t0('email.acctSendFailed', { account: labelOf(acct), err: err.message })}`);
        // 服务商拒绝不算消耗额度，归还名额
        if (limited) {
          try {
            await releaseDailyCount(this.db, acct.provider, acct.from);
          } catch (e2) {
            console.warn(`[email] daily release failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
          }
        }
        // 结果未知（超时/网络中断）：请求可能已被受理，换号会把同一封信发第二遍 → 就此判失败
        if (err.ambiguous) {
          await recordMailReport(this.db, { ok: false, to, at, test: false, attempts });
          return false;
        }
        continue;
      }
      attempts.push({ account: labelOf(acct), ok: true });
      await recordMailReport(this.db, { ok: true, to, at, test: false, attempts });
      return true;
    }
    if (overLimit === n) console.error(`[email] ${t0('email.allOverLimit', { n })}`);
    await recordMailReport(this.db, { ok: false, to, at, test: false, attempts });
    return false;
  }
}

/**
 * 后台「测试邮箱」：按**已保存**的池逐个账号实发一封测试信，同步返回每个账号的失败阶段与服务商原文。
 *
 * 与正式发信的差异只有三点，都是为了诊断：
 *  - 同步执行（不用 waitUntil），错误能直接回给管理员，而不是只落日志；
 *  - 不走每日限额（额度闸门会掩盖 Key/域名问题），也不消耗计数；
 *  - 只试前 N 个账号，避免一次点击把整池额度都消耗掉。
 * 顺序固定为池顺序（非轮询），同一个池反复测试的结果可比对。
 */
export async function sendTestMail(
  env: Env,
  db: D1b,
  cache: Cache,
  to: string,
  opts: { site?: string; maxAccounts?: number } = {},
): Promise<MailReport> {
  const [cfg, sec] = await Promise.all([loadExtConfig(cache, db, EMAIL_EXT_ID), loadExtSecret(db, EMAIL_EXT_ID, env)]);
  const { rows, keys } = poolSource(cfg, sec);
  const site = str(opts.site) || 'HTTP';
  const maxAccounts = Math.max(1, Math.floor(opts.maxAccounts ?? 3));
  const attempts: MailAttempt[] = [];

  for (const [i, raw] of rows.entries()) {
    if (attempts.length >= maxAccounts) break;
    const acct = toAccount(raw, keys[i]);
    // 缺字段的行在正式发信里会被 readPool 静默剔除（表现为「一个账号都没发，信凭空消失」），
    // 测试时必须显式报出来，否则管理员只会看到「测试不通过」而不知哪一行坏了。
    if (!acct) {
      const view = toView(raw, keys[i]);
      const missing = [
        !view.provider && 'provider',
        !view.from && 'from',
        view.provider === 'custom' && !view.url && 'url',
        !view.hasKey && 'key',
      ]
        .filter(Boolean)
        .join('/');
      attempts.push({
        account: `${view.provider || '?'}:${view.from || '?'}`,
        ok: false,
        stage: 'config',
        error: t0('email.acctIncomplete', { fields: missing }),
      });
      continue;
    }
    const account = labelOf(acct);
    try {
      await sendViaHttp(
        cfgOf(acct),
        acct.key,
        to,
        t0('email.testSubject', { site }),
        t0('email.testBody', { account, provider: acct.provider }),
      );
      attempts.push({ account, ok: true });
    } catch (e) {
      const err =
        e instanceof HttpSendError ? e : new HttpSendError(e instanceof Error ? e.message : String(e), 'http');
      console.error(`[email] ${t0('email.acctSendFailed', { account, err: err.message })}`);
      attempts.push({ account, ok: false, stage: err.stage, error: err.message });
    }
  }

  const report: MailReport = {
    ok: attempts.some((a) => a.ok),
    to,
    at: Math.floor(Date.now() / 1000),
    test: true,
    attempts,
  };
  await recordMailReport(db, report);
  return report;
}
