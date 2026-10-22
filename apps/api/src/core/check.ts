/**
 * 内容审核 + 回收站核心：
 *
 *  ok 状态机（OK INT(3)）：1=正常 0=待审核 -1=未通过（拒绝） -2=回收站（软删除）
 *  触发（check_or_not）：用户组与板块的同名 check 位**同时为 1** 时，该用户在该板块的内容进入待审核。
 *  审核权（see_check）：非 see_check 用户看不见他人未过审/回收站内容，也无现场审核权；
 *  see_check 为组级开关，管理组需自行勾选。
 *  全局开关（kv setting）：user_check=注册审核（新用户 ok=0，未过审禁发帖回帖）、recycle=回收站。
 *
 *  附注：edit_check（编辑审核）仅存取、无任何运行时消费
 *  （编辑流程实际用 'thread' 条件重置审核）——此处保持既有行为。
 */
import type { GroupForAccess, ForumForAccess } from './access';
import type { SiteSetting } from '@freeidx/shared';

/** ok 列取值（禁止散写字面量） */
export const CheckStatus = {
  PENDING: 0,
  NORMAL: 1,
  REJECTED: -1,
  RECYCLE: -2,
} as const;

/** check_or_not：组 && 板块的 `<action>_check` 同时为 1 才进审核队列 */
export function checkOrNot(
  group: GroupForAccess | undefined,
  forum: ForumForAccess | undefined,
  action: 'thread' | 'post' | 'edit',
): boolean {
  const key = `${action}_check`;
  return Number(group?.[key] ?? 0) === 1 && Number(forum?.[key] ?? 0) === 1;
}

/** 审核权限位（see_check）：可见他人未过审内容 + 前台现场通过/拒绝/删除/回收站操作 */
export function hasSeeCheck(group: GroupForAccess | undefined): boolean {
  return Number(group?.see_check ?? 0) === 1;
}

/**
 * 「非正常状态内容是否对当前访问者可见」：ok==1 恒可见；否则 see_check 组或作者本人可见
 * （列表/详情各读路径同一条件）
 */
export function canSeeUnapproved(
  ok: number,
  opts: { seeCheck: boolean; isAuthor: boolean },
): boolean {
  return Number(ok) === 1 || opts.seeCheck || opts.isAuthor;
}

/** 未过审用户发帖/回帖闸门条件：调用方据此抛 AppError */
export function shouldBlockUnapproved(setting: SiteSetting, viewerOk: number): boolean {
  return setting.userCheck && Number(viewerOk) !== CheckStatus.NORMAL;
}