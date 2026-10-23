-- FreeIDX 终态 schema 快照 —— 自动生成，请勿手工编辑
--
-- 生成：pnpm --filter @freeidx/api db:schema:dump
-- 校验：pnpm --filter @freeidx/api db:schema:check（CI 门禁，不一致即红）
--
-- 来源：migrations/*.sql 全量应用后的本地 D1 库（sqlite_master 导出，无数据）
-- 用途：唯一可读的终态事实源。migrations/ 保留为增量历史与升级路径，
--       本文件只描述「全部应用完之后长什么样」，方便零 JOIN 地看懂全库结构。
--
-- 改完迁移后若 check 报「新增/缺失/定义变化」，说明本文件没同步：
--   pnpm --filter @freeidx/api db:apply && pnpm --filter @freeidx/api db:schema:dump
-- 并把 migrations/ 与 schema.sql 一起提交。
--
-- 对象统计：32 表 / 72 索引

-- ===== 表（32）=====
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

CREATE TABLE bbs_announcement (
  aid INTEGER PRIMARY KEY AUTOINCREMENT,
  nid INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  isshow INTEGER NOT NULL DEFAULT 1,
  create_date INTEGER NOT NULL DEFAULT 0
);

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

CREATE TABLE bbs_cache (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL DEFAULT '',
  expiry INTEGER NOT NULL DEFAULT 0
);

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

CREATE TABLE bbs_checkin (
  uid INTEGER NOT NULL,
  day INTEGER NOT NULL,
  exp INTEGER NOT NULL DEFAULT 0,
  gold INTEGER NOT NULL DEFAULT 0,
  rmb INTEGER NOT NULL DEFAULT 0,
  vip_days INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL,
  PRIMARY KEY (uid, day)
);

CREATE TABLE bbs_email_code (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  scene TEXT NOT NULL DEFAULT '',
  create_date INTEGER NOT NULL DEFAULT 0,
  expiry INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE bbs_favorite (
  uid INTEGER NOT NULL DEFAULT 0,
  tid INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE bbs_follow (
  follower_uid INTEGER NOT NULL DEFAULT 0,
  followee_uid INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0,
  comment TEXT NOT NULL DEFAULT '',
  show_dynamic INTEGER NOT NULL DEFAULT 1
);

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
  seo_keywords TEXT NOT NULL DEFAULT '',
  icon_file TEXT NOT NULL DEFAULT '',
  icon_time INTEGER NOT NULL DEFAULT 0,
  thread_check INTEGER NOT NULL DEFAULT 0,
  post_check INTEGER NOT NULL DEFAULT 0,
  edit_check INTEGER NOT NULL DEFAULT 0,
  parent_fid INTEGER NOT NULL DEFAULT 0,
  lang TEXT NOT NULL DEFAULT ''
);

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
  allowviewip INTEGER NOT NULL DEFAULT 0,
  thread_check INTEGER NOT NULL DEFAULT 0,
  post_check INTEGER NOT NULL DEFAULT 0,
  edit_check INTEGER NOT NULL DEFAULT 0,
  see_check INTEGER NOT NULL DEFAULT 0,
  allowsell INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE bbs_kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL DEFAULT '',
  expiry INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE bbs_like (
  uid INTEGER NOT NULL DEFAULT 0,
  tid INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0
);

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

CREATE TABLE bbs_mypost (
  uid INTEGER NOT NULL DEFAULT 0,
  tid INTEGER NOT NULL DEFAULT 0,
  pid INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, pid)
);

CREATE TABLE bbs_mythread (
  uid INTEGER NOT NULL DEFAULT 0,
  tid INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, tid)
);

CREATE TABLE bbs_notice (
  nid INTEGER PRIMARY KEY AUTOINCREMENT,
  fromuid INTEGER NOT NULL DEFAULT 0,
  recvuid INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0,
  isread INTEGER NOT NULL DEFAULT 0,
  type INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT ''
);

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

CREATE TABLE bbs_paylist (
  plid INTEGER PRIMARY KEY AUTOINCREMENT,
  tid INTEGER NOT NULL DEFAULT 0,
  uid INTEGER NOT NULL DEFAULT 0,
  num INTEGER NOT NULL DEFAULT 0,
  credit_type INTEGER NOT NULL DEFAULT 0,
  type INTEGER NOT NULL DEFAULT 0,
  rate INTEGER NOT NULL DEFAULT 0,
  paytime INTEGER NOT NULL DEFAULT 0,
  nonce TEXT NOT NULL DEFAULT ''
);

CREATE TABLE bbs_point_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL DEFAULT 0,
  change INTEGER NOT NULL DEFAULT 0,
  balance INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  biz_key TEXT NOT NULL DEFAULT '',
  create_date INTEGER NOT NULL DEFAULT 0
);

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
  message_fmt TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE bbs_post_like (
  uid INTEGER NOT NULL DEFAULT 0,
  pid INTEGER NOT NULL DEFAULT 0,
  tid INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0
);
DELETE FROM sqlite_sequence;

CREATE TABLE bbs_queue (
  queueid INTEGER NOT NULL DEFAULT 0,
  v INTEGER NOT NULL DEFAULT 0,
  expiry INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (queueid, v)
);

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
  lastpid INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  content_buy INTEGER NOT NULL DEFAULT 0,
  content_buy_type INTEGER NOT NULL DEFAULT 1,
  tags TEXT NOT NULL DEFAULT '',
  image_urls TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT ''
);

CREATE TABLE bbs_thread_top (
  tid INTEGER PRIMARY KEY,
  fid INTEGER NOT NULL DEFAULT 0,
  top INTEGER NOT NULL DEFAULT 0
);

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
  vip_expire_at INTEGER NOT NULL DEFAULT 0,
  vip_from_gid INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 1,
  v TEXT NOT NULL DEFAULT '0',
  avatar_auto TEXT NOT NULL DEFAULT '0',
  bgimg TEXT NOT NULL DEFAULT '0'
);

CREATE TABLE bbs_user_pay (
  cid INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  num INTEGER NOT NULL DEFAULT 0,
  type INTEGER NOT NULL DEFAULT 1,
  credit_type INTEGER NOT NULL DEFAULT 1,
  code TEXT NOT NULL DEFAULT '',
  time INTEGER NOT NULL DEFAULT 0,
  nonce TEXT NOT NULL DEFAULT ''
);

CREATE TABLE bbs_v_apply (
  uid INTEGER PRIMARY KEY,
  create_time INTEGER NOT NULL DEFAULT 0,
  v TEXT NOT NULL DEFAULT '',
  v_info TEXT NOT NULL DEFAULT '',
  v_file TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  remark TEXT NOT NULL DEFAULT '',
  nonce TEXT NOT NULL DEFAULT ''
);

CREATE TABLE bbs_vip_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  duration_days INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  perks TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  create_date INTEGER NOT NULL DEFAULT 0,
  gid INTEGER NOT NULL DEFAULT 0
);

-- ===== 索引（72）=====
CREATE INDEX bbs_ad_slot_position ON bbs_ad_slot (position, enabled, sort);

CREATE INDEX bbs_announcement_isshow ON bbs_announcement (isshow, aid);

CREATE INDEX bbs_attach_pid ON bbs_attach (pid);

CREATE INDEX bbs_attach_status_date ON bbs_attach (status, create_date);

CREATE INDEX bbs_attach_tid ON bbs_attach (tid);

CREATE INDEX bbs_attach_uid ON bbs_attach (uid);

CREATE INDEX bbs_card_batch ON bbs_card (batch_no, status);

CREATE UNIQUE INDEX bbs_card_code ON bbs_card (code);

CREATE INDEX bbs_email_code_email_scene ON bbs_email_code (email, scene, id);

CREATE INDEX bbs_favorite_tid_date ON bbs_favorite (tid, create_date DESC);

CREATE INDEX bbs_favorite_uid ON bbs_favorite (uid);

CREATE UNIQUE INDEX bbs_favorite_uid_tid ON bbs_favorite (uid, tid);

CREATE INDEX bbs_follow_followee ON bbs_follow (followee_uid);

CREATE UNIQUE INDEX bbs_follow_pair ON bbs_follow (follower_uid, followee_uid);

CREATE INDEX bbs_forum_parent ON bbs_forum (parent_fid);

CREATE INDEX bbs_forum_rank ON bbs_forum (rank);

CREATE INDEX bbs_like_tid ON bbs_like (tid);

CREATE UNIQUE INDEX bbs_like_uid_tid ON bbs_like (uid, tid);

CREATE INDEX bbs_modlog_tid ON bbs_modlog (tid);

CREATE INDEX bbs_modlog_uid_logid ON bbs_modlog (uid, logid);

CREATE INDEX bbs_mypost_tid ON bbs_mypost (tid);

CREATE INDEX bbs_mythread_tid ON bbs_mythread (tid);

CREATE INDEX bbs_notice_recvuid ON bbs_notice (recvuid, isread);

CREATE INDEX bbs_notice_recvuid_nid ON bbs_notice (recvuid, nid DESC);

CREATE INDEX bbs_notice_recvuid_type ON bbs_notice (recvuid, type);

CREATE UNIQUE INDEX bbs_order_no ON bbs_order (order_no);

CREATE UNIQUE INDEX bbs_order_provider_ref ON bbs_order (provider_ref) WHERE provider_ref <> '';

CREATE INDEX bbs_order_status ON bbs_order (status, created_date);

CREATE INDEX bbs_order_uid ON bbs_order (uid, id);

CREATE INDEX bbs_paylist_nonce ON bbs_paylist (uid, nonce);

CREATE UNIQUE INDEX bbs_paylist_plid_tid ON bbs_paylist (plid, tid);

CREATE INDEX bbs_paylist_tid ON bbs_paylist (tid);

CREATE UNIQUE INDEX bbs_paylist_tid_uid ON bbs_paylist (tid, uid) WHERE type = 1;

CREATE INDEX bbs_paylist_uid ON bbs_paylist (uid, paytime);

CREATE UNIQUE INDEX bbs_point_log_biz ON bbs_point_log (uid, biz_key) WHERE biz_key <> '';

CREATE INDEX bbs_point_log_uid ON bbs_point_log (uid, id);

CREATE INDEX bbs_post_like_pid ON bbs_post_like (pid);

CREATE INDEX bbs_post_like_tid ON bbs_post_like (tid);

CREATE UNIQUE INDEX bbs_post_like_uid_pid ON bbs_post_like (uid, pid);

CREATE INDEX bbs_post_ok_pid ON bbs_post (ok, pid);

CREATE INDEX bbs_post_quotepid ON bbs_post (quotepid, create_date);

CREATE INDEX bbs_post_tid_pid ON bbs_post (tid, pid);

CREATE INDEX bbs_post_uid ON bbs_post (uid);

CREATE INDEX bbs_queue_expiry ON bbs_queue (expiry);

CREATE INDEX bbs_session_fid ON bbs_session (fid);

CREATE INDEX bbs_session_last_date ON bbs_session (last_date);

CREATE INDEX bbs_session_uid_last_date ON bbs_session (uid, last_date);

CREATE INDEX bbs_thread_fid_digest ON bbs_thread (fid, digest, tid);

CREATE INDEX bbs_thread_fid_lastpid ON bbs_thread (fid, lastpid);

CREATE INDEX bbs_thread_fid_ok_views ON bbs_thread (fid, ok, views DESC);

CREATE INDEX bbs_thread_fid_tid ON bbs_thread (fid, tid);

CREATE INDEX bbs_thread_lang_lastpid ON bbs_thread (lang, lastpid);

CREATE INDEX bbs_thread_lang_tid ON bbs_thread (lang, tid);

CREATE INDEX bbs_thread_ok_tid ON bbs_thread (ok, tid);

CREATE INDEX bbs_thread_ok_views ON bbs_thread (ok, views DESC);

CREATE INDEX bbs_thread_top_fid_top ON bbs_thread_top (fid, top);

CREATE INDEX bbs_thread_top_top_tid ON bbs_thread_top (top, tid);

CREATE INDEX bbs_thread_uid ON bbs_thread (uid);

CREATE UNIQUE INDEX bbs_user_email ON bbs_user (email);

CREATE INDEX bbs_user_gid ON bbs_user (gid);

CREATE INDEX bbs_user_ok_credits ON bbs_user (ok, credits DESC, uid ASC);

CREATE INDEX bbs_user_ok_golds ON bbs_user (ok, golds DESC, uid ASC);

CREATE INDEX bbs_user_ok_posts ON bbs_user (ok, posts DESC, uid ASC);

CREATE INDEX bbs_user_ok_rmbs ON bbs_user (ok, rmbs DESC, uid ASC);

CREATE INDEX bbs_user_ok_threads ON bbs_user (ok, threads DESC, uid ASC);

CREATE INDEX bbs_user_ok_uid ON bbs_user (ok, uid);

CREATE INDEX bbs_user_pay_nonce ON bbs_user_pay (uid, nonce);

CREATE INDEX bbs_user_pay_uid ON bbs_user_pay (uid, time);

CREATE INDEX bbs_user_pay_uid_type ON bbs_user_pay (uid, type, time);

CREATE UNIQUE INDEX bbs_user_username ON bbs_user (username);

CREATE INDEX bbs_v_apply_nonce ON bbs_v_apply (uid, nonce);

CREATE INDEX bbs_v_apply_status ON bbs_v_apply (status, create_time);
