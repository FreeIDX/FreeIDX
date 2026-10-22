-- FreeIDX seed — 基础种子数据（§5.4），日期统一 unix 秒
-- 应用方式：pnpm db:seed（wrangler d1 execute --local / 远端同名命令）

--> s1_group（预置用户组 0/1/2/4/5/6/7/101-105，credits 区间见各组定义）
INSERT OR REPLACE INTO bbs_group (gid, name, creditsfrom, creditsto, allowread, allowthread, allowpost, allowattach, allowdown, allowtop, allowupdate, allowdelete, allowmove, allowbanuser, allowdeleteuser, allowviewip) VALUES
(0,   '游客组',       0,     0,         1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0),
(1,   '管理员组',     0,     0,         1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1),
(2,   '超级版主组',   0,     0,         1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1),
(4,   '版主组',       0,     0,         1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1),
(5,   '实习版主组',   0,     0,         1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 0),
(6,   '待验证用户组', 0,     0,         1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0),
(7,   '禁止用户组',   0,     0,         0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0),
(101, '一级用户组',   0,     50,        1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0),
(102, '二级用户组',   50,    200,       1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0),
(103, '三级用户组',   200,   1000,      1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0),
(104, '四级用户组',   1000,  10000,     1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0),
(105, '五级用户组',   10000, 10000000,  1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0),
(106, 'VIP会员组',    0,     0,         1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0);

--> s2_forum（默认版块，同 install.sql：fid=1 允许删除保留 system_forum=[1]）
INSERT OR REPLACE INTO bbs_forum (fid, name, rank, brief, create_date) VALUES
(1, '默认版块', 1, '默认版块介绍', 0);

--> s3_forum_access（fid=1 × 全部组的 5 项权限矩阵，等价 forum_access_padding；
--     forum.accesson=0 时不生效，后台开权限控制后即按此矩阵双与）
INSERT OR REPLACE INTO bbs_forum_access (fid, gid, allowread, allowthread, allowpost, allowattach, allowdown) VALUES
(1, 0,   1, 0, 1, 0, 1),
(1, 1,   1, 1, 1, 1, 1),
(1, 2,   1, 1, 1, 1, 1),
(1, 4,   1, 1, 1, 1, 1),
(1, 5,   1, 1, 1, 1, 1),
(1, 6,   1, 0, 1, 0, 1),
(1, 7,   0, 0, 0, 0, 0),
(1, 101, 1, 1, 1, 1, 1),
(1, 102, 1, 1, 1, 1, 1),
(1, 103, 1, 1, 1, 1, 1),
(1, 104, 1, 1, 1, 1, 1),
(1, 105, 1, 1, 1, 1, 1),
(1, 106, 1, 1, 1, 1, 1);

--> s4_admin（首个管理员，预置哈希 = 旧 md5 兼容链路，
--     登录后可通过 legacy 校验懒升级；生产部署务必改密）
INSERT OR REPLACE INTO bbs_user (uid, gid, email, username, password, salt, create_date) VALUES
(1, 1, 'admin@admin.com', 'admin', 'd98bb50e808918dd45a8d92feafc4fa3', '123456', 0);

--> s5_setting（kv 表 setting 键 = 站点设置唯一存储，§5.3）
INSERT OR REPLACE INTO bbs_kv (k, v, expiry) VALUES
('setting', '{"sitename":"FreeIDX","brief":"FreeIDX 论坛","url":"","kw":"","desc":"","runlevel":5,"user_create_on":1,"user_create_email_on":0,"user_resetpw_on":1,"admin_on":1,"forum_orderby":0,"update_views_on":1,"upload_max_size":20971520,"lang":"en-us"}', 0),
('extensions', '{}', 0);

--> s6_stat_baseline（runtime 初值由 COUNT 重建，seed 后校准）
INSERT OR REPLACE INTO bbs_kv (k, v, expiry) VALUES
('runtime', '{"users":1,"threads":0,"posts":0,"onlines":1,"todayusers":0,"todayposts":0,"todaythreads":0,"cron_1_last_date":0,"cron_2_last_date":0}', 0);
