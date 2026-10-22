--  收藏表查询覆盖索引：消除主题页热路径与主题真删上的全表扫描。
--  背景：0021 逐条比对 WHERE / ORDER BY 与既有索引时漏了 bbs_favorite —— 该表只有
--  `bbs_favorite_uid_tid (uid, tid)` 与 `bbs_favorite_uid (uid)`，而生产热路径过滤的是 tid
--  （复合索引的第二列无法 seek）。D1 按 rows_read 计费，无索引时 `COUNT(*) WHERE tid = ?`
--  的 rows_read ≈ 全表行数（不是返回行数），收藏量增长即等比例放大配额消耗。
--  注：0001~0021 已应用到远端库不可改写，故新增迁移。

-- 主题详情页收藏计数（modules/thread/routes.ts：WHERE tid = ?；游客侧 60s 边缘缓存未命中时执行）
-- 收藏者弹层（同文件：WHERE f.tid = ? ORDER BY f.create_date DESC LIMIT 50）
-- 收藏 toggle 回显计数（modules/my/routes.ts：WHERE tid = ?）
-- 主题真删级联（core/purge.ts、modules/admin/forums.ts：DELETE ... WHERE tid IN (...)，此前全表扫描）
CREATE INDEX bbs_favorite_tid_date ON bbs_favorite (tid, create_date DESC);

-- 刻意未覆盖：热门收藏榜（modules/thread/routes.ts /api/threads/hot-favorites：
-- WHERE f.create_date >= ? GROUP BY t.tid）需要 (create_date, tid) 才能按时间窗口 seek。
-- 该卡片出厂关闭（extensions/light.ts hotFavoriteCard 默认 false），故不为它给每次收藏/取消收藏
-- 增加一份索引写放大；若后台启用该卡片，再补 bbs_favorite_date_tid。
