/**
 * 后台二级 Tab 的唯一事实来源 = 各菜单的 tab 子表（逐菜单条目对齐，含只有一项的菜单）。
 * 单 tab 的菜单（主题）也照出（作为该页标题位）；
 * 版块菜单的 tab 是**空表**，版块列表/编辑页因此没有二级 Tab。
 * 文案取 lang 键。
 */
import type { AdminKey } from '@freeidx/shared';

interface TabItem {
  k: string;
  to: string;
  textKey: AdminKey;
  fallback: string;
}

export const USER_TABS: TabItem[] = [
  { k: 'list', to: '/admin/users', textKey: 'admin_user_list', fallback: 'User List' },
  { k: 'banned', to: '/admin/banned', textKey: 'ban_manage', fallback: 'Blacklist' },
  { k: 'group', to: '/admin/groups', textKey: 'admin_user_group', fallback: 'User Groups' },
  { k: 'create', to: '/admin/users/new', textKey: 'admin_user_create', fallback: 'Create User' },
];

/** base + email 两档；email 档在 Workers 等价实现为「邮箱设置」（§11.3，socket SMTP 池 → Resend 兼容 HTTP API） */
export const SETTING_TABS: TabItem[] = [
  { k: 'base', to: '/admin/setting', textKey: 'admin_setting_base', fallback: 'Basic Settings' },
  { k: 'email', to: '/admin/setting/email', textKey: 'admin_setting_email', fallback: 'Email Settings' },
];

/** 只保留本地插件列表一档；官方市场要联网拉取，不做。
 * 广告位原是本页第二档，后并入「广告系统」插件详情页（/admin/extensions/ads），不再单列。 */
export const PLUGIN_TABS: TabItem[] = [
  { k: 'local', to: '/admin/extensions', textKey: 'admin_plugin_local_list', fallback: 'Local Plugins' },
];

export const OTHER_TABS: TabItem[] = [
  { k: 'cache', to: '/admin/other', textKey: 'admin_other_cache', fallback: 'Clear Cache' },
  /* 数据库维护：孤儿行/失效行分批清理（只报告账目类数据，不删） */
  { k: 'db', to: '/admin/maintenance/db', textKey: 'admin_maint_db', fallback: 'Database' },
  /* R2 存储维护：白名单前缀内的未引用对象扫描与删除 */
  { k: 'r2', to: '/admin/maintenance/r2', textKey: 'admin_maint_r2', fallback: 'Object Storage' },
  /* 版务日志是本项目新增（独立 mod_log 表），挂在「其他」菜单下 */
  { k: 'modlog', to: '/admin/modlogs', textKey: 'admin_mod_logs', fallback: 'Moderation Logs' },
];

/** 支付管理（§15.4）：VIP 计划 / 订单 / 卡密三档（本项目新增） */
export const PAY_TABS: TabItem[] = [
  { k: 'vip', to: '/admin/vip', textKey: 'admin_vip_plans', fallback: 'VIP Plans' },
  { k: 'order', to: '/admin/orders', textKey: 'admin_orders', fallback: 'Orders' },
  { k: 'card', to: '/admin/cards', textKey: 'admin_cards', fallback: 'Cards' },
];

/** 积分管理（本项目新增）：设置 / 用户积分 / 流水三档 */
export const POINT_TABS: TabItem[] = [
  { k: 'setting', to: '/admin/points', textKey: 'admin_credit_setting', fallback: 'Credit Settings' },
  { k: 'users', to: '/admin/points/users', textKey: 'admin_credit_users', fallback: 'User Credits' },
  { k: 'log', to: '/admin/points/logs', textKey: 'admin_credit_logs', fallback: 'Credit Logs' },
];

/** 消息管理：消息列表 / 发送系统通知 */
export const NOTICE_TABS: TabItem[] = [
  { k: 'list', to: '/admin/notices', textKey: 'notice_admin_notice_list', fallback: 'Notice List' },
  { k: 'post', to: '/admin/notices/send', textKey: 'notice_admin_send_notice', fallback: 'Send Notice' },
];

/** 内容审核：4 组「批量审核 X / 管理未通过 X」+ 主题回收站 + 审核设置 */
export const CHECK_TABS: TabItem[] = [
  { k: 'thread', to: '/admin/check', textKey: 'tt_check_nav_thread', fallback: 'Batch Review Threads' },
  { k: 'uthread', to: '/admin/check/unapproved-threads', textKey: 'tt_check_nav_uthread', fallback: 'Unapproved Threads' },
  { k: 'post', to: '/admin/check/posts', textKey: 'tt_check_nav_post', fallback: 'Batch Review Posts' },
  { k: 'upost', to: '/admin/check/unapproved-posts', textKey: 'tt_check_nav_upost', fallback: 'Unapproved Posts' },
  { k: 'user', to: '/admin/check/users', textKey: 'tt_check_nav_user', fallback: 'Batch Review Users' },
  { k: 'uuser', to: '/admin/check/unapproved-users', textKey: 'tt_check_nav_uuser', fallback: 'Unapproved Users' },
  { k: 'recycle', to: '/admin/check/recycle', textKey: 'tt_check_nav_recycle', fallback: 'Thread Recycle' },
  { k: 'setting', to: '/admin/check/setting', textKey: 'tt_check_setting', fallback: 'Review Settings' },
];

/** 加V认证：等待审核 / 审核通过 / 添加认证 / 设置四档展开为四个子路由同页切换 */
export const V_TABS: TabItem[] = [
  { k: 'applying', to: '/admin/v', textKey: 'idx_verify_applying', fallback: 'Pending' },
  { k: 'passed', to: '/admin/v/passed', textKey: 'idx_verify_passed', fallback: 'Passed' },
  { k: 'user', to: '/admin/v/user', textKey: 'idx_verify_user', fallback: 'Manual V' },
  { k: 'setting', to: '/admin/v/setting', textKey: 'idx_verify_setting', fallback: 'Pricing' },
];
