#!/usr/bin/env node
/**
 * 主题目录规范校验（构建前执行，失败即中止构建）。
 *
 * 校验项（对应 docs/theme-spec.md）：
 *  1. apps/web/src/themes/ 根目录**只允许主题文件夹**，出现普通文件即报错；
 *  2. 每个主题文件夹必须含 theme.json 与 index.tsx；
 *  3. theme.json 必须能解析，且 id 与文件夹名一致（文件夹名即主题 id）；
 *  4. name 至少提供 zh-cn 与 en-us（多语言缺省回落这两条）；
 *  5. 主题 id 唯一（同 id 只可能来自重名文件夹，这里防大小写/符号导致的重复）；
 *  6. 主题目录内除 theme.json / index.tsx / theme.css 之外的私有资源放行，
 *     但禁止把 registry.ts / types.ts 之类「基础设施文件」混进 themes/。
 *
 * 退出码 0 = 通过；1 = 有错误（一次性打印全部问题，便于一次改完）。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const THEMES_DIR = join(ROOT, 'apps', 'web', 'src', 'themes');
/** 主题目录内允许的固定文件名（其余文件视为主题私有资源，放行） */
const REQUIRED = ['theme.json', 'index.tsx'];
/** 禁止出现在 themes/ 根与主题目录内的基础设施文件名（它们属于 lib/theme/） */
const FORBIDDEN = ['registry.ts', 'registry.tsx', 'types.ts', 'sdk.ts', 'provider.tsx', 'slots.tsx', 'route.tsx', 'active.ts', 'README.md', 'index.ts'];

const errors = [];
const fail = (msg) => errors.push(msg);

if (!existsSync(THEMES_DIR)) {
  console.log('[themes] 跳过：apps/web/src/themes 目录不存在');
  process.exit(0);
}

const entries = readdirSync(THEMES_DIR);
const dirs = [];
for (const name of entries) {
  const full = join(THEMES_DIR, name);
  if (!statSync(full).isDirectory()) {
    fail(`themes/ 根目录只允许放主题文件夹，发现普通文件：${name}（基础设施请放 apps/web/src/lib/theme/）`);
    continue;
  }
  dirs.push(name);
}

if (dirs.length === 0) fail('themes/ 下没有任何主题文件夹（至少需要内置主题 light）');

const seen = new Map();
for (const dir of dirs) {
  const full = join(THEMES_DIR, dir);
  for (const req of REQUIRED) {
    if (!existsSync(join(full, req))) fail(`主题 ${dir}/ 缺少必需文件 ${req}`);
  }
  for (const bad of FORBIDDEN) {
    if (existsSync(join(full, bad))) fail(`主题 ${dir}/ 不允许出现基础设施文件 ${bad}（应放在 apps/web/src/lib/theme/）`);
  }
  const metaPath = join(full, 'theme.json');
  if (!existsSync(metaPath)) continue;

  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'));
  } catch (e) {
    fail(`主题 ${dir}/theme.json 不是合法 JSON：${e.message}`);
    continue;
  }
  if (meta.id !== dir) fail(`主题 ${dir}/theme.json 的 id 必须等于文件夹名（当前 id=${JSON.stringify(meta.id)}）`);
  if (!meta.name || typeof meta.name !== 'object') {
    fail(`主题 ${dir}/theme.json 缺少 name 对象`);
  } else {
    for (const loc of ['zh-cn', 'en-us']) {
      if (!meta.name[loc]) fail(`主题 ${dir}/theme.json 的 name 缺少 ${loc}`);
    }
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(dir)) {
    fail(`主题文件夹名 ${dir} 不合规（小写字母数字开头，可含 - _，最长 32）`);
  }
  if (seen.has(dir)) fail(`主题 id 重复：${dir}（与 ${seen.get(dir)} 冲突）`);
  else seen.set(dir, dir);
}

if (errors.length) {
  console.error('[themes] 校验未通过：');
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(`\n共 ${errors.length} 个问题，详见 docs/theme-spec.md`);
  process.exit(1);
}
console.log(`[themes] 校验通过：${dirs.length} 个内置主题（${dirs.join(', ')}）`);
