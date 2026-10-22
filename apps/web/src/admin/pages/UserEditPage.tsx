/**
 * 用户新建 / 编辑（模式 C 居中窄栏，占 8/12 栅格）。
 * 版式核实：二级 Tab（按钮组，mb-3）在卡**外面**，
 * 取用户菜单三档（列表/用户组/创建）——编辑态 active='list'、新建态 active='create'；
 * 卡内小标题「编辑用户」只在编辑态显示，新建态不渲染；
 * 底部整行次要按钮「返回」（mt-3）两态都有（跳回列表，不用 history.back()）。
 * 口令口径：服务端只接受**前端预哈希的 32 位 md5 串**（与前台登录同口径，见 shared 的 md5Hex），
 * 且改口令会同时 token_version+1 并销毁该用户全部会话——编辑页必须把这条后果写在字段说明里。
 * 编辑取数：后台没有 GET /api/admin/users/:uid，用列表接口的精确搜索（type=uid）拿单行；
 * 该投影带 email，所以编辑态可以直接回填并按 diff 提交。
 * PUT 只更新变化字段（按字段 diff 语义），因此提交前本地 diff，无差异则禁用按钮。
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { GroupId, md5Hex } from '@freeidx/shared';
import { createUser, getUsers, updateUser } from '../api';
import type { AdminUserRow } from '../types';
import { useAdminT } from '../t';
import { useGroupName } from '../../lib/i18n';
import { useAdminAction } from '../use-action';
import { useAuth } from '../../store/auth';
import { USER_TABS } from '../tabs';
import { fmtDate } from '../../lib/api';
import { Alert, Button, Card, ErrorState, Field, Input, LinkButton, PageTitle, Select, SubmitRow, TabBar } from '../ui';

interface FormState {
  email: string;
  username: string;
  gid: number;
  ok: number;
  password: string;
  password2: string;
}

const EMPTY: FormState = { email: '', username: '', gid: GroupId.LEVEL1, ok: 1, password: '', password2: '' };

export function UserEditPage() {
  const t = useAdminT();
  const gn = useGroupName();
  const navigate = useNavigate();
  const grouplist = useAuth((s) => s.grouplist);
  const routeUid = Number(useParams().uid ?? 0);
  const isNew = !routeUid;

  const q = useQuery({
    queryKey: ['admin', 'users', { type: 'uid', keyword: String(routeUid), page: 1 }],
    queryFn: () => getUsers({ type: 'uid', keyword: String(routeUid) }),
    enabled: !isNew,
  });
  const row: AdminUserRow | undefined = q.data?.list[0];

  const [form, setForm] = useState<FormState>(EMPTY);
  const [origin, setOrigin] = useState<FormState>(EMPTY);

  useEffect(() => {
    if (!row) return;
    const next: FormState = { email: row.email ?? '', username: row.username, gid: Number(row.gid), ok: Number(row.ok ?? 1), password: '', password2: '' };
    setForm(next);
    setOrigin(next);
  }, [row]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const patch = (): { email?: string; username?: string; gid?: number; ok?: number; password?: string } => {
    const out: { email?: string; username?: string; gid?: number; ok?: number; password?: string } = {};
    const email = form.email.trim();
    if (email && email !== origin.email) out.email = email;
    if (form.username !== origin.username) out.username = form.username;
    if (form.gid !== origin.gid) out.gid = form.gid;
    if (form.ok !== origin.ok) out.ok = form.ok;
    if (form.password) out.password = md5Hex(form.password);
    return out;
  };

  const submit = useAdminAction(
    async () => {
      if (isNew) {
        const d = await createUser({ email: form.email.trim(), username: form.username, password: md5Hex(form.password), gid: form.gid });
        navigate(`/admin/users/${d.uid}/edit`, { replace: true });
        return d;
      }
      return updateUser(routeUid, patch());
    },
    { ok: isNew ? t('user_create_success', '创建成功') : t('user_update_success', '更新成功'), invalidate: [['admin', 'users'], ['admin', 'runtime']] },
  );

  const groups = grouplist.filter((g) => Number(g.gid) > 0);
  const emptyPatch = !isNew && Object.keys(patch()).length === 0;

  if (!isNew && q.isError) return <ErrorState error={q.error} />;

  return (
    <div className="space-y-3 lg:w-2/3 mx-auto">
      <PageTitle>{isNew ? t('admin_user_create', '创建用户') : `${t('edit_user', '编辑用户')} - ${form.username || routeUid}`}</PageTitle>
      <TabBar active={isNew ? 'create' : 'list'} items={USER_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {submit.flash && <Alert tone={submit.flash.tone}>{submit.flash.text}</Alert>}
      {!isNew && q.isPending && <Card>{t('loading', '加载中…')}</Card>}
      {!isNew && !q.isPending && !row && <Card>{t('user_not_found_id', '用户 {uid} 不存在。', { uid: routeUid })}</Card>}

      <Card>
        {!isNew && <h4 className="mb-0 text-[1.1rem] font-normal leading-[1.2]">{t('edit_user', '编辑用户')}</h4>}
        <Field label={t('email', 'Email')} htmlFor="u-email" hint={isNew ? t('user_email_hint_new', '注册必填，需唯一') : t('user_email_hint_edit', '留空表示不修改，填写则覆盖为新邮箱')}>
          <Input id="u-email" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label={t('username', '用户名')} htmlFor="u-username" hint={t('user_username_hint', '最长 16 个字符，不能含空格')}>
          <Input id="u-username" value={form.username} onChange={(e) => set('username', e.target.value)} />
        </Field>
        <Field label={t('password', '密码')} htmlFor="u-password" hint={isNew ? t('user_password_hint_new', '至少 6 位；密码在本机加密后提交，不会明文传输') : t('user_password_hint_edit', '留空表示不修改；修改会让该用户所有登录会话失效')}>
          <Input id="u-password" type="password" value={form.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label={t('password_new_repeat', '重复新密码')} htmlFor="u-password2">
          <Input id="u-password2" type="password" value={form.password2} onChange={(e) => set('password2', e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label={t('user_group', '用户组')} htmlFor="u-gid" hint={t('user_group_hint', '用户组 ID 为 1 的是管理员（可进入后台）；修改后会立刻影响全站权限')}>
          <Select id="u-gid" value={String(form.gid)} onChange={(e) => set('gid', Number(e.target.value))}>
            {groups.map((g) => (
              <option key={g.gid} value={g.gid}>
                {g.gid} · {gn(g.gid, g.name)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('user_audit_label', '审核')} htmlFor="u-ok" hint={t('user_audit_hint', '配合「内容审核」插件的用户注册审核使用：待审核/未通过的用户无法发帖回帖')}>
          <Select id="u-ok" value={String(form.ok)} onChange={(e) => set('ok', Number(e.target.value))}>
            <option value="1">{t('user_audit_pass', '通过')}</option>
            <option value="0">{t('user_audit_pending', '待审核')}</option>
            <option value="-1">{t('user_audit_reject', '未通过')}</option>
          </Select>
        </Field>
        {!isNew && row && (
          <p className="mb-[1rem] text-xs text-muted-2">
            {t('user_stats_line', '注册 {create_date} · 最近登录 {login_date} · 主题 {threads} · 回帖 {posts} · 积分 {credits} · 注册 IP {create_ip}', {
              create_date: fmtDate(row.create_date) || '-',
              login_date: fmtDate(row.login_date) || '-',
              threads: row.threads,
              posts: row.posts,
              credits: row.credits,
              create_ip: row.create_ip_fmt,
            })}
          </p>
        )}

        <SubmitRow>
          <Button
            block
            loading={submit.pending}
            disabled={emptyPatch}
            onClick={() => {
              if (form.password !== form.password2) {
                submit.setFlash({ tone: 'warn', text: t('repeat_password_incorrect', '两次输入的密码不一致') });
                return;
              }
              submit.mutate();
            }}
          >
            {t('confirm', '确定')}
          </Button>
          <LinkButton to="/admin/users" variant="secondary" className="mt-[1rem] w-full">
            {t('back', '返回')}
          </LinkButton>
        </SubmitRow>
        {emptyPatch && <p className="mt-2 text-xs text-muted">{t('user_no_change', '没有任何修改（邮箱/用户名/用户组未变、密码未填）。')}</p>}
      </Card>
    </div>
  );
}
