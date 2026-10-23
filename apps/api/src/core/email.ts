/**
 * SMTP 账号池 EmailProvider（§11.3，§19 决策 4 拍板）。
 * Workers 直连 SMTP 实现：
 *  - `cloudflare:sockets` 出站 TCP：25 端口被封，465（隐式 TLS）/587（STARTTLS）可用；非 465/587 按明文（仅限本地假 SMTP 联调）。
 *  - 内置最小 SMTP 客户端：EHLO → STARTTLS? → AUTH（LOGIN / PLAIN，按 EHLO 通告能力选）→ MAIL FROM → RCPT TO → DATA → QUIT。
 *  - 多账号 **round-robin 轮询**（单账号免费额度 → N 倍，数量突破）；当前账号失败自动顺延下一账号（failover）。
 *    轮询指针存 D1 kv 行 `ext:email:rr`（单语句自增 RETURNING；竞态下偶发重复选号无害，仅轮转偏移）。
 *  - **每账号每日发送上限**（dailyLimit，0 不限）：达到上限的账号当天轮询自动跳过（顺延下一账号），
 *    当日计数存 D1 kv `ext:email:cnt:{ymd}:{host}:{user}`（UTC 日切；**发前预约、失败归还**，
 *    条件自增保证并发不超发）；读计数时顺带清理历史日期行。
 *  - 池配置：kv `ext:email:config{pool:[{from,host,port,user,dailyLimit}]}`（明文，三层缓存）+ `ext:email:secret{passes:[]}`
 *    （AES-GCM 按下标对应，永不回显）；后台「邮箱设置」整池提交（池与密码单事务），零部署生效。
 *  - 发送由 auth 路由经 waitUntil 旁路调用（绝不请求内阻塞发信，§D.6）；降级：池为空返回 null，
 *    等价 user_create_email_on=0（bootstrap 以 `setting.mailOn` 把该降级同步给前端）。
 */
import type { Env } from '../types/env';
import type { Cache } from './cache';
import type { D1b } from './db';
import { loadExtConfig, loadExtSecret } from './ext-store';
import { t0 } from './i18n';
import { connect } from 'cloudflare:sockets';

const EMAIL_EXT_ID = 'email';
/** 轮询指针 kv 行 key（bbs_kv，k 为主键） */
const RR_KEY = 'ext:email:rr';
/** 单步应答超时（每个阶段各自计 15s） */
const SMTP_TIMEOUT = 15_000;
/** 单次 SMTP 会话总超时（连接+握手+STARTTLS+认证+投递全程；单步超时不得超过剩余总时长） */
const SMTP_SESSION_TIMEOUT = 60_000;

interface EmailProvider {
  readonly name: string;
  send(to: string, subject: string, text: string): Promise<boolean>;
}

/** 后台「邮箱设置」回显行（密码永不回显，只回 hasPass） */
interface SmtpAccountView {
  from: string;
  host: string;
  port: number;
  user: string;
  /** 每日发送上限（0 = 不限）；达到上限的账号当天轮询自动跳过 */
  dailyLimit: number;
  hasPass: boolean;
}

interface SmtpAccount extends SmtpAccountView {
  pass: string;
}

const str = (v: unknown): string => String(v ?? '').trim();

/** 读取并规范化池：坏行静默剔除（缺 host/port/user/pass/from 任一项即不可用） */
async function readPool(env: Env, db: D1b, cache: Cache): Promise<SmtpAccount[]> {
  const [cfg, sec] = await Promise.all([loadExtConfig(cache, db, EMAIL_EXT_ID), loadExtSecret(db, EMAIL_EXT_ID, env.SECRETS_MASTER_KEY)]);
  const rawPool = Array.isArray(cfg.pool) ? (cfg.pool as Record<string, unknown>[]) : [];
  const passes = Array.isArray(sec.passes) ? sec.passes : [];
  const pool: SmtpAccount[] = [];
  rawPool.forEach((r, i) => {
    const from = str(r?.from);
    const host = str(r?.host);
    const port = Math.floor(Number(r?.port ?? 0));
    const user = str(r?.user);
    const pass = str(passes[i]);
    const dailyLimit = Math.max(0, Math.floor(Number(r?.dailyLimit ?? 0)) || 0);
    if (from && host && port > 0 && user && pass)
      pool.push({ from, host, port, user, pass, dailyLimit, hasPass: true });
  });
  return pool;
}

/**
 * 后台「邮箱设置」页状态：池行回显（密码只回 hasPass）。
 *
 * 与 readPool 的区别：这里**不**按「有密码才可用」过滤——密码缺失（SECRETS_MASTER_KEY 轮换/密文损坏）
 * 的行必须照常回显并标记 hasPass=false，否则后台看到的是空池，顺手一保存就把这些账号整行删掉；
 * 而 readPool 是发信路径，缺密码的行确实不可用（会被静默跳过）。
 */
export async function getEmailSettingState(env: Env, db: D1b, cache: Cache): Promise<{ pool: SmtpAccountView[] }> {
  const [cfg, sec] = await Promise.all([
    loadExtConfig(cache, db, EMAIL_EXT_ID),
    loadExtSecret(db, EMAIL_EXT_ID, env.SECRETS_MASTER_KEY),
  ]);
  const rawPool = Array.isArray(cfg.pool) ? (cfg.pool as Record<string, unknown>[]) : [];
  const passes = Array.isArray(sec.passes) ? sec.passes : [];
  const pool = rawPool.map((r, i) => ({
    from: str(r?.from),
    host: str(r?.host),
    port: Math.floor(Number(r?.port ?? 0)),
    user: str(r?.user),
    dailyLimit: Math.max(0, Math.floor(Number(r?.dailyLimit ?? 0)) || 0),
    hasPass: str(passes[i]) !== '',
  }));
  return { pool };
}

/** 池为空 → null（调用方按 §11.3 降级，而非报错） */
export async function getEmailProvider(env: Env, db: D1b, cache: Cache): Promise<EmailProvider | null> {
  const pool = await readPool(env, db, cache);
  return pool.length ? new SmtpPoolProvider(db, pool) : null;
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

/** 当日计数 key：`ext:email:cnt:{ymd}:{host}:{user}`，UTC 日切（0 点整池计数清零）。
 *  账号唯一标识是 (host, user)：只按 user 计数会让「同一发信账号配置在两个中转主机」的两行共用额度桶，
 *  其中一个账号额度耗尽即被误跳过（或超额）。
 *  host/user 来自后台配置且仅用于代码内插字面量（见 D1 upsert bind 怪癖），净化为安全字符集防 SQL 注入。 */
function cntKey(host: string, user: string): string {
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safe = (v: string) => v.replace(/[^A-Za-z0-9@._+-]/g, '_').slice(0, 64);
  return `${CNT_PREFIX}${ymd}:${safe(host)}:${safe(user)}`;
}

/**
 * 批量读当日已发送计数（仅存在限额账号时才产生查询，全部不限额 0 查询）；
 * 顺带删除历史日期的计数行（k 按日期前缀有序，`< 今日前缀` 即昨日及更早），防 bbs_kv 无限累积。
 *
 * 计数只是额度保护（best-effort），D1 抖动不能让整封信发不出去：查询失败按空计数继续，
 * 最坏结果只是当天多消耗几个名额；若在这里抛出，`send()` 会整体失败 → 用户收不到任何邮件。
 */
async function readDailyCounts(db: D1b, accounts: SmtpAccount[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!accounts.some((a) => a.dailyLimit > 0)) return map;
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  try {
    await db.prepare(`DELETE FROM bbs_kv WHERE k LIKE '${CNT_PREFIX}%' AND k < '${CNT_PREFIX}${ymd}'`).run();
    const keys = accounts
      .filter((a) => a.dailyLimit > 0)
      .map((a) => `'${cntKey(a.host, a.user)}'`);
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
 * 语义从「发成功后 +1」改为「发前预约、失败归还」：旧实现「先查后加」在两个 isolate 同时取号时
 * 会各自认为还剩 1 个名额 → 双双发出，日上限被突破。预约失败 = 该账号额度已满，直接跳过换号。
 * 代价是极端情况下（isolate 在会话中途被回收）会漏归还 1 个名额，方向上只会少发、不会超发。
 * 未限额账号（limit=0）不计数。
 */
async function tryReserveDailyCount(db: D1b, host: string, user: string, limit: number): Promise<boolean> {
  if (!(limit > 0)) return true;
  const r = await db
    .prepare(
      `INSERT INTO bbs_kv (k, v) VALUES ('${cntKey(host, user)}', '1')
       ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)
       WHERE CAST(v AS INTEGER) < ${Math.floor(limit)}`,
    )
    .run();
  return Number(r.meta?.changes ?? 0) > 0;
}

/** 归还名额（发送失败/未发出时调用；余额不为负） */
async function releaseDailyCount(db: D1b, host: string, user: string): Promise<void> {
  await db
    .prepare(
      `UPDATE bbs_kv SET v = CAST(CAST(v AS INTEGER) - 1 AS TEXT)
       WHERE k = '${cntKey(host, user)}' AND CAST(v AS INTEGER) > 0`,
    )
    .run();
}

class SmtpPoolProvider implements EmailProvider {
  readonly name = 'smtp-pool';

  constructor(
    private readonly db: D1b,
    private readonly accounts: SmtpAccount[],
  ) {}

  /** 从轮询位起依次尝试：超每日限额的账号直接跳过，账号级失败（连接/认证/拒收）顺延下一个；
   *  全败或全部账号达限额返回 false（上层按投递失败静默，原因落日志） */
  async send(to: string, subject: string, text: string): Promise<boolean> {
    const n = this.accounts.length;
    // 轮询指针只影响「从哪台开始试」，D1 抖动时退化为固定从 0 开始，不能因此不发信
    const start = await nextRoundRobin(this.db, n).catch((e: unknown) => {
      console.warn(`[email] round-robin failed: ${e instanceof Error ? e.message : String(e)}`);
      return 0;
    });
    const used = await readDailyCounts(this.db, this.accounts);
    let overLimit = 0;
    for (let i = 0; i < n; i++) {
      const acct = this.accounts[(start + i) % n]!;
      const limited = acct.dailyLimit > 0;
      // 先按批量读数粗筛（省掉明显发不出去的一次建连），真正的闸门是下面的原子预约
      if (limited && (used.get(cntKey(acct.host, acct.user)) ?? 0) >= acct.dailyLimit) {
        overLimit++;
        continue;
      }
      if (limited) {
        let reserved = true;
        try {
          reserved = await tryReserveDailyCount(this.db, acct.host, acct.user, acct.dailyLimit);
        } catch (e) {
          // 计数行读写异常不阻断发信（额度保护是 best-effort）
          console.warn(`[email] daily reserve failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!reserved) {
          overLimit++;
          continue;
        }
      }
      try {
        await smtpSendOne(acct, to, subject, text);
      } catch (e) {
        // 账号级失败顺延下一个；失败原因落日志（否则 waitUntil 静默无从排查）
        console.error(`[email] ${t0('email.acctSendFailed', { account: `${acct.user}@${acct.host}:${acct.port}`, err: e instanceof Error ? e.message : String(e) })}`);
        if (limited) {
          // 没发出去就归还名额（服务商拒绝不算消耗额度）
          try {
            await releaseDailyCount(this.db, acct.host, acct.user);
          } catch (e2) {
            console.warn(`[email] daily release failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
          }
        }
        continue;
      }
      // DATA 后的 250 已确认投递：名额保留，且此后任何失败都不得顺延下一个账号，
      // 否则同一封信会被第二台重发一次（对方收到两封）。
      return true;
    }
    if (overLimit === n) console.error(`[email] ${t0('email.allOverLimit', { n })}`);
    return false;
  }
}

/** TLS 模式：465=隐式 TLS；587=STARTTLS；其余=明文（仅本地联调用假 SMTP） */
function tlsMode(port: number): 'on' | 'starttls' | 'off' {
  if (port === 465) return 'on';
  if (port === 587) return 'starttls';
  return 'off';
}

const utf8 = new TextEncoder();

function b64(s: string): string {
  return btoa(String.fromCharCode(...utf8.encode(s)));
}

/** base64 正文按 RFC 2045 每 76 字符折行 */
function chunk76(s: string): string {
  return (s.match(/.{1,76}/g) ?? []).join('\r\n');
}

async function writeLine(w: WritableStreamDefaultWriter<Uint8Array>, s: string): Promise<void> {
  await w.write(utf8.encode(`${s}\r\n`));
}

/**
 * 读 SMTP 应答直到目标码的末行（"250 ok"；多行时中间行形如 "250-xxx"）。
 * 码不符的末行（如 535/530）抛错——failover 依据。
 * 超时：单步 SMTP_TIMEOUT，且不超过调用方传入的整段会话 deadline（`deadline`）。
 * `alt` 用于合法多码场景（RCPT TO 合法回 250/251/252）。
 * 返回本次应答的全部文本行（去掉 3 位状态码，供 EHLO 解析 AUTH 能力）。
 */
async function expectReply(
  r: ReadableStreamDefaultReader<Uint8Array>,
  code: string,
  opts: { alt?: string; deadline?: number } = {},
): Promise<string[]> {
  const limit = Math.min(Date.now() + SMTP_TIMEOUT, opts.deadline ?? Number.POSITIVE_INFINITY);
  const dec = new TextDecoder();
  const lines: string[] = [];
  let buf = '';
  for (;;) {
    if (Date.now() > limit) throw new Error(t0('email.smtpTimeout'));
    const idx = buf.indexOf('\r\n');
    if (idx < 0) {
      // 超时兜底：reader.read 挂起时 race 一个到时 reject（预接 catch 防 unhandled rejection）
      // 定时器在 race 结束后必须清掉，否则发信结束后仍会挂着一个待定 timer。
      let timerId: ReturnType<typeof setTimeout> | undefined;
      const timer = new Promise<never>((_, rej) => {
        timerId = setTimeout(() => rej(new Error(t0('email.smtpReadTimeout'))), Math.max(1, limit - Date.now()));
      });
      timer.catch(() => {});
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await Promise.race([r.read(), timer]);
      } finally {
        if (timerId !== undefined) clearTimeout(timerId);
      }
      if (chunk.done) throw new Error(t0('email.smtpClosedEarly'));
      buf += dec.decode(chunk.value, { stream: true });
      continue;
    }
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    if (line.length < 4) throw new Error(t0('email.smtpBadReply', { line }));
    const lineCode = line.slice(0, 3);
    lines.push(line.slice(4));
    if (line[3] === '-') continue; // 多行中间行
    if (lineCode !== code && lineCode !== opts.alt) {
      throw new Error(t0('email.smtpUnexpectedReply', { got: lineCode, want: code, line }));
    }
    return lines;
  }
}

/** 从 EHLO 应答行解析 AUTH 机制（`AUTH LOGIN PLAIN` / `AUTH=PLAIN`，大小写不敏感；未通告返回空） */
function authMechanisms(caps: readonly string[]): string[] {
  for (const line of caps) {
    const m = /^AUTH[ =]\s*(.+)$/i.exec(line.trim());
    if (m) return m[1]!.toUpperCase().split(/\s+/).filter(Boolean);
  }
  return [];
}

/** 组装 RFC 5321 邮件（UTF-8 base64 编码 Subject/正文，中文不乱码；点填充防提前结束 DATA） */
function buildMessage(from: string, to: string, subject: string, text: string): Uint8Array {
  const domain = from.includes('@') ? from.split('@')[1] : 'localhost';
  const lines = [
    `From: <${from}>`,
    `To: <${to}>`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    chunk76(b64(text)),
  ];
  return utf8.encode(`${lines.map((l) => (l.startsWith('.') ? `.${l}` : l)).join('\r\n')}\r\n`);
}

/**
 * 单账号完整 SMTP 会话；`DATA` 后的 250 之前任何一步失败都抛错（failover 依据），socket 必关。
 *
 * 关键：`DATA` 已被服务端以 250 收下 => 投递完成。此后的 QUIT 只是礼貌收尾，
 * 服务端可能直接断链或干脆不回 221；把它当成失败会触发 failover，导致**同一封信被第二个账号重发**。
 */
async function smtpSendOne(acct: SmtpAccount, to: string, subject: string, text: string): Promise<void> {
  const mode = tlsMode(acct.port);
  const deadline = Date.now() + SMTP_SESSION_TIMEOUT;
  let socket = connect({ hostname: acct.host, port: acct.port }, { secureTransport: mode });
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    writer = socket.writable.getWriter();
    reader = socket.readable.getReader();

    await expectReply(reader, '220', { deadline }); // 问候

    const ehlo = `EHLO ${acct.from.split('@')[1] ?? 'localhost'}`;
    await writeLine(writer, ehlo);
    let caps = await expectReply(reader, '250', { deadline });
    if (mode === 'starttls') {
      // RFC 3207：必须先显式发送 STARTTLS 并等待 220，才能做 TLS 握手。
      // 直接调用 startTls() 会让服务端在等待明文命令时收到 ClientHello，587 端口全部发信失败。
      await writeLine(writer, 'STARTTLS');
      await expectReply(reader, '220', { deadline });
      // startTls 要求释放流锁后调用；升级后流重新获取
      writer.releaseLock();
      reader.releaseLock();
      socket = socket.startTls();
      writer = socket.writable.getWriter();
      reader = socket.readable.getReader();
      await writeLine(writer, ehlo); // TLS 后重发 EHLO
      caps = await expectReply(reader, '250', { deadline });
    }

    // 认证机制按 EHLO 能力选：只支持 AUTH PLAIN 的服务商（Exchange/部分自建）不认 AUTH LOGIN，
    // 此前一律 LOGIN 会导致这类账号 504 全败。未通告 AUTH（部分服务商在 TLS 前隐藏）时按 LOGIN 试。
    if (authMechanisms(caps).includes('PLAIN') && !authMechanisms(caps).includes('LOGIN')) {
      await writeLine(writer, `AUTH PLAIN ${b64(`\0${acct.user}\0${acct.pass}`)}`);
      await expectReply(reader, '235', { deadline });
    } else {
      await writeLine(writer, 'AUTH LOGIN');
      await expectReply(reader, '334', { deadline });
      await writeLine(writer, b64(acct.user));
      await expectReply(reader, '334', { deadline });
      await writeLine(writer, b64(acct.pass));
      await expectReply(reader, '235', { deadline });
    }

    await writeLine(writer, `MAIL FROM:<${acct.from}>`);
    await expectReply(reader, '250', { deadline });
    await writeLine(writer, `RCPT TO:<${to}>`);
    await expectReply(reader, '250', { alt: '251', deadline }); // 251 = 非本地用户将转发（合法收件）
    await writeLine(writer, 'DATA');
    await expectReply(reader, '354', { deadline });
    await writer.write(buildMessage(acct.from, to, subject, text));
    await writeLine(writer, '.');
    await expectReply(reader, '250', { deadline }); // 到这里已确认投递成功

    // 收尾尽力而为：不参与成败判定
    try {
      await writeLine(writer, 'QUIT');
      await expectReply(reader, '221', { deadline });
    } catch {
      /* 服务端已收信，QUIT 应答缺失/断链不影响投递结果 */
    }
  } finally {
    // 持锁关 socket 会被 workerd 拒绝（抛错后被吞 => 连接泄漏到 GC），先释放流锁
    try {
      writer?.releaseLock();
    } catch {
      /* 已释放 */
    }
    try {
      reader?.releaseLock();
    } catch {
      /* 已释放 */
    }
    try {
      socket.close();
    } catch {
      // 已关闭则忽略
    }
  }
}
