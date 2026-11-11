-- 卡密核销时记录关联订单号。
-- redeem 流程「核销卡密 → markPaid → fulfillOrder」之间没有事务：markPaid 失败（D1 抖动/唯一冲突）时
-- 卡已置 status=1，订单却停在 pending 且 provider_ref 仍是 claim: 占位；卡密没有 provider 侧可查，
-- 无法走 reconcilePending。对账 cron 依此列反查「已核销卡 → 悬挂订单」并补发权益。
ALTER TABLE bbs_card ADD COLUMN redeemed_order_no TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_card_redeemed_order ON bbs_card(redeemed_order_no);
