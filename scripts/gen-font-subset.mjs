/**
 * 生成前台 webfont 子集（构建期一次性执行，产物入库）。
 *
 * 为什么这样做（实测数据见 docs 与提交说明）：
 *   - 原字体 885.7 KiB / 6619 字形，是首屏最大的单一资源（首屏 JS+CSS 仅约 160 KiB gzip）；
 *   - 站点 UI 词条实际只用 639 个汉字，中文长文样本 763 个；
 *   - 保留「常用 3500 字 ∪ 站点用字」后产物约 454 KiB（-49%），长文按字数回退率 0.08%；
 *   - unicode-range 切成 100 片实测只有 -46%~-59%，且引入 100+ 文件与 CSS 膨胀，故不采用。
 *
 * 字表口径：scripts/data/hanzi-3500.txt（《现代汉语常用字表》3500）+ 全部语言词条中的 CJK 用字
 * + 源字体里的非 CJK 码点（ASCII/数字/标点等，体积仅数 KB，保留可避免英文与数字回退）。
 *
 * 换档位 / 换字体时：改 VERSION 再执行，并同步 apps/web/src/styles/globals.css 的 @font-face。
 * 校验：node scripts/check-fonts.mjs（CI 门禁，会核对词条覆盖与 CSS 引用一致性）。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const subsetFont = require('subset-font');
const fontkit = require('fontkit');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps/web/fonts-src/HarmonyOS_Sans_SC_Medium.subset.woff2');
const OUT = join(ROOT, 'apps/web/public/fonts/HarmonyOS_Sans_SC_Medium.subset.v1.woff2');
const LIST = join(ROOT, 'scripts/data/hanzi-3500.txt');
const I18N = join(ROOT, 'packages/shared/src/i18n');
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

if (!existsSync(SRC)) {
  console.error(`✗ 缺少源字体：${SRC}\n  该文件是再生成的唯一来源（已从 public 移出，不随部署下发）。`);
  process.exit(1);
}

/* 1. 3500 常用字（忽略以 # 开头的来源说明行） */
const listChars = [...new Set(
  readFileSync(LIST, 'utf8')
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('#'))
    .join('')
    .split('')
    .filter((ch) => CJK.test(ch)),
)];

/* 2. 各语言词条里的 CJK 用字（后台/前台都算：后台文案同样走这套字体） */
const dictChars = new Set();
for (const sub of ['gen', 'override']) {
  for (const file of readdirSync(join(I18N, sub)).filter((f) => f.endsWith('.json'))) {
    const json = JSON.parse(readFileSync(join(I18N, sub, file), 'utf8'));
    for (const ns of ['bbs', 'admin']) {
      for (const value of Object.values(json[ns] ?? {})) {
        for (const ch of String(value)) if (CJK.test(ch)) dictChars.add(ch);
      }
    }
  }
}

/* 3. 源字体的非 CJK 码点（ASCII 字母数字、全角符号等）原样保留 */
const srcBuffer = readFileSync(SRC);
const srcFont = fontkit.openSync(SRC);
const srcCps = new Set(srcFont.characterSet);
const nonCjkCps = [...srcCps].filter((cp) => !CJK.test(String.fromCodePoint(cp)));

const wanted = new Set();
for (const ch of listChars) if (srcCps.has(ch.codePointAt(0))) wanted.add(ch);
for (const ch of dictChars) if (srcCps.has(ch.codePointAt(0))) wanted.add(ch);
for (const cp of nonCjkCps) wanted.add(String.fromCodePoint(cp));

const dropped = [...dictChars].filter((ch) => !srcCps.has(ch.codePointAt(0)));

const out = await subsetFont(srcBuffer, [...wanted].join(''), { targetFormat: 'woff2' });
writeFileSync(OUT, out);

const ratio = out.length / srcBuffer.length;
console.log('源字体      :', kb(srcBuffer.length), `(${srcCps.size} 码点)`);
console.log('常用字表    :', listChars.length, '字');
console.log('词条用字    :', dictChars.size, '字（源字体缺', dropped.length, '字，无法保留：', dropped.join('') || '无', '）');
console.log('非 CJK 保留 :', nonCjkCps.length, '码点');
console.log('产物        :', kb(out.length), `(${wanted.size} 字形, 相对源字体 ${(ratio * 100).toFixed(0)}%)`);
console.log('输出        :', OUT);

if (ratio > 0.75) {
  console.error('\n✗ 产物过大（>75%），字表可能没生效，请检查 scripts/data/hanzi-3500.txt');
  process.exit(1);
}
