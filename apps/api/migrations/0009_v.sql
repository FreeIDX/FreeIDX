-- FreeIDX 0009_v — 加V认证
-- 用户申请加V认证（认证头衔 + 证明材料），管理员后台审核，通过后全站头像旁显示 V 标。

-- 认证头衔（user.v；'0'=未认证，其余值即头衔）
ALTER TABLE bbs_user ADD COLUMN v TEXT NOT NULL DEFAULT '0';

--> 0009_v_apply  加V认证申请（uid 主键——一人至多一条申请记录，重复提交即覆盖重审）
-- status：0=待审核 1=成功 -1=未通过（拒绝分支写 -1）
CREATE TABLE bbs_v_apply (
  uid INTEGER PRIMARY KEY,
  create_time INTEGER NOT NULL DEFAULT 0,
  v TEXT NOT NULL DEFAULT '',
  v_info TEXT NOT NULL DEFAULT '',
  v_file TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0,
  remark TEXT NOT NULL DEFAULT '',
  -- 原子性锚定列（项目增强）：提交申请的扣费/置 0 语句以 EXISTS(... nonce=?) 守卫
  nonce TEXT NOT NULL DEFAULT ''
);
-- 后台两列表（status=0 待审 / status=1 已过）按 create_time 倒序分页
CREATE INDEX bbs_v_apply_status ON bbs_v_apply (status, create_time);
CREATE INDEX bbs_v_apply_nonce ON bbs_v_apply (uid, nonce);
