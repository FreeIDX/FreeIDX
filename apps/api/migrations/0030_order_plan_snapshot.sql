-- 订单创建时快照计划权益（时长 / 赠送积分）。
-- 履约与退款一律优先读快照：计划可被硬删（deletePlan）或被整量改价（updatePlan），
-- 若退款时按「当前计划」计算，会出现「钱已退、权益一分未回收」或「多扣用户 VIP」。
-- -1 = 旧订单无快照，回退读取 bbs_vip_plan（兼容发布前已存在的 pending/paid 单）。
ALTER TABLE bbs_order ADD COLUMN plan_duration_days INTEGER NOT NULL DEFAULT -1;
ALTER TABLE bbs_order ADD COLUMN plan_credits INTEGER NOT NULL DEFAULT -1;
ALTER TABLE bbs_order ADD COLUMN plan_gid INTEGER NOT NULL DEFAULT -1;
