/**
 * 权限位枚举（§6.3 单一事实源）
 * group 表 12 个 allow* 位；forum_access 表仅 5 个普通操作位。
 * 注意（§D.8#5 校准）：close/digest 版务操作复用 allowtop；7 项版务位仅 gid 1–5 持久化，
 * 自定义组提交时服务端静默丢弃。
 */

/** 普通操作位：forum_access_user 判定（accesson 时与 forum_access 双与） */
export const USER_PERMS = [
  'allowread',
  'allowthread',
  'allowpost',
  'allowattach',
  'allowdown',
] as const;
export type UserPerm = (typeof USER_PERMS)[number];

/** 版务操作位：forum_access_mod 判定（gid 1/2 恒通过；3/4/5 需组允许且 uid ∈ forum.moduids） */
export const MOD_PERMS = [
  'allowtop',
  'allowupdate',
  'allowdelete',
  'allowmove',
  'allowbanuser',
  'allowdeleteuser',
  'allowviewip',
] as const;
export type ModPerm = (typeof MOD_PERMS)[number];

/** group 表全部 12 个 allow* 列 */
export const GROUP_PERMS = [
  'allowread',
  'allowthread',
  'allowpost',
  'allowattach',
  'allowdown',
  'allowtop',
  'allowupdate',
  'allowdelete',
  'allowmove',
  'allowbanuser',
  'allowdeleteuser',
  'allowviewip',
] as const;
export type GroupPerm = (typeof GROUP_PERMS)[number];
