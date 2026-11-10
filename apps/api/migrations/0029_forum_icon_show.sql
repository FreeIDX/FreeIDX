/**
 * 0029_forum_icon_show：版块图标显示开关（逐版块独立）。
 *
 * icon_show：1 = 前台版块栏（首页/版块页左侧导航）显示该版块图标（默认，与历史行为一致）；
 *            0 = 只显示版块名，不渲染图标（自定义图与内置默认 folder 图都不出现）。
 *
 * 只影响**展示**：icon_file / icon_time（0003）照旧保存，关掉后图标文件仍在 R2，
 * 重新打开即恢复，不需要重新上传。其它位置（主题列表行徽标、版块页头部大图、
 * 发现页/发帖页的选择项）仍按 icon_url 正常展示，本列只作用于版块栏。
 */
ALTER TABLE bbs_forum ADD COLUMN icon_show INTEGER NOT NULL DEFAULT 1;
