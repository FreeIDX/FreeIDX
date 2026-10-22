-- FreeIDX 0011_announcement — 首页系统公告（本项目新增，依托 huux_notice 消息管理）。
-- 后台「发送系统通知」勾选公告开关时，除写入 bbs_notice 外同步落一条公告；
-- isshow=1 前台 GET /api/announcements 下发（首页浅蓝公告条），多条按 aid 倒序轮播；
-- isshow=0 不显示（后台列表内可再切换）。nid 关联源消息，删除消息时级联删除公告。

CREATE TABLE bbs_announcement (
  aid INTEGER PRIMARY KEY AUTOINCREMENT,
  nid INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  isshow INTEGER NOT NULL DEFAULT 1,
  create_date INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX bbs_announcement_isshow ON bbs_announcement (isshow, aid);
