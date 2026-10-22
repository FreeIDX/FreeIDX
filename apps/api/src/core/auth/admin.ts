/**
 * 后台轨令牌（T3-3，§8.1 admin_at）：复用 HS256 JWT，TTL 1h。
 * 载荷仅 uid/tv/iat/exp——gid 由守卫回查 bbs_user（改组即时生效）；tv 复核对应改密吊销。
 * 与前台 at 分离签名密钥（ADMIN_JWT_SECRET ?? JWT_SECRET），互不越权。
 */
import { ADMIN_TOKEN_TTL } from '@freeidx/shared';
import { signJwt, verifyJwt, type JwtPayload } from './jwt';

const nowTs = () => Math.floor(Date.now() / 1000);

export async function issueAdminToken(secret: string, uid: number, tokenVersion: number, now = nowTs()): Promise<string> {
  return signJwt({ uid, tv: tokenVersion, iat: now, exp: now + ADMIN_TOKEN_TTL }, secret);
}

/** 验签 + exp；失败 null（不抛错） */
export async function readAdminToken(token: string | undefined, secret: string, now = nowTs()): Promise<JwtPayload | null> {
  if (!token || !secret) return null;
  return verifyJwt(token, secret, now);
}
