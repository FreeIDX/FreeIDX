-- 0026 MCP 服务插件（id=mcp）：个人访问令牌 + 调用审计
--
-- 为什么令牌单独成表而不是复用 session：
--   session 是浏览器会话（sid cookie + 60s 心跳刷新），MCP 客户端是机器进程，
--   没有 cookie 也不该有心跳写；两者混用会让「在线人数」被 AI 客户端污染，
--   并且令牌需要独立的 scopes / 过期 / 撤销语义。
--
-- 安全：token_hash = SHA-256(明文)，明文只在创建响应出现一次；
--   token_prefix 仅为后台辨识（前 16 字符，单靠它无法反推令牌）。
CREATE TABLE IF NOT EXISTS bbs_mcp_token (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  token_prefix TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'read',
  expire_at INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0
);

-- 唯一索引即验签入口：每次调用按 hash 精确命中一行，O(1)
CREATE UNIQUE INDEX IF NOT EXISTS bbs_mcp_token_hash ON bbs_mcp_token (token_hash);

-- 后台列表按「谁建的/何时建」排序，并支撑按用户清理
CREATE INDEX IF NOT EXISTS bbs_mcp_token_uid ON bbs_mcp_token (uid, create_date DESC);

-- 调用审计：只落「失败 + 写类工具」，读类成功不写（AI 客户端高频读，省免费层 10 万行写/日）
CREATE TABLE IF NOT EXISTS bbs_mcp_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL DEFAULT 0,
  token_id INTEGER NOT NULL DEFAULT 0,
  tool TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 0,
  ms INTEGER NOT NULL DEFAULT 0,
  ip_hash TEXT NOT NULL DEFAULT '',
  create_date INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS bbs_mcp_audit_date ON bbs_mcp_audit (create_date DESC);
CREATE INDEX IF NOT EXISTS bbs_mcp_audit_tool ON bbs_mcp_audit (tool, create_date DESC);
