/**
 * 内容审核：四行链接表展开为 8 档（/admin/check[...]）——待审/未过审 × 主题·回帖·用户 + 主题回收站 + 审核设置。
 *  - 队列：页码分页（服务端 total/size，默认 20），表头列名用中文字面量（同新增页约定）；
 *  - 审核动作不重复造接口：复用前台 POST /api/check 与 POST /api/recycle，
 *    确认文案与前台 thread_js 口径一致；
 *  - 设置：一般设置（user_check/recycle）+ 用户组矩阵（发帖/回帖/编辑审核 + 查看回收站）+ 板块矩阵（发帖/回帖/编辑审核），
 *    服务端保存为「先全清后置选中」；广告推广卡不做。
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { checkAudit, fmtDate, recycleThread } from '../../lib/api';
import { apiErrorMessage } from '../../lib/errors';
import {
  getCheckPosts,
  getCheckRecycle,
  getCheckSetting,
  getCheckThreads,
  getCheckUsers,
  putCheckSetting,
  truncateRecycle,
} from '../api';
import type { AdminUserRow } from '../types';
import { useAdminAction, type Flash } from '../use-action';
import { useAdminT } from '../t';
import { useGroupName } from '../../lib/i18n';
import { CHECK_TABS } from '../tabs';
import {
  Alert,
  Button,
  Card,
  ErrorState,
  Field,
  PageTitle,
  PermissionMatrix,
  QueuePager,
  Select,
  TabBar,
  Table,
  usePage,
} from '../ui';

const PAGE_SIZE = 20;

function useActiveTab(): string {
  const { pathname } = useLocation();
  const hit = CHECK_TABS.find((x) => x.to !== '/admin/check' && pathname.startsWith(x.to));
  return hit?.k ?? 'thread';
}

function CheckTabs() {
  const t = useAdminT();
  const active = useActiveTab();
  return <TabBar active={active} items={CHECK_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />;
}

/**
 * 行级审核动作（确认弹层 + 提交 + 就地刷新）：
 * busyId 记录当前行，成功清对应列表缓存并提示服务端文案（'审核完毕！'/'操作完毕！'）。
 */
function useRowAction() {
  const t = useAdminT();
  const qc = useQueryClient();
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busyId, setBusyId] = useState(0);
  const run = async (
    id: number,
    confirmText: string,
    fn: () => Promise<unknown>,
    invalidate: readonly (readonly unknown[])[],
    okText?: string,
  ) => {
    if (!window.confirm(confirmText)) return;
    setBusyId(id);
    setFlash(null);
    try {
      await fn();
      for (const k of invalidate) await qc.invalidateQueries({ queryKey: k });
      setFlash({ tone: 'ok', text: okText ?? t('check_audit_done', '审核完毕！') });
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    } finally {
      setBusyId(0);
    }
  };
  return { flash, busyId, run };
}

/** 三枚审核按钮（通过/拒绝/删除，同三条队列） */
function AuditButtons({ busy, onPick }: { busy: boolean; onPick: (opt: number) => void }) {
  const t = useAdminT();
  return (
    <div className="flex flex-wrap gap-1.5">
      {(
        [
          [1, t('audit_pass', '通过')],
          [-1, t('audit_reject', '拒绝')],
          [-2, t('delete', '删除')],
        ] as const
      ).map(([opt, text]) => (
        <Button key={opt} size="sm" variant="default" disabled={busy} onClick={() => onPick(opt)}>
          {text}
        </Button>
      ))}
    </div>
  );
}

/* ---------------- 主题审核队列（ok=0 待审 / -1 未通过） ---------------- */

function ThreadQueue({ ok }: { ok: 0 | -1 }) {
  const t = useAdminT();
  const page = usePage();
  const path = ok === 0 ? '/admin/check' : '/admin/check/unapproved-threads';
  const listKey = ['admin', 'check', 'threads', ok] as const;
  const q = useQuery({
    queryKey: [...listKey, page],
    queryFn: () => getCheckThreads({ ok, page, size: PAGE_SIZE }),
  });
  const { flash, busyId, run } = useRowAction();
  const rows = q.data?.list ?? [];

  return (
    <div className="space-y-3">
      {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
      {q.isError && <ErrorState error={q.error} />}
      <Card title={ok === 0 ? t('tt_check_nav_thread', '批量审核主题') : t('tt_check_nav_uthread', '管理未通过主题')} noPadding>
        <Table head={[t('thread', '主题'), t('author', '作者'), t('check_post_time', '发表时间'), 'tid', t('operation', '操作')]} minWidth="min-w-[760px]">
          {rows.map((r) => (
            <tr key={r.tid}>
              <td>
                {/* 主题列开新窗口 */}
                <a className="text-brand hover:underline" href={`/thread/${r.tid}`} target="_blank" rel="noreferrer">
                  {r.subject}
                </a>
              </td>
              <td>{r.username ?? '—'}</td>
              <td className="whitespace-nowrap">{fmtDate(r.create_date)}</td>
              <td className="tabular-nums">{r.tid}</td>
              <td>
                <AuditButtons
                  busy={busyId === r.tid}
                  onPick={(opt) => void run(r.tid, t('confirm_audit_thread', '是否要审核该主题呢？'), () => checkAudit(0, r.tid, opt), [listKey])}
                />
              </td>
            </tr>
          ))}
        </Table>
        {rows.length === 0 && !q.isFetching && (
          <p className="py-6 text-center text-sm text-muted">{ok === 0 ? t('check_no_thread_0', '没有待审核的主题。') : t('check_no_thread_1', '没有未通过的主题。')}</p>
        )}
      </Card>
      <QueuePager page={page} totalPage={q.data?.totalPage ?? 1} path={path} />
    </div>
  );
}

/* ---------------- 回帖审核队列（isfirst=0） ---------------- */

function PostQueue({ ok }: { ok: 0 | -1 }) {
  const t = useAdminT();
  const page = usePage();
  const path = ok === 0 ? '/admin/check/posts' : '/admin/check/unapproved-posts';
  const listKey = ['admin', 'check', 'posts', ok] as const;
  const q = useQuery({
    queryKey: [...listKey, page],
    queryFn: () => getCheckPosts({ ok, page, size: PAGE_SIZE }),
  });
  const { flash, busyId, run } = useRowAction();
  const rows = q.data?.list ?? [];

  return (
    <div className="space-y-3">
      {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
      {q.isError && <ErrorState error={q.error} />}
      <Card title={ok === 0 ? t('tt_check_nav_post', '批量审核回帖') : t('tt_check_nav_upost', '管理未通过回帖')} noPadding>
        <Table head={[t('thread', '主题'), t('author', '作者'), t('check_post_time', '发表时间'), 'pid', t('message', '内容'), t('operation', '操作')]} minWidth="min-w-[960px]">
          {rows.map((r) => (
            <tr key={r.pid}>
              <td>
                <a className="text-brand hover:underline" href={`/thread/${r.tid}`} target="_blank" rel="noreferrer">
                  {r.subject ?? t('check_subject_fallback', '主题 {tid}', { tid: r.tid })}
                </a>
              </td>
              <td>{r.username ?? '—'}</td>
              <td className="whitespace-nowrap">{fmtDate(r.create_date)}</td>
              <td className="tabular-nums">{r.pid}</td>
              {/* 内容行：'内容：&nbsp;{message}' 纯文本（React 默认转义） */}
              <td className="max-w-[420px] whitespace-pre-wrap break-words text-muted-2">{r.message}</td>
              <td>
                <AuditButtons
                  busy={busyId === r.pid}
                  onPick={(opt) => void run(r.pid, t('confirm_audit_reply', '是否要审核该回帖呢？'), () => checkAudit(1, r.pid, opt), [listKey])}
                />
              </td>
            </tr>
          ))}
        </Table>
        {rows.length === 0 && !q.isFetching && (
          <p className="py-6 text-center text-sm text-muted">{ok === 0 ? t('check_no_post_0', '没有待审核的回帖。') : t('check_no_post_1', '没有未通过的回帖。')}</p>
        )}
      </Card>
      <QueuePager page={page} totalPage={q.data?.totalPage ?? 1} path={path} />
    </div>
  );
}

/* ---------------- 用户审核队列 ---------------- */

function UserQueue({ ok }: { ok: 0 | -1 }) {
  const t = useAdminT();
  const page = usePage();
  const path = ok === 0 ? '/admin/check/users' : '/admin/check/unapproved-users';
  const listKey = ['admin', 'check', 'users', ok] as const;
  const q = useQuery({
    queryKey: [...listKey, page],
    queryFn: () => getCheckUsers({ ok, page, size: PAGE_SIZE }),
  });
  const { flash, busyId, run } = useRowAction();
  const rows: AdminUserRow[] = q.data?.list ?? [];

  return (
    <div className="space-y-3">
      {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
      {q.isError && <ErrorState error={q.error} />}
      <Card title={ok === 0 ? t('tt_check_nav_user', '批量审核用户') : t('tt_check_nav_uuser', '管理未通过用户')} noPadding>
        <Table head={['uid', t('username', '用户名'), t('check_register_time', '注册时间'), t('check_email_addr', 'email地址'), t('check_ip_addr', 'IP地址'), t('operation', '操作')]} minWidth="min-w-[860px]">
          {rows.map((r) => (
            <tr key={r.uid}>
              <td className="tabular-nums">{r.uid}</td>
              <td>{r.username}</td>
              <td className="whitespace-nowrap">{fmtDate(r.create_date)}</td>
              <td>{r.email}</td>
              <td className="tabular-nums">{r.create_ip_fmt}</td>
              <td>
                <AuditButtons
                  busy={busyId === r.uid}
                  onPick={(opt) => void run(r.uid, t('check_confirm_user', '是否要审核该用户呢？'), () => checkAudit(2, r.uid, opt), [listKey])}
                />
              </td>
            </tr>
          ))}
        </Table>
        {rows.length === 0 && !q.isFetching && (
          <p className="py-6 text-center text-sm text-muted">{ok === 0 ? t('check_no_user_0', '没有待审核的用户。') : t('check_no_user_1', '没有未通过的用户。')}</p>
        )}
      </Card>
      <QueuePager page={page} totalPage={q.data?.totalPage ?? 1} path={path} />
    </div>
  );
}

/* ---------------- 主题回收站 ---------------- */

function RecycleTab() {
  const t = useAdminT();
  const page = usePage();
  const path = '/admin/check/recycle';
  const listKey = ['admin', 'check', 'recycle'] as const;
  const q = useQuery({ queryKey: [...listKey, page], queryFn: () => getCheckRecycle({ page, size: PAGE_SIZE }) });
  const { flash, busyId, run } = useRowAction();
  const trunc = useAdminAction(async () => {
    // 服务端每次最多清 2 条（D1 50 条语句硬上限），循环直到清完
    let count = 0;
    for (let i = 0; i < 500; i++) {
      const r = await truncateRecycle();
      count += r.count;
      if (!r.next) break;
    }
    return { count };
  }, {
    ok: (d) => t('check_recycle_truncate_ok', '清空成功！（{count} 个主题）', { count: d.count }),
    invalidate: [listKey],
  });
  const rows = q.data?.list ?? [];

  /* 清空回收站：整行危险按钮 + confirm 二次确认 */
  const submitTruncate = () => {
    if (!window.confirm(t('check_recycle_truncate_confirm', '您确定要清空回收站吗？清空后将无法恢复！'))) return;
    trunc.mutate();
  };

  return (
    <div className="space-y-3">
      {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
      {trunc.flash && <Alert tone={trunc.flash.tone}>{trunc.flash.text}</Alert>}
      {q.isError && <ErrorState error={q.error} />}
      <Card title={t('tt_check_nav_recycle', '主题回收站')} noPadding>
        <div className="border-b border-line-soft p-[1.25rem]">
          <Button variant="danger" block loading={trunc.pending} onClick={submitTruncate}>
            {t('check_recycle_clear_btn', '清空回收站')}
          </Button>
        </div>
        <Table head={[t('thread', '主题'), t('author', '作者'), t('check_post_time', '发表时间'), 'tid', t('operation', '操作')]} minWidth="min-w-[760px]">
          {rows.map((r) => (
            <tr key={r.tid}>
              <td>{r.subject}</td>
              <td>{r.username ?? '—'}</td>
              <td className="whitespace-nowrap">{fmtDate(r.create_date)}</td>
              <td className="tabular-nums">{r.tid}</td>
              <td>
                <div className="flex flex-wrap gap-1.5">
                  {/* 恢复/删除确认文案与前台回收站一致 */}
                  <Button
                    size="sm"
                    variant="default"
                    disabled={busyId === r.tid}
                    onClick={() => void run(r.tid, t('confirm_restore_thread_q', '是否要恢复该主题呢？'), () => recycleThread(r.tid, -1), [listKey], t('check_op_done', '操作完毕！'))}
                  >
                    {t('restore', '恢复')}
                  </Button>
                  <Button
                    size="sm"
                    variant="default"
                    disabled={busyId === r.tid}
                    onClick={() => void run(r.tid, t('confirm_delete_thread_q', '是否要删除该主题呢？'), () => recycleThread(r.tid, 1), [listKey], t('check_op_done', '操作完毕！'))}
                  >
                    {t('purge_delete', '彻底删除')}
                  </Button>
                </div>
              </td>
            </tr>
          ))}
        </Table>
        {rows.length === 0 && !q.isFetching && <p className="py-6 text-center text-sm text-muted">{t('check_recycle_empty', '回收站是空的。')}</p>}
      </Card>
      <QueuePager page={page} totalPage={q.data?.totalPage ?? 1} path={path} />
    </div>
  );
}

/* ---------------- 审核设置（表单部分） ---------------- */

const GROUP_PERM_KEYS = ['thread_check', 'post_check', 'edit_check', 'see_check'] as const;
const FORUM_PERM_KEYS = ['thread_check', 'post_check', 'edit_check'] as const;

function SettingTab() {
  const t = useAdminT();
  const gn = useGroupName();
  const q = useQuery({ queryKey: ['admin', 'check', 'setting'], queryFn: getCheckSetting });
  const [userCheck, setUserCheck] = useState(0);
  const [recycle, setRecycle] = useState(0);
  /* 矩阵只存数值列（PermissionMatrix 的 V extends Record<string, number>）；名称借 q.data 渲染 */
  const [gMatrix, setGMatrix] = useState<Record<number, Record<string, number>>>({});
  const [fMatrix, setFMatrix] = useState<Record<number, Record<string, number>>>({});

  useEffect(() => {
    if (!q.data) return;
    setUserCheck(q.data.user_check);
    setRecycle(q.data.recycle);
    setGMatrix(
      Object.fromEntries(
        q.data.groups.map((g) => [
          g.gid,
          { thread_check: g.thread_check, post_check: g.post_check, see_check: g.see_check, edit_check: g.edit_check },
        ]),
      ),
    );
    setFMatrix(
      Object.fromEntries(
        q.data.forums.map((f) => [f.fid, { thread_check: f.thread_check, post_check: f.post_check, edit_check: f.edit_check }]),
      ),
    );
  }, [q.data]);

  const onGroup = (gid: number, key: string, checked: boolean) =>
    setGMatrix((s) => ({ ...s, [gid]: { ...s[gid], [key]: checked ? 1 : 0 } }));
  const onForum = (fid: number, key: string, checked: boolean) =>
    setFMatrix((s) => ({ ...s, [fid]: { ...s[fid], [key]: checked ? 1 : 0 } }));

  const permLabel = (key: string): string => {
    switch (key) {
      case 'thread_check': return t('check_perm_thread', '发帖需要审核');
      case 'post_check': return t('check_perm_post', '回帖需要审核');
      case 'edit_check': return t('check_perm_edit', '编辑需要审核');
      case 'see_check': return t('check_perm_see', '查看、审核、操作回收站');
      default: return key;
    }
  };
  const groupPerms = GROUP_PERM_KEYS.map((k) => ({ key: k, label: permLabel(k) }));
  const forumPerms = FORUM_PERM_KEYS.map((k) => ({ key: k, label: permLabel(k) }));

  const save = useAdminAction(
    () =>
      putCheckSetting({
        user_check: userCheck as 0 | 1,
        recycle: recycle as 0 | 1,
        groups: (q.data?.groups ?? []).map((g) => ({
          gid: g.gid,
          thread_check: gMatrix[g.gid]?.thread_check ?? 0,
          post_check: gMatrix[g.gid]?.post_check ?? 0,
          see_check: gMatrix[g.gid]?.see_check ?? 0,
          edit_check: gMatrix[g.gid]?.edit_check ?? 0,
        })),
        forums: (q.data?.forums ?? []).map((f) => ({
          fid: f.fid,
          thread_check: fMatrix[f.fid]?.thread_check ?? 0,
          post_check: fMatrix[f.fid]?.post_check ?? 0,
          edit_check: fMatrix[f.fid]?.edit_check ?? 0,
        })),
      }),
    { ok: t('check_setting_saved', '设置成功！'), invalidate: [['admin', 'check', 'setting']] },
  );

  return (
    <div className="space-y-3">
      {save.flash && <Alert tone={save.flash.tone}>{save.flash.text}</Alert>}
      {q.isError && <ErrorState error={q.error} />}
      <Card>
        <h4 className="mb-3 text-[1.1rem] font-normal leading-[1.2]">{t('tt_check_setting', '审核设置')}</h4>
        {q.isLoading ? (
          <p className="py-6 text-center text-sm text-muted">{t('loading')}</p>
        ) : (
          <>
            <h5 className="mb-2 text-[1rem] font-medium">{t('check_general_setting', '一般设置')}</h5>
            <Field label={t('check_user_check_label', '用户注册需要审核，且未通过审核不得发帖回帖')} hint={t('check_user_check_hint', '0 关闭 / 1 开启；开启后新注册账号整站禁发帖回帖直至通过')}>
              <Select value={String(userCheck)} onChange={(e) => setUserCheck(Number(e.target.value))} className="w-[160px]">
                <option value="0">{t('check_off', '0 · 关闭')}</option>
                <option value="1">{t('check_on', '1 · 开启')}</option>
              </Select>
            </Field>
            <Field label={t('check_recycle_label', '开启主题帖子回收站')} hint={t('check_recycle_hint', '0 关闭 / 1 开启；开启后版务删除主题进回收站（可恢复/彻底删除）')}>
              <Select value={String(recycle)} onChange={(e) => setRecycle(Number(e.target.value))} className="w-[160px]">
                <option value="0">{t('check_off', '0 · 关闭')}</option>
                <option value="1">{t('check_on', '1 · 开启')}</option>
              </Select>
            </Field>

            <hr className="my-4 border-line-soft" />
            <h5 className="mb-2 text-[1rem] font-medium">{t('check_group_setting', '用户组设置')}</h5>
            <PermissionMatrix
              groups={(q.data?.groups ?? []).map((g) => ({ gid: g.gid, name: gn(g.gid, g.name) }))}
              perms={groupPerms}
              value={gMatrix}
              enabled
              onChange={onGroup}
            />

            <hr className="my-4 border-line-soft" />
            <h5 className="mb-2 text-[1rem] font-medium">{t('check_forum_setting', '板块设置')}</h5>
            <PermissionMatrix
              groups={(q.data?.forums ?? []).map((f) => ({ gid: f.fid, name: f.name }))}
              perms={forumPerms}
              value={fMatrix}
              enabled
              onChange={onForum}
            />

            <div className="mt-4">
              <Button loading={save.pending} onClick={() => save.mutate()}>
                {t('submit', '提交')}
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

/* ---------------- 页面 ---------------- */

export function CheckPage() {
  const t = useAdminT();
  const active = useActiveTab();
  return (
    <div className="space-y-3">
      <PageTitle>{CHECK_TABS.find((x) => x.k === active)?.fallback ?? t('check_page_title', '内容审核')}</PageTitle>
      <CheckTabs />
      {active === 'uthread' ? (
        <ThreadQueue ok={-1} />
      ) : active === 'post' ? (
        <PostQueue ok={0} />
      ) : active === 'upost' ? (
        <PostQueue ok={-1} />
      ) : active === 'user' ? (
        <UserQueue ok={0} />
      ) : active === 'uuser' ? (
        <UserQueue ok={-1} />
      ) : active === 'recycle' ? (
        <RecycleTab />
      ) : active === 'setting' ? (
        <SettingTab />
      ) : (
        <ThreadQueue ok={0} />
      )}
    </div>
  );
}