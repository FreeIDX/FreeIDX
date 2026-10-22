/**
 * 消息管理页（消息列表 + 发送系统通知）：两档按子路径切换。
 *  - 消息列表（/admin/notices）：全站消息 nid 倒序 + 页码分页，行内删除（ConfirmModal + 失效重取，
 *    同「用户列表」的处理）；
 *  - 发送系统通知（/admin/notices/send）：用户ID + 内容 表单，发送 type=3 系统消息（fromuid=当前管理员，服务端取 admin_at）。
 * 表头列名用中文字面量（与「用户列表」等页一致）。
 */
import { useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { deleteAdminNotice, getAdminNotices, sendNotice, toggleNoticeAnnouncement } from '../api';
import type { AdminNoticeRow } from '../types';
import { useAdminT, type AdminT } from '../t';
import { useBatchAction } from '../use-action';
import { NOTICE_TABS } from '../tabs';
import { fmtDate } from '../../lib/api';
import { Avatar } from '../../components/Avatar';
import {
  AdminPagination,
  Alert,
  Badge,
  Button,
  Card,
  ConfirmModal,
  ErrorState,
  Field,
  Input,
  PageTitle,
  Switch,
  TabBar,
  Table,
  Textarea,
} from '../ui';

const PAGE_SIZE = 20;

/** type 存库枚举（2 评论 / 3 系统 / 99 其他） */
function noticeTypeText(t: AdminT, type: number): string {
  if (type === 2) return t('notice_type_comment', '评论');
  if (type === 3) return t('notice_type_system', '系统');
  return t('notice_type_other', '其他');
}

function useActiveTab(): 'list' | 'post' {
  const { pathname } = useLocation();
  return pathname.startsWith('/admin/notices/send') ? 'post' : 'list';
}

/* ---------------- 消息列表 ---------------- */

function ListTab() {
  const t = useAdminT();
  const [sp] = useSearchParams();
  const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);
  const q = useQuery({
    queryKey: ['admin', 'notices', { page }],
    queryFn: () => getAdminNotices({ page, size: PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  const qc = useQueryClient();

  const del = useBatchAction([['admin', 'notices']]);
  const [target, setTarget] = useState<AdminNoticeRow | null>(null);

  const confirmDelete = async () => {
    if (!target) return;
    const ok = await del.run([() => deleteAdminNotice(target.nid)], t('notice_delete_success', '消息删除成功'));
    if (ok) setTarget(null);
  };

  /** 公告显示开关（0011）：乐观更新本页行，失败回滚由重取兜底 */
  const [toggling, setToggling] = useState(0);
  const toggleAnn = async (r: AdminNoticeRow) => {
    if (!r.ann_aid || toggling) return;
    setToggling(r.nid);
    try {
      await toggleNoticeAnnouncement(r.nid, r.ann_isshow === 1 ? 0 : 1);
      await qc.invalidateQueries({ queryKey: ['admin', 'notices'] });
    } finally {
      setToggling(0);
    }
  };

  const rows = q.data?.list ?? [];
  const href = (p: number) => (p > 1 ? `/admin/notices?page=${p}` : '/admin/notices');
  const userName = (name: string | null, uid: number) => name ?? String(uid);

  return (
    <>
      {q.isError && <ErrorState error={q.error} />}
      {del.flash && <Alert tone={del.flash.tone}>{del.flash.text}</Alert>}

      <Card title={t('notice_all_messages', '全站消息')} noPadding>
        <Table head={['ID', t('notice_col_sender', '发送者'), t('notice_col_receiver', '接收者'), t('notice_col_type', '类型'), t('notice_col_status', '状态'), t('notice_col_announcement', '首页公告'), t('notice_col_content', '内容'), t('notice_col_time', '时间'), t('operation', '操作')]} minWidth="min-w-[1040px]">
          {rows.map((r) => (
            <tr key={r.nid}>
              <td className="tabular-nums">{r.nid}</td>
              <td className="whitespace-nowrap">
                <span className="flex items-center gap-1.5">
                  <Avatar uid={r.fromuid} avatar={Number(r.from_avatar ?? 0)} username={r.from_username ?? ''} size={1} />
                  {userName(r.from_username, r.fromuid)}
                </span>
              </td>
              <td className="whitespace-nowrap">
                <span className="flex items-center gap-1.5">
                  <Avatar uid={r.recvuid} avatar={Number(r.recv_avatar ?? 0)} username={r.recv_username ?? ''} size={1} />
                  {userName(r.recv_username, r.recvuid)}
                </span>
              </td>
              <td>{noticeTypeText(t, r.type)}</td>
              <td>
                <Badge tone={r.isread ? 'secondary' : 'danger'}>{r.isread ? t('notice_read', '已读') : t('notice_unread', '未读')}</Badge>
              </td>
              <td className="whitespace-nowrap">
                {r.ann_aid ? (
                  <Switch
                    checked={r.ann_isshow === 1}
                    disabled={toggling === r.nid}
                    onChange={() => void toggleAnn(r)}
                    title={t('notice_ann_switch_title', '是否在首页公告条显示')}
                  />
                ) : (
                  <span className="text-muted">—</span>
                )}
              </td>
              <td className="max-w-[320px] text-muted">
                <div className="break-all [&_a]:text-brand [&_a:hover]:underline" dangerouslySetInnerHTML={{ __html: r.message }} />
              </td>
              <td className="whitespace-nowrap text-xs text-muted">{fmtDate(r.create_date)}</td>
              <td className="whitespace-nowrap">
                <Button size="sm" variant="default" onClick={() => setTarget(r)}>
                  {t('delete', '删除')}
                </Button>
              </td>
            </tr>
          ))}
        </Table>
        {rows.length === 0 && !q.isFetching && <p className="py-6 text-center text-sm text-muted">{t('notice_empty', '暂无消息。')}</p>}
        {q.data && <AdminPagination page={q.data.page} totalPage={q.data.totalPage} href={href} />}
      </Card>

      <ConfirmModal
        open={Boolean(target)}
        text={t('notice_delete_confirm', '确定删除消息 #{nid}？', { nid: target?.nid ?? '' })}
        loading={del.pending}
        onCancel={() => setTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </>
  );
}

/* ---------------- 发送系统通知 ---------------- */

function SendTab() {
  const t = useAdminT();
  const [recvuid, setRecvuid] = useState('');
  const [message, setMessage] = useState('');
  /* 首页公告开关（0011）：开 → 消息同时显示在首页公告条（多条轮播） */
  const [announcement, setAnnouncement] = useState(false);
  const send = useBatchAction([['admin', 'notices']]);

  const submit = async () => {
    const uid = recvuid.trim();
    if (!/^\d+$/.test(uid) || Number(uid) <= 0) {
      send.setFlash({ tone: 'warn', text: t('notice_recvuid_empty', '接收人不能为空') });
      return;
    }
    if (!message.trim()) {
      send.setFlash({ tone: 'warn', text: t('notice_content_empty', '内容不能为空') });
      return;
    }
    const ok = await send.run(
      [() => sendNotice({ recvuid: Number(uid), message: message.trim(), announcement })],
      announcement ? t('notice_send_success_ann', '发送通知成功，已同步到首页公告') : t('notice_send_success', '发送通知成功'),
    );
    if (ok) {
      setRecvuid('');
      setMessage('');
      setAnnouncement(false);
    }
  };

  return (
    <div className="space-y-3">
      {send.flash && <Alert tone={send.flash.tone}>{send.flash.text}</Alert>}
      <Card title={t('notice_send_title', '发送系统通知')}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label={t('notice_col_content', '内容')} hint={t('notice_content_hint', '发送给单个用户的系统消息，支持纯文本')}>
            <Textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <Field label={t('notice_user_id', '用户ID')} hint={t('notice_uid_hint', '接收者的 UID，可在「用户管理」中查询')} controlClass="sm:w-4/12">
            <Input type="number" min={1} value={recvuid} onChange={(e) => setRecvuid(e.target.value)} />
          </Field>
          <Field label={t('notice_col_announcement', '首页公告')} hint={t('notice_ann_hint', '开启后本条内容同时显示在首页公告条；多条公告将轮播展示，可随时在「消息列表」中开关或随消息删除')}>
            <Switch checked={announcement} onChange={setAnnouncement} label={announcement ? t('notice_ann_show', '显示在首页公告条') : t('notice_ann_hide', '不在首页显示')} />
          </Field>
          <div className="mt-3">
            <Button type="submit" loading={send.pending} className="w-full sm:w-auto">
              {t('confirm', '确认')}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

export function NoticeAdminPage() {
  const t = useAdminT();
  const active = useActiveTab();
  return (
    <div className="space-y-3">
      <PageTitle>{t('notice_admin_notice_list', '消息列表')}</PageTitle>
      <TabBar active={active} items={NOTICE_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {active === 'post' ? <SendTab /> : <ListTab />}
    </div>
  );
}