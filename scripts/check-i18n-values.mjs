#!/usr/bin/env node
/**
 * i18n 值级门禁（CI 硬门禁）：键齐了不等于翻译了。
 * 拦截四类「词典里的漏翻译」：
 *  1) EN_COPY —— 非 en-us 语言的值为英文原句（当年机翻时被整段复制）；
 *  2) ZH_COPY —— 非中文语言的值仍是 zh-cn 中文原句；
 *  3) CJK_PUNCT —— 非 CJK 语言里残留全角/中日韩标点（：，。「」【】…）；
 *  4) TW_SIMP —— zh-tw 里残留简体字形。
 * 覆盖前端词典（gen ∪ override）与后端 API_MESSAGES 的 M() 构造。
 * 白名单：scripts/i18n-value-allowlist.json（术语借词如 VIP/URL、有意不译的专名）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMergedDicts } from './lib/load-i18n.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ALLOW_PATH = join(root, 'scripts', 'i18n-value-allowlist.json');
const { locales, dicts } = loadMergedDicts(root);
const allow = existsSync(ALLOW_PATH) ? JSON.parse(readFileSync(ALLOW_PATH, 'utf8')) : {};
const allowTerms = new Set((allow.terms ?? []).map((t) => t.toLowerCase()));
const allowKeys = new Set(allow.keys ?? []);

const CN_PUNCT = /[，。；：！？「」『』【】（）《》、‥〈〉]/;
const FULLWIDTH = /[＀-￯]/;
const PUNCT_OK = new Set(['zh-cn', 'zh-tw', 'ja-jp', 'ko-kr']);
// 繁简同形字不判（在/核/后/里/于 等两侧同形），只列「简体专用、繁体必不同」的字形 → 繁体正字
const TW_SIMP = {
  设: '設', 内: '內', 发: '發', 变: '變', 运: '運', 图: '圖', 页: '頁', 单: '單', 号: '號',
  级: '級', 统: '統', 际: '際', 优: '優', 农: '農', 业: '業', 击: '擊', 艺: '藝', 节: '節',
  实: '實', 尘: '塵', 盘: '盤', 审: '審', 态: '態', 证: '證', 补: '補', 装: '裝', 复: '復',
  择: '擇', 启: '啟', 签: '簽', 张: '張', 间: '間', 长: '長', 与: '與', 对: '對', 视: '視',
  询: '詢', 称: '稱', 来: '來', 输: '輸', 废: '廢', 彻: '徹', 进: '進', 务: '務',
  删: '刪', 请: '請', 权: '權', 时: '時', 壹: '一',
};
const TW_SIMP_SET = new Set(Object.keys(TW_SIMP));

// 日语里不会出现的简体字（用于发现「中文词条未翻译」。已排除中日同形的 区/参/却/体/内/号 等）
const JA_SIMP =
  '设发变运图页单级统际优农业击艺节实盘审态证补装复择启签书车门马鸟鱼龙师华风飞习乐买卖务结给红纪经绝绿罗职联脑脸苏词试诗话诚认讲许论访评识诉诊译课调谈请诸读让训议讯记护报拥挥损换据摇权观欢难边过还进远选适达这个们么说时开关长应样种它为对从众网线组织严丽乱争亚产亲仅价伤伟传伞俭债偿储儿党兴养兽写军冲决况减凤凭凯刘则刚创删别剂剑剧劝办动劳势医协卫厂历压厌县双叙叠叶叹呜吗响哑哟唤啥啦喷嘴嘱嚷榜于顶贴坛络软户员账详';
const JA_SIMP_SET = new Set([...JA_SIMP]);

// 非中日韩语言里不应出现的汉字（用于发现「中文残留」）
const HANZI = /[\u3400-\u9fff]/;

const strip = (s) => s.replace(/\{[\w.]+\}/g, '');
const hasWord = (s) => /[A-Za-zÀ-ɏЀ-ӿ฀-๿぀-ヿ一-鿿가-힯]{2,}/.test(strip(s));
const latinSentence = (s) => /[A-Za-zÀ-ɏ]{4,}/.test(s);

/** 代码引用集：只有被 t()/t0()/textKey 或动态前缀命中的键才参与硬门禁；未引用的遗留键仅告警 */
const { scanSource } = await import('./lib/scan-ts.mjs');
const usedKeys = new Set();
const dynPrefix = [];
for (const dir of [join(root, 'apps', 'web', 'src'), join(root, 'apps', 'api', 'src'), join(root, 'packages', 'shared', 'src')]) {
  if (!existsSync(dir)) continue;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !/\.(ts|tsx)$/.test(e.name)) continue;
    const f = join(e.parentPath ?? e.path, e.name);
    const r = scanSource(f, readFileSync(f, 'utf8'));
    for (const k of r.calls) usedKeys.add(k);
    for (const k of r.textKeys) usedKeys.add(k);
    for (const p of r.dynamic) dynPrefix.push(p);
  }
}
const referenced = (k) => usedKeys.has(k) || dynPrefix.some((p) => p && k.startsWith(p));

/** 值是否为「纯借词/同形词」：所有实词都在该语言的白名单里（terms 全局 + cognates 按语言） */
const cognatesOf = (loc) => new Set((allow.cognates?.[loc] ?? []).map((t) => String(t).toLowerCase()));
function isTermOnly(v, loc) {
  const words = strip(v).match(/[A-Za-z][A-Za-z0-9._-]*/g) ?? [];
  if (!words.length) return true;
  const cogn = cognatesOf(loc);
  return words.every((w) => allowTerms.has(w.toLowerCase()) || cogn.has(w.toLowerCase()));
}

const issues = [];
const seen = new Set();
const push = (type, loc, key, val) => {
  const id = `${type}|${loc}|${key}`;
  if (seen.has(id) || allowKeys.has(`${loc}|${key}`)) return;
  seen.add(id);
  const bare = key.startsWith('api.') ? key.slice(4) : key.replace(/^(bbs|admin)\./, '');
  issues.push({ type, loc, key, live: referenced(bare), val: String(val).replace(/\s+/g, ' ').slice(0, 64) });
};

/* ---------- 前端词典 ---------- */
const zh = dicts['zh-cn'];
for (const loc of locales) {
  if (loc === 'zh-cn') continue;
  for (const ns of ['bbs', 'admin']) {
    for (const k of Object.keys(zh[ns] ?? {})) {
      if (/^lang_/.test(k)) continue; // 语言原生名按设计不译
      const v = String(dicts[loc][ns]?.[k] ?? '');
      const key = `${ns}.${k}`;
      if (!v.trim()) { push('EMPTY', loc, key, v); continue; }
      if (loc === 'zh-tw') {
        const simp = [...new Set([...v].filter((c) => TW_SIMP_SET.has(c)))].map((c) => `${c}→${TW_SIMP[c]}`);
        if (simp.length) push('TW_SIMP', loc, key, `${v}〔${simp.join(' ')}〕`);
        continue;
      }
      if (loc === 'ja-jp') {
        const cn = [...new Set([...v].filter((c) => JA_SIMP_SET.has(c)))];
        if (cn.length) push('JA_CN_CHAR', loc, key, `${v}〔${cn.join('')}〕`);
      }
      if (!PUNCT_OK.has(loc) && HANZI.test(v) && !isTermOnly(v, loc)) push('ZH_LEAK', loc, key, v);
      if (v === String(zh[ns][k]) && hasWord(v) && !isTermOnly(v, loc)) push('ZH_COPY', loc, key, v);
      if (loc !== 'en-us' && v === String(dicts['en-us'][ns]?.[k]) && latinSentence(v) && !isTermOnly(v, loc)) push('EN_COPY', loc, key, v);
      if (!PUNCT_OK.has(loc) && (CN_PUNCT.test(v) || FULLWIDTH.test(v))) push('CJK_PUNCT', loc, key, v);
    }
  }
}

/* ---------- 后端 API_MESSAGES ---------- */
const apiFile = readFileSync(join(root, 'apps', 'api', 'src', 'core', 'i18n', 'index.ts'), 'utf8');
const body = apiFile.slice(apiFile.indexOf('API_MESSAGES: Record<string, MsgDict> = {'));
const LO = ['zh-cn', 'zh-tw', 'en-us', 'ru-ru', 'th-th', 'de-de', 'ja-jp', 'ko-kr', 'es-es', 'fr-fr'];
/** 位置式实参扫描：兼容单/双引号与模板串，字符串内的括号与另一类引号不干扰配对 */
function parseArgs(src, from) {
  const args = [];
  let d = 1, p = from;
  while (p < src.length && d > 0) {
    const c = src[p];
    if (c === "'" || c === '"' || c === '`') {
      p++;
      let s = '';
      while (p < src.length && src[p] !== c) {
        if (src[p] === '\\') {
          const nx = src[p + 1] ?? '';
          s += nx === c || nx === '\\' ? nx : src[p] + nx;
          p += 2;
          continue;
        }
        s += src[p++];
      }
      p++;
      args.push(s);
      continue;
    }
    if (c === '(') d++;
    else if (c === ')') d--;
    p++;
  }
  return args;
}
let apiChecked = 0;
for (const m of body.matchAll(/^\s*'([A-Za-z0-9_.]+)':\s*M\(/gm)) {
  const open = body.indexOf('(', m.index + m[0].length - 1);
  const args = parseArgs(body, open + 1);
  if (args.length !== 10) { push('API_ARITY', '-', m[1], `语言数 ${args.length}`); continue; }
  apiChecked++;
  for (let j = 1; j < 10; j++) {
    const loc = LO[j], v = args[j], key = `api.${m[1]}`;
    if (!v.trim()) push('EMPTY', loc, key, v);
    if (loc === 'zh-tw') { if ([...v].some((c) => TW_SIMP_SET.has(c))) push('TW_SIMP', loc, key, v); continue; }
    if (loc === 'ja-jp' && [...v].some((c) => JA_SIMP_SET.has(c))) push('JA_CN_CHAR', loc, key, v);
    if (!PUNCT_OK.has(loc) && HANZI.test(v) && !isTermOnly(v, loc)) push('ZH_LEAK', loc, key, v);
    if (v === args[0] && hasWord(v) && !isTermOnly(v, loc)) push('ZH_COPY', loc, key, v);
    if (j > 2 && v === args[2] && latinSentence(v) && !isTermOnly(v, loc)) push('EN_COPY', loc, key, v);
    if (!PUNCT_OK.has(loc) && (CN_PUNCT.test(v) || FULLWIDTH.test(v))) push('CJK_PUNCT', loc, key, v);
  }
}

const stat = {};
for (const i of issues) stat[i.type] = (stat[i.type] ?? 0) + 1;
const live = issues.filter((i) => i.live);
const dead = issues.filter((i) => !i.live);
console.log(`[i18n] 值级检查：前端 ${locales.length} 语言 × ${Object.keys(zh.bbs ?? {}).length + Object.keys(zh.admin ?? {}).length} 键，后端 ${apiChecked} 词条，代码引用键 ${usedKeys.size} 个`);
if (dead.length) console.warn(`[i18n] 提示：另有 ${dead.length} 处遗留在【代码未引用】的键上（不阻断，建议随死键清理一并删除或补译）：${[...new Set(dead.map((i) => i.key))].slice(0, 10).join(', ')}${dead.length > 10 ? ' …' : ''}`);
const byType = Object.entries(stat).map(([t, n]) => `${t}:${n}`).join(' ');
if (!live.length) {
  console.log('[i18n] 值级门禁通过：在用词条未见整段复制未译、中文标点残留或简体残留。');
  process.exit(0);
}
console.error(`[i18n] 值级检查失败：${live.length} 处【代码在用】（${byType}）。按类型抽样：`);
for (const t of Object.keys(stat)) {
  const rows = live.filter((i) => i.type === t);
  if (!rows.length) continue;
  console.error(`  -- ${t} (${rows.length}) --`);
  rows.slice(0, 12).forEach((i) => console.error(`     ${i.loc} ${i.key} :: ${i.val}`));
}
console.error('\n请补译，或确属借词/专名时登记 scripts/i18n-value-allowlist.json。');
process.exit(1);
