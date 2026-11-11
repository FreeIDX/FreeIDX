-- 站点级 runtime 计数落表（原实现是缓存键 'runtime' 的读-改-写）。
-- 缓存读-改-写在并发发帖时各自读到旧值再写回 +1，N 个并发只增加 1；
-- cron 写 onlines / today* 清零时整对象覆盖还会抹掉并发增量，且 today* 无 DB 校准。
-- 落表后用单条 UPSERT 原子自增（见 modules/shared.ts patchRuntime/setRuntime）。
CREATE TABLE bbs_runtime (
  k TEXT PRIMARY KEY,
  v INTEGER NOT NULL DEFAULT 0
);

-- 用真实计数初始化 threads/posts/users，避免升级后统计面板显示 0 直到下一轮 cron。
-- today* 无法从历史还原（原实现只存缓存），置 0；onlines 由 5 分钟档刷新。
INSERT OR REPLACE INTO bbs_runtime (k, v) SELECT 'threads', COUNT(*) FROM bbs_thread WHERE ok = 1;
INSERT OR REPLACE INTO bbs_runtime (k, v) SELECT 'posts', COUNT(*) FROM bbs_post WHERE ok = 1;
INSERT OR REPLACE INTO bbs_runtime (k, v) SELECT 'users', COUNT(*) FROM bbs_user WHERE ok = 1;
INSERT OR IGNORE INTO bbs_runtime (k, v) VALUES
  ('todaythreads', 0),
  ('todayposts', 0),
  ('todayusers', 0),
  ('onlines', 0);
