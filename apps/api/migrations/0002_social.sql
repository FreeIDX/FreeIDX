-- FreeIDX 0002_social — A 组社交依赖项（点赞/关注/收藏）。
-- 冻结 schema（铁律 1）之外的新增表：计数一律 COUNT 实时算（无反规范化列，量级低频写）。

--> 0001_like  帖子点赞（tid 级，对应详情页面包屑「点赞 N」）
CREATE TABLE bbs_like (
  uid INTEGER NOT NULL DEFAULT 0,
  tid INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX bbs_like_uid_tid ON bbs_like (uid, tid);
CREATE INDEX bbs_like_tid ON bbs_like (tid);

--> 0002_follow  关注/粉丝（follower_uid 关注了 followee_uid）
CREATE TABLE bbs_follow (
  follower_uid INTEGER NOT NULL DEFAULT 0,
  followee_uid INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX bbs_follow_pair ON bbs_follow (follower_uid, followee_uid);
CREATE INDEX bbs_follow_followee ON bbs_follow (followee_uid);

--> 0003_favorite  主题收藏
CREATE TABLE bbs_favorite (
  uid INTEGER NOT NULL DEFAULT 0,
  tid INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX bbs_favorite_uid_tid ON bbs_favorite (uid, tid);
CREATE INDEX bbs_favorite_uid ON bbs_favorite (uid);
