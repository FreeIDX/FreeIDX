import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
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