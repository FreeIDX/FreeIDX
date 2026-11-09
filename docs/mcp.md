# FreeIDX MCP 服务说明

> 对应实现：`apps/api/src/extensions/mcp/`（插件 id=`mcp`）。本文档描述协议端点、鉴权与授权模型、能力清单及运维要点。

## 1 定位

MCP（Model Context Protocol）服务把论坛内容以标准协议暴露给 AI 客户端（Claude Desktop、Cursor 等）。

插件本身**只做三件事**：协议解析、身份鉴权、结果出口。具体能力由各插件通过**扩展点契约 ⑨**（`contributeMcpTool` / `contributeMcpResource`）贡献，因此新增能力不需要改动 MCP 插件本体 —— 这也是它与其他插件解耦、可独立停用的前提。

设计取向是「AI 能看到的，绝不多于同一个人用浏览器能看到的」：所有工具一律复用核心权限、审核与付费墙实现，不另写一套判定。

## 2 端点与传输

| 项 | 值 |
|---|---|
| 端点 | `POST /mcp` |
| 传输 | `streamable-http`，**无状态** |
| 会话 | 不签发 `Mcp-Session-Id`，不落会话表，不使用 Durable Object |
| 请求体上限 | 256 KB（先校验 `content-length`，再按实读长度复检，防 chunked 绕过） |
| 批量 | 支持 JSON-RPC 批量请求，逐条回执 |

**为什么是 `/mcp` 而不是 `/api/mcp`**：契约 ③ `registerRoute` 只接管非 `/api` 路径，且 CSRF 双提交只校验 `/api/*` —— MCP 客户端是服务端进程，没有 Cookie，走不到 CSRF 链路。路径放在 `/api` 下会被中间件链直接拦死。

无状态的代价与收益：一次 POST 一次响应，免费层不产生任何长连接时长与额外计费资源；代价是不支持服务端推送与服务端会话状态。

**停用行为**：插件停用或路径拼错时，`/mcp*` 一律返回 `404` + JSON-RPC 错误体（而不是落入 SPA 壳返回 `text/html`），避免客户端只报「响应无法解析」而无法定位。

## 3 协议支持

基线版本 `2025-06-18`，同时接受 `2025-03-26`、`2024-11-05`。`initialize` 时客户端版本命中列表则回同版本，否则回基线。

| 方法 | 说明 |
|---|---|
| `initialize` | 返回协议版本、serverInfo、capabilities |
| `ping` | 存活探测，返回空结果 |
| `tools/list` | 返回当前身份**可见**的工具（已按授权裁剪） |
| `tools/call` | 调用工具，业务失败以 `isError` 返回 |
| `resources/templates/list` | 返回资源模板（`exposeResources` 关闭时为空） |
| `resources/list` | 恒为空数组 —— 所有资源以参数化模板形式暴露 |
| `resources/read` | 按 `freeidx://` URI 读取内容 |
| 通知类（`notifications/*`） | 不产生响应体 |
| 其他 | `-32601 Method not found` |

标准错误码段：`-32700` 解析错误、`-32600` 请求无效、`-32601` 方法不存在、`-32602` 参数无效、`-32603` 内部错误。

## 4 鉴权

唯一身份载体是**个人访问令牌**（Bearer）。Cookie 双轨（`sid`/`at`）在这里完全不可用 —— MCP 客户端不带浏览器会话。

```
Authorization: Bearer fi_mcp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

| 项 | 实现 |
|---|---|
| 明文形态 | `fi_mcp_` 前缀 + 32 字节随机数的 base64url（共 50 字符） |
| 存储 | 库中只存 SHA-256 指纹（唯一索引），**明文仅在创建响应中出现一次** |
| 辨识 | 额外存前缀列（`fi_mcp_` + 8 字符），后台靠它识别，不构成秘密 |
| 校验 | 按指纹查 `bbs_mcp_token` 并 LEFT JOIN `bbs_user`，单次查询取全权限位 |
| 实时性 | **每次调用都重新查用户**，不做跨请求缓存 —— 改组/封禁/删号即时生效 |

401 的判定顺序：缺失或格式非法 → 令牌不存在 → 已吊销 → 已过期 → 持有者已被删除（孤儿令牌一并失效）。

## 5 授权模型

工具可见性与可调用性是**三层交集**，任一不满足即不可见（写类工具整体从 `tools/list` 消失，模型不会误选后再撞错误）：

1. **令牌档位** `scopes`：`read` / `write` / `admin`
2. **站点档位** `enabledScopes`：插件配置，站点策略上限
3. **站点策略**（与核心中间件同口径复刻）
   - `runlevel`：站点关闭/仅管理员/只读档位下写类工具不可用；管理员恒直通
   - 小黑屋：`READ`/`LOGIN` 位读写全拒，`MUTE` 位只拒写
   - 注册审核：`ok != 1` 的账号禁止写入（读取仍允许）

`/mcp` 在中间件层被豁免（无 Cookie，`loadViewer` 判不出身份），因此档位语义在 `auth.ts` 中复刻。**改动 `middleware/runlevel.ts` 或 `middleware/ban.ts` 时必须同步这两处**，否则会出现「网页拦住、AI 照样写」的绕过面。

### 5.1 版块配置工具（`forum_get` / `forum_update`）的额外闸门

这类工具改的是**站点配置**而非内容，因此在上述三层之外再加两道，任一不满足即不可见或返回 `isError`：

4. **站点点开关** `forumWriteOn`（出厂关闭）：关闭时两个工具直接不进 `tools/list`；
5. **持有者必须是管理员**：`admin` 档位由管理员发放，但拿令牌的人未必是管理员，因此请求期再校验令牌持有者 `gid=1`。

`enabledScopes` 未含 `admin`、或站点处于只读档位（`runlevel`）时，同样不可见/不可调用 —— 与写工具共用同一套请求期裁剪。

## 6 工具清单

### 6.1 只读（scope=`read`）

| 工具 | 用途 |
|---|---|
| `forum_list` | 版块列表（按访问者可见性过滤） |
| `thread_list` | 主题列表（支持版块、游标分页、排序、精华过滤） |
| `thread_get` | 主题详情（含首帖，付费段已脱敏） |
| `thread_replies` | 楼层列表（分页） |
| `search` | 全站搜索（标题/正文口径与 HTTP 端一致） |
| `user_get` | 用户公开资料 |
| `site_info` | 站点信息与运行数据 |

### 6.2 写入（scope=`write`，出厂不可用）

| 工具 | 用途 |
|---|---|
| `thread_create` | 发主题（走核心写链路：审核、积分、事件、人机验证已有前置） |
| `reply_create` | 回帖 |

写工具**照常贡献**到运行时，可见性由请求期「令牌档位 ∩ 站点 `enabledScopes` ∩ 站点写闸门」裁剪。默认配置 `enabledScopes=read`，因此出厂状态下客户端看不到任何写工具。

### 6.3 版块配置（scope=`admin`，出厂关闭）

| 工具 | 用途 |
|---|---|
| `forum_get` | 读取版块简介、公告、SEO 标题、SEO 关键词及其多语言映射 |
| `forum_update` | 修改上述字段（merge 语义：只写显式传入的键；空串/空对象 = 清空，展示回退主字段） |

- 需同时满足：站点开关 `forumWriteOn=1` + `enabledScopes` 含 `admin` + 令牌含 `admin` + 持有者 `gid=1`。
- 多语言键只接受站点支持的语言（`AVAILABLE_LOCALES`），非法语言静默丢弃；文本归一化与后台表单同一实现（`normNameI18n` / `stringifyNameI18n`）。
- 写后主动失效 `forumlist` 缓存，前台与 SEO 产物下一次请求即读到新文案（版块页预渲染 HTML 的 Cache API 副本仍按 1 小时 TTL 自然过期）。
- 调用会落 `bbs_mcp_audit`（`scope != read` 的写类工具统一审计）。

## 7 资源模板

| URI 模板 | 内容 |
|---|---|
| `freeidx://thread/{tid}` | 主题内容（JSON） |
| `freeidx://forum/{fid}` | 版块内容（JSON） |

受 `exposeResources` 开关控制；资源读取与工具走同一套权限、审核与付费墙判定。

## 8 安全不变量

三条硬约束，任何一条破了都意味着「AI 能看到的比网页多」：

1. **权限只走 `core/access.ts`**：版块可见性用 `forumListAccessFilter` / `forumAccessUser`，列表行用 `threadListAccessFilter`，绝不自行判断 gid。
2. **审核只走 `core/check.ts`**：`ok != 1` 的行一律按 `canSeeUnapproved` 过滤（`see_check` 组与作者例外）。
3. **付费墙只在服务端脱敏**：付费段正文用 `redactPaidBlocks` 抹除后再交给模型，与 `GET /api/threads/:tid` 同一口径，不依赖前端隐藏。

输出刻意「瘦」：只给模型判断所需字段，不含 `avatar`/`images`/`userip` 等展示位 —— 既省 token 也减少内部字段外泄面。

## 9 反滥用

| 手段 | 口径 |
|---|---|
| 限流 | 每令牌每分钟 N 次（`rateLimitPerMin`，0=不限），超限 `429` + `retry-after: 60` |
| 限流存储 | **per-isolate 内存计数**，零 D1/KV 写；多 isolate 各自计数，用精度换额度 |
| 写放大抑制 | `last_used_at` 按 60 秒窗口节流回写（与 `session.last_date` 同一思路） |
| 审计 | 只落「失败调用 + 写类工具」，读类成功不落库，避免 AI 高频读打爆日写额度 |
| 审计清理 | `mcp:audit-gc` 每日执行，保留 30 天 |

## 10 配置项

后台路径：插件中心 → MCP 服务。配置存 kv `ext:mcp:config`（非敏感，无 secret 项）。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabledScopes` | 后台多选（存逗号分隔文本） | `read` | `read`=只读、`write`=含写入、`admin`=含版务 |
| `toolDenylist` | 后台多选（存逗号分隔文本） | 空 | 勾选即不向客户端展示的工具名；候选为本插件自带工具，配置里的额外名字也会显示为勾选项 |
| `rateLimitPerMin` | 后台下拉（0/30/60/120/300/600） | `60` | 每令牌每分钟调用数，0=不限 |
| `exposeResources` | 开关 | 开 | 是否允许客户端以 `freeidx://` 挂载内容 |
| `forumWriteOn` | 开关 | 关 | 是否暴露 `forum_get` / `forum_update`（版块文案配置）；打开后仍需 `admin` 档位与管理员持有者 |

出厂 `enable: 0`：未配置令牌前不暴露任何入口。

## 11 数据表

| 表 | 用途 | 索引 |
|---|---|---|
| `bbs_mcp_token` | 令牌（指纹、前缀、scopes、过期、吊销、最近使用） | `token_hash` 唯一、`(uid, create_date)` |
| `bbs_mcp_audit` | 调用审计（失败与写类） | `create_date`、`(tool, create_date)` |

## 12 后台接口

均要求 `gid=1` 且校验 `admin_at`：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/admin/mcp/tokens` | 令牌列表（只回前缀，永不回明文） |
| `POST` | `/api/admin/mcp/tokens` | 创建令牌，**明文仅在本响应出现一次** |
| `DELETE` | `/api/admin/mcp/tokens/:id` | 吊销令牌 |

## 13 客户端接入

以 Claude Desktop 为例（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "freeidx": {
      "type": "http",
      "url": "https://your-site.example/mcp",
      "headers": { "Authorization": "Bearer fi_mcp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
    }
  }
}
```

Cursor 等支持自定义 HTTP MCP server 的客户端同理：URL 填站点 `/mcp`，请求头带 `Authorization: Bearer <令牌>`。

CORS 已放行 `Authorization`、`Mcp-Protocol-Version`、`MCP-Protocol-Version` 请求头，浏览器型 MCP 客户端的预检可以正常通过。

## 14 错误语义

区分三类失败，客户端可据此决定重试策略：

| 层 | 表现 | 典型原因 |
|---|---|---|
| HTTP | `401` | 令牌缺失/非法/吊销/过期/持有者删除 |
| HTTP | `403` + JSON-RPC error | 站点档位、小黑屋、注册审核拒绝 |
| HTTP | `413` / `429` | 请求体超限 / 限流 |
| JSON-RPC | `error.code`（-32700 等） | 协议层问题：解析失败、方法不存在、参数非法 |
| 工具结果 | `isError: true` | 业务失败（主题不存在、无权限等），让模型自行纠正参数 |

**业务失败不占用协议错误码** —— 这是刻意设计：模型能读懂 `isError` 文本并重试，而协议错误会让部分客户端直接放弃。

## 15 故障排查

| 现象 | 排查方向 |
|---|---|
| 客户端报「无法解析响应」 | 确认地址是 `/mcp`（不是 `/api/mcp`），且插件已启用；停用时返回 JSON-RPC 404 而非 HTML |
| `401` | 令牌是否已吊销/过期；前缀是否为 `fi_mcp_` |
| 看不到写工具 | 检查令牌 `scopes`、站点 `enabledScopes`（默认 `read`），以及 `toolDenylist` 是否含该工具 |
| 看不到 `forum_update` | 站点开关 `forumWriteOn` 是否打开；`enabledScopes` 是否含 `admin`；令牌 `scopes` 是否含 `admin`；令牌持有者是否 `gid=1` |
| 写操作用 `403` 拒绝 | 站点 `runlevel` 是否只读、账号是否被禁言/待审核 |
| `429` | 命中 `rateLimitPerMin`；注意计数是 per-isolate 的，多节点各自计数 |
| 工具列表里少了某个插件的能力 | 该插件是否启用；它的 `setup` 是否调用了 `contributeMcpTool` |

## 16 边界

明确不做的事：

- 不支持 SSE 长连接与服务端主动推送（无状态设计）
- 不支持 OAuth 2.1 授权流（个人访问令牌是唯一形态）
- 不提供跨站联邦或代理转发
- 不实现 MCP 的 sampling / roots 等客户端侧能力

---

相关文档：[开发架构文档](./开发架构文档.md)（第 10 章 扩展机制）、[主题开发指南](./theme-dev-guide.md)
