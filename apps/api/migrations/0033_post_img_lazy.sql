-- 正文图片补 loading="lazy" / decoding="async"（性能项 16-a）。
--
-- 新内容由写时定稿（core/fmt.ts 的 decorateImages）自动补属性，本迁移只回填**历史帖子**：
-- 一条帖子塞多张原图（实测单张 449KB）时，旧 HTML 会让浏览器在首屏并发拉取全部原图。
--
-- 安全性：
--   * 只改 message_fmt 里的标签属性，不动正文文本，也不动 message 原文；
--   * message_fmt 由 sanitize 产出，代码块里的 `<img` 已转义成 &lt;img，不会被误伤；
--   * 已带 loading= 的行整行跳过，可重复执行（幂等）。
UPDATE bbs_post
   SET message_fmt = REPLACE(
         REPLACE(message_fmt, '<img ', '<img loading="lazy" decoding="async" '),
         '<img>', '<img loading="lazy" decoding="async">'
       )
 WHERE instr(message_fmt, '<img') > 0
   AND instr(message_fmt, 'loading=') = 0;
