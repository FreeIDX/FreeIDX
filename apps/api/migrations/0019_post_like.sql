--  楼层点赞（帖子内「热门回复」卡的数据基础）
-- 楼层点赞独立表 post_like(tid,pid,uid,create_date,create_ip)；本表按 (uid,pid) 唯一防重，
-- tid 冗余便于按帖聚合点赞数（热门回复 = 同帖点赞数 TOP N）。
-- 计数一律 COUNT 实时算（与 bbs_like/bbs_favorite 同口径，无反规范化列）。
CREATE TABLE bbs_post_like (
  uid INTEGER NOT NULL DEFAULT 0,
  pid INTEGER NOT NULL DEFAULT 0,
  tid INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX bbs_post_like_uid_pid ON bbs_post_like (uid, pid);
CREATE INDEX bbs_post_like_tid ON bbs_post_like (tid);
CREATE INDEX bbs_post_like_pid ON bbs_post_like (pid);
