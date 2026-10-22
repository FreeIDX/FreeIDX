/**
 * CSRF 双提交（T2-3，§8.2）：`csrf` cookie（JS 可读，非 HttpOnly）+ 非 GET 请求头
 * `X-CSRF-Token` 必须与 cookie 一致；SameSite=Lax 阻断跨站自动携带。
 * /api/auth/* 豁免（游客可达，爆破防护由 T2-4 Turnstile+频控承担）。
 */
import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie } from 'hono/cookie';
import { Code } from '@freeidx/shared';
import type { Env } from '../types/env';
import type { D1b } from '../core/db';
import type { Cache } from '../core/cache';
import type { ApiT } from '../core/i18n';
import { isHttpsRequest } from '../core/site';
import { AppError } from './envelope';

type CtxEnv = { Bindings: Env; Variables: { db: D1b; cache: Cache; runlevel: number; t: ApiT } };

function randomToken(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** 恒定时间比较，防时序侧信道 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const csrf = createMiddleware<CtxEnv>(async (c, next) => {
  if (!c.req.path.startsWith('/api/')) return next();

  // Secure 跟随当前请求协议（多域名/预览域下 SITE_URL 可能未配置或与实际请求域不一致）
  const secure = isHttpsRequest(c);
  const cookieOpts = { path: '/', sameSite: 'Lax' as const, secure, httpOnly: false };
  const token = getCookie(c, 'csrf');

  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') {
    if (!token) setCookie(c, 'csrf', randomToken(), cookieOpts);
    return next();
  }

  if (c.req.path.startsWith('/api/auth/')) return next();
  // 支付通道回调（§15.5 webhook）：公网 provider 服务器发起，无法携带本站 CSRF；安全性由各通道 verifyWebhook 验签保证
  if (c.req.path.startsWith('/api/payments/webhook/')) return next();

  const header = c.req.header('X-CSRF-Token') ?? '';
  if (!token || !header || !safeEqual(header, token)) {
    throw new AppError(Code.CSRF_FAILED, c.get('t')('csrf.failed'));
  }
  return next();
});
