/**
 * 版本发布索引读取（后台「版本更新」页用）：
 *
 * 口径：
 *  - 发布数据不自建接口，直接托管在 GitHub 仓库 `.github/releases/version.json`，
 *    每条的更新日志是仓库内的 Markdown；页面经 raw.githubusercontent.com 读取（公开仓库带 CORS）。
 *  - 因此发新版本只需在仓库里加索引条目 + 日志文件，站点无需重新部署。
 *  - fork 或私有化部署可用 `VITE_GITHUB_RELEASES_RAW_BASE` 指向自己的仓库/分支。
 */

const RAW_BASE = (
  import.meta.env.VITE_GITHUB_RELEASES_RAW_BASE ?? 'https://raw.githubusercontent.com/FreeIDX/FreeIDX/main'
).replace(/\/+$/, '');

/** 上游仓库（「数据来源」「打开 Release」「查看详细变更」等外链均基于它） */
export const REPO_URL = (() => {
  const match = RAW_BASE.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//);
  return match ? `https://github.com/${match[1]}/${match[2]}` : 'https://github.com/FreeIDX/FreeIDX';
})();

const RELEASE_INDEX_PATH = '.github/releases/version.json';

export interface ReleaseEntry {
  /** 版本 tag，例如 v1.0.0 */
  tagName: string;
  /** Release 标题（可选，不展示时仅用于无障碍文案） */
  name?: string;
  /** GitHub Release 页面 */
  htmlUrl: string;
  /** 仓库内 Markdown 更新日志的相对路径（可为空） */
  changelogPath: string;
  /** 发布时间（ISO 8601） */
  publishedAt: string;
  createdAt?: string;
  updatedAt?: string;
  /** 发布指向的提交（短/长哈希均可） */
  targetCommitish?: string | null;
  authorLogin?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}

function isReleaseEntry(value: unknown): value is ReleaseEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.tagName === 'string' && typeof v.htmlUrl === 'string';
}

function releaseTime(entry: ReleaseEntry): number {
  const time = Date.parse(entry.publishedAt || entry.createdAt || '');
  return Number.isFinite(time) ? time : 0;
}

async function fetchText(path: string, signal?: AbortSignal): Promise<string | null> {
  const res = await fetch(`${RAW_BASE}/${path.replace(/^\/+/, '')}`, { signal, cache: 'no-store' });
  if (!res.ok) return null;
  return res.text();
}

/** 读取发布索引（按发布时间倒序；草稿/预发布也保留，由页面自行标识） */
export async function fetchReleaseIndex(signal?: AbortSignal): Promise<ReleaseEntry[]> {
  const res = await fetch(`${RAW_BASE}/${RELEASE_INDEX_PATH}`, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data: unknown = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(isReleaseEntry).sort((a, b) => releaseTime(b) - releaseTime(a));
}

/**
 * 读取单条发布的更新日志：优先当前后台语言目录 `i18n/<locale>/<tag>.md`，
 * 缺失时回落到索引里的 changelogPath（通常是中文基准稿）。
 */
export async function fetchReleaseChangelog(
  entry: ReleaseEntry,
  locale: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const localized = await fetchText(`.github/releases/i18n/${locale}/${entry.tagName}.md`, signal);
  if (localized) return localized;
  if (!entry.changelogPath) return null;
  return fetchText(entry.changelogPath, signal);
}

/** 归一化版本号：去掉 v 前缀，并剥离 `+build` 构建元数据（如 1.0.1+17 → 1.0.1），只留可比较的版本部分 */
export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, '').replace(/\+.*$/, '');
}

/**
 * 语义化版本比较（只比主/次/修订数字段，预发布段如 -rc1 不参与）：
 * 返回 >0 表示 a 更新、<0 表示 a 更旧、0 表示同版本。构建元数据（+N）一律忽略。
 */
export function compareVersion(a: string, b: string): number {
  const pa = normalizeVersion(a).split(/[.-]/).map((x) => Number(x) || 0);
  const pb = normalizeVersion(b).split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 提交短哈希（12 位）；空值显示 - */
export function shortCommit(sha?: string | null): string {
  return sha ? sha.trim().slice(0, 12) : '-';
}

/** 判断两个提交号是否指向同一次提交（允许短/长哈希混用） */
export function isSameCommit(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  return left === right || left.startsWith(right) || right.startsWith(left);
}
