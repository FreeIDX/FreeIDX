/**
 * D1 队列 GC（§11.2）：bbs_queue 表仅剩过期清理职责
 * （push/pop 消费端未接线，原语已随死代码清理移除；表结构与 cron GC 保留，便于后续接线）。
 */
import type { D1b } from './db';

/** GC：删除已过期（expiry < now）行 */
export async function queueGc(db: D1b, now = Math.floor(Date.now() / 1000)): Promise<void> {
  await db.prepare('DELETE FROM bbs_queue WHERE expiry > 0 AND expiry < ?').bind(now).run();
}
