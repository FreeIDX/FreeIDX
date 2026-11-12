-- 置顶时间（多帖置顶时的排序依据）
--
-- bbs_thread.top 只描述置顶级别（1/2 = 版块置顶，3 = 全站置顶），不含时间，
-- 同级多帖置顶时无法按「置顶先后」排序（旧实现按 tid DESC 兜底，先置顶的帖子
-- 会因 tid 小而沉到后面）。这里补记 top_at（unix 秒）：
--   · 置顶时写入当前时间；取消置顶写 0；
--   · 列表按 `tt.top DESC, tt.top_at DESC, t.tid DESC` 排序（同级新置顶在前）；
--   · 存量行 top_at = 0，回落到 tid DESC，与升级前的顺序一致。
ALTER TABLE bbs_thread_top ADD COLUMN top_at INTEGER NOT NULL DEFAULT 0;
