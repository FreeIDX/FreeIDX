--  查询覆盖索引补充：消除只读热路径上的全表扫描。
--  方法：把全仓 SELECT 的 WHERE / ORDER BY 与既有索引（0001~0020）逐条比对，
--  只为「既有索引无法覆盖 + 该表随业务持续增长」的查询补索引；D1 按 rows_read 计费，
--  无索引的 ORDER BY 会让 rows_read ≈ 表行数（而非 LIMIT 行数），是配额的最大隐患。
--  注：0001~0020 已应用到远端库不可改写，故新增迁移。

-- 楼层回复弹层（modules/thread/routes.ts：WHERE quotepid = ? [ORDER BY create_date ASC]）
-- bbs_post 为最大表，此前仅有 (tid,pid)/(uid)/(ok,pid)，quotepid 过滤全表扫描。
CREATE INDEX bbs_post_quotepid ON bbs_post (quotepid, create_date);

-- 附件级联删（core/purge.ts、modules/admin/users.ts、modules/admin/forums.ts：WHERE tid = ? / tid IN (...))
-- 既有索引为 pid/uid/(status,create_date)，tid 删除操作全表扫描。
CREATE INDEX bbs_attach_tid ON bbs_attach (tid);

-- 主题榜（modules/rank/routes.ts：WHERE ok = 1 [AND create_date > ?] ORDER BY views DESC LIMIT ?）
-- 既有 bbs_thread_ok_tid(ok,tid) 无法满足 views 排序。
CREATE INDEX bbs_thread_ok_views ON bbs_thread (ok, views DESC);

-- 版块热门（modules/rank/routes.ts /api/rank/forum：WHERE fid = ? AND ok = 1 ORDER BY views DESC）
-- 该端点无缓存，版块页每次访问都执行；既有 bbs_thread_fid_tid 无法满足 views 排序。
CREATE INDEX bbs_thread_fid_ok_views ON bbs_thread (fid, ok, views DESC);

-- 消息列表（modules/notice/routes.ts：WHERE recvuid = ? [AND nid < ?] ORDER BY nid DESC LIMIT ?）
-- 既有 (recvuid,isread)/(recvuid,type) 无法满足按 nid 倒序游标分页。
CREATE INDEX bbs_notice_recvuid_nid ON bbs_notice (recvuid, nid DESC);

-- 排行榜单（modules/rank/routes.ts /api/rank/list：WHERE ok = 1 AND uid > 0 ORDER BY <列> DESC, uid ASC LIMIT/OFFSET）
-- 该端点实时查询无缓存，五个排序列此前均为全表排序。
-- 代价：bbs_user 计数列在发帖/积分变动时会被更新，需一并维护这 5 个索引（CPU 开销，不计 rows_written）；
--      换来的是每次排行查询的 rows_read 从 O(用户数) 降到 O(每页条数)，对免费层配额更有利。
CREATE INDEX bbs_user_ok_threads ON bbs_user (ok, threads DESC, uid ASC);
CREATE INDEX bbs_user_ok_posts ON bbs_user (ok, posts DESC, uid ASC);
CREATE INDEX bbs_user_ok_credits ON bbs_user (ok, credits DESC, uid ASC);
CREATE INDEX bbs_user_ok_golds ON bbs_user (ok, golds DESC, uid ASC);
CREATE INDEX bbs_user_ok_rmbs ON bbs_user (ok, rmbs DESC, uid ASC);
