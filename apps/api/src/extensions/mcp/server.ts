/**
 * MCP 请求分发（无状态 Streamable HTTP 的服务端实现）。
 *
 * 支持的方法（MCP 2025-06-18 基线）：
 *   initialize / notifications/* / ping
 *   tools/list / tools/call
 *   resources/list / resources/templates/list / resources/read
 *
 * 刻意不实现：sampling、roots、logging 订阅、服务端主动 notification、SSE 长连接。
 * 这些都需要会话状态与常驻连接（Node/DO 设施），与 Workers 免费层的「请求-响应」模型冲突；
 * initialize 的 capabilities 已如实声明，客户端会自动降级而不是超时重试。
 *
 * 错误分层（客户端行为差异的关键）：
 *  - 协议层错误（未知方法、参数非法、工具不存在）→ JSON-RPC error；
 *  - 工具业务失败（无权限、主题不存在、参数越界）→ result.isError=true，
 *    这样模型能看到文本并自行纠正，而不是把整轮对话判成传输故障。
 */
import { extText, type McpToolScope } from '@freeidx/shared';
import type { D1b } from '../../core/db';
import type { Cache } from '../../core/cache';
import type { Env } from '../../types/env';
import type { ApiT } from '../../core/i18n';
import type { McpActor } from './auth';
import { scopeAllows, writeAudit } from './auth';
import type { McpResourceDef, McpToolDef } from '../../core/extensions/registry';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_VERSIONS,
  RPC_ERROR,
  isRpcRequest,
  rpcError,
  rpcResult,
  toolResult,
  type RpcId,
  type RpcRequest,
} from './protocol';
import { ToolError } from './tools';

/** ext:mcp:config 的强类型视图（键名与插件 schema 一一对应，改名会静默失效） */
export interface McpConfig {
  /** 站点允许暴露的最大档位（令牌自身 scope 还要与之取交集） */
  enabledScopes: string;
  /** 工具黑名单：站点策略级停用个别工具 */
  toolDenylist: string[];
  /** 每令牌每分钟工具调用上限（0 = 不限） */
  rateLimitPerMin: number;
  exposeResources: boolean;
}

export function parseConfig(raw: Record<string, unknown>): McpConfig {
  const scopes = String(raw.enabledScopes ?? 'read')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const denylist = String(raw.toolDenylist ?? '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const perMin = Number(raw.rateLimitPerMin ?? 60);
  return {
    // 未配置 scopes 时按只读：安全默认值，避免一次误提交配置把写能力打开
    enabledScopes: scopes.length ? scopes.join(',') : 'read',
    toolDenylist: denylist,
    rateLimitPerMin: Number.isFinite(perMin) && perMin >= 0 ? Math.trunc(perMin) : 60,
    exposeResources: raw.exposeResources === true || raw.exposeResources === 1 || raw.exposeResources === '1',
  };
}

export interface DispatchDeps {
  db: D1b;
  cache: Cache;
  env?: Env;
  lang: string;
  actor: McpActor;
  config: McpConfig;
  tools: McpToolDef[];
  resources: McpResourceDef[];
  ipHash: string;
  /** 请求 IP 整数形式（写工具落 userip 用，缺失为 0） */
  ip: number;
  /** API 文案取词器：写工具抛出的错误与 HTTP 端同一套 message */
  t: ApiT;
}

/** 工具是否对本次调用可见（档位交集 + 黑名单） */
function toolVisible(tool: McpToolDef, deps: DispatchDeps): boolean {
  if (deps.config.toolDenylist.includes(tool.name)) return false;
  return scopeAllows(deps.actor, deps.config.enabledScopes, tool.scope);
}

function pickProtocolVersion(params: Record<string, unknown> | undefined): string {
  const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
  return (MCP_SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_PROTOCOL_VERSION;
}

/** URI 模板 → 正则 + 变量名（只支持 `{name}` 单段变量，够覆盖 freeidx://thread/{tid} 这类形态） */
function compileTemplate(template: string): { re: RegExp; keys: string[] } {
  const keys: string[] = [];
  const pattern = template
    .split(/(\{\w+\})/g)
    .map((part) => {
      const m = /^\{(\w+)\}$/.exec(part);
      if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      keys.push(m[1]!);
      return '([^/]+)';
    })
    .join('');
  return { re: new RegExp(`^${pattern}$`), keys };
}

async function callTool(req: RpcRequest, id: RpcId, deps: DispatchDeps): Promise<unknown> {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const name = typeof params.name === 'string' ? params.name : '';
  const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
    ? (params.arguments as Record<string, unknown>)
    : {};
  const tool = deps.tools.find((t) => t.name === name);
  if (!tool) return rpcError(id, RPC_ERROR.INVALID_PARAMS, `Unknown tool: ${name}`);
  if (!toolVisible(tool, deps)) {
    // 存在但无权：用 isError 而非协议错误，模型能据此改用其它工具
    return rpcResult(id, toolResult(`Tool "${name}" is not permitted for this token.`, true));
  }

  const started = Date.now();
  try {
    const out = await tool.handler(args, {
      principal: { uid: deps.actor.uid, gid: deps.actor.gid, tokenId: deps.actor.tokenId },
      db: deps.db,
      cache: deps.cache,
      env: deps.env,
      lang: deps.lang,
      ip: deps.ip,
      t: deps.t,
    });
    // 审计只覆盖写类工具：读类成功不落库（AI 客户端高频读，省 D1 写额度）
    if (tool.scope !== 'read') {
      await writeAudit(deps.db, { uid: deps.actor.uid, tokenId: deps.actor.tokenId, tool: name, ok: true, ms: Date.now() - started, ipHash: deps.ipHash });
    }
    return rpcResult(id, toolResult(out.text, out.isError === true));
  } catch (err) {
    const message = err instanceof ToolError ? err.message : 'Tool execution failed';
    if (!(err instanceof ToolError)) console.error(`[mcp] tool ${name} failed:`, err);
    await writeAudit(deps.db, { uid: deps.actor.uid, tokenId: deps.actor.tokenId, tool: name, ok: false, ms: Date.now() - started, ipHash: deps.ipHash });
    return rpcResult(id, toolResult(message, true));
  }
}

function listTools(deps: DispatchDeps): unknown {
  return deps.tools.filter((t) => toolVisible(t, deps)).map((t) => ({
    name: t.name,
    description: extText(t.description, deps.lang),
    inputSchema: t.inputSchema,
  }));
}

function resourceTemplates(deps: DispatchDeps): unknown {
  return deps.resources.map((r) => ({
    uriTemplate: r.uriTemplate,
    name: extText(r.name, deps.lang),
    mimeType: r.mimeType,
  }));
}

async function readResource(req: RpcRequest, id: RpcId, deps: DispatchDeps): Promise<unknown> {
  const uri = typeof (req.params as Record<string, unknown> | undefined)?.uri === 'string'
    ? String((req.params as Record<string, unknown>).uri)
    : '';
  if (!uri) return rpcError(id, RPC_ERROR.INVALID_PARAMS, 'uri is required');
  if (!deps.config.exposeResources) return rpcError(id, RPC_ERROR.INVALID_PARAMS, 'Resources are disabled');
  for (const res of deps.resources) {
    const { re, keys } = compileTemplate(res.uriTemplate);
    const m = re.exec(uri);
    if (!m) continue;
    const vars: Record<string, string> = {};
    keys.forEach((k, i) => {
      vars[k] = m[i + 1] ?? '';
    });
    try {
      const text = await res.handler(vars, {
        principal: { uid: deps.actor.uid, gid: deps.actor.gid, tokenId: deps.actor.tokenId },
        db: deps.db,
        cache: deps.cache,
        env: deps.env,
        lang: deps.lang,
        ip: deps.ip,
        t: deps.t,
      });
      return rpcResult(id, { contents: [{ uri, mimeType: res.mimeType, text }] });
    } catch (err) {
      if (!(err instanceof ToolError)) console.error(`[mcp] resource ${uri} failed:`, err);
      return rpcError(id, RPC_ERROR.INTERNAL_ERROR, err instanceof ToolError ? err.message : 'Resource read failed');
    }
  }
  return rpcError(id, RPC_ERROR.INVALID_PARAMS, `Unknown resource: ${uri}`);
}

const NOTIFICATIONS = new Set(['notifications/initialized', 'notifications/cancelled', 'notifications/progress', 'notifications/roots/list_changed']);

/** 单条请求分发：返回响应对象；通知类返回 null（HTTP 层回 202 无体） */
export async function dispatchOne(raw: unknown, deps: DispatchDeps): Promise<unknown | null> {
  if (!isRpcRequest(raw)) {
    return rpcError(null, RPC_ERROR.INVALID_REQUEST, 'Invalid JSON-RPC request');
  }
  const req = raw;
  const id: RpcId = req.id ?? null;
  if (NOTIFICATIONS.has(req.method)) return null;

  switch (req.method) {
    case 'initialize': {
      const params = req.params ?? {};
      return rpcResult(id, {
        protocolVersion: pickProtocolVersion(params),
        capabilities: {
          tools: { listChanged: false },
          ...(deps.config.exposeResources ? { resources: { subscribe: false, listChanged: false } } : {}),
        },
        serverInfo: { name: 'freeidx-mcp', version: '1.0.0' },
        instructions:
          'FreeIDX forum MCP server. Tools are read-only unless the token and site policy allow writes. ' +
          'All results respect the token owner permissions, moderation state and paid-content redaction.',
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: listTools(deps) });
    case 'tools/call':
      return callTool(req, id, deps);
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: deps.config.exposeResources ? resourceTemplates(deps) : [] });
    case 'resources/list':
      // 全部能力以模板形式暴露（参数化 URI），没有固定列表
      return rpcResult(id, { resources: [] });
    case 'resources/read':
      return readResource(req, id, deps);
    default:
      return rpcError(id, RPC_ERROR.METHOD_NOT_FOUND, `Method not found: ${req.method}`);
  }
}

/**
 * 批量入口：JSON-RPC 允许数组，逐条分发（单条失败不影响其它）。
 * 数组全为通知时返回 null（HTTP 202）。
 */
export async function dispatchBatch(body: unknown, deps: DispatchDeps): Promise<unknown | null> {
  if (!Array.isArray(body)) return dispatchOne(body, deps);
  if (!body.length) return rpcError(null, RPC_ERROR.INVALID_REQUEST, 'Empty batch');
  if (body.length > 20) return rpcError(null, RPC_ERROR.INVALID_REQUEST, 'Batch too large (max 20)');
  const out: unknown[] = [];
  for (const item of body) {
    const r = await dispatchOne(item, deps);
    if (r !== null) out.push(r);
  }
  return out.length ? out : null;
}

/** 工具是否属于「写」（runlevel/封禁判定按它区分读写口径） */
export function isWriteScope(scope: McpToolScope): boolean {
  return scope !== 'read';
}
