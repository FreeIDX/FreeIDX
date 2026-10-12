-- FreeIDX 0010_avatar_auto — 预设头像
-- 用户头像设为站内预设图（前端静态资源 /avatars/0..56.png）：
--   选预设（imgsrc 非空）→ avatar_auto=路径 + avatar=0（与自定义头像互斥，同步删除旧自定义头像文件）
--   仅清预设（imgsrc 为空）→ avatar_auto 置 '0'，不动 avatar
-- avatar_auto 默认 '0'；'0'=未使用预设。
-- 头像解析：avatar 为空且 avatar_auto 非 '0'/非空 → 头像取 avatar_auto。

ALTER TABLE bbs_user ADD COLUMN avatar_auto TEXT NOT NULL DEFAULT '0';
