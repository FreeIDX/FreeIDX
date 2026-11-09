/**
 * HTTP 邮件 API 通道（§11.3 的第二条投递通道）。
 *
 * 为什么需要它：SMTP 依赖 `cloudflare:sockets` 的出站 TCP，而部分 Worker 出站环境会把
 * 到邮件服务器的 TCP 连接判定为「TCP Loop」直接拒绝（DNS 正常、465/587 均失败，与授权码无关）。
 * 这类环境里只有 `fetch`（443/HTTPS）可用，因此把投递改走服务商的 REST API 即可绕开。
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
  if (!req.url) throw new Error('HTTP endpoint missing');
  const res = await fetch(req.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...req.headers },
    body: JSON.stringify(req.body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT),
  });
  if (res.ok) return;
  const raw = await res.text().catch(() => '');
  throw new Error(httpErrorDetail(res.status, raw));
}
