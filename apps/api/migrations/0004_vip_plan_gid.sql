-- FreeIDX 0004_vip_plan_gid — VIP 计划关联用户组。
-- gid：购买/兑换该计划履约时把买家挂入的用户组（0 = 不关联，仅延长会员时长）。
-- 仅允许 0 或 >=100 的等级/VIP 组（<100 为管理组，履约写库时同样受保护，防止提权误配）。

ALTER TABLE bbs_vip_plan ADD COLUMN gid INTEGER NOT NULL DEFAULT 0;
