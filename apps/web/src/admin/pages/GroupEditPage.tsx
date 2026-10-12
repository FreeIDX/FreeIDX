/**
 * 用户组编辑（路由 /admin/groups/:gid/edit，模式 C）。
 * 版式：卡体内小标题「用户组编辑 - 名称」→ 用户组名/起始积分/结束积分 三个
 * 「标签窄栏 + 控件宽栏」表单行 → 「用户权限」行内一张**无表头**的两行表（第一行居中文字、第二行居中复选框）
 * → gid 1-5 才出现的「管理权限」行（同构七列表）→ 整行「确定」+ 整行「返回」。
 * 提交仍走列表那条 PUT /api/admin/groups（列表/编辑共用一个 upsert 语义），
 * 只是这里只带单组；服务端 §D.8#5 对 gid∉[1,5] 静默丢弃版务位，故非管理组整块不渲染而非禁用。
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import type { AdminKey } from '@freeidx/shared';
import { getGroups, putGroups } from '../api';
import type { GroupFullRow } from '../types';
import { useAdminT } from '../t';
import { useAdminAction } from '../use-action';
import { USER_TABS } from '../tabs';
import { MOD_PERMS, USER_PERMS, isModGid, toItem, type GroupNumericKey } from './group-perms';
import { Alert, Button, Card, Checkbox, ErrorState, Field, Input, LinkButton, PageTitle, SubmitRow, TabBar } from '../ui';

/** 用户权限两行表：thead 缺席，首行是居中文字表头，次行是居中复选框 */
function PermRow({
  minWidth,
  items,
  value,
  onChange,
}: {
  minWidth: string;
  items: readonly { key: GroupNumericKey; labelKey: AdminKey; fallback: string }[];
  value: GroupFullRow;
  onChange: (key: GroupNumericKey, next: boolean) => void;
}) {
  const t = useAdminT();
  return (
    <div className="overflow-x-auto">
      <table className="adm-table w-full text-base" style={{ minWidth }}>
        <tbody>
          <tr className="text-center">
            {items.map((p) => (
              <td key={p.key}>{t(p.labelKey, p.fallback)}</td>
            ))}
          </tr>
          <tr className="text-center">
            {items.map((p) => (
              <td key={p.key}>
                <Checkbox checked={Number(value[p.key]) === 1} onChange={(v) => onChange(p.key, v)} />
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function GroupEditPage() {
  const t = useAdminT();
  const gid = Number(useParams().gid ?? 0);
  const q = useQuery({ queryKey: ['admin', 'groups'], queryFn: getGroups });
  const found = useMemo(() => (q.data?.groups ?? []).find((g) => Number(g.gid) === gid), [q.data, gid]);

  const [form, setForm] = useState<GroupFullRow | null>(null);
  useEffect(() => {
    if (found) setForm(found);
  }, [found]);

  const save = useAdminAction(() => putGroups([toItem(form ?? found!)]), {
    ok: t('save_successfully'),
    invalidate: [['admin', 'groups'], ['admin', 'forums']],
  });
  const set = <K extends GroupNumericKey>(key: K, v: GroupFullRow[K]) => setForm((f) => (f ? { ...f, [key]: v } : f));
  const setName = (v: string) => setForm((f) => (f ? { ...f, name: v } : f));

  if (q.isError) return <ErrorState error={q.error} />;
  if (!form && !q.isPending) return <Card>{t('group_not_found', '用户组 {gid} 不存在。', { gid })}</Card>;
  if (!form) return <Card>{t('loading')}</Card>;

  return (
    <div className="space-y-3">
      <PageTitle>{`${t('group_edit', '用户组编辑')} - ${form.name}`}</PageTitle>
      <TabBar active="group" items={USER_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {save.flash && <Alert tone={save.flash.tone}>{save.flash.text}</Alert>}

      <Card>
        <h4 className="mb-0 text-[1.1rem] font-normal leading-[1.2]">
          {t('group_edit', '用户组编辑')} - {form.name}
        </h4>
        <Field label={t('group_name', '用户组名')} htmlFor="g-name">
          <Input id="g-name" value={form.name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('group_credits_from', '起始积分')} htmlFor="g-creditsfrom" hint={t('group_credits_hint')}>
          <Input id="g-creditsfrom" type="number" value={String(form.creditsfrom)} onChange={(e) => set('creditsfrom', Number(e.target.value || 0))} />
        </Field>
        <Field label={t('group_credits_to', '结束积分')} htmlFor="g-creditsto">
          <Input id="g-creditsto" type="number" value={String(form.creditsto)} onChange={(e) => set('creditsto', Number(e.target.value || 0))} />
        </Field>

        <Field label={t('user_privileges', '用户权限')}>
          <PermRow
            minWidth="400px"
            items={USER_PERMS}
            value={form}
            onChange={(k, v) => set(k, v ? 1 : 0)}
          />
        </Field>

        {isModGid(gid) && (
          <Field label={t('admin_privilege', '管理权限')}>
            <PermRow
              minWidth="600px"
              items={MOD_PERMS}
              value={form}
              onChange={(k, v) => set(k, v ? 1 : 0)}
            />
          </Field>
        )}

        <SubmitRow>
          <Button block loading={save.pending} onClick={() => save.mutate()}>
            {t('confirm', '确定')}
          </Button>
          <LinkButton to="/admin/groups" variant="secondary" className="mt-[1rem] w-full">
            {t('back', '返回')}
          </LinkButton>
        </SubmitRow>
      </Card>
    </div>
  );
}
