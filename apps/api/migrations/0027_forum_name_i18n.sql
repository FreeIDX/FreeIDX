/**
 * 0027_forum_name_i18n：版块名多语言。
 *
 * 存法：JSON 对象 `{"zh-cn":"综合讨论","en-us":"General"}`，空串 = 未配置。
 *  - 主名称仍是 name（后台列表 / SEO / 前端缺省回退都读它），本列只覆盖「展示取词」；
 *  - 只接受 AVAILABLE_LOCALES 内的语言（归一化见 shared/forum-name.ts）；
 *  - 与 0024 的 lang（内容语言，只过滤/绑定主题）无关，不改变任何查询口径。
 *
 * 前端按当前界面语言取词：命中本列 → 用译文；未命中 → 回退 name。
 * 因此切换语言无需重新请求 bootstrap，展示即时同步。
 */
ALTER TABLE bbs_forum ADD COLUMN name_i18n TEXT NOT NULL DEFAULT '';
