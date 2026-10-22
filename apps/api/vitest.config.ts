import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { i18nSplitPlugin } from '../../scripts/i18n-split.plugin';

export default defineConfig({
  // 共享包的词典加载器经虚拟模块按「命名空间 × 语言」分包（见 packages/shared/src/i18n/bundles.ts），
  // 冒烟测试要全量预载，故此处注册同一插件以解析 virtual:freeidx-i18n/*
  plugins: [i18nSplitPlugin(fileURLToPath(new URL('../../packages/shared/src/i18n', import.meta.url)))],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      // Workers 专属模块在 Node 测试环境无实现 → 替身（仅保证模块可加载；见 test/helpers/sockets.ts）
      'cloudflare:sockets': fileURLToPath(new URL('./test/helpers/sockets.ts', import.meta.url)),
    },
  },
});