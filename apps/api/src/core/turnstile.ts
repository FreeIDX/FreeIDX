/**
 * Turnstile 人机验证（§8.4/附录 B，同位挂载：登录/注册/发码/找回密码 + 发帖/回帖）。
 * 未配置 TURNSTILE_SECRET 时直通（本地开发/账号未到货，铁律 8），与 EmailProvider 同降级思路。
 * token 300s 过期且一次性（官方口径），校验发生在各 handler 参数解析之后、任何 D1 写之前。
 */
import type { Env } from '../types/env';

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(env: Env, token: string | undefined, ip: string): Promise<boolean> {
  const secret = env.TURNSTILE_SECRET;
  if (!secret) return true;
  if (!token) return false;
  const fd = new URLSearchParams({ secret, response: token });
  if (ip && ip !== '0.0.0.0') fd.set('remoteip', ip);
  try {
    const r = await fetch(SITEVERIFY, { method: 'POST', body: fd });
    const j = (await r.json()) as { success?: boolean };
    return !!j.success;
  } catch {
    return false;
  }
}
