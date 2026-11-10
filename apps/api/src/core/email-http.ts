/**
 * HTTP 邮件 API 通道（§11.3 唯一的投递通道）。
 *
 * 为什么只走它：SMTP 依赖 `cloudflare:sockets` 的出站 TCP，而部分 Worker 出站环境会把
 * 到邮件服务器的 TCP 连接判定为「TCP Loop」直接拒绝（DNS 正常、465/587 均失败，与授权码无关）。
 * 这类环境里只有 `fetch`（443/HTTPS）可用，因此投递统一改走服务商的 REST API。
 *
 * 支持的服务商（都是「POST 一段 JSON + 一个 Key」的最简形态）：
 *  - resend   https://api.resend.com/emails            Authorization: Bearer
 *  - sendgrid https://api.sendgrid.com/v3/mail/send    Authorization: Bearer
 *  - brevo    https://api.brevo.com/v3/smtp/email      api-key
 *  - custom   自建/其他中转（POST JSON {from,to,subject,text}，Authorization: Bearer）
 *
 * 约束：from 必须是**在服务商侧已验证**的地址（自有域名最佳）；`@qq.com` 这类你无法验证的
 * 邮箱多数服务商会拒收（403/422），面板会把服务商返回的原文透出来。
 */

/** 支持的 HTTP 服务商标识 */
export const HTTP_PROVIDERS = ['resend', 'sendgrid', 'brevo', 'custom'] as const;
export type HttpProvider = (typeof HTTP_PROVIDERS)[number];

export interface HttpMailConfig {
  provider: HttpProvider;
  /** 发件地址（服务商侧已验证） */
  from: string;
  /** provider=custom 时的完整接口地址（https） */
  url?: string;
}

export interface HttpMailRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** 请求超时（单次 API 调用） */
const HTTP_TIMEOUT = 15_000;
/** 错误原文截断长度（落到 kv 与面板，避免服务商返回大段 HTML 撑爆） */
const ERR_MAX = 300;

/** 按服务商组装请求（纯函数，便于单测） */
export function buildHttpMailRequest(
  cfg: HttpMailConfig,
  key: string,
  to: string,
  subject: string,
  text: string,
): HttpMailRequest {
  switch (cfg.provider) {
    case 'resend':
      return {
        url: 'https://api.resend.com/emails',
        headers: { authorization: `Bearer ${key}` },
        body: { from: cfg.from, to: [to], subject, text },
      };
    case 'sendgrid':
      return {
        url: 'https://api.sendgrid.com/v3/mail/send',
        headers: { authorization: `Bearer ${key}` },
        body: {
          personalizations: [{ to: [{ email: to }] }],
          from: { email: cfg.from },
          subject,
          content: [{ type: 'text/plain', value: text }],
        },
      };
    case 'brevo':
      return {
        url: 'https://api.brevo.com/v3/smtp/email',
        headers: { 'api-key': key },
        body: { sender: { email: cfg.from }, to: [{ email: to }], subject, textContent: text },
      };
    case 'custom':
      return {
        url: cfg.url ?? '',
        headers: { authorization: `Bearer ${key}` },
        body: { from: cfg.from, to, subject, text },
      };
  }
}

/**
 * 从失败响应里抠出可读原因：不同服务商的错误结构不同
 * （resend: {message} / sendgrid: {errors:[{message}]} / brevo: {message} / 网关: 纯文本）。
 */
export function httpErrorDetail(status: number, raw: string): string {
  const text = raw.trim();
  let detail = text;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const errors = j.errors as { message?: string }[] | undefined;
    detail =
      (typeof j.message === 'string' && j.message) ||
      (typeof j.error === 'string' && j.error) ||
      (Array.isArray(errors) && errors[0]?.message) ||
      (typeof j.detail === 'string' && j.detail) ||
      text;
  } catch {
    /* 非 JSON：原样使用 */
  }
  const one = String(detail).replace(/\s+/g, ' ').trim().slice(0, ERR_MAX);
  return one ? `HTTP ${status}: ${one}` : `HTTP ${status}`;
}

/** 失败阶段：config=配置不全 / http=服务商明确拒绝 / rate-limit=限流 / timeout|network=结果未知 */
export type HttpFailStage = 'config' | 'http' | 'rate-limit' | 'timeout' | 'network';

/**
 * 投递失败（含阶段与「是否可能已被受理」）。
 *
 * `ambiguous` 是账号池 failover 的判据：服务商明确回 4xx/5xx 说明**没有受理**，换下一个账号重发是安全的；
 * 而超时/网络中断时请求可能已经进了对方的队列，此时换号重发会让收件人收到两封，
 * 所以这类失败只记账、不再换号（对应 SMTP 时代「DATA 后 250 之前/之后」的同一类问题）。
 */
export class HttpSendError extends Error {
  constructor(
    message: string,
    readonly stage: HttpFailStage,
    /** 服务商 HTTP 状态码（网络层失败无此值） */
    readonly status?: number,
    /** true = 结果未知，禁止换号重发 */
    readonly ambiguous = false,
  ) {
    super(message);
    this.name = 'HttpSendError';
  }
}

/**
 * 经 HTTP API 投递一封纯文本邮件；失败抛错（原因含服务商原文），由上层判失败与展示。
 * 成功判定：HTTP 2xx（各服务商的受理码 200/201/202 均在此范围）。
 */
export async function sendViaHttp(
  cfg: HttpMailConfig,
  key: string,
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const req = buildHttpMailRequest(cfg, key, to, subject, text);
  if (!req.url) throw new HttpSendError('HTTP endpoint missing', 'config');
  let res: Response;
  try {
    res = await fetch(req.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...req.headers },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(HTTP_TIMEOUT),
    });
  } catch (e) {
    // fetch 抛错 = 没拿到任何 HTTP 响应：请求可能已到达服务商（超时）也可能根本没出网。
    // 两种情况都无法确认未被受理，按「结果未知」处理，绝不换号重发。
    const name = e instanceof Error ? e.name : '';
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    throw new HttpSendError(msg, name === 'TimeoutError' ? 'timeout' : 'network', undefined, true);
  }
  if (res.ok) return;
  const raw = await res.text().catch(() => '');
  const detail = httpErrorDetail(res.status, raw);
  // 429 是限流：明确没受理，换下一个账号立刻能发；其余 4xx/5xx 同样视为未受理。
  throw new HttpSendError(detail, res.status === 429 ? 'rate-limit' : 'http', res.status);
}
