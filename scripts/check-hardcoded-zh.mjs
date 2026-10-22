#!/usr/bin/env node
/**
 * 硬编码中文（未走 i18n）门禁：基线式增量 + 按文件预算棘轮。
 *
 * 两道防线：
 *  1. 基线增量：全局 entries 集合，拦截基线之外的【新增】硬编码（配合 ESLint 规则）。
 *  2. 按文件预算棘轮：每文件独立预算，current(file) ≤ budget(file)；
 *     预算只能减不能增（--update），文件清零后任何新增即拦截。
 *     → 防止「拆东补西」（A 文件新增、B 文件清理，总数不变）。
 *
 * 用法：
 *   node scripts/check-hardcoded-zh.mjs          CI 检查
 *   node scripts/check-hardcoded-zh.mjs --update  收紧基线 + 预算（只减不增）
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource } from './lib/scan-ts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = [
  join(root, 'apps', 'web', 'src'),
  join(root, 'apps', 'api', 'src'),
  join(root, 'packages', 'shared', 'src'),
];
const BASELINE_PATH = join(root, 'scripts', 'i18n-hardcoded-baseline.json');
const BUDGET_PATH = join(root, 'scripts', 'i18n-file-budget.json');
const update = process.argv.includes('--update');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) out.push(join(e.parentPath ?? e.path ?? dir, e.name));
  }
  return out;
}

// 扫描当前所有硬编码
const currentEntries = new Set();
const currentByFile = {};
for (const dir of SCAN_DIRS) {
  if (!existsSync(dir)) continue;
  for (const file of walk(dir)) {
    const { hardcoded } = scanSource(file, readFileSync(file, 'utf8'));
    const rel = relative(root, file).replace(/\\/g, '/');
    const fileTexts = new Set();
    for (const text of hardcoded) {
      const key = `${rel}::${text}`;
      currentEntries.add(key);
      fileTexts.add(text);
    }
    if (fileTexts.size) currentByFile[rel] = fileTexts.size;
  }
}

// 加载基线
const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : { entries: [] };
const baselineSet = new Set(baseline.entries ?? []);

// 加载预算
const budgetData = existsSync(BUDGET_PATH) ? JSON.parse(readFileSync(BUDGET_PATH, 'utf8')) : { budgets: {} };
const budgets = budgetData.budgets ?? {};

if (update) {
  // === 更新模式：重建基线 + 棘轮收紧预算 ===

  // 1. 重建基线
  const entries = [...currentEntries].sort();
  const baselineOut = {
    _comment: '硬编码中文基线：含中文且未走 t(...) 的 AST 节点文本（path::归一化文本）。CI 仅拦截此清单之外的新增项。清理存量后重跑 --update 收紧。',
    generatedFrom: SCAN_DIRS.map((d) => relative(root, d).replace(/\\/g, '/')),
    count: entries.length,
    entries,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baselineOut, null, 1) + '\n');

  // 2. 棘轮收紧预算（只减不增）
  const newBudgets = {};
  let tightened = 0;
  let locked = 0;
  for (const file of Object.keys(currentByFile).sort()) {
    const cur = currentByFile[file];
    const old = budgets[file] ?? cur;
    const next = Math.min(cur, old);
    newBudgets[file] = next;
    if (next < old) tightened++;
    if (next === 0) locked++;
  }
  // 保留预算中已有但当前未扫描到的文件（可能被删除或暂时无硬编码）
  for (const file of Object.keys(budgets)) {
    if (!(file in newBudgets)) {
      newBudgets[file] = 0;
      locked++;
    }
  }
  const totalBudget = Object.values(newBudgets).reduce((a, b) => a + b, 0);
  const budgetOut = {
    _comment: '按文件硬编码中文预算（棘轮：只减不增）。CI 检查 current(file) <= budget(file)。文件清零后任何新增即拦截。',
    generated: new Date().toISOString().slice(0, 10),
    totalFiles: Object.keys(newBudgets).length,
    totalBudget,
    budgets: newBudgets,
  };
  writeFileSync(BUDGET_PATH, JSON.stringify(budgetOut, null, 1) + '\n');

  console.log(`[i18n] 基线已更新：${entries.length} 条`);
  console.log(`[i18n] 预算棘轮：${Object.keys(newBudgets).length} 文件，总预算 ${totalBudget}，收紧 ${tightened} 文件，已清零 ${locked} 文件`);
  process.exit(0);
}

// === 检查模式 ===

// 1. 基线增量检查
const added = [...currentEntries].filter((e) => !baselineSet.has(e));
const cleared = [...baselineSet].filter((e) => !currentEntries.has(e));

console.log(`[i18n] 硬编码中文（AST）：当前命中 ${currentEntries.size} 处 / 基线 ${baselineSet.size} 处`);

if (cleared.length) {
  console.log(`[i18n] 已清理 ${cleared.length} 处（基线可收紧，运行 pnpm i18n:baseline）`);
}

// 2. 按文件预算检查
let budgetViolations = 0;
const fileReport = [];
for (const file of Object.keys(currentByFile).sort()) {
  const cur = currentByFile[file];
  const budget = budgets[file] ?? 0;
  if (cur > budget) {
    budgetViolations++;
    fileReport.push(`  ✗ ${file}: ${cur} > 预算 ${budget}`);
  }
}
// 新文件（不在预算中）有硬编码
for (const file of Object.keys(currentByFile)) {
  if (!(file in budgets) && currentByFile[file] > 0) {
    budgetViolations++;
    fileReport.push(`  ✗ ${file}: ${currentByFile[file]} > 预算 0（新文件）`);
  }
}

if (budgetViolations) {
  console.error(`\n[i18n] ${budgetViolations} 个文件超出硬编码预算（棘轮违反）：`);
  for (const r of fileReport) console.error(r);
}

// 汇总
const cleanFiles = Object.keys(budgets).filter((f) => budgets[f] === 0 && !(currentByFile[f] > 0));
const remainingFiles = Object.keys(budgets).filter((f) => budgets[f] > 0);
console.log(`[i18n] 文件预算：${cleanFiles.length} 已清零 / ${remainingFiles.length} 待清理 / 共 ${Object.keys(budgets).length}`);

if (added.length) {
  console.error(`\n[i18n] 发现 ${added.length} 处【新增】硬编码中文（未走 t(...)），请改用 t('key','中文') 并补词条：`);
  for (const e of added.slice(0, 40)) console.error('  ✗ ' + e);
  if (added.length > 40) console.error(`  … 其余 ${added.length - 40} 处省略`);
}

if (added.length || budgetViolations) process.exit(1);
console.log('[i18n] 硬编码中文门禁通过（增量 + 按文件预算棘轮）。');