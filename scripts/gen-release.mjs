#!/usr/bin/env node
/**
 * 生成/更新后台「版本更新」页的发布索引与更新日志。
 *
 * 触发方式：
 *  - .github/workflows/release.yml 在推送 v* Tag 时自动执行
 *  - 本地补记录：TAG=v1.1.0 node scripts/gen-release.mjs（需先 git fetch --tags）
 *
 * 行为：
 *  - 更新 .github/releases/version.json（同 Tag 覆盖，新条目按发布时间置顶）
 *  - 更新日志不存在时，按「上一发布..当前 Tag」的提交自动生成
 *  - 已存在的更新日志不覆盖，便于手写发布说明
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function tryGit(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

const tag = process.env.TAG?.trim();
if (!tag) fail('缺少 TAG 环境变量，例如 TAG=v1.1.0');
if (!/^v\d/.test(tag)) fail(`Tag ${tag} 不是 v 开头的版本号，已跳过`);

const targetCommitish = tryGit(['rev-parse', '--verify', `${tag}^{commit}`]);
if (!targetCommitish) fail(`本地找不到 Tag ${tag}，请先执行 git fetch --tags`);

const repository = process.env.GITHUB_REPOSITORY ?? 'FreeIDX/FreeIDX';
const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
const repoUrl = `${server}/${repository}`;

const indexPath = resolve(ROOT, '.github/releases/version.json');
const releases = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : [];
if (!Array.isArray(releases)) fail('version.json 应为数组');

const existing = releases.find((item) => item?.tagName === tag);
const publishedAt = tryGit(['log', '-1', '--format=%cI', tag]) ?? new Date().toISOString();

// 上一条发布：优先取索引里最近的记录，缺失时回落到 git 标签
let baseTag = releases
  .filter((item) => item?.tagName && item.tagName !== tag)
  .sort((a, b) => (Date.parse(b.publishedAt ?? '') || 0) - (Date.parse(a.publishedAt ?? '') || 0))[0]?.tagName;
if (baseTag && !tryGit(['rev-parse', '--verify', `${baseTag}^{commit}`])) baseTag = undefined;
if (!baseTag) baseTag = tryGit(['describe', '--tags', '--abbrev=0', `${tag}^`]) ?? undefined;

const changelogPath = `.github/releases/changelog/${tag}.md`;
const changelogAbs = resolve(ROOT, changelogPath);

if (!existsSync(changelogAbs)) {
  const range = baseTag ? `${baseTag}..${tag}` : tag;
  const log = tryGit(['log', '--no-merges', '--pretty=format:- %s (%h)', range]) ?? '';
  const lines = log
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('- chore(release):'));
  const body = lines.length ? lines.join('\n') : '- 本次发布没有新的代码提交。';
  const compare = baseTag ? `\n\n## 完整变更\n\n${repoUrl}/compare/${baseTag}...${tag}\n` : '';
  mkdirSync(dirname(changelogAbs), { recursive: true });
  writeFileSync(changelogAbs, `# FreeIDX ${tag}\n\n## 主要内容\n\n${body}${compare}\n`, 'utf8');
  console.log(`[release] 已生成更新日志：${changelogPath}`);
} else {
  console.log(`[release] 更新日志已存在，保留原内容：${changelogPath}`);
}

const entry = {
  tagName: tag,
  name: existing?.name ?? `FreeIDX ${tag}`,
  htmlUrl: `${repoUrl}/releases/tag/${tag}`,
  changelogPath,
  publishedAt: existing?.publishedAt ?? publishedAt,
  createdAt: existing?.createdAt ?? publishedAt,
  updatedAt: publishedAt,
  targetCommitish,
  authorLogin:
    existing?.authorLogin ?? process.env.GITHUB_ACTOR ?? tryGit(['log', '-1', '--format=%an', tag]) ?? 'unknown',
  draft: false,
  prerelease: /-/.test(tag.replace(/^v/, '')),
};

const next = [entry, ...releases.filter((item) => item?.tagName !== tag)].sort(
  (a, b) => (Date.parse(b.publishedAt ?? '') || 0) - (Date.parse(a.publishedAt ?? '') || 0),
);
writeFileSync(indexPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
console.log(`[release] 已写入发布索引：${tag}（共 ${next.length} 条）`);

// 同步包版本：后续构建的版本号以 apps/web/package.json 为基准，
// 发版后自动提升，避免下一条提交仍显示旧的主版本。
const packageVersion = tag.replace(/^v/, '');
for (const relativePath of ['apps/web/package.json', 'apps/api/package.json', 'packages/shared/package.json']) {
  const absolutePath = resolve(ROOT, relativePath);
  if (!existsSync(absolutePath)) continue;
  const pkg = JSON.parse(readFileSync(absolutePath, 'utf8'));
  if (pkg.version === packageVersion) continue;
  pkg.version = packageVersion;
  writeFileSync(absolutePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`[release] 已更新 ${relativePath} → ${packageVersion}`);
}
if (baseTag) console.log(`[release] 更新范围：${baseTag}...${tag}`);
