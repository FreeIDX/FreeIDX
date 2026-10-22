#!/usr/bin/env node
/**
 * 生成「内置用户组名」跨语言索引：packages/shared/src/i18n/group-names.json
 *
 * 背景：builtinGroupName() 需要判断 DB 里的 bbs_group.name 是否等于「任一语言包」的 group_{gid}
 * 译文（相等即视为站长未自定义组名，应随界面语言翻译）。原实现遍历全部词典，这要求 10 个语言包
 * 全部静态打进前端主包；词典改为按需动态加载后不能再依赖全量词典，故把这 14 个键 × 10 语言
 * 预生成为独立索引（约 2KB），使该判定保持同步且与词典加载解耦。
 *
 * 产物为 JSON 而非 TS：这里是「数据」不是「代码」，且 CI 的硬编码中文门禁只扫 .ts/.tsx，
 * 放在 JSON 里可与 gen/*.json 保持同一性质（词典数据），不会被误判为界面文案。
 *
 * 用法：node scripts/gen-i18n-groupnames.mjs          生成/覆盖
 *       node scripts/gen-i18n-groupnames.mjs --check  校验已生成文件最新（CI 门禁）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMergedDicts } from './lib/load-i18n.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(root, 'packages', 'shared', 'src', 'i18n', 'group-names.json');
const check = process.argv.includes('--check');

const { locales, dicts } = loadMergedDicts(root);
const sorted = [...locales].sort();

const table = {};
for (const loc of sorted) {
  const keys = Object.keys(dicts[loc].bbs)
    .filter((k) => k.startsWith('group_'))
    .sort();
  const row = {};
  for (const k of keys) row[k] = dicts[loc].bbs[k];
  table[loc] = row;
}

const out = {
  _comment:
    '本文件由 scripts/gen-i18n-groupnames.mjs 自动生成，请勿手改。变更组名词条后运行 pnpm i18n:types 重新生成。作用：builtinGroupName() 判定「DB 组名是否为任一语言的内置名」所需的跨语言索引（仅 group_* 键）。',
  table,
};
const content = JSON.stringify(out, null, 2) + '\n';

if (check) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (cur !== content) {
    console.error('[i18n] 组名索引漂移：请运行 node scripts/gen-i18n-groupnames.mjs');
    process.exit(1);
  }
  console.log(`[i18n] 组名索引已最新：${sorted.length} 个 locale`);
} else {
  writeFileSync(OUT, content);
  console.log(`[i18n] 组名索引已生成：${sorted.length} 个 locale → ${OUT}`);
}
