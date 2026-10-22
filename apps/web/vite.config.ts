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
 * 构建版本号：<package 版本>+<提交总数>[.dirty]。
 *
 * 每次提交后 `git rev-list --count HEAD` 自动 +1，因此后台「版本更新」页的
 * 当前版本随提交自动变化，不需要手改代码；正式发版只提升 apps/web/package.json
 * 的 version 并补发布索引。没有 git 元数据（如源码压缩包构建）时退化为包版本。
 */
function resolveAppVersion(): string {
  const overridden = process.env.VITE_APP_VERSION?.trim();
  if (overridden) return overridden;

  let base = '0.0.0';
  try {
    const pkg = JSON.parse(readFileSync(resolve(webRoot, 'package.json'), 'utf8')) as { version?: string };
    base = pkg.version ?? base;
  } catch {
    // 读取失败时用兜底版本，不阻断构建
  }

  const count = git(['rev-list', '--count', 'HEAD']);
  const sha = git(['rev-parse', '--short=7', 'HEAD']);
  const dirty = git(['status', '--porcelain', '--untracked-files=no']) ? '.dirty' : '';
  const build = count && Number(count) > 0 ? count : sha;
  return build ? `${base}+${build}${dirty}` : base;
}

const appVersion = resolveAppVersion();
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
