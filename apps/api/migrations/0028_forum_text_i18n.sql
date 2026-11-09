/**
 * 0028_forum_text_i18n：版块简介 / 版块公告 / SEO 标题 / SEO 关键词多语言。
 *
 * 存法与 0027 的 name_i18n 完全一致：JSON 对象 `{"zh-cn":"…","en-us":"…"}`，空串 = 未配置。
 *  - 主字段（brief / announcement / seo_title / seo_keywords）仍是事实源：
 *    后台列表、SEO 缺省回退、前台未命中语言时都读它，本列只覆盖「展示取词」；
 *  - 只接受 AVAILABLE_LOCALES 内的语言（归一化见 shared/forum-name.ts 的 normNameI18n）；
 *  - 不影响任何查询/发帖口径，只影响展示与 SEO 产物文案。
 *
 * 前端按当前界面语言取词（切换语言即时同步）；SEO 静态产物固定按站点语言（setting.lang）取词。
 */
ALTER TABLE bbs_forum ADD COLUMN brief_i18n TEXT NOT NULL DEFAULT '';
ALTER TABLE bbs_forum ADD COLUMN announcement_i18n TEXT NOT NULL DEFAULT '';
ALTER TABLE bbs_forum ADD COLUMN seo_title_i18n TEXT NOT NULL DEFAULT '';
ALTER TABLE bbs_forum ADD COLUMN seo_keywords_i18n TEXT NOT NULL DEFAULT '';
