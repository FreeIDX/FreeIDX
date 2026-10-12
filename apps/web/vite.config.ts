import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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
  plugins: [react(), tailwindcss()],
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
      },
    },
  },
});
