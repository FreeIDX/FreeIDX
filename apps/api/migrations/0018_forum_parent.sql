-- FreeIDX 0018_forum_parent — 二级版块（版块层级）。
-- parent_fid：上级版块 fid，0 = 一级版块（顶层）；仅支持两级（一级 + 子版块）。
-- 前台 /api/bootstrap 的 forumlist 仍为扁平数组（含子版块），每项带 parentFid，由前端归并成二级导航。

ALTER TABLE bbs_forum ADD COLUMN parent_fid INTEGER NOT NULL DEFAULT 0;
CREATE INDEX bbs_forum_parent ON bbs_forum (parent_fid);