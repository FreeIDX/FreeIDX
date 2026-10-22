-- FreeIDX 0008_credits — 积分交易
-- 三币种列 credits(经验)/golds(金币)/rmbs(人民币·分) 与 group.creditsfrom/creditsto 已在 0001 建好；
-- 本迁移补齐：主题付费位（content_buy/content_buy_type）、用户组收费权限（allowsell）与两张流水表。

-- 付费主题：content_buy=价格（type=3 时单位为分，其余为个）；
-- content_buy_type：1=经验 2=金币 3=人民币（分）。0=免费（旧帖与未收费帖的自然默认）
ALTER TABLE bbs_thread ADD COLUMN content_buy INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bbs_thread ADD COLUMN content_buy_type INTEGER NOT NULL DEFAULT 1;

-- 收费帖权限位（group.allowsell，默认 0；后台「收费组设置」逐组开启）
ALTER TABLE bbs_group ADD COLUMN allowsell INTEGER NOT NULL DEFAULT 0;

--> 0008_paylist  付费主题购买清单（type=1 即购买主题）
-- num=成交价（按 credit_type 单位）；rate 为预留列（未用）；UNIQUE(plid,tid) 防重复键
CREATE TABLE bbs_paylist (
  plid INTEGER PRIMARY KEY AUTOINCREMENT,
  tid INTEGER NOT NULL DEFAULT 0,
  uid INTEGER NOT NULL DEFAULT 0,
  num INTEGER NOT NULL DEFAULT 0,
  credit_type INTEGER NOT NULL DEFAULT 0,
  type INTEGER NOT NULL DEFAULT 0,
  rate INTEGER NOT NULL DEFAULT 0,
  paytime INTEGER NOT NULL DEFAULT 0,
  -- 原子性锚定列（项目增强）：batch 内插入随机串，后续扣款/入账语句以
  -- EXISTS(... AND nonce=?) 守卫，确保「本请求的流水行已插入」才允许动余额
  nonce TEXT NOT NULL DEFAULT ''
);
CREATE INDEX bbs_paylist_tid ON bbs_paylist (tid);
CREATE UNIQUE INDEX bbs_paylist_plid_tid ON bbs_paylist (plid, tid);
-- 已购幂等：同一用户对同一主题 type=1 至多一行（购买 INSERT...SELECT 冲突即整批回滚 → '免费成功' 分支）
CREATE UNIQUE INDEX bbs_paylist_tid_uid ON bbs_paylist (tid, uid) WHERE type = 1;
-- 已购列表（my-purchased）：uid + paytime 倒序
CREATE INDEX bbs_paylist_uid ON bbs_paylist (uid, paytime);
CREATE INDEX bbs_paylist_nonce ON bbs_paylist (uid, nonce);

--> 0008_user_pay  全站积分变动记录（type 定义见积分模块）
-- type：4=购买主题 6=兑换 12=发送转账 13=收到转账（其余类型留给后续红包/悬赏/VIP 等复用同表）
CREATE TABLE bbs_user_pay (
  cid INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  num INTEGER NOT NULL DEFAULT 0,
  type INTEGER NOT NULL DEFAULT 1,
  credit_type INTEGER NOT NULL DEFAULT 1,
  code TEXT NOT NULL DEFAULT '',
  time INTEGER NOT NULL DEFAULT 0,
  -- 原子性锚定列（项目增强）：同 bbs_paylist.nonce，兑换/转账等资金的守卫锚
  nonce TEXT NOT NULL DEFAULT ''
);
CREATE INDEX bbs_user_pay_uid ON bbs_user_pay (uid, time);
-- 兑换频控（每 10 分钟 1 次）：uid + type + time 取最近一条
CREATE INDEX bbs_user_pay_uid_type ON bbs_user_pay (uid, type, time);
CREATE INDEX bbs_user_pay_nonce ON bbs_user_pay (uid, nonce);