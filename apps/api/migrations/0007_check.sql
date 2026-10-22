-- FreeIDX 0007_check — 内容审核 + 回收站
-- ok 状态机（OK INT(3)）：1=正常 0=待审核 -1=未通过（拒绝） -2=回收站（软删除）
-- 审核触发（check_or_not）：用户组与板块的同名 check 位**同时为 1** 时，该用户在该板块的内容进入待审核；
-- 全局开关 user_check（注册审核）/ recycle（回收站）存 bbs_kv.setting。
ALTER TABLE bbs_thread ADD COLUMN ok INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bbs_post ADD COLUMN ok INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bbs_user ADD COLUMN ok INTEGER NOT NULL DEFAULT 1;

-- 用户组审核位（group.thread_check/post_check/edit_check/see_check，同名同默认）
-- see_check = 「查看、审核、操作回收站」：非 see_check 用户看不见他人未过审/回收站内容，也无现场审核权
ALTER TABLE bbs_group ADD COLUMN thread_check INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bbs_group ADD COLUMN post_check INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bbs_group ADD COLUMN edit_check INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bbs_group ADD COLUMN see_check INTEGER NOT NULL DEFAULT 0;

-- 板块审核位（forum.thread_check/post_check/edit_check）
ALTER TABLE bbs_forum ADD COLUMN thread_check INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bbs_forum ADD COLUMN post_check INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bbs_forum ADD COLUMN edit_check INTEGER NOT NULL DEFAULT 0;

-- 待审核/未通过/回收站列表（后台按 ok 过滤 + id 倒序）
CREATE INDEX bbs_thread_ok_tid ON bbs_thread (ok, tid);
CREATE INDEX bbs_post_ok_pid ON bbs_post (ok, pid);
CREATE INDEX bbs_user_ok_uid ON bbs_user (ok, uid);