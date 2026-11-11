/**
 * webfont 子集校验（CI 门禁）。
 *
 * 防的是四类「静默劣化」：
 *  1. 词条新增了生僻字，但字体子集没重生成 → 线上出现雅黑回退（最容易被忽略）；
 *  2. `unicode-range` 声明了某片覆盖某字，而该片 woff2 里其实没有这个字形
 *     （分片后新增的失效模式：浏览器按 range 选中该片、取不到字形 → 静默回退，且不会再试其它片）；
 *  3. globals.css 没引入生成的分片 CSS，或引用的文件不存在（改了样式忘了构建）；
 *  4. 误把完整字体重提交进 public、或分片数量/unicode-range 条目数失控（首屏悄悄变重）。
 *
 * 修复方式统一为：pnpm fonts:build（必要时先改 gen-font-subset.mjs 的 VERSION 与分片参数）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fontkit = require('fontkit');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GLOBALS = join(ROOT, 'apps/web/src/styles/globals.css');
const CSS = join(ROOT, 'apps/web/src/styles/font-faces.generated.css');
const FONT_DIR = join(ROOT, 'apps/web/public/fonts');
const SRC = join(ROOT, 'apps/web/fonts-src/HarmonyOS_Sans_SC_Medium.subset.woff2');
const I18N = join(ROOT, 'packages/shared/src/i18n');
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** 体积 / 规模闸门（v2 分片口径，见 gen-font-subset.mjs） */
const MAX_TOTAL = 560 * 1024;
const MAX_FIRST = 180 * 1024;
const MAX_RANGES = 4000;
const MAX_CSS = 40 * 1024;
const MIN_SLICES = 2;
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

const errors = [];
const fail = (msg) => errors.push(msg);

/* ---------- 1. 样式接线：globals.css 必须引入生成的分片 CSS ---------- */
const globals = readFileSync(GLOBALS, 'utf8');
if (!/@import\s+'\.\/font-faces\.generated\.css';/.test(globals)) {
  fail('globals.css 未引入 ./font-faces.generated.css（@import 必须在文件顶部）');
}
/* 旧口径残留：正文分片的 @font-face 只应存在于生成文件里。
 * （得意黑 SmileySans 是后台「正文样式=2」的单文件覆盖，不属于正文分片，仍在 globals.css 里，此处不过问） */
const strayHarmony = [...globals.matchAll(/url\('\/fonts\/(HarmonyOS[^']+\.woff2)'\)/g)].map((m) => m[1]);
if (strayHarmony.length) {
  fail(`globals.css 仍有硬编码的 HarmonyOS 字体 URL：${strayHarmony.join(', ')}（应只在生成的分片 CSS 里）`);
}

if (!existsSync(CSS)) {
  fail('缺少 apps/web/src/styles/font-faces.generated.css，请执行 pnpm fonts:build');
}

/* ---------- 2. 解析分片 CSS ---------- */
const faces = [];
if (existsSync(CSS)) {
  const css = readFileSync(CSS, 'utf8');
  if (css.length > MAX_CSS) fail(`分片 CSS ${kb(css.length)} 超过上限 ${kb(MAX_CSS)}（unicode-range 条目失控？）`);

  for (const m of css.matchAll(/@font-face\{([^}]+)\}/g)) {
    const block = m[1];
    const url = /url\('\/fonts\/([^']+\.woff2)'\)/.exec(block);
    const range = /unicode-range:([^;]+);/.exec(block);
    if (!url || !range) {
      fail(`@font-face 缺少 url 或 unicode-range：${block.slice(0, 80)}…`);
      continue;
    }
    const ranges = range[1]
      .split(',')
      .map((s) => s.trim().replace(/^U\+/i, '').split('-'))
      .map(([a, b]) => [parseInt(a, 16), parseInt(b ?? a, 16)]);
    if (ranges.some(([a, b]) => !Number.isFinite(a) || !Number.isFinite(b) || b < a)) {
      fail(`unicode-range 解析失败：${url[1]}`);
      continue;
    }
    const file = join(FONT_DIR, url[1]);
    if (!existsSync(file)) {
      fail(`CSS 引用的字体分片不存在：public/fonts/${url[1]}`);
      continue;
    }
    faces.push({ name: url[1], bytes: readFileSync(file).length, ranges, cps: new Set(fontkit.openSync(file).characterSet) });
  }

  if (faces.length < MIN_SLICES) fail(`分片数应 ≥ ${MIN_SLICES}，实际 ${faces.length}`);
  const rangeCount = faces.reduce((a, f) => a + f.ranges.length, 0);
  if (rangeCount > MAX_RANGES) fail(`unicode-range 条目 ${rangeCount} 超过上限 ${MAX_RANGES}（CSS 会拖慢首屏）`);

  const names = faces.map((f) => f.name);
  if (new Set(names).size !== names.length) fail('存在重复引用的分片文件名');

  /* ---------- 3. 体积闸门 ---------- */
  const total = faces.reduce((a, f) => a + f.bytes, 0);
  if (total > MAX_TOTAL) fail(`分片合计 ${kb(total)} 超过上限 ${kb(MAX_TOTAL)}（是否提交了完整字体？）`);
  if (faces[0] && faces[0].bytes > MAX_FIRST) {
    fail(`第 00 片 ${kb(faces[0].bytes)} 超过上限 ${kb(MAX_FIRST)}（UI 片是任何页面的必下载项）`);
  }
}

/* ---------- 4. 覆盖校验：词条用字 + 非 CJK 码点 ----------
 * 判据是「浏览器视角」：按 unicode-range 找到第一个命中的片，该片 woff2 必须真的含这个字形。
 * 只查 range 不查字形是不够的 —— 分片后最容易出的错正是「range 声明了、字形没进去」。
 */
function faceFor(cp) {
  return faces.find((f) => f.ranges.some(([a, b]) => cp >= a && cp <= b));
}

if (!existsSync(SRC)) {
  fail('缺少源字体 apps/web/fonts-src/HarmonyOS_Sans_SC_Medium.subset.woff2，无法校验覆盖');
} else if (faces.length) {
  const srcCps = new Set(fontkit.openSync(SRC).characterSet);

  const missingRange = new Set();
  const missingGlyph = new Map(); // 片名 -> 缺字形
  const check = (ch) => {
    const cp = ch.codePointAt(0);
    const face = faceFor(cp);
    if (!face) {
      missingRange.add(ch);
      return;
    }
    if (!face.cps.has(cp)) {
      const list = missingGlyph.get(face.name) ?? [];
      list.push(ch);
      missingGlyph.set(face.name, list);
    }
  };

  for (const sub of ['gen', 'override']) {
    const dir = join(I18N, sub);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const json = JSON.parse(readFileSync(join(I18N, sub, file), 'utf8'));
      for (const ns of ['bbs', 'admin']) {
        for (const value of Object.values(json[ns] ?? {})) {
          for (const ch of String(value)) if (CJK.test(ch) && srcCps.has(ch.codePointAt(0))) check(ch);
        }
      }
    }
  }
  if (missingRange.size) {
    fail(`词条用字没有任何分片声明覆盖（会雅黑回退）：${[...missingRange].join('')}`);
  }
  for (const [name, chars] of missingGlyph) {
    fail(`${name} 的 unicode-range 声明覆盖但文件缺字形（静默回退）：${[...new Set(chars)].join('')}`);
  }

  const lost = [...srcCps].filter((cp) => {
    if (CJK.test(String.fromCodePoint(cp))) return false;
    const face = faceFor(cp);
    return !face || !face.cps.has(cp);
  });
  if (lost.length) {
    fail(
      `非 CJK 码点未覆盖 ${lost.length} 个（英文/数字可能回退）：` +
        lost.slice(0, 10).map((c) => 'U+' + c.toString(16).toUpperCase()).join(' '),
    );
  }
}

if (errors.length) {
  console.error('✗ 字体校验失败：');
  for (const e of errors) console.error('  -', e);
  console.error('\n修复：pnpm fonts:build（必要时改 gen-font-subset.mjs 的 VERSION 并同步 CSS 产物）');
  process.exit(1);
}

const total = faces.reduce((a, f) => a + f.bytes, 0);
console.log(
  `✓ 字体校验通过：${faces.length} 片 / ${kb(total)}（第 00 片 ${kb(faces[0].bytes)}，` +
    `${faces.reduce((a, f) => a + f.ranges.length, 0)} 段 unicode-range），词条用字与非 CJK 码点全覆盖`,
);
