/**
 * Cron 表达式一致性门禁（§11.1）。
 *
 * 真实事故：`wrangler.toml` 的每日档改成 `1 3 * * *`（为错开 03:00 的 5 分钟档与每小时档 ——
 * 三者都会读改写 runtime，同刻执行会被旧值覆盖），但 `handleScheduled` 的 case 仍比对
 * `0 3 * * *`。于是每日维护（today* 清零、计数校准、queue/cache GC）与插件每日任务
 * （seo 收录推送）全部落进 default 分支，**一次都没执行过**，线上只留一行 warn。
 *
 * 本文件把三处声明钉在同一组常量上：
 *   ① wrangler.toml [triggers].crons 与 HANDLED_CRONS 必须完全一致；
 *   ② 插件 registerCron 的 pattern 必须落在 HANDLED_CRONS 内；
 *   ③ handleScheduled 的 case 必须引用常量，不得回退成字面量。
 */
import { readFileSync } from 'node:fs';
import type { ExtensionState } from '@freeidx/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { l0Clear } from '../src/core/cache';
import { CRON_5MIN, CRON_DAILY, CRON_HOURLY, HANDLED_CRONS } from '../src/core/cron-schedule';
import { buildRuntime } from '../src/core/extensions/registry';
import { EXTENSION_MODULES } from '../src/core/extensions';

afterEach(() => {
  l0Clear();
});

/** 从 wrangler.toml 抽出 [triggers].crons 的表达式列表 */
function declaredCrons(): string[] {
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const block = /^\s*crons\s*=\s*\[([\s\S]*?)\]/m.exec(toml);
  expect(block, 'wrangler.toml 缺少 [triggers].crons 声明').not.toBeNull();
  const body = block?.[1] ?? '';
  return [...body.matchAll(/'([^']*)'|"([^"]*)"/g)]
    .map((m) => m[1] ?? m[2] ?? '')
    .filter((expr) => expr !== '');
}

describe('cron 表达式一致性（防静默失效）', () => {
  it('wrangler.toml 声明的触发与 HANDLED_CRONS 完全一致', () => {
    const declared = declaredCrons();
    expect(declared.length).toBeGreaterThan(0);
    // toml 里有、代码没接 → 该档静默失效（历史事故即此向）
    for (const expr of declared) expect(HANDLED_CRONS, `wrangler.toml 的 ${expr} 未被 handleScheduled 处理`).toContain(expr);
    // 代码登记了、toml 没声明 → 死分支，容易掩盖后续改动
    for (const expr of HANDLED_CRONS) expect(declared, `HANDLED_CRONS 的 ${expr} 未在 wrangler.toml 声明`).toContain(expr);
  });

  it('插件注册的 cron pattern 必须在登记表内', () => {
    // 全部插件置为已安装+启用，确保任何插件注册的 cron 都被纳入校验
    const allOn: Record<string, ExtensionState> = {};
    for (const m of EXTENSION_MODULES) allOn[m.manifest.id] = { installed: 1, enable: 1 };
    const rt = buildRuntime(EXTENSION_MODULES, allOn);
    expect(rt.crons.length).toBeGreaterThan(0); // seo 每日推送为出厂启用
    for (const c of rt.crons) expect(HANDLED_CRONS, `插件 cron ${c.name} 的 ${c.pattern} 未被 handleScheduled 处理`).toContain(c.pattern);
  });

  it('handleScheduled 只按常量分发，不得回退成字面量', () => {
    const src = readFileSync(new URL('../src/core/cron.ts', import.meta.url), 'utf8');
    for (const name of ['CRON_5MIN', 'CRON_HOURLY', 'CRON_DAILY']) {
      expect(src, `handleScheduled 缺少 case ${name}`).toMatch(new RegExp(`case\\s+${name}\\s*:`));
    }
    // 形如 case '0 3 * * *': 的字面量分支 = 漂移风险回归
    expect(src).not.toMatch(/case\s+['"][\d*/][^'"]*['"]\s*:/);
  });

  it('三个档位的表达式互不相同（否则 switch 会静默合并分支）', () => {
    expect(new Set([CRON_5MIN, CRON_HOURLY, CRON_DAILY]).size).toBe(3);
  });
});
