-- 小黑屋（用户封禁/禁言）：
--   ban_scope 位掩码 0=无 1=禁言(MUTE) 2=禁访(READ) 4=禁登(LOGIN)，可组合（3=禁言+禁访，7=传统封号）
--   ban_until 0=永久，否则为解封时间（unix 秒）；到期由读路径惰性判定 + 每小时 cron 兜底清理
--   ban_reason/ban_at/ban_by 为当前生效封禁的理由、操作时间、操作者 uid
-- 热路径（每请求的 loadViewer）只读 bbs_user 本行，故封禁态放主表而非独立表，避免额外 D1 读；
-- bbs_user_ban 只承担历史/解封留痕（低频写、后台可查）。
ALTER TABLE bbs_user ADD COLUMN ban_scope INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bbs_user ADD COLUMN ban_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bbs_user ADD COLUMN ban_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE bbs_user ADD COLUMN ban_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bbs_user ADD COLUMN ban_by INTEGER NOT NULL DEFAULT 0;

-- 到期扫描：部分索引只收录生效中的封禁行，cron 每小时档据此定位（无封禁行时索引近空）
CREATE INDEX IF NOT EXISTS bbs_user_ban_until ON bbs_user (ban_until) WHERE ban_scope > 0;

CREATE TABLE IF NOT EXISTS bbs_user_ban (
  bid INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL DEFAULT 0,
  scope INTEGER NOT NULL DEFAULT 1,
  reason TEXT NOT NULL DEFAULT '',
  operator_uid INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0,
  expire_date INTEGER NOT NULL DEFAULT 0,
  lifted_at INTEGER NOT NULL DEFAULT 0,
  lifted_by INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS bbs_user_ban_uid ON bbs_user_ban (uid, create_date DESC);
