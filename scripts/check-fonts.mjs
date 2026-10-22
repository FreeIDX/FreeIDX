/**
 * webfont 子集校验（CI 门禁）。
 *
 * 防的是三类「静默劣化」：
 *  1. 词条新增了生僻字，但字体子集没重生成 → 线上出现雅黑回退（最容易被忽略）；
 *  2. globals.css 引用的文件与产物不一致（换档位时忘了改名/忘记构建）；
 *  3. 误把完整字体重提交进 public → 首屏悄悄回到 886 KiB。
 *
 * 修复方式统一为：pnpm fonts:build（必要时先改 gen-font-subset.mjs 的产物名与 globals.css 的 @font-face）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fontkit = require('fontkit');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = join(ROOT, 'apps/web/src/styles/globals.css');
const SRC = join(ROOT, 'apps/web/fonts-src/HarmonyOS_Sans_SC_Medium.subset.woff2');
const I18N = join(ROOT, 'packages/shared/src/i18n');
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const MAX_BYTES = 520 * 1024;
const MIN_BYTES = 300 * 1024;
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

const errors = [];
const fail = (msg) => errors.push(msg);

/* ---------- 1. CSS 引用 ↔ 产物一致性 ---------- */
const css = readFileSync(CSS, 'utf8');
const urls = [...css.matchAll(/url\('\/fonts\/([^']+\.woff2)'\)/g)].map((m) => m[1]);
const harmony = urls.filter((name) => name.startsWith('HarmonyOS'));
if (harmony.length !== 1) {
  fail(`globals.css 的 HarmonyOS 字体引用应恰好 1 处，实际 ${harmony.length} 处：${harmony.join(', ') || '无'}`);
}
const fontFile = harmony[0] ? join(ROOT, 'apps/web/public/fonts', harmony[0]) : '';
if (fontFile && !existsSync(fontFile)) {
  fail(`globals.css 引用的字体不存在：public/fonts/${harmony[0]}`);
}

/* ---------- 2. 体积闸门（防止完整字体重回 public） ---------- */
let subsetSize = 0;
if (fontFile && existsSync(fontFile)) {
  subsetSize = readFileSync(fontFile).length;
  if (subsetSize > MAX_BYTES) fail(`产物 ${kb(subsetSize)} 超过上限 ${kb(MAX_BYTES)}（是否提交了完整字体？）`);
  if (subsetSize < MIN_BYTES) fail(`产物 ${kb(subsetSize)} 低于下限 ${kb(MIN_BYTES)}（字表可能被误改）`);
}

/* ---------- 3. 词条覆盖 + 非 CJK 码点保留 ---------- */
if (!existsSync(SRC)) {
  fail(`缺少源字体 apps/web/fonts-src/${basename(SRC)}，无法校验覆盖`);
} else if (fontFile && existsSync(fontFile)) {
  const srcCps = new Set(fontkit.openSync(SRC).characterSet);
  const subCps = new Set(fontkit.openSync(fontFile).characterSet);

  const missing = new Set();
  for (const sub of ['gen', 'override']) {
    for (const file of readdirSync(join(I18N, sub)).filter((f) => f.endsWith('.json'))) {
      const json = JSON.parse(readFileSync(join(I18N, sub, file), 'utf8'));
      for (const ns of ['bbs', 'admin']) {
        for (const value of Object.values(json[ns] ?? {})) {
          for (const ch of String(value)) {
            if (!CJK.test(ch)) continue;
            const cp = ch.codePointAt(0);
            if (srcCps.has(cp) && !subCps.has(cp)) missing.add(ch);
          }
        }
      }
    }
  }
  if (missing.size) fail(`词条用字在子集中缺失（会雅黑回退）：${[...missing].join('')}`);

  const lost = [...srcCps].filter((cp) => !CJK.test(String.fromCodePoint(cp)) && !subCps.has(cp));
  if (lost.length) {
    fail(`非 CJK 码点丢失 ${lost.length} 个（英文/数字可能回退）：${lost.slice(0, 10).map((c) => 'U+' + c.toString(16).toUpperCase()).join(' ')}`);
  }
}

if (errors.length) {
  console.error('✗ 字体校验失败：');
  for (const e of errors) console.error('  -', e);
  console.error('\n修复：pnpm fonts:build（必要时改产物名并同步 globals.css 的 @font-face）');
  process.exit(1);
}

console.log(`✓ 字体校验通过：${basename(fontFile)} ${kb(subsetSize)}，词条用字与非 CJK 码点全覆盖`);
