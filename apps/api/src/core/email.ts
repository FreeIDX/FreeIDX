/**
 * SMTP 账号池 EmailProvider（§11.3，§19 决策 4 拍板）。
 * Workers 直连 SMTP 实现：
 *  - `cloudflare:sockets` 出站 TCP：25 端口被封，465（隐式 TLS）/587（STARTTLS）可用；非 465/587 按明文（仅限本地假 SMTP 联调）。
 *  - 内置最小 SMTP 客户端：EHLO → STARTTLS? → AUTH LOGIN → MAIL FROM → RCPT TO → DATA → QUIT。
 *  - 多账号 **round-robin 轮询**（单账号免费额度 → N 倍，数量突破）；当前账号失败自动顺延下一账号（failover）。
 *    轮询指针存 D1 kv 行 `ext:email:rr`（单语句自增 RETURNING；竞态下偶发重复选号无害，仅轮转偏移）。
 *  - **每账号每日发送上限**（dailyLimit，0 不限）：达到上限的账号当天轮询自动跳过（顺延下一账号），
 *    当日计数存 D1 kv `ext:email:cnt:{ymd}:{host}:{user}`（UTC 日切，成功发送才计数），读计数时顺带清理历史日期行。
 *  - 池配置：kv `ext:email:config{pool:[{from,host,port,user,dailyLimit}]}`（明文，三层缓存）+ `ext:email:secret{passes:[]}`
 *    （AES-GCM 按下标对应，永不回显）；后台「邮箱设置」整池提交，零部署生效。
 *  - 发送由 auth 路由经 waitUntil 旁路调用（绝不请求内阻塞发信，§D.6）；降级：池为空返回 null，
 *    等价 user_create_email_on=0。
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
/** 单次 SMTP 会话总超时（连接+握手+发送全程） */
const SMTP_TIMEOUT = 15_000;

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

/** 后台「邮箱设置」页状态：池行回显（密码只回 hasPass） */
export async function getEmailSettingState(env: Env, db: D1b, cache: Cache): Promise<{ pool: SmtpAccountView[] }> {
  const pool = await readPool(env, db, cache);
  return { pool: pool.map(({ from, host, port, user, dailyLimit, hasPass }) => ({ from, host, port, user, dailyLimit, hasPass })) };
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
 */
async function readDailyCounts(db: D1b, accounts: SmtpAccount[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (!accounts.some((a) => a.dailyLimit > 0)) return map;
  const ymd = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  await db.prepare(`DELETE FROM bbs_kv WHERE k LIKE '${CNT_PREFIX}%' AND k < '${CNT_PREFIX}${ymd}'`).run();
  const keys = accounts
    .filter((a) => a.dailyLimit > 0)
    .map((a) => `'${cntKey(a.host, a.user)}'`);
  const r = await db.prepare<{ k: string; v: string }>(`SELECT k, v FROM bbs_kv WHERE k IN (${keys.join(',')})`).all();
  for (const row of r.results ?? []) map.set(row.k, Number(row.v) || 0);
  return map;
}

/** 成功发送后计数 +1（原子单语句 upsert；RR_KEY 同款字面量内插，绕开 D1 upsert 混用 bind 的平台怪癖） */
async function bumpDailyCount(db: D1b, host: string, user: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bbs_kv (k, v) VALUES ('${cntKey(host, user)}', '1')
       ON CONFLICT(k) DO UPDATE SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT)`,
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
    const start = await nextRoundRobin(this.db, n);
    const used = await readDailyCounts(this.db, this.accounts);
    let allOverLimit = true;
    for (let i = 0; i < n; i++) {
      const acct = this.accounts[(start + i) % n]!;
      if (acct.dailyLimit > 0 && (used.get(cntKey(acct.host, acct.user)) ?? 0) >= acct.dailyLimit) continue;
      allOverLimit = false;
      try {
        await smtpSendOne(acct, to, subject, text);
        await bumpDailyCount(this.db, acct.host, acct.user); // 成功才计数（服务商拒绝不算消耗额度）
        return true;
      } catch (e) {
        // 账号级失败顺延下一个；失败原因落日志（否则 waitUntil 静默无从排查）
        console.error(`[email] ${t0('email.acctSendFailed', { account: `${acct.user}@${acct.host}:${acct.port}`, err: e instanceof Error ? e.message : String(e) })}`);
      }
    }
    if (allOverLimit) console.error(`[email] ${t0('email.allOverLimit', { n })}`);
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
 * 码不符的末行（如 535/530）抛错——failover 依据；全程受 SMTP_TIMEOUT 约束。
 */
async function expectReply(r: ReadableStreamDefaultReader<Uint8Array>, code: string): Promise<void> {
  const deadline = Date.now() + SMTP_TIMEOUT;
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    if (Date.now() > deadline) throw new Error(t0('email.smtpTimeout'));
    const idx = buf.indexOf('\r\n');
    if (idx < 0) {
      // 超时兜底：reader.read 挂起时 race 一个到时 reject（预接 catch 防 unhandled rejection）
      const timer = new Promise<never>((_, rej) => {
        const id = setTimeout(() => rej(new Error(t0('email.smtpReadTimeout'))), Math.max(1, deadline - Date.now()));
        void id;
      });
      timer.catch(() => {});
      const chunk = await Promise.race([r.read(), timer]);
      if (chunk.done) throw new Error(t0('email.smtpClosedEarly'));
      buf += dec.decode(chunk.value, { stream: true });
      continue;
    }
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    if (line.length < 4) throw new Error(t0('email.smtpBadReply', { line }));
    const lineCode = line.slice(0, 3);
    if (line[3] === '-') continue; // 多行中间行
    if (lineCode !== code) throw new Error(t0('email.smtpUnexpectedReply', { got: lineCode, want: code, line }));
    return;
  }
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

/** 单账号完整 SMTP 会话；任何一步失败抛错（failover 依据），socket 必关 */
async function smtpSendOne(acct: SmtpAccount, to: string, subject: string, text: string): Promise<void> {
  const mode = tlsMode(acct.port);
  let socket = connect({ hostname: acct.host, port: acct.port }, { secureTransport: mode });
  try {
    let writer = socket.writable.getWriter();
    let reader = socket.readable.getReader();

    await expectReply(reader, '220'); // 问候

    const ehlo = `EHLO ${acct.from.split('@')[1] ?? 'localhost'}`;
    await writeLine(writer, ehlo);
    if (mode === 'starttls') {
      await expectReply(reader, '250');
      // startTls 要求释放流锁后调用；升级后流重新获取
      writer.releaseLock();
      reader.releaseLock();
      socket = socket.startTls();
      writer = socket.writable.getWriter();
      reader = socket.readable.getReader();
      await writeLine(writer, ehlo); // TLS 后重发 EHLO
    }
    await expectReply(reader, '250');

    await writeLine(writer, 'AUTH LOGIN');
    await expectReply(reader, '334');
    await writeLine(writer, b64(acct.user));
    await expectReply(reader, '334');
    await writeLine(writer, b64(acct.pass));
    await expectReply(reader, '235');

    await writeLine(writer, `MAIL FROM:<${acct.from}>`);
    await expectReply(reader, '250');
    await writeLine(writer, `RCPT TO:<${to}>`);
    await expectReply(reader, '250');
    await writeLine(writer, 'DATA');
    await expectReply(reader, '354');
    await writer.write(buildMessage(acct.from, to, subject, text));
    await writeLine(writer, '.');
    await expectReply(reader, '250');

    await writeLine(writer, 'QUIT');
    await expectReply(reader, '221');
  } finally {
    try {
      socket.close();
    } catch {
      // 已关闭则忽略
    }
  }
}
