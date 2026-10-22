-- FreeIDX 0001_init — G1 schema 冻结（铁律 1：全表一次定稿）
-- MySQL→SQLite 转换（§5.1）：unix 秒 INTEGER、去 ENGINE、独立 CREATE INDEX、保留 bbs_ 前缀。
-- session_data 合并进 session.data（D1 单行 2MB）；核心表 16 张 + email_code
-- + 会员体系 4 张（vip_plan/order/point_log/card）+ ad_slot。
--
-- ⚠️ 本文件是**历史起点，不是终态**：此后 0002~0022 又加了十余列、多张表与成批索引。
--    想看全库最终长什么样，看 apps/api/schema.sql（由本地库自动导出，唯一可读终态）；
--    本文件不可改写——已部署库的 d1_migrations 按文件名认账，改内容不会重跑也不会补列。

--> 0001_user
CREATE TABLE bbs_user (
  uid INTEGER PRIMARY KEY AUTOINCREMENT,
  gid INTEGER NOT NULL DEFAULT 0,
  email TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  realname TEXT NOT NULL DEFAULT '',
  idnumber TEXT NOT NULL DEFAULT '',
  password TEXT NOT NULL DEFAULT '',
  password_sms TEXT NOT NULL DEFAULT '',
  salt TEXT NOT NULL DEFAULT '',
  mobile TEXT NOT NULL DEFAULT '',
  qq TEXT NOT NULL DEFAULT '',
  threads INTEGER NOT NULL DEFAULT 0,
  posts INTEGER NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL DEFAULT 0,
  golds INTEGER NOT NULL DEFAULT 0,
  rmbs INTEGER NOT NULL DEFAULT 0,
  create_ip INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0,
  login_ip INTEGER NOT NULL DEFAULT 0,
  login_date INTEGER NOT NULL DEFAULT 0,
  logins INTEGER NOT NULL DEFAULT 0,
  avatar INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0,
  vip_expire_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX bbs_user_username ON bbs_user (username);
CREATE UNIQUE INDEX bbs_user_email ON bbs_user (email);
CREATE INDEX bbs_user_gid ON bbs_user (gid);

--> 0002_group
CREATE TABLE bbs_group (
  gid INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  creditsfrom INTEGER NOT NULL DEFAULT 0,
  creditsto INTEGER NOT NULL DEFAULT 0,
  allowread INTEGER NOT NULL DEFAULT 0,
  allowthread INTEGER NOT NULL DEFAULT 0,
  allowpost INTEGER NOT NULL DEFAULT 0,
  allowattach INTEGER NOT NULL DEFAULT 0,
  allowdown INTEGER NOT NULL DEFAULT 0,
  allowtop INTEGER NOT NULL DEFAULT 0,
  allowupdate INTEGER NOT NULL DEFAULT 0,
  allowdelete INTEGER NOT NULL DEFAULT 0,
  allowmove INTEGER NOT NULL DEFAULT 0,
  allowbanuser INTEGER NOT NULL DEFAULT 0,
  allowdeleteuser INTEGER NOT NULL DEFAULT 0,
  allowviewip INTEGER NOT NULL DEFAULT 0
);

--> 0003_forum
CREATE TABLE bbs_forum (
  fid INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  rank INTEGER NOT NULL DEFAULT 0,
  threads INTEGER NOT NULL DEFAULT 0,
  todayposts INTEGER NOT NULL DEFAULT 0,
  todaythreads INTEGER NOT NULL DEFAULT 0,
  brief TEXT NOT NULL DEFAULT '',
  announcement TEXT NOT NULL DEFAULT '',
  accesson INTEGER NOT NULL DEFAULT 0,
  orderby INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0,
  icon INTEGER NOT NULL DEFAULT 0,
  moduids TEXT NOT NULL DEFAULT '',
  seo_title TEXT NOT NULL DEFAULT '',
  seo_keywords TEXT NOT NULL DEFAULT ''
);
CREATE INDEX bbs_forum_rank ON bbs_forum (rank);

--> 0004_forum_access
CREATE TABLE bbs_forum_access (
  fid INTEGER NOT NULL DEFAULT 0,
  gid INTEGER NOT NULL DEFAULT 0,
  allowread INTEGER NOT NULL DEFAULT 0,
  allowthread INTEGER NOT NULL DEFAULT 0,
  allowpost INTEGER NOT NULL DEFAULT 0,
  allowattach INTEGER NOT NULL DEFAULT 0,
  allowdown INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (fid, gid)
);

--> 0005_thread（含 digest 与反规范化 username/lastusername/avatar 列，§5.2）
CREATE TABLE bbs_thread (
  tid INTEGER PRIMARY KEY AUTOINCREMENT,
  fid INTEGER NOT NULL DEFAULT 0,
  top INTEGER NOT NULL DEFAULT 0,
  digest INTEGER NOT NULL DEFAULT 0,
  uid INTEGER NOT NULL DEFAULT 0,
  username TEXT NOT NULL DEFAULT '',
  avatar INTEGER NOT NULL DEFAULT 0,
  userip INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL DEFAULT '',
  create_date INTEGER NOT NULL DEFAULT 0,
  last_date INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  posts INTEGER NOT NULL DEFAULT 0,
  images INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  mods INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  firstpid INTEGER NOT NULL DEFAULT 0,
  lastuid INTEGER NOT NULL DEFAULT 0,
  lastusername TEXT NOT NULL DEFAULT '',
  lastpid INTEGER NOT NULL DEFAULT 0
);
-- 覆盖索引：列表页 (fid,lastpid) 倒排 与 (fid,tid) 正序（§18.3#7）
CREATE INDEX bbs_thread_fid_lastpid ON bbs_thread (fid, lastpid);
CREATE INDEX bbs_thread_fid_tid ON bbs_thread (fid, tid);
CREATE INDEX bbs_thread_fid_digest ON bbs_thread (fid, digest, tid);
CREATE INDEX bbs_thread_uid ON bbs_thread (uid);

--> 0006_thread_top
CREATE TABLE bbs_thread_top (
  tid INTEGER PRIMARY KEY,
  fid INTEGER NOT NULL DEFAULT 0,
  top INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX bbs_thread_top_top_tid ON bbs_thread_top (top, tid);
CREATE INDEX bbs_thread_top_fid_top ON bbs_thread_top (fid, top);

--> 0007_post
CREATE TABLE bbs_post (
  pid INTEGER PRIMARY KEY AUTOINCREMENT,
  tid INTEGER NOT NULL DEFAULT 0,
  uid INTEGER NOT NULL DEFAULT 0,
  isfirst INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0,
  userip INTEGER NOT NULL DEFAULT 0,
  images INTEGER NOT NULL DEFAULT 0,
  files INTEGER NOT NULL DEFAULT 0,
  doctype INTEGER NOT NULL DEFAULT 0,
  quotepid INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  message_fmt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX bbs_post_tid_pid ON bbs_post (tid, pid);
CREATE INDEX bbs_post_uid ON bbs_post (uid);

--> 0008_attach（filename 存 R2 key；status 0=临时待关联 1=已入库，§9.3）
CREATE TABLE bbs_attach (
  aid INTEGER PRIMARY KEY AUTOINCREMENT,
  tid INTEGER NOT NULL DEFAULT 0,
  pid INTEGER NOT NULL DEFAULT 0,
  uid INTEGER NOT NULL DEFAULT 0,
  filesize INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  filename TEXT NOT NULL DEFAULT '',
  orgfilename TEXT NOT NULL DEFAULT '',
  filetype TEXT NOT NULL DEFAULT '',
  create_date INTEGER NOT NULL DEFAULT 0,
  comment TEXT NOT NULL DEFAULT '',
  downloads INTEGER NOT NULL DEFAULT 0,
  credits INTEGER NOT NULL DEFAULT 0,
  golds INTEGER NOT NULL DEFAULT 0,
  rmbs INTEGER NOT NULL DEFAULT 0,
  isimage INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX bbs_attach_pid ON bbs_attach (pid);
CREATE INDEX bbs_attach_uid ON bbs_attach (uid);
CREATE INDEX bbs_attach_status_date ON bbs_attach (status, create_date);

--> 0009_mythread
CREATE TABLE bbs_mythread (
  uid INTEGER NOT NULL DEFAULT 0,
  tid INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, tid)
);
CREATE INDEX bbs_mythread_tid ON bbs_mythread (tid);

--> 0010_mypost（写路径由 post_create 事件真实维护——§D.4）
CREATE TABLE bbs_mypost (
  uid INTEGER NOT NULL DEFAULT 0,
  tid INTEGER NOT NULL DEFAULT 0,
  pid INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, pid)
);
CREATE INDEX bbs_mypost_tid ON bbs_mypost (tid);

--> 0011_session（合并 session_data：data TEXT 单列，D1 单行 2MB 足够）
CREATE TABLE bbs_session (
  sid TEXT PRIMARY KEY,
  uid INTEGER NOT NULL DEFAULT 0,
  fid INTEGER NOT NULL DEFAULT 0,
  url TEXT NOT NULL DEFAULT '',
  ip INTEGER NOT NULL DEFAULT 0,
  useragent TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '',
  last_date INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX bbs_session_uid_last_date ON bbs_session (uid, last_date);
CREATE INDEX bbs_session_last_date ON bbs_session (last_date);
CREATE INDEX bbs_session_fid ON bbs_session (fid);

--> 0012_modlog（版务审计日志，后台提供查看器）
CREATE TABLE bbs_modlog (
  logid INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL DEFAULT 0,
  tid INTEGER NOT NULL DEFAULT 0,
  pid INTEGER NOT NULL DEFAULT 0,
  subject TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  rmbs INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL DEFAULT ''
);
CREATE INDEX bbs_modlog_uid_logid ON bbs_modlog (uid, logid);
CREATE INDEX bbs_modlog_tid ON bbs_modlog (tid);

--> 0013_kv（站点设置唯一存储，§5.3）
CREATE TABLE bbs_kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL DEFAULT '',
  expiry INTEGER NOT NULL DEFAULT 0
);

--> 0014_cache（L2 D1 兜底缓存层，§7）
CREATE TABLE bbs_cache (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL DEFAULT '',
  expiry INTEGER NOT NULL DEFAULT 0
);

--> 0015_queue
CREATE TABLE bbs_queue (
  queueid INTEGER NOT NULL DEFAULT 0,
  v INTEGER NOT NULL DEFAULT 0,
  expiry INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (queueid, v)
);
CREATE INDEX bbs_queue_expiry ON bbs_queue (expiry);

--> 0016_table_day（v1 建表不启用，§14.9）
CREATE TABLE bbs_table_day (
  year INTEGER NOT NULL DEFAULT 0,
  month INTEGER NOT NULL DEFAULT 0,
  day INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0,
  "table" TEXT NOT NULL DEFAULT '',
  maxid INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (year, month, day, "table")
);

--> 0017_email_code（按 email 存储 + TTL 强制过期 §D.8#11）
CREATE TABLE bbs_email_code (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  scene TEXT NOT NULL DEFAULT '',
  create_date INTEGER NOT NULL DEFAULT 0,
  expiry INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX bbs_email_code_email_scene ON bbs_email_code (email, scene, id);

--> 0018_vip_plan（§15.2）
CREATE TABLE bbs_vip_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  duration_days INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  perks TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0
);

--> 0019_order（status 状态机 pending→paid→fulfilled/refunded；provider_ref 唯一约束做 webhook 幂等）
CREATE TABLE bbs_order (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL DEFAULT '',
  uid INTEGER NOT NULL DEFAULT 0,
  plan_id INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'pending',
  provider TEXT NOT NULL DEFAULT '',
  provider_ref TEXT NOT NULL DEFAULT '',
  created_date INTEGER NOT NULL DEFAULT 0,
  paid_date INTEGER NOT NULL DEFAULT 0,
  fulfilled_date INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX bbs_order_no ON bbs_order (order_no);
CREATE UNIQUE INDEX bbs_order_provider_ref ON bbs_order (provider_ref) WHERE provider_ref <> '';
CREATE INDEX bbs_order_uid ON bbs_order (uid, id);
CREATE INDEX bbs_order_status ON bbs_order (status, created_date);

--> 0020_point_log（余额+流水同批事务；biz_key 幂等防重复发放，§15.1）
CREATE TABLE bbs_point_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL DEFAULT 0,
  change INTEGER NOT NULL DEFAULT 0,
  balance INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  biz_key TEXT NOT NULL DEFAULT '',
  create_date INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX bbs_point_log_biz ON bbs_point_log (uid, biz_key) WHERE biz_key <> '';
CREATE INDEX bbs_point_log_uid ON bbs_point_log (uid, id);

--> 0021_card（卡密插件数据，§15.5）
CREATE TABLE bbs_card (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL DEFAULT '',
  plan_id INTEGER NOT NULL DEFAULT 0,
  batch_no TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0,
  redeemed_uid INTEGER NOT NULL DEFAULT 0,
  redeemed_date INTEGER NOT NULL DEFAULT 0,
  expire_date INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX bbs_card_code ON bbs_card (code);
CREATE INDEX bbs_card_batch ON bbs_card (batch_no, status);

--> 0022_ad_slot（schema 归核心、数据归 ads 插件独占，§17.1）
CREATE TABLE bbs_ad_slot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'html',
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  start_date INTEGER NOT NULL DEFAULT 0,
  end_date INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX bbs_ad_slot_position ON bbs_ad_slot (position, enabled, sort);

--> 0023_login_fail（IP×账号失败计数 5 次锁 15min，§8.4 纵深防御）
CREATE TABLE bbs_login_fail (
  k TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  lock_until INTEGER NOT NULL DEFAULT 0,
  last_date INTEGER NOT NULL DEFAULT 0
);
