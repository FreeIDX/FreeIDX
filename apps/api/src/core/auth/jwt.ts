/**
 * JWT HS256（WebCrypto，§8.1 Token 轨）：载荷 {uid, tv: token_version, iat, exp}，
 * Cookie `at` TTL 100 天（8640000s）。
 * 改密吊销：user.token_version+1 使旧 JWT 的 tv 复核失败（loadViewer 每请求比对，
 * 比对复用 user:{uid} 装载查询，无额外 D1 成本）。
 */

/** 令牌轨道：at=前台会话，admin_at=后台轨。两轨载荷同构，必须靠 typ 区分，否则前台令牌可当后台令牌用。 */
export type JwtTokenType = 'at' | 'admin_at';

export interface JwtPayload {
  uid: number;
  tv: number;
  iat: number;
  exp: number;
  /** 旧版本签发的令牌没有该字段；验签侧按 expectedTyp 严格拒绝，避免跨轨复用。 */
  typ?: JwtTokenType;
}

/** Access token TTL（秒） */
export const ACCESS_TOKEN_TTL = 8640000;

const enc = new TextEncoder();

const b64urlEnc = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const b64urlDec = (part: string): Uint8Array => {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const jsonB64url = (obj: unknown): string => b64urlEnc(enc.encode(JSON.stringify(obj)));

async function hmac(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function signJwt(payload: JwtPayload, secret: string): Promise<string> {
  const head = jsonB64url({ alg: 'HS256', typ: 'JWT' });
  const body = jsonB64url(payload);
  const data = `${head}.${body}`;
  const sig = await crypto.subtle.sign('HMAC', await hmac(secret), enc.encode(data));
  return `${data}.${b64urlEnc(new Uint8Array(sig))}`;
}

/** 验签 + exp 检查 + 令牌轨道校验；失败返回 null（不抛错，热路径零成本拒绝） */
export async function verifyJwt(
  token: string,
  secret: string,
  now: number = Math.floor(Date.now() / 1000),
  expectedTyp?: JwtTokenType,
): Promise<JwtPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  // 三段都必须符合 base64url 字符集：atob 对非法字符会抛 InvalidCharacterError，
  // 若不预先白名单校验，畸形 cookie 会把请求打成 500（低成本 DoS/探测面）。
  if (!parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDec(parts[1])));
  } catch {
    return null;
  }
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(
      'HMAC',
      await hmac(secret),
      b64urlDec(parts[2]),
      enc.encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    return null;
  }
  if (!ok) return null;
  const p = payload as Partial<JwtPayload>;
  if (typeof p.uid !== 'number' || typeof p.tv !== 'number' || typeof p.iat !== 'number' || typeof p.exp !== 'number') {
    return null;
  }
  if (p.exp <= now || p.iat > now + 60) return null;
  // 带期望轨道时严格相等：旧令牌（无 typ）一律拒绝，宁可让用户重新登录也不接受跨轨令牌。
  if (expectedTyp && p.typ !== expectedTyp) return null;
  if (p.typ !== undefined && p.typ !== 'at' && p.typ !== 'admin_at') return null;
  return { uid: p.uid, tv: p.tv, iat: p.iat, exp: p.exp, ...(p.typ ? { typ: p.typ } : {}) };
}

export async function issueAccessToken(
  secret: string,
  uid: number,
  tokenVersion: number,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  return signJwt({ uid, tv: tokenVersion, iat: now, exp: now + ACCESS_TOKEN_TTL, typ: 'at' }, secret);
}
