-- 内容语言分区（模式 1「软过滤」的数据底座）
--
-- lang 与界面语言（cookie `lang` / kv setting.lang）是两套体系：
--   · 界面语言决定 UI 文案，不影响数据；
--   · 内容语言描述「帖子正文用哪种语言写成」，写时定稿、读时过滤。
--
-- 取值：zh / en / ja / ko / ru / th / de / fr / es / other；空串 = 未指定（存量数据）。
-- 由发帖时自动检测或用户显式选择写入（见 packages/shared/src/content-lang.ts）。
ALTER TABLE bbs_thread ADD COLUMN lang TEXT NOT NULL DEFAULT '';

-- 列表两条排序路径（tid / lastpid）各配一条「语言 + 排序列」复合索引：
-- lang 基数极低（≤10），等值过滤后仍可直接走索引取有序页，避免全表扫描。
CREATE INDEX IF NOT EXISTS bbs_thread_lang_tid ON bbs_thread (lang, tid);
CREATE INDEX IF NOT EXISTS bbs_thread_lang_lastpid ON bbs_thread (lang, lastpid);
