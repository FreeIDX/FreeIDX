/**
 * 生成前台 webfont 子集（构建期一次性执行，产物入库）。
 *
 * ## v1 → v2：从「单文件」改为「按字频分片」
 *
 * v1 是单文件：源字体 885.7 KiB（6579 码点）→「常用 3500 字 ∪ 站点词条用字」≈ 454 KiB（-49%）。
 * 它仍是首访最大的单一资源（首屏 JS+CSS 合计仅约 160 KiB br），而且**只要页面上出现一个字
 * 不在常见的几百字里，整个 454 KiB 就全量下载** —— 帖子里一个地名、一个人名就够触发。
 *
 * v2 沿用同一份字表，用 `unicode-range` 切成 `SLICES` 片，片序按「被用到的可能性」从高到低：
 *   - 第 0 片 = 站点词条用字 ∪ 非 CJK 码点 ∪ 语料高频字（UI 文案 + 最常用汉字）；
 *     任何页面都会渲染导航/按钮/标签，所以这一片必然命中，且保证 UI 文案零回退；
 *   - 其余片按词频顺序等分，只有当前页面**真实渲染到**片内某个字时浏览器才去取。
 *
 * 实测（同一份字表、按线上真实页面渲染到的字符统计；v1 单文件为 454 KiB）：
 *   任意页面的 UI 文案        1 片  122.7 KiB  (-73%)
 *   首页（UI + 列表标题）     2 片  156.4 KiB  (-66%)
 *   帖子页（含正文全文）      5 片  259.4 KiB  (-43%)
 *
 * 三个旋钮：`SLICES`（片数）、`GAP`（合并相邻码点空洞，压住 unicode-range 条目数）、
 * `TIER0_MIN`（第 0 片最少字形数）。
 *
 * ## 字表与排序语料（全部仓库内置，离线可复现）
 *
 *   - `scripts/data/hanzi-3500.txt`：《现代汉语常用字表》3500 字，**拼音序**；
 *   - `packages/shared/src/i18n` 全语言词条：UI 用字，第 0 片强制收录；
 *   - `docs/**\/*.md` 中文文档：作为正文语料给 3500 字排词频序。
 *
 * 为什么需要语料：3500 字表是拼音序（阿啊哎哀…八巴叭吧），直接按表顺序切片，
 * 一页正文的字会均匀散落在所有片里，等于没有分片。用真实中文语料排出词频序后，
 * 高频字集中在前面的片里，一页的命中才能收敛到少数几片。
 *
 * 代价与口径：新增/大改 docs 会改变排序 → 重跑 `pnpm fonts:build` 即可（不会让已有覆盖失效，
 * 只会让分片边界变化）。改档位/换字体时改 `VERSION` 再执行。
 *
 * 校验：`node scripts/check-fonts.mjs`（CI 门禁：覆盖、体积、CSS 同步）。
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const subsetFont = require('subset-font');
const fontkit = require('fontkit');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps/web/fonts-src/HarmonyOS_Sans_SC_Medium.subset.woff2');
const OUT_DIR = join(ROOT, 'apps/web/public/fonts');
const CSS_OUT = join(ROOT, 'apps/web/src/styles/font-faces.generated.css');
const LIST = join(ROOT, 'scripts/data/hanzi-3500.txt');
const I18N = join(ROOT, 'packages/shared/src/i18n');
const DOCS = join(ROOT, 'docs');

const FAMILY = 'HarmonyOS_Sans_SC_Medium';
const VERSION = 'v2';
/** 分片数：12 片时「UI 片 + 1~2 个正文档」≈ 150~260 KiB；再细分收益 <10% 而请求数翻倍 */
const SLICES = 12;
/** 合并相邻码点空洞的上限：空洞内的码点会被并入本片，用于把 unicode-range 条目数压到可控 */
const GAP = 12;
/** 第 0 片最少收录的字形数（UI 用字之外再补最常用字，让正文页也尽量不再追加片） */
const TIER0_MIN = 900;
/** 体积闸门（合计含分片头部开销与「吞空洞」补进来的相邻字形，比 v1 单文件高约 10%） */
const MAX_TOTAL = 560 * 1024;
const MAX_FIRST = 180 * 1024;

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const kb = (n) => `${(n / 1024).toFixed(1)} KiB`;

if (!existsSync(SRC)) {
  console.error(`✗ 缺少源字体：${SRC}\n  该文件是再生成的唯一来源（已从 public 移出，不随部署下发）。`);
  process.exit(1);
}
if (!existsSync(OUT_DIR)) {
  console.error(`✗ 缺少输出目录：${OUT_DIR}`);
  process.exit(1);
}

/* ---------- 1. 字表基座 ---------- */
const listChars = [
  ...new Set(
    readFileSync(LIST, 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('#'))
      .join('')
      .split('')
      .filter((ch) => CJK.test(ch)),
  ),
];
/** 表内原始顺序（拼音序），只作为词频相同时的稳定兜底 */
const listOrder = new Map(listChars.map((ch, i) => [ch, i]));

/* ---------- 2. 语料：站点词条（UI 用字）+ docs 中文文档（正文词频） ---------- */
const uiChars = new Set();
const freq = new Map();
const bump = (text, weight = 1) => {
  for (const ch of String(text)) {
    if (!CJK.test(ch)) continue;
    uiChars.add(ch);
    freq.set(ch, (freq.get(ch) ?? 0) + weight);
  }
};

for (const sub of ['gen', 'override']) {
  for (const file of readdirSync(join(I18N, sub)).filter((f) => f.endsWith('.json'))) {
    const json = JSON.parse(readFileSync(join(I18N, sub, file), 'utf8'));
    for (const ns of ['bbs', 'admin']) {
      for (const value of Object.values(json[ns] ?? {})) bump(value);
    }
  }
}
const uiCharCount = uiChars.size;

/** docs 下的中文文档：只用于给 3500 字定序，不给 UI 用字加权（UI 用字已被第 0 片强制收录） */
function walkMd(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkMd(p, out);
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}
let docFiles = 0;
let docChars = 0;
if (existsSync(DOCS)) {
  for (const file of walkMd(DOCS)) {
    const text = readFileSync(file, 'utf8');
    for (const ch of text) {
      if (!CJK.test(ch)) continue;
      freq.set(ch, (freq.get(ch) ?? 0) + 1);
      docChars++;
    }
    docFiles++;
  }
}

/* ---------- 3. 源字体码点 ---------- */
const srcBuffer = readFileSync(SRC);
const srcFont = fontkit.openSync(SRC);
const srcCps = new Set(srcFont.characterSet);
const nonCjkCps = [...srcCps].filter((cp) => !CJK.test(String.fromCodePoint(cp)));

/* ---------- 4. 全量字形（与 v1 完全一致：常用 3500 ∪ 词条用字 ∪ 非 CJK） ---------- */
const wanted = new Map(); // cp -> char
for (const ch of listChars) if (srcCps.has(ch.codePointAt(0))) wanted.set(ch.codePointAt(0), ch);
for (const ch of uiChars) if (srcCps.has(ch.codePointAt(0))) wanted.set(ch.codePointAt(0), ch);
for (const cp of nonCjkCps) wanted.set(cp, String.fromCodePoint(cp));
const droppedUi = [...uiChars].filter((ch) => !srcCps.has(ch.codePointAt(0)));

/* ---------- 5. 排序：UI 用字固定在最前，其余按词频降序（拼音序兜底） ---------- */
/* 非 CJK 码点不需要排序（全部落在第 0 片），这里只排 CJK 字 */
const ranked = [...wanted.keys()]
  .filter((cp) => CJK.test(String.fromCodePoint(cp)))
  .sort((a, b) => {
    const fa = freq.get(String.fromCodePoint(a)) ?? 0;
    const fb = freq.get(String.fromCodePoint(b)) ?? 0;
    if (fa !== fb) return fb - fa;
    return (listOrder.get(String.fromCodePoint(a)) ?? 1e9) - (listOrder.get(String.fromCodePoint(b)) ?? 1e9);
  });

/* 第 0 片：非 CJK 全收（英文/数字/标点必用）+ UI 用字全收 + 高频字补到 TIER0_MIN */
const tier0 = new Set(nonCjkCps);
for (const ch of uiChars) if (srcCps.has(ch.codePointAt(0))) tier0.add(ch.codePointAt(0));
for (const cp of ranked) {
  if (tier0.size >= TIER0_MIN) break;
  tier0.add(cp);
}

/* 其余按词频顺序等分。
 * 试过「前细后粗」的递增尺寸（正文用字集中在词频靠前的区间，理论上更省），实测反而更差：
 * 片一细，一页正文就会横跨十几个片，请求数翻倍而字节数只降几个百分点。等分是请求数与
 * 字节数的均衡点（实测 12 片等分：首页 2 片 156 KiB，帖子页 5 片 259 KiB）。 */
const rest = ranked.filter((cp) => !tier0.has(cp));
const tailCount = Math.max(1, SLICES - 1);
const per = Math.ceil(rest.length / tailCount);
const slices = [tier0];
for (let i = 0; i < tailCount; i++) {
  const chunk = rest.slice(i * per, (i + 1) * per);
  if (chunk.length) slices.push(new Set(chunk));
}

/* ---------- 6. unicode-range 归并 ----------
 * 同一片内的码点未必连续，逐个列出会让 CSS 膨胀到几十 KB。做法：按码点升序扫描，
 * 空洞 ≤ GAP 且空洞内的码点（a）存在于源字体、（b）还没被前面的片占用，就一并吞进来。
 * 吞噬必须同时加入字体字形集，否则 unicode-range 声明了文件里没有的字形 → 该字静默回退。
 */
const taken = new Set();
const finalSlices = [];
for (const slice of slices) {
  const own = [...slice].filter((cp) => !taken.has(cp) && srcCps.has(cp)).sort((a, b) => a - b);
  if (!own.length) continue;
  const glyphs = new Set();
  const ranges = [];
  let start = own[0];
  let prev = own[0];
  glyphs.add(prev);
  taken.add(prev);
  for (let i = 1; i < own.length; i++) {
    const cp = own[i];
    let mergeable = cp - prev <= GAP + 1;
    if (mergeable) {
      for (let x = prev + 1; x < cp; x++) {
        if (taken.has(x) || !srcCps.has(x)) {
          mergeable = false;
          break;
        }
      }
    }
    if (mergeable) {
      for (let x = prev + 1; x <= cp; x++) {
        glyphs.add(x);
        taken.add(x);
      }
      prev = cp;
      continue;
    }
    ranges.push([start, prev]);
    start = cp;
    prev = cp;
    glyphs.add(cp);
    taken.add(cp);
  }
  ranges.push([start, prev]);
  finalSlices.push({ glyphs, ranges });
}

/* ---------- 7. 逐片生成 woff2 ---------- */
const files = [];
for (let i = 0; i < finalSlices.length; i++) {
  const { glyphs } = finalSlices[i];
  const text = [...glyphs].map((cp) => String.fromCodePoint(cp)).join('');
  const buf = await subsetFont(srcBuffer, text, { targetFormat: 'woff2' });
  const name = `${FAMILY}.subset.${VERSION}-${String(i).padStart(2, '0')}.woff2`;
  writeFileSync(join(OUT_DIR, name), buf);
  files.push({ name, bytes: buf.length, glyphs: glyphs.size, ranges: finalSlices[i].ranges });
}

/* 旧版本产物清理：/fonts/* 是 immutable，文件名不升版老访客永远不会重取（见 styles/globals.css） */
let removed = [];
for (const f of readdirSync(OUT_DIR)) {
  if (f.startsWith(FAMILY) && f.endsWith('.woff2') && !files.some((x) => x.name === f)) {
    unlinkSync(join(OUT_DIR, f));
    removed.push(f);
  }
}

/* ---------- 8. 生成 CSS ---------- */
const rangeText = (ranges) =>
  ranges.map(([a, b]) => (a === b ? `U+${a.toString(16).toUpperCase()}` : `U+${a.toString(16).toUpperCase()}-${b.toString(16).toUpperCase()}`)).join(',');

const cssLines = [
  '/*',
  ' * 由 `pnpm fonts:build`（scripts/gen-font-subset.mjs）生成，请勿手改。',
  ` * ${files.length} 片按字频排序：第 00 片 = UI 文案 + 最常用汉字（任何页面必然命中），`,
  ' * 其余片由浏览器按 unicode-range 在真实渲染到片内字符时按需下载。',
  ' * 校验：pnpm fonts:check。改分片参数后需重跑生成并提交产物。',
  ' */',
];
for (const f of files) {
  cssLines.push(
    `@font-face{font-family:'${FAMILY}';font-style:normal;font-display:swap;` +
      `src:url('/fonts/${f.name}') format('woff2');unicode-range:${rangeText(f.ranges)};}`,
  );
}
const css = cssLines.join('\n') + '\n';
writeFileSync(CSS_OUT, css);

/* ---------- 9. 报告 ---------- */
const total = files.reduce((a, f) => a + f.bytes, 0);
const rangeCount = files.reduce((a, f) => a + f.ranges.length, 0);
console.log('源字体    :', kb(srcBuffer.length), `(${srcCps.size} 码点)`);
console.log('常用字表  :', listChars.length, '字');
console.log('词条用字  :', uiCharCount, '字（源字体缺', droppedUi.length, '字，无法保留：', droppedUi.join('') || '无', '）');
console.log('非 CJK    :', nonCjkCps.length, '码点（全部并入第 00 片）');
console.log('正文语料  :', docFiles, '个 md /', docChars, '个汉字（仅用于定词频序）');
console.log('字形合计  :', wanted.size, '（与 v1 单文件完全一致）');
console.log('');
console.log('分片明细：');
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  console.log(
    `  ${String(i).padStart(2, '0')}  ${kb(f.bytes).padStart(10)}  ${String(f.glyphs).padStart(4)} 字形  ` +
      `${String(f.ranges.length).padStart(4)} 段  ${f.name}`,
  );
}
console.log('');
console.log('合计      :', kb(total), '| 分片数', files.length, '| unicode-range 段数', rangeCount);
console.log('CSS       :', kb(Buffer.byteLength(css)), '→', CSS_OUT);
if (removed.length) console.log('已清理旧产物:', removed.join(', '));
console.log('v1 单文件 :', kb(454 * 1024), '→ 首页（仅 UI 片 ~', kb(files[0].bytes), '）');

/* ---------- 10. 闸门 ---------- */
const problems = [];
if (total > MAX_TOTAL) problems.push(`字形合计 ${kb(total)} 超过上限 ${kb(MAX_TOTAL)}（字表可能被误改）`);
if (files[0].bytes > MAX_FIRST) problems.push(`第 00 片 ${kb(files[0].bytes)} 超过上限 ${kb(MAX_FIRST)}（UI 片是必下载项）`);
/* 分片并集只允许多、不允许少：多出来的是「吞空洞」补进来的相邻字形（无害，反而少一个片） */
const missing = [...wanted.keys()].filter((cp) => !taken.has(cp));
if (missing.length) {
  problems.push(`有 ${missing.length} 个字形未被任何分片收录：${missing.slice(0, 20).map((c) => 'U+' + c.toString(16).toUpperCase()).join(' ')}`);
}
if (problems.length) {
  console.error('\n✗ 生成结果不合规：');
  for (const p of problems) console.error('  -', p);
  process.exit(1);
}
