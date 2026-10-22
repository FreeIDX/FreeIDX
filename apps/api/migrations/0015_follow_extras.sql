--  关注附加项（我的关注页「备注」与「接收动态」开关）
-- comment：关注备注（列表与动态流以备注优先显示，空串=未设）
-- show_dynamic：是否接收该用户的动态（1=接收，0=从关注动态流中隐藏；默认 1）
ALTER TABLE bbs_follow ADD COLUMN comment TEXT NOT NULL DEFAULT '';
ALTER TABLE bbs_follow ADD COLUMN show_dynamic INTEGER NOT NULL DEFAULT 1;