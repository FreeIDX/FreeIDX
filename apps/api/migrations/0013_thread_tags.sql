-- 主题标签（idx_tag 轻量实现）
-- tags 为反规范化列：逗号分隔的标签名（≤4 个、每个 ≤12 字），发帖时随行写入；
-- 列表/详情零 JOIN 直接下发，按标签筛选走 `instr(','||tags||',', ',标签,')`。
ALTER TABLE bbs_thread ADD COLUMN tags TEXT NOT NULL DEFAULT '';