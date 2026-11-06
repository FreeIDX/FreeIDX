/**
 * MCP 协议层（§ 扩展契约 ⑨）：JSON-RPC 2.0 编解码 + 协议版本 + 结果封装。
 *
 * 为什么是「子集」而不是引入 @modelcontextprotocol/sdk：
 *  1. 本项目只需要无状态 Streamable HTTP 的请求-响应面（tools/resources/ping），
 *     不需要 SSE 长连接、session、sampling、roots —— 那些依赖 Node/DO 设施；
 *  2. Workers 免费层的核心预算是指令数与时长，能自实现 ~200 行就别背一个 SDK 包；
 *  3. 协议面收窄后可用性只取决于本文件，升级 MCP 版本时改动可控。
 *
 * 无状态实现的两条硬约束（客户端常见误判点）：
 *  - 不发 Mcp-Session-Id：服务端不保存任何会话，客户端每次请求都必须自带身份；
 *  - 通知类请求（notifications/*）一律 202 无响应体，否则客户端会等一个永不发生的 id。
 */

/** JSON-RPC 2.0 标准错误码（-32768..-32000 为协议保留段） */
export const RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** 协议基线：initialize 协商时命中列表则回同版本，否则回基线 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const MCP_SUPPORTED_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;

export type RpcId = string | number | null;

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: RpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcSuccess {
  jsonrpc: '2.0';
  id: RpcId;
  result: unknown;
}

export interface RpcFailure {
  jsonrpc: '2.0';
  id: RpcId;
  error: { code: number; message: string; data?: unknown };
}

/** 请求体形态校验：批量请求里出现非对象元素时按 INVALID_REQUEST 逐条回错，不整体 500 */
export function isRpcRequest(v: unknown): v is RpcRequest {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return o.jsonrpc === '2.0' && typeof o.method === 'string' && o.method.length > 0;
}

export function rpcResult(id: RpcId, result: unknown): RpcSuccess {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id: RpcId, code: number, message: string, data?: unknown): RpcFailure {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

/** 工具结果封装：MCP 的 content 只认 content blocks，文本块是唯一通用形态 */
export function toolResult(text: string, isError = false): { content: { type: 'text'; text: string }[]; isError?: true } {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

/** 结构化数据 → 工具文本块（缩进便于模型阅读；超长交给调用方裁剪） */
export function jsonText(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}
