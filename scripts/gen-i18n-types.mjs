#!/usr/bin/env node
/**
 * 由词典生成 key 联合类型，供前端/后端 t() 的入参做编译期约束（拼错 key 直接报错）。
 * 来源：gen ∪ override（前端）+ apps/api API_MESSAGES（后端）+ scripts/i18n-allowlist.json（登记项）。
 * 用法：node scripts/gen-i18n-types.mjs          生成/覆盖
 *       node scripts/gen-i18n-types.mjs --check  校验已生成文件最新（CI 门禁）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMergedDicts } from './lib/load-i18n.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'packages', 'shared', 'src', 'i18n', 'gen', 'keys.ts');
const API_I18N = join(root, 'apps', 'api', 'src', 'core', 'i18n', 'index.ts');
const ALLOW = join(root, 'scripts', 'i18n-allowlist.json');
const check = process.argv.includes('--check');

const { dicts } = loadMergedDicts(root);
const zh = dicts['zh-cn'] ?? { bbs: {}, admin: {} };
const allow = existsSync(ALLOW) ? JSON.parse(readFileSync(ALLOW, 'utf8')) : {};
const allowFront = Object.keys(allow.frontend ?? {});
const allowApi = Object.keys(allow.api ?? {});

const frontKeys = new Set([...Object.keys(zh.bbs), ...allowFront]);
const adminOnly = new Set([...Object.keys(zh.admin), ...allowFront]);
for (const k of frontKeys) adminOnly.delete(k);

const apiSrc = readFileSync(API_I18N, 'utf8');
const apiKeys = new Set([
  ...[...apiSrc.matchAll(/^\s*'([A-Za-z0-9_.]+)':\s*M\(/gm)].map((m) => m[1]),
  ...allowApi,
]);

const unionType = (name, keys, extendsType) => {
  const arr = [...keys].sort();
  const body = arr.map((k) => `  | '${k}'`).join('\n');
  const first = extendsType ? `  | ${extendsType}\n` : '';
  return `export type ${name} =\n${first}${body};`;
};

const content = `/* eslint-disable */
// 本文件由 scripts/gen-i18n-types.mjs 自动生成，请勿手改。变更词典后运行 pnpm i18n:types 重新生成。
// 来源：packages/shared/src/i18n/{gen,override} ∪ scripts/i18n-allowlist.json；后端来自 apps/api/src/core/i18n/index.ts。

${unionType('FrontKey', frontKeys)}

${unionType('AdminKey', adminOnly, 'FrontKey')}

${unionType('ApiKey', apiKeys)}
`;

if (check) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (cur !== content) {
    console.error('[i18n] key 类型漂移：请运行 node scripts/gen-i18n-types.mjs');
    process.exit(1);
  }
  console.log(`[i18n] key 类型已最新：FrontKey ${frontKeys.size} / AdminKey ${frontKeys.size + adminOnly.size} / ApiKey ${apiKeys.size}`);
} else {
  writeFileSync(OUT, content);
  console.log(`[i18n] key 类型已生成：FrontKey ${frontKeys.size} / AdminKey ${frontKeys.size + adminOnly.size} / ApiKey ${apiKeys.size} → ${OUT}`);
}