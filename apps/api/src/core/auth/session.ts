/**
 * Session 轨（§8.1，T2-2）：D1 bbs_session 行（sid, uid, ip, url, useragent, last_date），
 * 同时是在线用户数据源（T4-2 消费）。
 * last_date 刷新节流 60s（D1 写额度下低频化；在线口径 ±60s）。
 */
import type { D1b } from '../db';

interface SessionInit {
  ip: number;
  useragent: string;
  url: string;
  fid?: number;
}

/** 点分 IPv4 → 无符号整数（ip2long 语义；IPv6/非法 → 0） */
export function ipToLong(ip: string): number {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return 0;
  return (((+m[1]! << 24) | (+m[2]! << 16) | (+m[3]! << 8) | +m[4]!) >>> 0);
}

/** 无符号整数 → 点分 IPv4（long2ip 语义，含 0 → '0.0.0.0'；后台列表展示注册 IP 用） */
export function ipToStr(long: number): string {
  const n = long >>> 0;
  return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

function genSid(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export async function createSession(db: D1b, uid: number, init: SessionInit, sid = genSid()): Promise<string> {
  await db
    .prepare('REPLACE INTO bbs_session (sid, uid, fid, url, ip, useragent, last_date) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(sid, uid, init.fid ?? 0, init.url.slice(0, 255), init.ip, init.useragent.slice(0, 255), Math.floor(Date.now() / 1000))
    .run();
  return sid;
}

/** 刷新活跃时间 + 当前页（在线列表 url 口径） */
export async function touchSession(db: D1b, sid: string, url: string): Promise<void> {
  await db
    .prepare('UPDATE bbs_session SET last_date = ?, url = ? WHERE sid = ?')
    .bind(Math.floor(Date.now() / 1000), url.slice(0, 255), sid)
    .run();
}

export async function destroySession(db: D1b, sid: string): Promise<void> {
  await db.prepare('DELETE FROM bbs_session WHERE sid = ?').bind(sid).run();
}

export async function destroyUserSessions(db: D1b, uid: number): Promise<void> {
  await db.prepare('DELETE FROM bbs_session WHERE uid = ?').bind(uid).run();
}
