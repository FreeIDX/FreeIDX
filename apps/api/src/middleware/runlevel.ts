/**
 * runlevel 全局闸门（T1-2）：
 *   0 站点关闭：非管理员全拒（runlevel_reason 自定义文案）
 *   1 管理员可读写：非管理员全拒
 *   2 会员只读：游客拒读、任何非 GET 拒写
 *   3 会员可读写：仅游客拒（引导登录）
 *   4 所有人只读：仅拒非 GET
 *   5 正常：直通（默认，零额外查询）
 * 登录白名单：/api/auth/*
 * 各档位下始终放行；gid=1 管理员恒直通。
 * 错误码映射：游客受限 → NOT_LOGIN(-1)（前端据此跳登录，§6.1）；
 *            站点关闭/只读拒写 → RUNLEVEL_CLOSED(-5)。
 */
import { createMiddleware } from 'hono/factory';
import { Code, RunLevel, type SiteSetting } from '@freeidx/shared';
import type { Env } from '../types/env';
import { D1b } from '../core/db';
import { Cache } from '../core/cache';
import { loadViewer, loadSetting } from '../core/loaders';
import type { ApiT } from '../core/i18n';
import { AppError } from './envelope';

export const runlevel = createMiddleware<{
  Bindings: Env;
  Variables: { db: D1b; cache: Cache; runlevel: number; t: ApiT };
}>((async (c, next) => {
  // 健康检查与静态探测不查库
  if (c.req.path === '/api/health') return next();
  const db = c.get('db');
  const t = c.get('t');
  let level: number = RunLevel.NORMAL;
  let reason = '';
  try {
    // loadSetting 读穿缓存（与 i18n 中间件同一条，命中零 D1）；runlevel_reason 为管理员自定义文案，透传不译
    const setting = await loadSetting(c.get('cache'), db);
    level = Number(setting.runlevel ?? RunLevel.NORMAL);
    reason = String((setting as Partial<SiteSetting> & { runlevel_reason?: string }).runlevel_reason ?? t('runlevel.closed'));
  } catch {
    level = RunLevel.NORMAL;
  }
  c.set('runlevel', level);
  if (level >= RunLevel.NORMAL) return next();

  // 登录白名单：任何档位放行
  if (c.req.path.startsWith('/api/auth/')) return next();

  const viewer = await loadViewer(c.get('cache'), db, c);
  if (viewer.gid === 1) return next(); // 管理员直通

  const isRead = c.req.method === 'GET' || c.req.method === 'HEAD';
  const isGuest = viewer.uid === 0;
  switch (level) {
    case RunLevel.CLOSED_SITE:
      throw new AppError(Code.RUNLEVEL_CLOSED, reason);
    case RunLevel.ADMIN_ONLY:
      throw new AppError(Code.RUNLEVEL_CLOSED, t('runlevel.adminOnly'));
    case RunLevel.MEMBER_READ_ONLY:
      if (isGuest) throw new AppError(Code.NOT_LOGIN, t('runlevel.memberRoLogin'));
      if (!isRead) throw new AppError(Code.RUNLEVEL_CLOSED, t('runlevel.memberRo'));
      break;
    case RunLevel.MEMBER_READ_WRITE:
      if (isGuest) throw new AppError(Code.NOT_LOGIN, t('runlevel.memberRwLogin'));
      break;
    case RunLevel.ALL_READ_ONLY:
      if (!isRead) throw new AppError(Code.RUNLEVEL_CLOSED, t('runlevel.allRo'));
      break;
    default:
      break; // 未知档位按正常放行
  }
  return next();
}));
