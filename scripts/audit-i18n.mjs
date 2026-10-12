#!/usr/bin/env node
/**
 * i18n 语言包完整性门禁（CI 硬门禁）：
 * 以 zh-cn 为基线，校验其余 9 个 locale 的 bbs / admin 命名空间：
 *  - 缺键：locale 缺少 zh-cn 拥有的键
 *  - 多键：locale 拥有 zh-cn 没有的键
 *  - 占位符：{name} 集合不一致
 * 词典来源 = gen/*.json（PHP 源生成）∪ override/*.json（项目新增词条），任一问题即 exit 1。
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMergedDicts } from './lib/load-i18n.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'zh-cn';
const { locales, dicts } = loadMergedDicts(root);

const base = dicts[BASE];
if (!base) {
  console.error('[i18n] 缺少基线语言包 zh-cn');
  process.exit(1);
}

const ph = (s) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
let issues = 0;

for (const loc of locales) {
  if (loc === BASE) continue;
  for (const ns of ['bbs', 'admin']) {
    const b = base[ns] ?? {};
    const c = dicts[loc][ns] ?? {};
    const missing = Object.keys(b).filter((k) => !(k in c));
    const extra = Object.keys(c).filter((k) => !(k in b));
    if (missing.length) {
      issues++;
      console.error(`[缺键] ${loc}/${ns} (${missing.length}): ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ' …' : ''}`);
    }
    if (extra.length) {
      issues++;
      console.error(`[多键] ${loc}/${ns} (${extra.length}): ${extra.slice(0, 12).join(', ')}${extra.length > 12 ? ' …' : ''}`);
    }
    for (const k of Object.keys(b)) {
      if (!(k in c)) continue;
      const a = ph(b[k]);
      const d = ph(c[k]);
      const diff = [...a].filter((x) => !d.has(x)).concat([...d].filter((x) => !a.has(x)));
      if (diff.length) {
        issues++;
        console.error(`[占位符] ${loc}/${ns}.${k}: 差异 ${diff.join(', ')}`);
      }
    }
  }
}

console.log(`[i18n] 语言包完整性：${locales.length} 个 locale，基线 ${BASE}（bbs:${Object.keys(base.bbs ?? {}).length} admin:${Object.keys(base.admin ?? {}).length}）`);
for (const loc of locales) console.log('  ' + loc.padEnd(6), 'bbs:' + Object.keys(dicts[loc].bbs ?? {}).length, 'admin:' + Object.keys(dicts[loc].admin ?? {}).length);

if (issues) {
  console.error(`\n[i18n] 语言包完整性失败，共 ${issues} 类问题。`);
  process.exit(1);
}
console.log('[i18n] 语言包完整性通过：全部 locale 键覆盖 100%、占位符一致。');
