/**
 * 用户组列表（模式 B 表格式内联编辑）。只有四列可编辑
 * （用户组 ID / 用户组名 / 起始积分 / 结束积分）+ 编辑列 + 删除列，
 * **12 项权限不在这张表里**，点「编辑」进用户组编辑页逐组改（见 GroupEditPage），
 * 所以此处的列收窄，权限编辑不再挤进列表。
 * 提交是整表 PUT /api/admin/groups 批量 upsert：列表读的是完整行（GET /api/admin/groups 返回全字段），
 * 故只改这四列也不会把权限列写回 0（toItem 把未展示的 allow* 原样带上）。
 * 删除的口径差异：整表 upsert 语义由单组编辑页复用（只提交一组），
 * 走“未提交即删除”会把整表清掉，所以删除拆成显式 DELETE /api/admin/groups/:gid，交互仍是点「删除」即生效。
 * 系统保留组**整格不渲染按钮**（不是禁用），见 InlineEditGrid 的 lockMode='hide'。
 * gid 是主键：改 gid 等于新建一个组，原组不会被删（服务端同此语义）。
 * 文案口径：尾注使用 `group_edit_tips`（“请谨慎编辑用户组……”），不与版块编辑页同串。
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { deleteGroup, getGroups, putGroups } from '../api';
import type { GroupFullRow } from '../types';
import { useAdminT } from '../t';
import { useBatchAction } from '../use-action';
import { useAuth } from '../../store/auth';
import { USER_TABS } from '../tabs';
import { toItem } from './group-perms';
import { Alert, Card, ConfirmModal, ErrorState, InlineEditGrid, PageTitle, TabBar, type GridColumn } from '../ui';

/** 系统保留组的 gid 集合（不可删除/不可改 gid） */
const SYSTEM_GIDS = [0, 1, 2, 3, 4, 5, 6, 7, 101];

function BLANK_GROUP(gid: number): GroupFullRow {
  return {
    gid,
    name: '',
    creditsfrom: 0,
    creditsto: 0,
    allowread: 1,
    allowthread: 1,
    allowpost: 1,
    allowattach: 0,
    allowdown: 0,
    allowtop: 0,
    allowupdate: 0,
    allowdelete: 0,
    allowmove: 0,
    allowbanuser: 0,
    allowdeleteuser: 0,
    allowviewip: 0,
  };
}

export function GroupListPage() {
  const t = useAdminT();
  const navigate = useNavigate();
  const refresh = useAuth((s) => s.refresh);
  const q = useQuery({ queryKey: ['admin', 'groups'], queryFn: getGroups });
  const [rows, setRows] = useState<GroupFullRow[]>([]);
  const [confirming, setConfirming] = useState<GroupFullRow | null>(null);
  const batch = useBatchAction([['admin', 'groups'], ['admin', 'forums']]);

  useEffect(() => {
    if (q.data) setRows(q.data.groups);
  }, [q.data]);

  const save = async () => {
    if (await batch.run([() => putGroups(rows.map(toItem))], t('group_saved'))) await refresh();
  };

  const remove = async (r: GroupFullRow) => {
    if (await batch.run([() => deleteGroup(r.gid)], t('group_deleted', '已删除用户组「{name}」', { name: r.name }))) await refresh();
    setConfirming(null);
  };

  const columns: GridColumn<GroupFullRow>[] = [
    { key: 'gid', title: t('group_id', '用户组ID'), placeholder: t('group_id', '用户组ID'), inputType: 'number', width: 'w-[100px]' },
    { key: 'name', title: t('group_name', '用户组名'), placeholder: t('group_name', '用户组名') },
    { key: 'creditsfrom', title: t('group_credits_from', '起始积分'), placeholder: t('group_credits_from', '起始积分'), inputType: 'number', width: 'w-[130px]' },
    { key: 'creditsto', title: t('group_credits_to', '结束积分'), placeholder: t('group_credits_to', '结束积分'), inputType: 'number', width: 'w-[130px]' },
  ];

  if (q.isError) return <ErrorState error={q.error} />;

  return (
    <div className="space-y-3">
      <PageTitle>{t('group_list', '用户组列表')}</PageTitle>
      <TabBar active="group" items={USER_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {batch.flash && <Alert tone={batch.flash.tone}>{batch.flash.text}</Alert>}
      {!q.isPending && rows.length === 0 && <Card>{t('group_empty_data')}</Card>}

      <InlineEditGrid
        columns={columns}
        rows={rows}
        rowId={(r) => r.gid}
        systemIds={SYSTEM_GIDS}
        blank={() => BLANK_GROUP(Math.max(0, ...rows.map((r) => r.gid)) + 1)}
        onChange={setRows}
        onSubmit={save}
        submitting={batch.pending}
        submitText={t('confirm', '确定')}
        addText={t('add_new_line', '增加一行')}
        editLabel={t('edit', '编辑')}
        deleteLabel={t('delete', '删除')}
        tip={t('group_edit_tips', '请谨慎编辑用户组，一旦确定后不要轻易变动，否则可能会导致用户关联错误，一般在正式运营时就不要再变动。')}
        onEdit={(r) => navigate(`/admin/groups/${r.gid}/edit`)}
        onDelete={setConfirming}
      />

      <ConfirmModal
        open={confirming !== null}
        loading={batch.pending}
        text={t('group_delete_confirm', '删除用户组「{name}」会同时清掉各版块对该组的读写限制记录；组内用户的 gid 不会自动回退（服务端同此），删除后这些人将落到不存在的组。确定删除？', { name: confirming?.name ?? '' })}
        onConfirm={() => void remove(confirming!)}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
