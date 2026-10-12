-- FreeIDX 0006_notice — 消息系统（huux_notice）。
-- type：0=全部（仅查询过滤用）· 2=评论（回帖/引用通知）· 3=系统（版务/管理员通知）· 99=其他。
-- 计数口径：notices / unread_notices 不设反规范化列，
-- 未读数实时 COUNT 走 (recvuid, isread) 索引（与 0002_social 同一取舍，量级低频写）。

CREATE TABLE bbs_notice (
  nid INTEGER PRIMARY KEY AUTOINCREMENT,
  fromuid INTEGER NOT NULL DEFAULT 0,
  recvuid INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0,
  isread INTEGER NOT NULL DEFAULT 0,
  type INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX bbs_notice_recvuid ON bbs_notice (recvuid, isread);
CREATE INDEX bbs_notice_recvuid_type ON bbs_notice (recvuid, type);