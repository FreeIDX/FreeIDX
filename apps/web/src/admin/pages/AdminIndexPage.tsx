/**
 * 后台首页仪表盘。现代扁平风：统计卡 = 大数字 + 软色徽标 + 右侧图标块，服务器信息 = 浅灰 chips。
 *   第一行 4 张统计卡（主题/帖子/用户/附件，含「今日+N」软色徽标，整卡可点进对应管理页）
 *   第二行 2 张信息卡（在线人数 / 今日新增汇总）
 *   第三行两张半宽卡：「用户分布图」（环形图 + 不含管理组徽标）与「快捷管理」（gid 1..7 成员表）
 *   收尾一张「服务器信息」卡（chips 展示 + 运行时用量实测条）
 * 数值全部来自 `GET /api/admin/runtime`（本请求 D1b 计数器真实累计，§14.8 落点），60s 轮询。
 * 两处按云运行时口径替换：磁盘剩余空间（Worker 无文件系统）→ 附件总数；
 * 面板指标由 workerd/D1 提供；环形图用纯 CSS conic-gradient 实现（不引第三方库）。
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { ReactNode } from 'react';
import { RunLevel } from '@freeidx/shared';
import { getRuntime } from '../api';
import { Icon, type IconName } from '../../components/icons';
import { Avatar } from '../../components/Avatar';
import { useAdminT } from '../t';
import { useGroupName } from '../../lib/i18n';
import { useAuth } from '../../store/auth';
import { Badge, Card, ErrorState, cardCls, cx } from '../ui';

/** 统计卡徽标的软色四态（今日新增等） */
const STAT_TONE = {
  brand: 'bg-brand/10 text-brand',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/15 text-warning',
  muted: 'bg-secondary/10 text-secondary',
} as const;

type StatTone = keyof typeof STAT_TONE;

/** 统计卡：白卡 + 大数字 + 软色徽标 + 右侧图标块；整卡可点（沿用各卡的跳转目标） */
function StatCard(props: { tone: StatTone; value: number; label: string; today?: number; icon: IconName; to: string }) {
  const { tone, value, label, today, icon, to } = props;
  const t = useAdminT();
  return (
    <Link
      to={to}
      className="group mb-4 flex items-center justify-between gap-3 rounded-[8px] bg-surface p-[1.25rem] shadow-adm-card transition-shadow hover:shadow-[0_4px_16px_rgba(0,0,0,.08)]"
    >
      <div className="min-w-0">
        <p className="m-0 truncate text-sm text-muted">{label}</p>
        <p className="m-0 mt-1 text-[26px] font-semibold leading-none tabular-nums text-ink">{value}</p>
        {today !== undefined && (
          <span className={cx('mt-2 inline-block rounded-[4px] px-1.5 py-[2px] text-xs leading-none', STAT_TONE[tone])}>
            {t('admin_today_add', '今日+')}
            {today}
          </span>
        )}
      </div>
      <span className="flex size-[46px] shrink-0 items-center justify-center rounded-[10px] bg-canvas text-muted/60 transition-colors group-hover:bg-brand/10 group-hover:text-brand">
        <Icon name={icon} className="size-[22px]" />
      </span>
    </Link>
  );
}

/** 信息卡：白卡 + 软色图标块（现代扁平风：80px 内的图标格） */
function InfoBox(props: { tone: 'success' | 'warning'; icon: IconName; label: string; value: number; sub?: string }) {
  const { tone, icon, label, value, sub } = props;
  return (
    <div className="mb-4 flex min-h-[80px] w-full items-center gap-3 rounded-[8px] bg-surface p-[1.25rem] shadow-adm-card">
      <span
        className={cx(
          'flex size-[46px] shrink-0 items-center justify-center rounded-[10px]',
          tone === 'success' ? 'bg-success/10 text-success' : 'bg-warning/15 text-warning',
        )}
      >
        <Icon name={icon} className="size-[22px]" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <span className="block truncate text-sm text-muted">{label}</span>
        <span className="mt-1 block text-[26px] font-semibold leading-none tabular-nums text-ink">{value}</span>
        {sub && <span className="mt-2 block truncate text-sm text-muted">{sub}</span>}
      </div>
    </div>
  );
}

/**
 * 环形图：Chart.js `type:'doughnut'`（默认 cutout 50%）的 CSS 等价物——conic-gradient 分扇区 +
 * 50% 直径的白色内核挖洞。配色采用后台现代六色（Chart.js 硬编码轮转配色的扁平化替代）。
 * 图例 = Chart.js 默认 top 图例：色块 + 组名，左对齐换行。
 */
const DONUT_COLORS = ['#409eff', '#67c23a', '#e6a23c', '#f56c6c', '#909399', '#13c2c2'];

function DonutChart({ data }: { data: { gid: number; name: string; count: number }[] }) {
  const t = useAdminT();
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total <= 0) {
    return <p className="m-0 py-[100px] text-center text-sm text-muted">{t('admin_no_user_group_data', '暂无普通用户组数据')}</p>;
  }
  let acc = 0;
  const stops = data.map((d, i) => {
    const from = (acc / total) * 360;
    acc += d.count;
    const to = (acc / total) * 360;
    return `${DONUT_COLORS[i % DONUT_COLORS.length]} ${from}deg ${to}deg`;
  });
  return (
    <div className="min-h-[250px]">
      <div className="flex justify-center gap-2 text-sm">
        {data.map((d, i) => (
          <span key={d.gid} className="inline-flex items-center gap-1">
            <span className="inline-block size-3" style={{ backgroundColor: DONUT_COLORS[i % DONUT_COLORS.length] }} />
            {t('admin_group_label', '{name}（{count}）', { name: d.name, count: d.count })}
          </span>
        ))}
      </div>
      <div
        className="relative mx-auto mt-2 h-[220px] w-[220px] rounded-full"
        style={{ background: `conic-gradient(from 0deg, ${stops.join(', ')})` }}
        role="img"
        aria-label={t('admin_member_dist', '共 {total} 名会员分布', { total })}
      >
        <div className="absolute left-1/2 top-1/2 size-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface" />
      </div>
    </div>
  );
}


/** 服务器信息 chip：浅灰底小标签（label 灰 + 值墨色），替代两列文本行 */
function ServerItem({ label, children }: { label: string; children: ReactNode }) {
  const t = useAdminT();
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[6px] bg-canvas px-3 py-[.5rem] text-sm">
      <span className="text-muted">{label}{t('admin_colon', '：')}</span>
      <span className="font-medium text-ink">{children}</span>
    </span>
  );
}

/** 预算条：实测值 / 上限，超 80% 转警告色（Workers 免费层新增的必看指标） */
function BudgetBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className={cx(ratio > 0.8 ? 'text-danger' : 'font-medium text-ink-soft', 'tabular-nums')}>
          {used} / {limit}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line-soft" role="img" aria-label={`${label} ${Math.round(ratio * 100)}%`}>
        <div className={cx('h-full rounded-full transition-[width] duration-200', ratio > 0.8 ? 'bg-danger' : 'bg-brand')} style={{ width: `${ratio * 100}%` }} />
      </div>
    </div>
  );
}

export function AdminIndexPage() {
  const t = useAdminT();
  const gn = useGroupName();
  const RUNLEVEL_TEXT: Record<number, string> = {
    [RunLevel.CLOSED_SITE]: t('admin_runlevel_closed_site', '站点关闭'),
    [RunLevel.ADMIN_ONLY]: t('admin_runlevel_admin_only', '仅管理员可读写'),
    [RunLevel.MEMBER_READ_ONLY]: t('admin_runlevel_member_read_only', '会员只读'),
    [RunLevel.MEMBER_READ_WRITE]: t('admin_runlevel_member_read_write', '会员可读写'),
    [RunLevel.ALL_READ_ONLY]: t('admin_runlevel_all_read_only', '所有人只读'),
    [RunLevel.NORMAL]: t('admin_runlevel_normal', '正常开放'),
  };
  const q = useQuery({ queryKey: ['admin', 'runtime'], queryFn: getRuntime, refetchInterval: 60_000 });
  const setting = useAuth((s) => s.setting);
  const d = q.data;

  const manageGroups = (d?.groups ?? []).filter((g) => g.gid > 0 && g.gid <= 7);
  const chartGroups = d?.groups ?? [];

  return (
    <div>
      {q.isError && <ErrorState error={q.error} />}
      {d && (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-0 lg:grid-cols-4">
            <StatCard tone="brand" icon="comment" value={d.totals.threads} today={d.today.threads} label={t('threads', '主题')} to="/admin/threads" />
            <StatCard tone="success" icon="comments" value={d.totals.posts} today={d.today.posts} label={t('posts', '帖子')} to="/admin/threads" />
            <StatCard tone="warning" icon="users" value={d.totals.users} today={d.today.users} label={t('users', '用户')} to="/admin/users" />
            <StatCard tone="muted" icon="chart_pie" value={d.totals.attachs} label={t('attachs', '附件')} to="/admin/other" />
          </div>

          <div className="grid grid-cols-2 gap-x-4">
            <InfoBox tone="success" icon="flag" label={t('onlines', '在线人数')} value={d.online} />
            <InfoBox
              tone="warning"
              icon="copy"
              label={t('admin_today_add', '今日+')}
              value={d.today.threads + d.today.posts + d.today.users}
              sub={t('admin_today_summary', '主题 {threads} · 帖子 {posts} · 用户 {users}', { threads: d.today.threads, posts: d.today.posts, users: d.today.users })}
            />
          </div>

          <div className="grid grid-cols-1 gap-x-4 lg:grid-cols-2">
            <Card
              title={
                <>
                  {t('user_chart', '用户分布图')}
                  <Badge tone="warning" className="ml-2">
                    {t('not_include_admin', '不含管理组')}
                  </Badge>
                </>
              }
            >
              <DonutChart data={chartGroups.filter((g) => g.gid > 100).map((g) => ({ ...g, name: gn(g.gid, g.name) }))} />
            </Card>

            <Card title={t('admin_manage_group', '快捷管理')} noPadding>
              <div className="overflow-x-auto">
                <table className="adm-table adm-table-striped w-full text-base">
                  <thead>
                    <tr>
                      <th className="w-[10px] font-medium">{t('admin_group_id', 'ID')}</th>
                      <th className="font-medium">{t('admin_group_name', '用户组名')}</th>
                      <th className="w-[200px] font-medium">{t('admin_group_users', '成员')}</th>
                      <th className="text-center font-medium">{t('admin_group_num', '数量')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {manageGroups.map((g) => (
                      <tr key={g.gid}>
                        <td>{g.gid}</td>
                        <td>
                          <Link className="text-brand hover:underline" to={`/admin/users?type=gid&keyword=${g.gid}`}>
                            {gn(g.gid, g.name)}
                          </Link>
                        </td>
                        <td>
                          <div className="flex flex-wrap gap-1">
                            {g.users.map((u) => (
                              <Link key={u.uid} to={`/admin/users/${u.uid}/edit`} title={u.username}>
                                <Avatar uid={u.uid} avatar={u.avatar} username={u.username} size={2} />
                              </Link>
                            ))}
                          </div>
                        </td>
                        <td className="text-center">
                          <Badge tone={GROUP_BADGE[g.gid] ?? 'secondary'}>{g.count}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>

          <Card title={t('server_info', '服务器信息')}>
            <div className="flex flex-wrap gap-2">
              {/* D1 不允许 SELECT sqlite_version()（本地与远端均拒绝），所以只标引擎不编版本号 */}
              <ServerItem label={t('database', '数据库')}>D1</ServerItem>
              <ServerItem label="Web Server">Cloudflare Workers</ServerItem>
              <ServerItem label={t('client_ip', '客户端 IP')}>{d.server.client_ip || '—'}</ServerItem>
              <ServerItem label={t('admin_runlevel_label', '运行级别')}>{RUNLEVEL_TEXT[Number(setting?.runlevel ?? 5)] ?? String(setting?.runlevel ?? 5)}</ServerItem>
              <ServerItem label={t('lang', '语言')}>{setting?.lang ?? 'en-us'}</ServerItem>
              <ServerItem label={t('admin_upload_max_size', '上传上限')}>
                {Math.round(Number(setting?.uploadMaxSize ?? 0) / 1024 / 1024)} MB
              </ServerItem>
              <ServerItem label={t('admin_user_create_on', '允许注册')}>{setting?.userCreateOn ? t('yes', '是') : t('no', '否')}</ServerItem>
            </div>
            <h6 className="mt-5 mb-3 text-sm font-medium text-ink">{t('admin_runtime_usage', '运行时用量（本请求实测）')}</h6>
            <div className="grid grid-cols-1 gap-x-6 gap-y-4 md:grid-cols-2">
              <BudgetBar label={t('admin_d1_queries', 'D1 查询数')} used={d.budget.d1_queries} limit={d.budget.limits.ci_d1_queries_max} />
              <BudgetBar label={t('admin_subrequests', '子请求数')} used={d.budget.subrequests} limit={d.budget.limits.ci_subrequests_max} />
              <BudgetBar label={t('admin_rows_read_estimate', 'rows read（估算）')} used={d.budget.rows_read_estimate} limit={d.budget.limits.ci_rows_read_max} />
              <BudgetBar label={t('admin_cpu_ms_estimate', 'CPU ms（估算）')} used={d.budget.cpu_ms_estimate} limit={d.budget.limits.ci_cpu_ms_max} />
            </div>
            <p className="mt-5 mb-0 text-xs text-muted-2">
              {t('admin_budget_note', '注：硬上限 D1 查询 {hard_d1_queries} 次/请求；以上数值为本次 runtime 请求的真实累计，非全站日均。', { hard_d1_queries: d.budget.limits.hard_d1_queries })}
            </p>
          </Card>
        </>
      )}
      {!d && !q.isError && <div className={cx(cardCls, 'p-[1.25rem] text-sm text-muted')}>{t('submiting', '加载中')}…</div>}
    </div>
  );
}

/** 用户组徽标配色表，gid 3 不在 if 分支里故走 default */
const GROUP_BADGE: Record<number, 'danger' | 'warning' | 'primary' | 'success' | 'info' | 'dark'> = {
  1: 'danger',
  2: 'warning',
  4: 'primary',
  5: 'success',
  6: 'info',
  7: 'dark',
};
