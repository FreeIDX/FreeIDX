/**
 * Cron 表达式唯一事实源（§11.1）。
 *
 * 背景（真实事故）：表达式此前在 `wrangler.toml` 与 `handleScheduled` 的 `switch` 里各写一份。
 * 每日档为了「错开 03:00 的每 5 分钟档与每小时档（三者都会读改写 runtime，同刻执行会被旧值
 * 覆盖）」把 toml 改成 `1 3 * * *`，但 handler 仍在比对 `0 3 * * *` —— 于是每日维护（today*
 * 清零、计数校准、queue/cache GC）与插件每日任务（seo 收录推送）全部落进 `default` 分支，
 * 一次都没执行过。这类漂移在运行时完全静默（只打一行 warn），因此必须把表达式收敛到一处常量：
 *   - `wrangler.toml` 的 `[triggers].crons`
 *   - `handleScheduled` 的分发
 *   - 插件 `registerCron({ pattern })`
 * 三处都只引用这里，并由 `test/cron-schedule.test.ts` 门禁（toml 与插件注册必须落在本表内）。
 *
 * ⚠️ 每日档刻意保持 03:01（不是 03:00）：见上，与每小时档并发会互相覆盖 runtime。
 */

/** 每 5 分钟档：session GC + 在线数刷新 */
export const CRON_5MIN = '*/5 * * * *';

/** 每小时档：掉单对账、超期关单、会员到期回落、临时附件 GC、改名 SEO 重建 */
export const CRON_HOURLY = '0 * * * *';

/** 每日档（03:01）：计数校准、today* 清零、queue/cache GC + 插件每日任务 */
export const CRON_DAILY = '1 3 * * *';

/**
 * `handleScheduled` 必须处理的全部表达式。
 * 测试据此校验：wrangler.toml 里声明的每个触发、以及每个插件注册的 cron pattern，
 * 都必须落在本表内 —— 否则该项会在运行时从 default 分支静默漏过。
 */
export const HANDLED_CRONS: readonly string[] = [CRON_5MIN, CRON_HOURLY, CRON_DAILY];
