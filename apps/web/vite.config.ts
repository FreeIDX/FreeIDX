import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { i18nSplitPlugin } from '../../scripts/i18n-split.plugin';

const webRoot = dirname(fileURLToPath(import.meta.url));

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: webRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 构建期版本信息（三件事解耦，避免「当前版本」显示错位）：
 *  - `__GIT_TAG__`：最近可达的发布 Tag（`git describe --tags --abbrev=0`），如 v1.0.2。
 *    「当前版本」以它为准——不管构建点在 Tag 前还是后，都能归到正确的发布版本；
 *    不再把提交数伪装成版本号（此前 `1.0.1+17` 的 +17 是提交总数，Tag 之后任何一次
 *    部署都会因为哈希对不上而永远显示这个怪值）。
 *  - `__APP_VERSION__`：纯发布版本号（无 +build 元数据）。优先取最近 Tag 的版本，
 *    无 git 元数据（源码包/浅克隆找不到 Tag）时退化为 apps/web/package.json 的 version。
 *  - `__BUILD_NUM__`：提交总数（构建号），仅用于后台「当前提交」的附注，不参与版本比较。
 *
 * 注意：`git describe` 需要全量历史，deploy.yml 与 ci.yml 均已 fetch-depth: 0。
 */
function resolveTag(): string | null {
  const tag = git(['describe', '--tags', '--abbrev=0']);
  return tag && /^v/.test(tag) ? tag : null;
}

function resolveAppVersion(recentTag: string | null): string {
  const overridden = process.env.VITE_APP_VERSION?.trim();
  if (overridden) return overridden;

  let base = '0.0.0';
  try {
    const pkg = JSON.parse(readFileSync(resolve(webRoot, 'package.json'), 'utf8')) as { version?: string };
    base = pkg.version ?? base;
  } catch {
    // 读取失败时用兜底版本，不阻断构建
  }

  const tagVersion = recentTag?.replace(/^v/, '') ?? '';
  if (tagVersion && tagVersion !== base) {
    // 包版本由发版流水线在 Tag 提交里才提升，Tag 前后的构建点容易出现错配：
    // 版本号以最近 Tag 为准，并在构建日志里留痕，便于排查「线上显示旧主版本」。
    console.warn(`[vite] 包版本 ${base} 与最近 Tag ${recentTag} 不一致，当前版本按 Tag 展示`);
  }
  return tagVersion || base;
}

const gitTag = resolveTag();
const appVersion = resolveAppVersion(gitTag);
const commitCount = git(['rev-list', '--count', 'HEAD']);
const buildNum = commitCount && Number(commitCount) > 0 ? Number(commitCount) : null;
const commitSha = process.env.VITE_COMMIT_SHA?.trim() || git(['rev-parse', 'HEAD']) || '';

/**
 * 供应商分包：把不随业务代码变化的依赖拆成独立 chunk。
 * 收益：① 长期缓存命中率更高（业务改动不会让依赖 chunk 失效）；
 *       ② 首屏主包从「全部依赖 + 全部页面」的单一 1.82MiB 包降为按需加载。
 * 页面本身的分割由 App.tsx 的路由懒加载完成，此处只负责依赖归类。
 */
function vendorChunkOf(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;
  // 兼容 pnpm 布局：node_modules/.pnpm/<name>@<ver>/node_modules/<name>/...，取其真实包名
  const m = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/.exec(id);
  const pkg = m?.[1];
  if (!pkg) return undefined;
  if (pkg === 'react' || pkg === 'react-dom' || pkg === 'scheduler') return 'vendor-react';
  if (pkg === 'react-router') return 'vendor-router';
  if (pkg.startsWith('@tanstack/')) return 'vendor-query';
  if (pkg === 'zustand') return 'vendor-zustand';
  if (pkg.startsWith('@tiptap/') || pkg.startsWith('prosemirror-')) return 'vendor-editor';
  return undefined;
}

export default defineConfig({
  // 构建期确定版本与提交，运行时不发额外请求；后台「版本更新」页直接读取
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __COMMIT_SHA__: JSON.stringify(commitSha),
    __GIT_TAG__: JSON.stringify(gitTag),
    __BUILD_NUM__: JSON.stringify(buildNum),
  },
  // 词典按「命名空间 × 语言」分包（前台 bbs / 后台 admin 各自成 chunk，见 packages/shared/src/i18n/bundles.ts）
  plugins: [react(), tailwindcss(), i18nSplitPlugin(resolve(webRoot, '../../packages/shared/src/i18n'))],
  server: {
    proxy: {
      // 本地同域开发：/api 与 /files 转发到 Worker（§13.2 同域方案的本地等价）
      '/api': 'http://localhost:8787',
      '/files': 'http://localhost:8787',
    },
  },
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
    // 与 tsconfig.base.json 的 target 对齐：不做多余降级（产物只由 Workers Assets 静态应答）
    target: 'es2022',
    // 分包后单 chunk 仍可能超过默认 500kB（编辑器/词典），显式提高上限使告警保持有意义
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: vendorChunkOf,
        /**
         * 词典 chunk 命名：bbs（前台）与 admin（后台）同属一个语言时默认都叫 `<locale>-<hash>`，
         * 产物列表里无法区分。按虚拟模块 id 显式命名，便于核对「前台到底下了哪几个包」。
         */
        chunkFileNames: (chunk) => {
          const virtual = chunk.moduleIds.find((id) => id.startsWith('\0virtual:freeidx-i18n/'));
          const m = virtual ? /\/(bbs|admin)\/([a-z]{2}-[a-z]{2})$/.exec(virtual) : null;
          if (m) return `assets/i18n-${m[1]}-${m[2]}-[hash].js`;
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
});
