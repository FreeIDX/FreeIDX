-- FreeIDX 0003_forum_icon — 版块图标上传（落盘 R2）。
-- icon_file：R2 key（如 forum/3.png），非空 = 有自定义图标；
-- icon_time：上传 unix 时间戳，兼作 icon_url 的缓存版本号。

ALTER TABLE bbs_forum ADD COLUMN icon_file TEXT NOT NULL DEFAULT '';
ALTER TABLE bbs_forum ADD COLUMN icon_time INTEGER NOT NULL DEFAULT 0;
