/**
 * 用户列表（/admin/users）。
 * 版式，数值口径见各处注释：
 *  - 顶部是用户菜单三档 Tab（列表/用户组/创建），不是两个；
 *  - 搜索行**不在卡里**：一行三格 = 下拉 + 输入框 + 搜索钮；
 *    select 首项是空值占位「搜索类型」，提交时空值回退 uid（`srchtype ? srchtype : 'uid'`）；
 *  - 卡三段式：卡头（标题「用户列表」+ 右浮「全部用户」下拉，
 *    下拉项是各用户组的 gid 过滤链接）→ 卡体无内距，内放可横向滚动的悬停高亮表（min-width:800px）
 *    → 卡脚（危险按钮「删除」+ 右侧灰色小字盾牌图例）；
 *  - 列头 width 在 60/50/150/150/100/100/100/60 基础上于创建 IP 前插入最近登录时间（130）；
 *    「注册时间」即创建时间列（create_date，格式 YYYY-MM-DD），
 *    「最近登录时间」是新增列（bbs_user.login_date，字典里只有 last_login_date=最后登录/create_date=创建时间，
 *    与列名不符），故表头用中文字面量，用 fmtDate 带时分；
 *  - 用户名后 `0<gid<6` 追加盾牌图标；
 * 三处必要改判（§7 记账）：
 *  1. Email / 注册 IP 两列需要后端投影，已把 `/api/admin/users` 扩成 USER_PUBLIC_COLS + email/create_ip
 *     （create_ip_fmt 服务端 long2ip，0 → '0.0.0.0'）；公开的用户接口不受影响。
 *  2. 行内删除确认换成 ConfirmModal（而非 window.confirm + 逐行请求后摘 DOM 行）：
 *     成功文案仍是 `admin_delete_success`，列表靠 invalidate 重取。
 *  3. 逐行 uid==1 才提示「不允许删除管理员」改为直接禁掉管理员行的复选框（服务端同样拒绝，省一次 403）。
 *  4. 首列表头由「删除」改为「全选」（字面量，同权限矩阵勾选列），底部批量删除钮不变。
 * 删除是硬删并级联清主题/回帖/附件。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { GroupId, effectiveBanScope, type AdminKey } from '@freeidx/shared';
import { batchBanUsers, deleteUser, getUsers } from '../api';
import { BAN_DURATIONS, BanScopePicker, scopeText } from '../ban';
import { useAdminAction } from '../use-action';
import type { AdminUserRow } from '../types';
import { useAdminT } from '../t';
import { useGroupName } from '../../lib/i18n';
import { useBatchAction } from '../use-action';
import { useAuth } from '../../store/auth';
import { USER_TABS } from '../tabs';
import { fmtDate, fmtDay } from '../../lib/api';
import { posInt } from '../../lib/params';
import {
  AdminPagination,
  Alert,
  Button,
  Checkbox,
  ConfirmModal,
  ErrorState,
  Field,
  Input,
  PageTitle,
  Select,
  SubmitRow,
  TabBar,
  Table,
  cardCls,
  cardFooterCls,
  cardHeaderCls,
  cx,
} from '../ui';
import { Icon } from '../../components/icons';

/** 搜索类型下拉的 option 顺序，首项空值 = 搜索类型占位 */
const SEARCH_TYPES: { value: string; textKey: AdminKey; fallback: string }[] = [
  { value: 'uid', textKey: 'uid', fallback: 'UID' },
  { value: 'username', textKey: 'username', fallback: 'Username' },
  { value: 'email', textKey: 'email', fallback: 'Email' },
  { value: 'gid', textKey: 'user_group', fallback: 'User group' },
  { value: 'create_ip', textKey: 'create_ip', fallback: 'Creation IP' },
];

/** 「全部用户」等裸按钮：透明底灰字，hover 转品牌蓝浅底（现代扁平风） */
const btnDefaultCls =
  'inline-flex items-center justify-center rounded-[6px] bg-transparent px-3 py-[.375rem] text-base leading-[1.5] text-ink-soft no-underline transition-colors hover:bg-brand/5 hover:text-brand';
/** 下拉菜单：白底 8px 圆角 + 发丝线 + 软投影 */
const dropdownMenuCls =
  'absolute right-0 left-auto z-[1000] mt-[.125rem] min-w-[10rem] float-left list-none rounded-[8px] border border-line bg-surface py-[.5rem] text-base text-ink text-left shadow-[0_8px_24px_rgba(0,0,0,.12)]';
/** 下拉项：block、width 100%、padding .25rem 1.5rem，hover 浅灰底 */
const dropdownItemCls = 'block w-full whitespace-nowrap border-0 bg-transparent px-[1.5rem] py-[.25rem] font-normal text-ink-soft no-underline transition-colors hover:bg-canvas hover:text-ink';

export function UserListPage() {
  const t = useAdminT();
  const gn = useGroupName();
  const [sp, setSp] = useSearchParams();
  const grouplist = useAuth((s) => s.grouplist);

  const urlType = sp.get('type') ?? '';
  const type = urlType || 'uid';
  const keyword = sp.get('keyword') ?? '';
  const page = posInt(sp.get('page'));

  const [formType, setFormType] = useState(urlType);
  const [formKey, setFormKey] = useState(keyword);
  useEffect(() => {
    setFormType(urlType);
    setFormKey(keyword);
  }, [urlType, keyword]);

  const q = useQuery({
    queryKey: ['admin', 'users', { type, keyword, page }],
    queryFn: () => getUsers({ type, keyword, page }),
    placeholderData: keepPreviousData,
  });

  const batch = useBatchAction([['admin', 'users'], ['admin', 'runtime']]);
  const [picked, setPicked] = useState<number[]>([]);
  const [confirming, setConfirming] = useState(false);

  /* 小黑屋：批量封禁（勾选后展开内联表单，避免误触；单用户封禁走编辑页的完整表单） */
  const [banOpen, setBanOpen] = useState(false);
  const [banScope, setBanScope] = useState(0);
  const [banDuration, setBanDuration] = useState(BAN_DURATIONS[1]?.value ?? 86_400);
  const [banReason, setBanReason] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const rows = q.data?.list ?? [];
  useEffect(() => setPicked([]), [q.data]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  const groupName = useMemo(() => new Map(grouplist.map((g) => [Number(g.gid), gn(g.gid, g.name)])), [grouplist, gn]);

  /** 只把非默认值写进 URL：/admin/users 保持干净，翻页不丢搜索条件 */
  const buildHref = (p: number): string => {
    const params = new URLSearchParams();
    if (type !== 'uid') params.set('type', type);
    if (keyword) params.set('keyword', keyword);
    if (p > 1) params.set('page', String(p));
    const s = params.toString();
    return s ? `/admin/users?${s}` : '/admin/users';
  };

  const submit = () => {
    const params = new URLSearchParams();
    // 占位空值按 uid 处理，因此 uid 搜索不落 type 参数
    if (formType && formType !== 'uid') params.set('type', formType);
    const k = formKey.trim();
    if (k) params.set('keyword', k);
    setSp(new URLSearchParams(params.toString()));
  };

  const targets = rows.filter((r) => picked.includes(r.uid) && Number(r.gid) !== GroupId.ADMIN);

  const banAct = useAdminAction(
    () =>
      batchBanUsers({ uids: targets.map((r) => r.uid), scope: banScope, duration: banDuration, reason: banReason.trim() }),
    {
      invalidate: [['admin', 'users'], ['admin', 'banned'], ['admin', 'runtime']],
      onData: () => {
        setPicked([]);
        setBanOpen(false);
      },
    },
  );

  const deletePicked = async () => {
    if (!picked.length) {
      batch.setFlash({ tone: 'warn', text: t('please_check_delete_user', '请勾选您要删除的用户') });
      return;
    }
    setConfirming(true);
  };

  const confirmDelete = async () => {
    const ok = await batch.run(
      targets.map((r) => () => deleteUser(r.uid)),
      t('admin_delete_success', '删除成功！'),
    );
    if (ok) {
      setPicked([]);
      setConfirming(false);
    }
  };

  return (
    <div className="space-y-3">
      <PageTitle>{t('admin_user_list', '用户列表')}</PageTitle>
      <TabBar active="list" items={USER_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />

      {/* 搜索行：一行三格，独立于卡之外 */}
      <div className="grid grid-cols-1 items-start gap-x-[30px] md:grid-cols-12">
        <div className="min-w-0 md:col-span-2">
          <Select aria-label={t('search_type', '搜索类型')} value={formType} onChange={(e) => setFormType(e.target.value)}>
            <option value="">{t('search_type', '搜索类型')}</option>
            {SEARCH_TYPES.map((s) => (
              <option key={s.value} value={s.value}>
                {t(s.textKey, s.fallback)}：
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-0 md:col-span-3">
          <Input
            aria-label={t('keyword', '关键字')}
            placeholder={t('keyword', '关键字')}
            value={formKey}
            onChange={(e) => setFormKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        </div>
        <div className="min-w-0 md:col-span-2">
          <Button loading={q.isFetching} onClick={submit} className="w-full">
            <Icon name="search" />
            {t('search', '搜索')}
          </Button>
        </div>
      </div>
      <p className="-mt-2 text-xs text-muted-2">{t('admin_user_search_note', '注：搜索是精确匹配（非模糊），用户名/邮箱需整串对上；创建 IP 填点分十进制，服务端会转整数。')}</p>

      {q.isError && <ErrorState error={q.error} />}
      {batch.flash && <Alert tone={batch.flash.tone}>{batch.flash.text}</Alert>}

      <section className={cx(cardCls, 'flex flex-col')}>
        <div className={cardHeaderCls}>
          <span className="text-[1.1rem] font-normal leading-[1.5]">{t('admin_users_list', '用户列表')}</span>
          <div ref={menuRef} className="relative ml-auto inline-flex">
            <Link to="/admin/users" className={btnDefaultCls}>
              {t('admin_all_users', '全部用户')}
            </Link>
            {/* 按钮组相邻压边：-1px + 左侧圆角归零 */}
            <button
              type="button"
              aria-label={t('admin_user_filter_by_group', '按用户组筛选')}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              className={cx(btnDefaultCls, '-ml-px rounded-l-none')}
            >
              <span className="ml-[.255em] inline-block h-0 w-0 align-[.255em] border-x-[.3em] border-t-[.3em] border-x-transparent border-t-current" />
            </button>
            {menuOpen && (
              <div className={dropdownMenuCls} role="menu">
                {grouplist.map((g) => (
                  <Link key={Number(g.gid)} role="menuitem" to={`/admin/users?type=gid&keyword=${Number(g.gid)}`} className={dropdownItemCls} onClick={() => setMenuOpen(false)}>
                    {gn(g.gid, g.name)}
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* .card-body p-0：内距交给表格的 .75rem 胞距，表格本身 mb-0（adm-flush） */}
        <div className="min-h-px flex-1">
          <Table
            flush
            minWidth="min-w-[1060px]"
            head={[
              t('check_all', '全选'),
              'ID：',
              t('email', '邮箱'),
              t('username', '用户名'),
              t('user_group', '用户组'),
              t('ban_status', '状态'),
              t('admin_user_reg_time', '注册时间'),
              t('admin_user_last_login_time', '最近登录时间'),
              t('create_ip', '创建 IP'),
              t('operation', '操作'),
            ]}
            headCls={['w-[60px] text-center', 'w-[50px]', 'w-[150px]', 'w-[150px]', 'w-[100px]', 'w-[110px]', 'w-[100px]', 'w-[130px]', 'w-[100px]', 'w-[60px]']}
          >
            {rows.map((r) => (
              <UserRow
                key={r.uid}
                row={r}
                groupName={groupName.get(Number(r.gid)) ?? `gid ${r.gid}`}
                picked={picked.includes(r.uid)}
                onPick={(v) => setPicked((p) => (v ? [...p, r.uid] : p.filter((x) => x !== r.uid)))}
              />
            ))}
          </Table>
          {rows.length === 0 && !q.isFetching && <p className="m-0 py-[.75rem] text-center text-sm text-muted">{t('none', '无')}</p>}
        </div>

        <div className={cx(cardFooterCls, 'flex flex-wrap items-center justify-between gap-2')}>
          <div className="flex flex-wrap items-center gap-2">
            {/* 删除钮不做 disabled，未勾选时靠提示语拦截 */}
            <Button variant="danger" size="sm" loading={batch.pending} onClick={() => void deletePicked()}>
              <Icon name="trash" />
              {t('delete', '删除')}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                if (!picked.length) {
                  batch.setFlash({ tone: 'warn', text: t('ban_no_selection', '请先勾选用户') });
                  return;
                }
                setBanOpen((v) => !v);
              }}
            >
              <Icon name="shield" />
              {t('ban_batch', '批量封禁')}
            </Button>
          </div>
          <span className="text-[80%] text-muted">
            <Icon name="shield" className="ml-2 inline size-[1em] align-[-.125em]" />
            {t('admin_user_shield_legend', ':表示管理组成员，请谨慎操作！')}
          </span>
        </div>
      </section>

      {q.data && <AdminPagination page={q.data.page} totalPage={q.data.totalPage} href={buildHref} />}

      {/* 批量封禁表单：勾选后展开，命中 gid=1 / 自己 / 不存在 的目标由服务端 skipped 返回 */}
      {banOpen && (
        <section className={cx(cardCls, 'p-4')}>
          <h4 className="mb-0 text-[1.1rem] font-normal leading-[1.2]">
            {t('ban_batch', '批量封禁')}（{targets.length}）
          </h4>
          {banAct.flash && <Alert tone={banAct.flash.tone}>{banAct.flash.text}</Alert>}
          <BanScopePicker value={banScope} onChange={setBanScope} />
          <Field label={t('ban_duration', '封禁时长')} htmlFor="batch-ban-duration">
            <Select id="batch-ban-duration" value={String(banDuration)} onChange={(e) => setBanDuration(Number(e.target.value))}>
              {BAN_DURATIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {t(d.key)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('ban_reason_label', '原因')} htmlFor="batch-ban-reason">
            <Input id="batch-ban-reason" value={banReason} maxLength={200} onChange={(e) => setBanReason(e.target.value)} />
          </Field>
          <SubmitRow indentClass="sm:w-full">
            <Button
              block
              loading={banAct.pending}
              onClick={() => {
                if (!banScope) {
                  banAct.setFlash({ tone: 'warn', text: t('ban_scope_required', '请至少选择一种封禁范围') });
                  return;
                }
                banAct.mutate();
              }}
            >
              {t('ban_submit', '封禁')}
            </Button>
          </SubmitRow>
        </section>
      )}

      <ConfirmModal
        open={confirming}
        loading={batch.pending}
        text={`${t('user_delete_confirm', '确定删除用户？')}${t('admin_user_delete_confirm_body', '将永久删除 {n} 个账户并级联清理其主题/回帖/附件：', { n: targets.length })}${targets
          .slice(0, 5)
          .map((r) => `${r.username}(${r.uid})`)
          .join('、')}${targets.length > 5 ? ' …' : ''}。`}
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

function UserRow({
  row,
  groupName,
  picked,
  onPick,
}: {
  row: AdminUserRow;
  groupName: string;
  picked: boolean;
  onPick: (v: boolean) => void;
}) {
  const t = useAdminT();
  const gid = Number(row.gid);
  const isAdmin = gid === GroupId.ADMIN;
  /** 盾牌图例：`gid > 0 && gid < 6`，即管理员/版务组 */
  const manage = gid > 0 && gid < 6;
  return (
    <tr>
      <td className="text-center">
        <Checkbox
          checked={picked && !isAdmin}
          disabled={isAdmin}
          title={isAdmin ? t('user_admin_cant_be_deleted', '不允许删除管理员用户，如果确实要删除，请先调整用户组!') : undefined}
          onChange={onPick}
        />
      </td>
      <td className="tabular-nums">{row.uid}</td>
      <td className="break-all">{row.email}</td>
      <td>
        {row.username}
        {manage && <Icon name="shield" className="ml-[.5rem] inline size-[1em] align-[-.125em]" />}
      </td>
      <td>{groupName}</td>
      <td>
        <BanBadge scope={row.ban_scope} until={row.ban_until} />
      </td>
      {/* create_date 即注册时间；login_date=0 表示从未登录，fmtDate 返回空串 */}
      <td className="whitespace-nowrap">{fmtDay(row.create_date)}</td>
      <td className="whitespace-nowrap tabular-nums">{fmtDate(row.login_date)}</td>
      <td className="whitespace-nowrap tabular-nums">{row.create_ip_fmt}</td>
      {/* `td.pr-0`：贴右边留给按钮本身的圆角；按钮是小尺寸主色按钮 */}
      <td className="pr-0">
        <Link
          to={`/admin/users/${row.uid}/edit`}
          className="inline-flex items-center rounded-[.2rem] bg-brand px-2 py-1 text-[.875rem] leading-[1.5] text-white no-underline hover:bg-brand-hover"
        >
          {t('edit', '编辑')}
        </Link>
      </td>
    </tr>
  );
}

/** 封禁状态徽章：按 ban_until 惰性判定（已到期但 cron 未清理的行显示为正常） */
function BanBadge({ scope, until }: { scope: number; until: number }) {
  const t = useAdminT();
  const eff = effectiveBanScope(scope, until, Math.floor(Date.now() / 1000));
  if (!eff) return <span className="text-muted">{t('ban_status_none', '正常')}</span>;
  return (
    <span
      className="inline-flex items-center rounded-[4px] bg-danger/10 px-2 py-0.5 text-xs text-danger"
      title={scopeText(eff, t)}
    >
      {t('ban_status_banned', '已封禁')}
    </span>
  );
}
