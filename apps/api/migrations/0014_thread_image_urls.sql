-- 列表图片组（thread_summary_pic）
-- image_urls 为反规范化列：首帖正文 HTML 中提取的图片地址（≤9 张，逗号分隔）；
-- 发帖/首帖编辑时随行写入，列表零 JOIN 直接下发缩略图（前台按 thread_summary_pic 截断渲染）。
ALTER TABLE bbs_thread ADD COLUMN image_urls TEXT NOT NULL DEFAULT '';