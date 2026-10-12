-- 0012 每日签到插件（checkin）：bbs_checkin 表（schema 归核心，数据归插件独占，同 bbs_ad_slot 先例）
-- PK(uid, day)：uid + UTC 日序号（points.ts dayNo 口径）天然幂等，重复签到 INSERT 冲突整批回滚。
-- exp/gold/rmb/vip_days = 实发奖励快照（配置后续变更不影响历史记录）；credits 流水另记 bbs_point_log（reason='checkin'）。
CREATE TABLE bbs_checkin (
  uid INTEGER NOT NULL,
  day INTEGER NOT NULL,
  exp INTEGER NOT NULL DEFAULT 0,
  gold INTEGER NOT NULL DEFAULT 0,
  rmb INTEGER NOT NULL DEFAULT 0,
  vip_days INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL,
  PRIMARY KEY (uid, day)
);
