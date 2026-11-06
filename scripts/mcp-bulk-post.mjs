#!/usr/bin/env node
/**
 * MCP 批量填充：为多个账号签发临时令牌 → 以各自身份发帖 → 撤销令牌。
 *
 * 为什么按「一账号一令牌」做：MCP 写工具的作者恒为令牌持有者（thread_create 不接受 uid 参数），
 * 所以多账号填充只能一账号一令牌。详见 docs/mcp.md。
 *
 * 用法：
 *   FREEIDX_ADMIN_PASSWORD='明文密码' node scripts/mcp-bulk-post.mjs \
 *     --base https://your-site.example \
 *     --admin admin \
 *     --uids 2,3,4,5 \
 *     --posts posts.json \
 *     --concurrency 3
 *
 * posts.json：
 *   [{ "fid": 2, "subject": "标题", "message": "<p>正文</p>" }]
 *
 * 密码只从环境变量 FREEIDX_ADMIN_PASSWORD 读；--password 仅为兼容保留（会警告并留在 shell 历史）。
 * 站点开了 Turnstile 时登录会被拦，改用 --cookie 直传浏览器里已登录的 admin_at + csrf。
 *
 * 断点续跑：状态文件记录令牌与已完成的「账号×帖子」组合，重跑自动跳过。
 * 状态文件默认在系统临时目录（含令牌明文，不进仓库），可用 --state 指定固定路径。
 * 令牌明文只在该本地状态文件中保留；跑完默认撤销（--keep-tokens 可保留）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/* ------------------------------- 参数 ------------------------------- */
function arg(name, dflt = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const BASE = String(arg('base', process.env.FREEIDX_BASE || 'http://localhost:8787')).replace(/\/$/, '');
const ADMIN = String(arg('admin', arg('admin-account', '')));
const ENV_PASSWORD = process.env.FREEIDX_ADMIN_PASSWORD ?? '';
const ARG_PASSWORD = String(arg('password', ''));
const PASSWORD = ENV_PASSWORD || ARG_PASSWORD;
const COOKIE = arg('cookie', '');
const UIDS_RAW = String(arg('uids', ''));
const UIDS_FILE = arg('uids-file', '');
const POSTS_FILE = String(arg('posts', ''));
const CONCURRENCY = Math.max(1, Number(arg('concurrency', 3)) || 3);
const KEEP_TOKENS = Boolean(arg('keep-tokens', false));
const DRY_RUN = Boolean(arg('dry-run', false));
/** 待审主题自动通过：默认关闭（审核是站点的内容防线，脚本不该默认绕过） */
const APPROVE = Boolean(arg('approve', false));
/**
 * 状态文件默认落在系统临时目录：内含令牌明文，绝不能进仓库。
 * 本仓库的 .gitignore 自身不被跟踪（规则仅本地生效），所以不能依赖忽略规则兜底；
 * 需要固定到项目内时用 --state 显式指定，并自行确认已被忽略。
 */
const STATE_FILE = String(arg('state', join(tmpdir(), 'freeidx-mcp-bulk-state.json')));
const SCOPES = 'write';
const TOKEN_NAME = 'bulk-fill';

const md5Hex = (s) => createHash('md5').update(s, 'utf8').digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------- Cookie 罐 ----------------------------- */
const jar = new Map();

function storeCookies(res) {
  const list =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie')]
        : [];
  for (const sc of list) {
    const pair = String(sc).split(';')[0];
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1).trim();
    if (!v || /max-age=0/i.test(sc)) jar.delete(k);
    else jar.set(k, v);
  }
}

const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/* ------------------------------ HTTP ------------------------------ */
async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (jar.size) headers.cookie = cookieHeader();
  if (method !== 'GET') {
    // CSRF 双提交：cookie `csrf`（JS 可读）+ 头 X-CSRF-Token；/api/auth/* 已豁免
    const csrf = jar.get('csrf');
    if (csrf) headers['x-csrf-token'] = csrf;
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  storeCookies(res);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { status: res.status, json, text };
}

class McpToolError extends Error {}

async function callTool(token, name, args) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }

  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') || 60);
    const e = new Error(`限流，${wait} 秒后重试`);
    e.retryable = true;
    e.waitMs = wait * 1000;
    throw e;
  }
  if (json?.error) throw new McpToolError(json.error.message || `rpc error ${json.error.code}`);
  const r = json?.result;
  if (!r) throw new McpToolError(`响应不可解析：${text.slice(0, 200)}`);
  if (r.isError) throw new McpToolError(r.content?.[0]?.text || 'tool error');
  return JSON.parse(r.content?.[0]?.text ?? '{}');
}

/* ------------------------------ 状态 ------------------------------ */
const state = existsSync(STATE_FILE)
  ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  : { tokens: {}, done: {}, results: [] };
state.tokens ??= {};
state.done ??= {};
state.results ??= [];
const save = () => {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
};

/* --------------------------- 登录与校验 --------------------------- */
async function login() {
  if (COOKIE) {
    for (const part of String(COOKIE).split(';')) {
      const i = part.indexOf('=');
      if (i > 0) jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
    }
    if (!jar.get('admin_at')) throw new Error('--cookie 中缺少 admin_at，无法调用后台接口');
    return;
  }
  if (!ADMIN || !PASSWORD) {
    throw new Error('缺少管理员账号或密码：请设置环境变量 FREEIDX_ADMIN_PASSWORD，或用 --cookie 传入已有会话');
  }
  if (ARG_PASSWORD && !ENV_PASSWORD) {
    console.warn('[warn] 检测到 --password：明文会留在 shell 历史与进程列表，建议改用 FREEIDX_ADMIN_PASSWORD');
  }
  // 先取 csrf cookie（首访签发），否则后续写请求会被双提交拦掉
  await api('GET', '/api/health');
  const r = await api('POST', '/api/auth/login', { account: ADMIN, password: md5Hex(PASSWORD) });
  if (r.json?.code !== 0) {
    throw new Error(`管理员登录失败：code=${r.json?.code} ${r.json?.message ?? r.text.slice(0, 120)}`);
  }
  if (!jar.get('admin_at')) throw new Error('登录成功但未拿到 admin_at：该账号不是 gid=1');
  if (!jar.get('sid')) throw new Error('登录成功但未拿到 sid：--approve 需要前台会话才能调用审核接口');
}

async function resolveUid(key) {
  if (/^\d+$/.test(key)) return Number(key);
  const r = await api('GET', `/api/admin/users?type=username&keyword=${encodeURIComponent(key)}&size=1`);
  const hit = r.json?.data?.list?.[0];
  if (!hit) throw new Error(`用户名不存在：${key}`);
  return Number(hit.uid);
}

async function ensureToken(uid) {
  if (state.tokens[uid]) return state.tokens[uid];
  if (DRY_RUN) {
    state.tokens[uid] = { id: 0, token: '', prefix: 'dry-run' };
    return state.tokens[uid];
  }
  const r = await api('POST', '/api/admin/mcp/tokens', { uid, name: TOKEN_NAME, scopes: SCOPES, expireDays: 1 });
  const d = r.json?.data;
  if (r.json?.code !== 0 || !d?.token) {
    throw new Error(`为 uid=${uid} 建令牌失败：code=${r.json?.code} ${r.json?.message ?? ''}`);
  }
  state.tokens[uid] = { id: d.id, token: d.token, prefix: String(d.token).slice(0, 14) };
  save();
  console.log(`  + uid=${uid} 令牌已建（${state.tokens[uid].prefix}…）`);
  return state.tokens[uid];
}

/** 待审主题自动通过（POST /api/check，act=0 主题 / opt=1 通过） */
async function approveThread(tid) {
  const r = await api('POST', '/api/check', { act: 0, id: tid, opt: 1 });
  if (r.json?.code !== 0) throw new Error(`审核通过失败 tid=${tid}：code=${r.json?.code} ${r.json?.message ?? ''}`);
}

/* ------------------------------ 主流程 ------------------------------ */
async function main() {
  if (!POSTS_FILE) throw new Error('缺少 --posts <json 文件>');
  const posts = JSON.parse(readFileSync(POSTS_FILE, 'utf8'));
  if (!Array.isArray(posts) || !posts.length) throw new Error('posts 文件必须是非空数组');

  const keys = UIDS_RAW
    ? UIDS_RAW.split(',').map((s) => s.trim()).filter(Boolean)
    : UIDS_FILE
      ? readFileSync(String(UIDS_FILE), 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : [];
  if (!keys.length) throw new Error('缺少 --uids 或 --uids-file');

  console.log(`目标站点 ${BASE}`);
  console.log(`账号 ${keys.length} 个 / 帖子模板 ${posts.length} 条 / 并发 ${CONCURRENCY}`);
  if (APPROVE) console.log('审核：待审主题将自动通过（--approve）');
  if (DRY_RUN) console.log('（dry-run：只校验登录与参数，不建令牌、不发帖）');

  await login();

  const uids = [];
  for (const k of keys) uids.push(await resolveUid(k));
  console.log(`解析到 uid：${uids.join(',')}`);

  // 账号 × 帖子 round-robin：帖子均匀落到各账号，避免单账号刷屏
  const jobs = posts.map((post, i) => {
    const uid = uids[i % uids.length];
    return { post, uid, key: `${uid}:${i}` };
  });
  const todo = jobs.filter((j) => !state.done[j.key]);
  console.log(`待执行 ${todo.length} / 总计 ${jobs.length}（已完成 ${jobs.length - todo.length}）`);

  if (DRY_RUN) {
    for (const j of todo.slice(0, 20)) console.log(`  · uid=${j.uid} fid=${j.post.fid} ${String(j.post.subject).slice(0, 40)}`);
    if (todo.length > 20) console.log(`  … 其余 ${todo.length - 20} 条`);
    return;
  }

  for (const uid of uids) await ensureToken(uid);

  let ok = 0;
  let pending = 0;
  let approved = 0;
  let fail = 0;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const idx = cursor++;
      if (idx >= todo.length) return;
      const job = todo[idx];
      const tok = state.tokens[job.uid];
      const p = job.post;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const out = await callTool(tok.token, 'thread_create', {
            fid: Number(p.fid),
            subject: String(p.subject),
            message: String(p.message),
            ...(p.lang ? { lang: String(p.lang) } : {}),
            ...(p.tags ? { tags: p.tags } : {}),
          });

          let isPending = !!out.pending;
          if (isPending && APPROVE) {
            await approveThread(out.tid);
            isPending = false;
            approved++;
          } else if (isPending) {
            pending++;
          } else {
            ok++;
          }

          state.done[job.key] = { tid: out.tid, pending: isPending, at: Date.now() };
          state.results.push({ uid: job.uid, subject: p.subject, tid: out.tid, pending: isPending });
          save();
          console.log(`  ✓ uid=${job.uid} tid=${out.tid}${isPending ? '（待审核）' : ''} ${String(p.subject).slice(0, 30)}`);
          break;
        } catch (e) {
          if (e.retryable && attempt < 3) {
            await sleep(e.waitMs ?? 5000);
            continue;
          }
          fail++;
          state.results.push({ uid: job.uid, subject: p.subject, error: String(e.message) });
          save();
          console.error(`  ✗ uid=${job.uid} ${String(p.subject).slice(0, 30)} — ${e.message}`);
          break;
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length || 1) }, worker));

  console.log(`\n完成：成功 ${ok} / 待审核 ${pending} / 自动通过 ${approved} / 失败 ${fail}`);

  if (!KEEP_TOKENS) {
    console.log('撤销临时令牌…');
    for (const [uid, t] of Object.entries(state.tokens)) {
      if (!t.id) continue;
      const r = await api('DELETE', `/api/admin/mcp/tokens/${t.id}`);
      console.log(`  - uid=${uid} ${r.json?.code === 0 ? '已撤销' : `撤销失败 ${r.json?.message ?? ''}`}`);
      if (r.json?.code === 0) delete state.tokens[uid];
    }
    save();
  }

  console.log(`状态文件：${STATE_FILE}`);
  if (fail) process.exitCode = 1;
}

main().catch((e) => {
  console.error('失败：', e.message);
  process.exit(1);
});
