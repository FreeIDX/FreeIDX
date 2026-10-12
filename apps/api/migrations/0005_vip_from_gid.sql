-- FreeIDX 0005_vip_from_gid — 会员挂组回落（会员体系与用户组合一）。
-- vip_from_gid：开通会员挂组前的原组快照（0 = 未处于挂组态）。挂组时首次记录、续费不覆盖；
-- 到期由 cron（demoteExpiredVip）降回该组并清零，形成「开通=入组、到期=回落」的闭环。

ALTER TABLE bbs_user ADD COLUMN vip_from_gid INTEGER NOT NULL DEFAULT 0;
