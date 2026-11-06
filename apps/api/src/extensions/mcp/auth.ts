/**
 * MCP 鉴权（个人访问令牌 Bearer）与反滥用。
 *
 * 为什么不是 Cookie：MCP 客户端是服务端进程，不带浏览器会话；`sid/at` 双轨在这里完全不可用。
 * 因此令牌是唯一身份载体，安全边界必须落在令牌本身：
 *  - 明文只在创建响应里出现一次，库里只存 SHA-256（泄露库 ≠ 泄露令牌）；
 *  - 前缀单独成列，后台只靠它辨识，避免为「看一眼」而回显明文；
 *  - 每次调用都重新查用户（不做跨请求缓存）：改组/封禁/删号即时生效，
 *    代价是 1 次 D1 查询，远低于 40 条告警线。
 *
 * 反滥用（免费层适配，§6.4）：
 *  - 限流用 per-isolate 内存计数：零 D1/KV 写；多 isolate 各自计数，精度换取额度；
 *  - last_used_at 写库做 60s 节流（与 session.last_date 同一思路），避免每请求一次写放大；
 *  - 审计只落「失败 + 写类工具」，读类成功不落库，防止 AI 客户端高频读打爆 10 万行写/日。
 */
import { BanScope, Code, RunLevel, effectiveBanScope, mcpScopeAllowed, type McpToolScope } from '@freeidx/shared';
import type { D1b } from '../../core/db';

/** 令牌明文前缀：与站点其它密钥不混淆，也便于日志里一眼认出（日志永不记录完整值） */
export const MCP_TOKEN_PREFIX = 'fi_mcp_';
/** 前缀列保留长度（含 fi_mcp_），用于后台辨识 */
const TOKEN_PREFIX_LEN = MCP_TOKEN_PREFIX.length + 8;

export interface McpActor {
  tokenId: number;
  uid: number;
  gid: number;
  username: string;
  /** 注册审核位（tt_check user.ok）：非 1 的账号禁止写入 */
  ok: number;
  scopes: string;
  banScope: number;
  banUntil: number;
  /** 上次使用时间（unix 秒）：用于 last_used_at 的 60s 节流写 */
  lastUsedAt: number;
}

export type AuthResult =
  | { ok: true; actor: McpActor }
  | { ok: false; status: number; message: string; invalidate?: boolean };

/** base64url（无 padding）：URL 与 header 都安全，且比 hex 短一半 */
function base64url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i]!.toString(16).padStart(2, '0');
  return s;
}

/** 生成新令牌明文（32 字节随机 → 43 字符 base64url） */
export function generateToken(): string {
  return MCP_TOKEN_PREFIX + base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** 令牌指纹：库中唯一索引列；明文永不落库、不入日志 */
export async function hashToken(token: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
}

/** 后台辨识用前缀（不构成秘密：单靠它无法反推令牌） */
export function tokenPrefixOf(token: string): string {
  return token.slice(0, TOKEN_PREFIX_LEN);
}

/** 恒定时间比较（防时序侧信道；与 middleware/csrf.ts 同口径） */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 从 Authorization 头提取 Bearer 值（大小写不敏感，容许前后空白） */
export function bearerOf(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^\s*Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1] ?? null;
}

interface TokenRow {
  id: number;
  uid: number;
  scopes: string;
  expire_at: number;
  revoked: number;
  last_used_at: number;
  gid: number | null;
  username: string | null;
  ok: number | null;
  ban_scope: number | null;
  ban_until: number | null;
}

/**
 * 验令牌 → 载入持有者。
 * 单次 JOIN 查询取全（令牌 + 用户权限位），既省一次往返，也让「改组/封禁」在令牌层即时反映。
 */
export async function authenticate(db: D1b, header: string | undefined): Promise<AuthResult> {
  const token = bearerOf(header);
  if (!token || !token.startsWith(MCP_TOKEN_PREFIX)) {
    return { ok: false, status: 401, message: 'Missing or malformed bearer token' };
  }
  const row = await db
    .prepare<TokenRow>(
      `SELECT t.id, t.uid, t.scopes, t.expire_at, t.revoked, t.last_used_at,
              u.gid, u.username, u.ok, u.ban_scope, u.ban_until
         FROM bbs_mcp_token t LEFT JOIN bbs_user u ON u.uid = t.uid
        WHERE t.token_hash = ?`,
    )
    .bind(await hashToken(token))
    .first<TokenRow>();
  if (!row) return { ok: false, status: 401, message: 'Invalid token' };
  if (Number(row.revoked) === 1) return { ok: false, status: 401, message: 'Token revoked' };
  const now = Math.floor(Date.now() / 1000);
  if (Number(row.expire_at) > 0 && Number(row.expire_at) <= now) {
    return { ok: false, status: 401, message: 'Token expired' };
  }
  // 用户已删（LEFT JOIN 无行）：令牌一并失效，避免 orphan token 长期可用
  if (row.gid === null || row.uid === null) return { ok: false, status: 401, message: 'Token owner no longer exists' };
  return {
    ok: true,
    actor: {
      tokenId: Number(row.id),
      uid: Number(row.uid),
      gid: Number(row.gid),
      username: String(row.username ?? ''),
      ok: Number(row.ok ?? 1),
      scopes: String(row.scopes ?? 'read'),
      banScope: Number(row.ban_scope ?? 0),
      banUntil: Number(row.ban_until ?? 0),
      lastUsedAt: Number(row.last_used_at ?? 0),
    },
  };
}

/** 档位与后台配置的交集：令牌给的是上限，插件配置是站点策略 */
export function scopeAllows(actor: McpActor, enabledScopes: string, scope: McpToolScope): boolean {
  return mcpScopeAllowed(actor.scopes, scope) && mcpScopeAllowed(enabledScopes, scope);
}

/**
 * 站点访问档位（runlevel）的 MCP 复刻。
 * `/mcp` 在中间件层被豁免（它没有 Cookie，走不了 loadViewer 的档位判定），
 * 因此这套语义必须在这里与 middleware/runlevel.ts 保持一致 —— 否则会出现
 * 「站点关闭/只读时网页拦住、AI 客户端照样写入」的绕过面。
 */
export function runlevelDeny(level: number, actor: McpActor, isWrite: boolean): string | null {
  if (level >= RunLevel.NORMAL) return null;
  if (actor.gid === 1) return null; // 管理员恒直通
  switch (level) {
    case RunLevel.CLOSED_SITE:
      return 'Site is closed';
    case RunLevel.ADMIN_ONLY:
      return 'Only administrators may access the site right now';
    case RunLevel.MEMBER_READ_ONLY:
      return isWrite ? 'Site is in read-only mode' : null;
    case RunLevel.MEMBER_READ_WRITE:
    case RunLevel.ALL_READ_ONLY:
      return isWrite ? 'Site is in read-only mode' : null;
    default:
      return null; // 未知档位按正常放行（与中间件同口径）
  }
}

/**
 * 小黑屋判定（与 middleware/ban.ts 同口径）：
 *  - READ/LOGIN 位：读写全拒（禁访 + 禁登等价于账号不可用）；
 *  - MUTE 位：只拒写。
 */
export function banDeny(actor: McpActor, isWrite: boolean): string | null {
  const now = Math.floor(Date.now() / 1000);
  const mask = effectiveBanScope(actor.banScope, actor.banUntil, now);
  if (!mask) return null;
  if (mask & (BanScope.READ | BanScope.LOGIN)) return 'Account is banned';
  if (isWrite && mask & BanScope.MUTE) return 'Account is muted';
  return null;
}

/** 注册审核未通过的账号禁止写入（与 shouldBlockUnapproved 同口径，读仍允许） */
export function approvalDeny(actor: McpActor, isWrite: boolean): string | null {
  if (isWrite && Number(actor.ok) !== 1) return 'Account is pending approval';
  return null;
}

/* ------------------------------ 限流 ------------------------------ */

interface Bucket {
  minute: number;
  count: number;
}

const buckets = new Map<number, Bucket>();
/** 内存桶上限：超限时清掉过期分钟，避免常驻 isolate 无限增长 */
const BUCKET_CAP = 4096;

/** 令牌级分钟窗口限流：返回 true = 放行。零外部写，多 isolate 各自计数。 */
export function allowRequest(tokenId: number, perMin: number): boolean {
  if (perMin <= 0) return true;
  const minute = Math.floor(Date.now() / 60000);
  const cur = buckets.get(tokenId);
  if (!cur || cur.minute !== minute) {
    if (buckets.size > BUCKET_CAP) {
      for (const [k, v] of buckets) if (v.minute !== minute) buckets.delete(k);
    }
    buckets.set(tokenId, { minute, count: 1 });
    return true;
  }
  if (cur.count >= perMin) return false;
  cur.count++;
  return true;
}

/* ------------------------------ 审计 ------------------------------ */

/** last_used_at 节流窗口（秒）：同窗口内不重复写库 */
const TOUCH_WINDOW = 60;

export function shouldTouch(lastUsedAt: number, now: number): boolean {
  return now - Number(lastUsedAt) > TOUCH_WINDOW;
}

export async function touchToken(db: D1b, tokenId: number, now: number): Promise<void> {
  try {
    await db
      .prepare('UPDATE bbs_mcp_token SET last_used_at = ? WHERE id = ? AND last_used_at < ?')
      .bind(now, tokenId, now - TOUCH_WINDOW)
      .run();
  } catch {
    /* 观测字段，写失败不影响调用 */
  }
}

export interface AuditRecord {
  uid: number;
  tokenId: number;
  tool: string;
  ok: boolean;
  ms: number;
  ipHash: string;
}

/** 审计落库（fail-soft）：只记失败与写类工具，见文件头预算说明 */
export async function writeAudit(db: D1b, rec: AuditRecord): Promise<void> {
  try {
    await db
      .prepare(
        'INSERT INTO bbs_mcp_audit (uid,token_id,tool,ok,ms,ip_hash,create_date) VALUES (?,?,?,?,?,?,?)',
      )
      .bind(rec.uid, rec.tokenId, rec.tool.slice(0, 64), rec.ok ? 1 : 0, Math.trunc(rec.ms), rec.ipHash, Math.floor(Date.now() / 1000))
      .run();
  } catch {
    /* 审计是旁路：D1 写额度/表缺失绝不升级为工具调用失败 */
  }
}

/** IP 只留不可逆指纹（排障够用，不构成个人信息落库） */
export async function ipFingerprint(ip: string): Promise<string> {
  if (!ip) return '';
  return (await hashToken(ip)).slice(0, 16);
}

/** 未授权响应：HTTP 401 + WWW-Authenticate（MCP 客户端据此提示用户检查令牌） */
export function unauthorized(message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: Code.NOT_LOGIN, message } }), {
    status: 401,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'www-authenticate': 'Bearer realm="freeidx-mcp"',
    },
  });
}
