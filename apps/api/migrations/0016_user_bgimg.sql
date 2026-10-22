-- 主页背景设置（bbs_user.bgimg）
-- bgimg：用户选择的预设背景编号（'0'=默认 bg-0.png；'1'..N 对应 /theme-light/bgimg/bg-N.png，N 由 light.user_bg_num 配置）
ALTER TABLE bbs_user ADD COLUMN bgimg TEXT NOT NULL DEFAULT '0';
