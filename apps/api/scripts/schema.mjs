/**
 * D1 schema 快照工具（迁移保留增量历史，终态以 schema.sql 为唯一可读事实源）。
 *
 * 防的是「迁移文件都对、终态却悄悄漂移」：
 *  1. 新增迁移漏了某条热路径索引（0021/0022 就是这样漏掉 bbs_favorite 的 tid 查询）；
 *  2. 有人直接改本地/远端库，迁移文件与真实结构不再一致；
 *  3. 迁移被合并或重排后，新装库与老库结构分叉——CI 只跑新装库，天然测不出这种分叉。
 *
 * 用法：
 *   node scripts/schema.mjs dump    # 由本地终态库导出 schema.sql（改完迁移就重跑并提交）
 *   node scripts/schema.mjs check   # CI 门禁：schema.sql 与迁移产出必须逐对象一致
 *
 * 前置：本地库需先应用全部迁移（pnpm db:apply），否则 check 会把「尚未应用的迁移」误报成漂移。
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = join(API_ROOT, 'schema.sql');

/**
 * D1 / SQLite 内部表不进快照。
 * 刻意用黑名单而非 `bbs_` 前缀白名单：将来加任何前缀的业务表都不会被静默漏掉。
 */
const INTERNAL = new Set([
  'd1_migrations',
  '_cf_KV',
  '_cf_METADATA',
  'sqlite_sequence',
  'sqlite_stat1',
]);

const RE_TABLE = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[\w$]+)/i;
const RE_INDEX = /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[\w$]+)/i;

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
/**
 * 比较用的归一化：除了压空白，还要规范标点两侧空格。
 * 原因：SQLite 对 ALTER TABLE ADD COLUMN 的表会留下 `DEFAULT 0\n, gid ...` 这种
 * 「逗号在行首」的原文，而快照渲染成 `DEFAULT 0,\n  gid ...`，纯粹靠压空白对不齐。
 */
const normalize = (sql) =>
  sql
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*\)\s*/g, ')')
    .replace(/\s*;\s*$/, ';')
    .trim();
const toPosix = (p) => p.replace(/\\/g, '/');

function run(args) {
  try {
    return execSync(`npx ${args}`, {
      cwd: API_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' },
    });
  } catch (err) {
    console.error(`命令失败：npx ${args}`);
    console.error([err.stdout, err.stderr].filter(Boolean).join('\n').trim());
    process.exit(1);
  }
}

/** 由本地 D1 库导出无数据的 SQL（PRAGMA + CREATE TABLE + CREATE INDEX），并解析成对象列表。 */
function exportObjects() {
  const out = join(tmpdir(), `freeidx-schema-${process.pid}.sql`);
  run(`wrangler d1 export freeidx --local --no-data --output="${toPosix(out)}"`);
  const raw = readFileSync(out, 'utf8');
  unlinkSync(out);
  return parseObjects(raw);
}

/**
 * 按行首 CREATE 切块解析。导出文件里每条语句都从行首 CREATE 开始，
 * 且 CREATE TABLE 的括号体内不含「行首 CREATE」，切开是安全的。
 */
function parseObjects(raw) {
  const objects = [];
  for (const chunk of raw.split(/^(?=CREATE\s)/m)) {
    // 剥离整行注释：导出文件本身没有注释，但 schema.sql 里的段标题（-- ===== 索引 =====）
    // 会粘在上一条语句尾部，不剥掉会让最后一个表被误判为「定义变化」。
    const text = chunk
      .split('\n')
      .filter((line) => !/^\s*--/.test(line))
      .join('\n')
      .trim();
    if (!text) continue;
    const head = text.split('\n', 1)[0];
    let kind;
    let name;
    let m;
    if ((m = RE_TABLE.exec(head))) kind = 'table';
    else if ((m = RE_INDEX.exec(head))) kind = 'index';
    else continue; // PRAGMA / 其他语句
    name = m[1].replace(/"/g, '');
    if (INTERNAL.has(name)) continue;
    objects.push({ kind, name, text, body: normalize(text) });
  }
  return objects.sort(byName);
}

/** 按括号深度切分（只切顶层逗号），保留内部 `PRIMARY KEY (a, b)` 等结构。 */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of body) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function bodyOf(createTable) {
  const open = createTable.indexOf('(');
  const close = createTable.lastIndexOf(')');
  if (open < 0 || close < 0) return null;
  return createTable.slice(open + 1, close);
}

/** CREATE TABLE 的顶层列名（跳过表级约束）；用于把「定义变化」细化为「加了哪些列」。 */
function columnsOf(createTable) {
  const body = bodyOf(createTable);
  if (body === null) return [];
  return splitTopLevel(body)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((p) => !/^(CONSTRAINT|PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i.test(p))
    .map((p) => p.split(' ')[0].replace(/"/g, ''));
}

/**
 * 把 CREATE TABLE 重排成「每列一行」。
 * 必要性：ALTER TABLE ADD COLUMN 追加的列被 SQLite 挤在同一行，直接导出几乎无法阅读。
 * 安全性：check 比较用空白归一化后的文本，重排不影响比对结果。
 */
function formatTable(text) {
  const body = bodyOf(text);
  if (body === null) return text;
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  const head = text.slice(0, open).trim();
  const tail = text.slice(close + 1).trim() || ';';
  const items = splitTopLevel(body)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return `${head} (\n${items.map((i) => `  ${i}`).join(',\n')}\n)${tail}`;
}

function renderHeader(tables, indexes) {
  return `-- FreeIDX 终态 schema 快照 —— 自动生成，请勿手工编辑
--
-- 生成：pnpm --filter @freeidx/api db:schema:dump
-- 校验：pnpm --filter @freeidx/api db:schema:check（CI 门禁，不一致即红）
--
-- 来源：migrations/*.sql 全量应用后的本地 D1 库（sqlite_master 导出，无数据）
-- 用途：唯一可读的终态事实源。migrations/ 保留为增量历史与升级路径，
--       本文件只描述「全部应用完之后长什么样」，方便零 JOIN 地看懂全库结构。
--
-- 改完迁移后若 check 报「新增/缺失/定义变化」，说明本文件没同步：
--   pnpm --filter @freeidx/api db:apply && pnpm --filter @freeidx/api db:schema:dump
-- 并把 migrations/ 与 schema.sql 一起提交。
--
-- 对象统计：${tables.length} 表 / ${indexes.length} 索引
`;
}

function render(snapshotObjects) {
  const tables = snapshotObjects.filter((o) => o.kind === 'table').sort(byName);
  const indexes = snapshotObjects.filter((o) => o.kind === 'index').sort(byName);
  const blocks = [renderHeader(tables, indexes)];

  blocks.push(`-- ===== 表（${tables.length}）=====`);
  for (const t of tables) blocks.push(`${formatTable(t.text)}\n`);

  blocks.push(`-- ===== 索引（${indexes.length}）=====`);
  for (const i of indexes) blocks.push(`${i.text}\n`);

  return blocks.join('\n');
}

function assertNotPending() {
  const out = run('wrangler d1 migrations list freeidx --local');
  if (/Migrations to be applied/i.test(out)) {
    console.error('本地库还有未应用的迁移，先执行：pnpm --filter @freeidx/api db:apply');
    process.exit(1);
  }
}

function dump() {
  assertNotPending();
  const objects = exportObjects();
  const tables = objects.filter((o) => o.kind === 'table');
  if (tables.length === 0) {
    console.error('导出结果为空：本地库未建表？先执行 pnpm --filter @freeidx/api db:apply');
    process.exit(1);
  }
  writeFileSync(SNAPSHOT, render(objects), 'utf8');
  const indexes = objects.length - tables.length;
  console.log(`已写入 ${SNAPSHOT}（${tables.length} 表 / ${indexes} 索引）`);
}

function check() {
  assertNotPending();

  if (!existsSync(SNAPSHOT)) {
    console.error('缺少 schema.sql：pnpm --filter @freeidx/api db:schema:dump 后提交');
    process.exit(1);
  }

  const actual = exportObjects();
  const expected = parseObjects(readFileSync(SNAPSHOT, 'utf8'));
  if (actual.length === 0) {
    console.error('导出结果为空：本地库未建表？先执行 pnpm --filter @freeidx/api db:apply');
    process.exit(1);
  }

  const actualMap = new Map(actual.map((o) => [`${o.kind}:${o.name}`, o]));
  const expectedMap = new Map(expected.map((o) => [`${o.kind}:${o.name}`, o]));

  const added = [...actualMap.keys()].filter((k) => !expectedMap.has(k)).sort();
  const removed = [...expectedMap.keys()].filter((k) => !actualMap.has(k)).sort();
  const changed = [];

  for (const [key, now] of actualMap) {
    const before = expectedMap.get(key);
    if (!before || before.body === now.body) continue;
    if (now.kind === 'table') {
      const a = columnsOf(before.text);
      const b = columnsOf(now.text);
      const plus = b.filter((c) => !a.includes(c));
      const minus = a.filter((c) => !b.includes(c));
      if (plus.length || minus.length) {
        changed.push(
          `${now.name}（表）：${[...plus.map((c) => `+${c}`), ...minus.map((c) => `-${c}`)].join(', ')}`,
        );
        continue;
      }
    }
    changed.push(`${now.name}（${now.kind === 'table' ? '表' : '索引'}）：定义文本不同`);
  }

  if (!added.length && !removed.length && !changed.length) {
    const tables = actual.filter((o) => o.kind === 'table').length;
    console.log(`schema.sql 与迁移终态一致（${tables} 表 / ${actual.length - tables} 索引）`);
    return;
  }

  const lines = ['', 'schema.sql 与迁移终态不一致（D1 已应用全部迁移的前提下）：', ''];
  if (added.length) {
    lines.push('  库中新增、schema.sql 缺失：');
    for (const k of added) lines.push(`    + ${k.replace(':', ' ')}`);
    lines.push('');
  }
  if (removed.length) {
    lines.push('  schema.sql 有、库中已不存在：');
    for (const k of removed) lines.push(`    - ${k.replace(':', ' ')}`);
    lines.push('');
  }
  if (changed.length) {
    lines.push('  定义变化：');
    for (const c of changed) lines.push(`    ~ ${c}`);
    lines.push('');
  }
  lines.push('修复：pnpm --filter @freeidx/api db:schema:dump 后把 schema.sql 与迁移一起提交。');
  console.error(lines.join('\n'));
  process.exit(1);
}

const command = process.argv[2];
if (command === 'dump') dump();
else if (command === 'check') check();
else {
  console.error('用法：node scripts/schema.mjs <dump|check>');
  process.exit(1);
}
