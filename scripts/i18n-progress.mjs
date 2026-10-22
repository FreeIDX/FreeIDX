#!/usr/bin/env node
/**
 * i18n 清理进度看板：展示按文件预算的当前状态和清理路线图。
 *
 * 用法：node scripts/i18n-progress.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource } from './lib/scan-ts.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIR = join(root, 'apps', 'web', 'src');
const BUDGET_PATH = join(root, 'scripts', 'i18n-file-budget.json');

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) out.push(join(e.parentPath ?? e.path ?? dir, e.name));
  }
  return out;
}

// 扫描当前
const currentByFile = {};
for (const file of walk(SCAN_DIR)) {
  const { hardcoded } = scanSource(file, readFileSync(file, 'utf8'));
  const rel = relative(root, file).replace(/\\/g, '/');
  if (hardcoded.length) currentByFile[rel] = new Set(hardcoded).size;
}

// 加载预算
const budgetData = JSON.parse(readFileSync(BUDGET_PATH, 'utf8'));
const budgets = budgetData.budgets ?? {};

// 分类
const clean = [];       // 预算=0 且当前=0
const locked = [];      // 预算=0 但当前>0（违反）
const inProgress = [];  // 预算>0
const newFiles = [];    // 不在预算中

for (const file of Object.keys(budgets).sort()) {
  const cur = currentByFile[file] ?? 0;
  const bud = budgets[file];
  if (bud === 0 && cur === 0) clean.push(file);
  else if (bud === 0 && cur > 0) locked.push({ file, cur });
  else inProgress.push({ file, cur, bud });
}
for (const file of Object.keys(currentByFile)) {
  if (!(file in budgets)) newFiles.push({ file, cur: currentByFile[file] });
}

// 按优先级分组（用户可见度）
const priority = (f) => {
  if (f.includes('/pages/')) return 1;    // 前台页面
  if (f.includes('/components/')) return 2; // 公共组件
  if (f.includes('/admin/pages/')) return 3; // 后台页面
  if (f.includes('/admin/')) return 4;    // 后台共享
  if (f.includes('/lib/')) return 5;      // 工具库
  return 6;
};
inProgress.sort((a, b) => priority(a.file) - priority(b.file) || b.cur - a.cur);

// 输出看板
const totalBudget = Object.values(budgets).reduce((a, b) => a + b, 0);
const totalCurrent = Object.values(currentByFile).reduce((a, b) => a + b, 0);
const cleanRate = ((clean.length / Object.keys(budgets).length) * 100).toFixed(1);

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║          i18n 硬编码清理进度看板                              ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log();
console.log(`总文件: ${Object.keys(budgets).length}  |  已清零: ${clean.length} (${cleanRate}%)  |  待清理: ${inProgress.length}  |  总预算: ${totalBudget}  |  当前: ${totalCurrent}`);
console.log();

if (clean.length) {
  console.log(`✅ 已清零 (${clean.length} 文件):`);
  for (const f of clean) console.log(`   ${f}`);
  console.log();
}

if (inProgress.length) {
  console.log(`🔧 待清理 (${inProgress.length} 文件，按优先级排序):`);
  console.log('   优先级: 1=前台页面 2=公共组件 3=后台页面 4=后台共享 5=工具库');
  console.log();
  for (const { file, cur, bud } of inProgress) {
    const p = priority(file);
    const bar = '█'.repeat(Math.min(20, Math.round((cur / bud) * 20)));
    const pct = ((cur / bud) * 100).toFixed(0);
    console.log(`   [P${p}] ${file}`);
    console.log(`         ${bar} ${cur}/${bud} (${pct}%)`);
  }
  console.log();
}

if (locked.length) {
  console.log(`⚠️  预算违反 (${locked.length} 文件，预算=0 但有硬编码):`);
  for (const { file, cur } of locked) console.log(`   ${file}: ${cur} 处`);
  console.log();
}

if (newFiles.length) {
  console.log(`🆕 新文件 (${newFiles.length}，不在预算中):`);
  for (const { file, cur } of newFiles) console.log(`   ${file}: ${cur} 处`);
  console.log();
}

console.log('清理步骤:');
console.log('  1. 选择一个文件，将硬编码中文替换为 t(\'key\', \'中文\') 调用');
console.log('  2. 补充 override 词典词条（10 语言）');
console.log('  3. 运行 pnpm i18n:check 验证');
console.log('  4. 运行 pnpm i18n:baseline 收紧预算（棘轮）');
console.log('  5. 重复直到文件清零');