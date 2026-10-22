#!/usr/bin/env node
/**
 * i18n 代码引用一致性门禁（CI 硬门禁，TypeScript AST 实现）。
 *
 * 校验三件事，任一不通过即 exit 1：
 *  1) 前端 t('key') 与 `textKey: 'key'` 常量引用的 key，必须存在于合并词典（gen ∪ override，zh-cn 为源）。
 *  2) 后端 t('ns.key') / t0('ns.key') 引用的 key，必须存在于 apps/api/src/core/i18n/index.ts 的 API_MESSAGES。
 *  3) 动态模板 key（t(`prefix_${x}`)）的前缀必须能命中字典中至少一个键。
 *
 * 逃生舱：scripts/i18n-allowlist.json —— 登记「项目新增、字典暂缺」的 key（仅告警，不失败），
 * 及无法静态提取的动态 key 前缀。每条都应在补完翻译后从白名单移除。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMergedDicts } from './lib/load-i18n.mjs';
import { scanSource } from './lib/scan-ts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = join(root, 'apps', 'web', 'src');
const API_SRC = join(root, 'apps', 'api', 'src');
const API_I18N = join(API_SRC, 'core', 'i18n', 'index.ts');
const ALLOW_PATH = join(root, 'scripts', 'i18n-allowlist.json');

const allow = existsSync(ALLOW_PATH) ? JSON.parse(readFileSync(ALLOW_PATH, 'utf8')) : {};
const allowFront = allow.frontend ?? {};
const allowApi = allow.api ?? {};
const allowDyn = allow.dynamicPrefixes ?? [];

/** 前端字典键集（zh-cn 为源语言，gen ∪ override 两层合并） */
const { dicts } = loadMergedDicts(root);
const zh = dicts['zh-cn'] ?? { bbs: {}, admin: {} };
const frontKeys = new Set([...Object.keys(zh.bbs), ...Object.keys(zh.admin)]);

/** 后端词条键集 */
const apiSrc = readFileSync(API_I18N, 'utf8');
const apiKeys = new Set([...apiSrc.matchAll(/^\s*'([A-Za-z0-9_.]+)':\s*M\(/gm)].map((m) => m[1]));

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) out.push(join(e.parentPath ?? e.path ?? dir, e.name));
  }
  return out;
}

/** @type {Map<string, string[]>} key → [相对路径] */
const frontUsed = new Map();
const dynPrefixes = new Map();
const apiUsed = new Map();
const record = (map, key, file) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(relative(root, file).replace(/\\/g, '/'));
};

for (const file of walk(WEB_SRC)) {
  const { calls, dynamic, textKeys } = scanSource(file, readFileSync(file, 'utf8'));
  for (const k of calls) record(frontUsed, k, file);
  for (const k of textKeys) record(frontUsed, k, file);
  for (const p of dynamic) record(dynPrefixes, p, file);
}

for (const file of walk(API_SRC)) {
  const { calls } = scanSource(file, readFileSync(file, 'utf8'));
  for (const k of calls) record(apiUsed, k, file);
}

const errors = [];

const frontMissing = [...frontUsed.keys()].filter((k) => !frontKeys.has(k) && !(k in allowFront));
for (const k of frontMissing) errors.push(`[前端 key 未定义] ${k}  ← ${frontUsed.get(k).slice(0, 3).join(', ')}${frontUsed.get(k).length > 3 ? ` 等 ${frontUsed.get(k).length} 处` : ''}`);

for (const [pfx, where] of dynPrefixes) {
  if (!pfx) continue;
  const hit = [...frontKeys].some((k) => k.startsWith(pfx));
  if (!hit && !allowDyn.includes(pfx)) errors.push(`[动态 key 前缀无匹配] \`${pfx}\${…}\` ← ${where.slice(0, 3).join(', ')}（字典无 \`${pfx}\` 前缀的键，请补词条或在 i18n-allowlist.json 登记）`);
}

const apiMissing = [...apiUsed.keys()].filter((k) => !apiKeys.has(k) && !(k in allowApi));
for (const k of apiMissing) errors.push(`[后端 key 未定义] ${k}  ← ${apiUsed.get(k).slice(0, 3).join(', ')}${apiUsed.get(k).length > 3 ? ` 等 ${apiUsed.get(k).length} 处` : ''}`);

const staleFront = Object.keys(allowFront).filter((k) => !frontUsed.has(k));
const staleApi = Object.keys(allowApi).filter((k) => !apiUsed.has(k));

console.log(`[i18n] 前端静态 key ${frontUsed.size} 个 / 后端 key ${apiUsed.size} 个 / 动态前缀 ${dynPrefixes.size} 个（AST 扫描）`);
if (staleFront.length) console.log(`[i18n] 提示：前端白名单中 ${staleFront.length} 条已不再被引用，可清理：${staleFront.slice(0, 8).join(', ')}${staleFront.length > 8 ? ' …' : ''}`);
if (staleApi.length) console.log(`[i18n] 提示：后端白名单中 ${staleApi.length} 条已不再被引用，可清理：${staleApi.slice(0, 8).join(', ')}${staleApi.length > 8 ? ' …' : ''}`);

const pending = [...Object.keys(allowFront).filter((k) => frontUsed.has(k)), ...Object.keys(allowApi).filter((k) => apiUsed.has(k))];
if (pending.length) {
  console.warn(`[i18n] 提示：白名单中 ${pending.length} 个 key 仍待补 10 语言翻译（当前仅回落中文），补完后请从 i18n-allowlist.json 移除：${pending.slice(0, 8).join(', ')}${pending.length > 8 ? ' …' : ''}`);
}

if (errors.length) {
  console.error(`\n[i18n] 代码引用一致性失败，共 ${errors.length} 处：`);
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}
console.log('[i18n] 代码引用一致性通过：所有 t(...) 引用的 key 均已定义。');