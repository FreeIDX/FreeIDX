-- 列表摘要（列表标题下的首帖纯文本摘要）
-- summary：首帖正文去标签后的纯文本摘要（写入时截断，最多 300 字；前台按 light.thread_summary_word 再截断）
ALTER TABLE bbs_thread ADD COLUMN summary TEXT NOT NULL DEFAULT '';
