/**
 * MCP 访问令牌后台（插件 id=mcp 的配套管理面）。
 *
 * 三条安全约定：
 *  1. 明文只在创建响应里出现一次，之后列表只回 token_prefix（前 16 字符）+ 元信息；
 *  2. 库里只存 SHA-256 指纹（token_hash 唯一索引），删库/导出都拿不到可用令牌；
 *  3. 撤销是软删除（revoked=1）而不是 DELETE：审计表要能一直指回人来排查。
 *
 * 挂载在 adminGuard 之后（gid=1），CSRF 双提交由全局中间件覆盖。
 */
import { Hono } from 'hono';
import { Code, MCP_SCOPES, type McpToolScope } from '@freeidx/shared';
import { AppError, ok } from '../../middleware/envelope';
import { generateToken, hashToken, tokenPrefixOf } from '../../extensions/mcp/auth';
import type { ApiT } from '../../core/i18n';
import { adminUidOf, core, readJsonObject, type ReadEnv } from '../shared';

/** 过期天数上限（10 年）：再长就等于永不过期，不如显式填 0 */
const MAX_EXPIRE_DAYS = 3650;
/** 单站点令牌数上限：防误操作批量生成把表撑大（也是撞库面的上界） */
const MAX_TOKENS = 200;

const now = (): number => Math.floor(Date.now() / 1000);

/** 档位解析：只接受 MCP_SCOPES 内的值，逗号分隔去重；空则回落 read */
function parseScopes(raw: unknown, t: ApiT): string {
  const list = String(raw ?? 'read')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is McpToolScope => (MCP_SCOPES as readonly string[]).includes(s));
  if (!list.length) throw new AppError(Code.VALIDATION_ERROR, t('mcp.scopeInvalid'));
  return [...new Set(list)].join(',');
}

interface TokenRow {
  id: number;
  uid: number;
  username: string | null;
  name: string;
  token_prefix: string;
  scopes: string;
  expire_at: number;
  last_used_at: number;
  revoked: number;
  create_date: number;
}

function tokenView(r: TokenRow): Record<string, unknown> {
  return {
    id: Number(r.id),
    uid: Number(r.uid),
    username: String(r.username ?? ''),
    name: String(r.name ?? ''),
    tokenPrefix: String(r.token_prefix ?? ''),
    scopes: String(r.scopes ?? 'read'),
    expireAt: Number(r.expire_at ?? 0),
    lastUsedAt: Number(r.last_used_at ?? 0),
    revoked: Number(r.revoked ?? 0) === 1,
    createDate: Number(r.create_date ?? 0),
  };
}

export function adminMcpRoutes(): Hono<ReadEnv> {
  const app = new Hono<ReadEnv>();

  app.get('/api/admin/mcp/tokens', async (c) => {
    const { db } = core(c);
    const r = await db
      .prepare<TokenRow>(
        `SELECT t.id, t.uid, t.name, t.token_prefix, t.scopes, t.expire_at, t.last_used_at, t.revoked, t.create_date,
                u.username
           FROM bbs_mcp_token t LEFT JOIN bbs_user u ON u.uid = t.uid
          ORDER BY t.id DESC LIMIT 200`,
      )
      .all();
    return ok(c, 'ok', { data: { tokens: r.results.map(tokenView) } });
  });

  app.post('/api/admin/mcp/tokens', async (c) => {
    const { db } = core(c);
    const t = c.get('t');
    const body = await readJsonObject(c);
    const self = await adminUidOf(c);

    // 目标用户：缺省为当前管理员本人；给他人发令牌需显式传 uid（后台仅 gid=1 可达）
    const uid = body.uid === undefined ? self : Number.parseInt(String(body.uid), 10);
    if (!Number.isInteger(uid) || uid <= 0) throw new AppError(Code.VALIDATION_ERROR, t('common.uidInvalid'));
    const user = await db.prepare<{ uid: number }>('SELECT uid FROM bbs_user WHERE uid = ?').bind(uid).first<{ uid: number }>();
    if (!user) throw new AppError(Code.NOT_FOUND, t('common.userNotFound'));

    const cnt = await db.prepare<{ c: number }>('SELECT COUNT(*) AS c FROM bbs_mcp_token WHERE revoked = 0').first<{ c: number }>();
    if (Number(cnt?.c ?? 0) >= MAX_TOKENS) throw new AppError(Code.VALIDATION_ERROR, t('mcp.tokenLimit'));

    const name = String(body.name ?? '').trim().slice(0, 40) || 'AI client';
    const scopes = parseScopes(body.scopes, t);
    const days = Math.min(MAX_EXPIRE_DAYS, Math.max(0, Math.trunc(Number(body.expireDays ?? 0) || 0)));
    const expireAt = days > 0 ? now() + days * 86400 : 0;

    const token = generateToken();
    const row = await db
      .prepare<{ id: number }>(
        `INSERT INTO bbs_mcp_token (uid,name,token_prefix,token_hash,scopes,expire_at,last_used_at,revoked,create_date)
         VALUES (?,?,?,?,?,?,0,0,?) RETURNING id`,
      )
      .bind(uid, name, tokenPrefixOf(token), await hashToken(token), scopes, expireAt, now())
      .first<{ id: number }>();

    return ok(c, t('common.created'), {
      data: {
        id: Number(row?.id ?? 0),
        uid,
        name,
        scopes,
        expireAt,
        // 唯一一次明文下发：前端必须提示管理员立即复制（关闭后无法再取回）
        token,
        endpoint: '/mcp',
      },
    });
  });

  app.delete('/api/admin/mcp/tokens/:id', async (c) => {
    const { db } = core(c);
    const t = c.get('t');
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(Code.VALIDATION_ERROR, t('common.paramError'));
    await db.prepare('UPDATE bbs_mcp_token SET revoked = 1 WHERE id = ?').bind(id).run();
    return ok(c, t('common.deleted'), { data: { id } });
  });

  return app;
}
