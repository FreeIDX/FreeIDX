/**
 * 用户组权限表的共用定义（列表 + 编辑共用同一套 12 个 allow* 列）。
 * 标签键：用户权限 5 列是 allow_view/allow_thread/allow_post/allow_upload/allow_download，
 * 版务 7 列是 top/edit/delete/move/ban_user/delete_user/view_user_info。
 * §D.8#5：7 项版务位**仅 1≤gid≤5 持久化**，自定义组提交时服务端静默丢弃，故非管理组整块不渲染。
 */
import type { GroupFullRow, GroupUpsertItem } from '../types';

/** 除组名外的列都是 0/1 或数值，权限表只碰这些键 */
export type GroupNumericKey = Exclude<keyof GroupFullRow, 'name'>;

export const USER_PERMS = [
  { key: 'allowread', labelKey: 'allow_view', fallback: 'Allow read' },
  { key: 'allowthread', labelKey: 'allow_thread', fallback: 'New thread' },
  { key: 'allowpost', labelKey: 'allow_post', fallback: 'Reply' },
  { key: 'allowattach', labelKey: 'allow_upload', fallback: 'Upload' },
  { key: 'allowdown', labelKey: 'allow_download', fallback: 'Download' },
] as const satisfies readonly { key: GroupNumericKey; labelKey: string; fallback: string }[];

export const MOD_PERMS = [
  { key: 'allowtop', labelKey: 'top', fallback: 'Sticky' },
  { key: 'allowupdate', labelKey: 'edit', fallback: 'Edit' },
  { key: 'allowdelete', labelKey: 'delete', fallback: 'Delete' },
  { key: 'allowmove', labelKey: 'move', fallback: 'Move' },
  { key: 'allowbanuser', labelKey: 'ban_user', fallback: 'Ban user' },
  { key: 'allowdeleteuser', labelKey: 'delete_user', fallback: 'Delete user' },
  { key: 'allowviewip', labelKey: 'view_user_info', fallback: 'View user info' },
] as const satisfies readonly { key: GroupNumericKey; labelKey: string; fallback: string }[];

export const isModGid = (gid: number): boolean => gid >= 1 && gid <= 5;

/** 提交口径：标量 + 5 项用户权限恒发，7 项版务位只给管理组（服务端也只收这一档） */
export function toItem(r: GroupFullRow): GroupUpsertItem {
  const item: GroupUpsertItem = {
    gid: r.gid,
    name: r.name,
    creditsfrom: r.creditsfrom,
    creditsto: r.creditsto,
    allowread: r.allowread,
    allowthread: r.allowthread,
    allowpost: r.allowpost,
    allowattach: r.allowattach,
    allowdown: r.allowdown,
  };
  if (isModGid(r.gid)) for (const p of MOD_PERMS) item[p.key] = r[p.key];
  return item;
}
