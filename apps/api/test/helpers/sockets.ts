/**
 * 测试替身：Node 环境没有 Cloudflare 专属模块 `cloudflare:sockets`（vitest.config.ts alias 到本文件）。
 * 仅保证模块可加载（SMTP 发信在测试中不会真正建连），运行时行为不变——Workers 里走真实模块。
 */
export function connect(...args: unknown[]): never {
  throw new Error(`cloudflare:sockets 在 Node 测试环境不可用（connect(${JSON.stringify(args)}))`);
}