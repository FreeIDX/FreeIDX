/**
 * 加V认证后台：四档展开为四个子路由同页切换。
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fmtDate } from '../../lib/api';
import { apiErrorMessage } from '../../lib/errors';
import { getVApplies, getVSetting, getVUser, passV, putVSetting, rejectV, setVUser } from '../api';
import type { AdminVApplyRow, AdminVUser, VFeeSetting } from '../types';
import { useAdminT } from '../t';
import type { Flash } from '../use-action';
import { useAdminAction } from '../use-action';
import { V_TABS } from '../tabs';
import {
  Alert,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  PageTitle,
  QueuePager,
  Select,
  SubmitRow,
  TabBar,
  Table,
  usePage,
} from '../ui';

function useActiveTab(): string {
  const { pathname } = useLocation();
  const hit = V_TABS.find((x) => x.to !== '/admin/v' && pathname.startsWith(x.to));
  return hit?.k ?? 'applying';
}

function VTabs() {
  const t = useAdminT();
  const active = useActiveTab();
  return <TabBar active={active} items={V_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />;
}

/** 证明图片缩略：缩略图 + 点击新窗口放大 */
function ProofFile({ file }: { file: string }) {
  const t = useAdminT();
  if (!file) return <span className="text-muted">—</span>;
  return (
    <a href={file} target="_blank" rel="noreferrer" title={t('v_proof_zoom', '点击放大（新窗口打开）')}>
      <img src={file} alt={t('v_file_label', '证明图片')} className="max-h-[64px] max-w-[120px] rounded-[4px] border border-line-soft object-contain" />
    </a>
  );
}

/* ---------------- 审核两列表（GET status=0/1 两列） ---------------- */

function ApplyQueue({ status }: { status: 0 | 1 }) {
  const t = useAdminT();
  const page = usePage();
  const path = status === 0 ? '/admin/v' : '/admin/v/passed';
  const listKey = ['admin', 'v', 'applies', status] as const;
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: [...listKey, page],
    queryFn: () => getVApplies({ status, page }),
  });
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busyId, setBusyId] = useState(0);
  const rows: AdminVApplyRow[] = q.data?.list ?? [];

  /** 行级动作：成功失效当前列表缓存就地刷新 */
  const run = async (uid: number, fn: () => Promise<unknown>, okText: string) => {
    setBusyId(uid);
    setFlash(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: listKey });
      setFlash({ tone: 'ok', text: okText });
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    } finally {
      setBusyId(0);
    }
  };
  /* 通过（无确认框：user.v=申请头衔 + status=1，系统通知由服务端发） */
  const pass = (uid: number) => void run(uid, () => passV(uid), t('v_pass_ok', '加V认证成功'));
  /* 拒绝（本项目增强：remark 经 window.prompt 输入，取消即不操作） */
  const reject = (uid: number) => {
    const remark = window.prompt(t('v_confirm_reject', '拒绝备注（可留空）：'));
    if (remark === null) return;
    void run(uid, () => rejectV(uid, remark.trim()), t('v_reject_ok', '已拒绝'));
  };

  return (
    <div className="space-y-3">
      {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
      {q.isError && <ErrorState error={q.error} />}
      <Card title={status === 0 ? t('idx_verify_applying', '待审核') : t('idx_verify_passed', '已通过')} noPadding>
        <Table
          head={['uid', t('username', '用户名'), t('v_title_label', '认证头衔'), t('v_info_label', '证明信息'), t('v_file_label', '证明图片'), t('v_apply_time', '申请时间'), t('v_remark', '备注'), ...(status === 0 ? [t('operation', '操作')] : [])]}
          minWidth="min-w-[1000px]"
        >
          {rows.map((r) => (
            <tr key={r.uid}>
              <td className="tabular-nums">{r.uid}</td>
              <td>{r.username || '—'}</td>
              <td>{r.v}</td>
              <td className="max-w-[280px] whitespace-pre-wrap break-words text-muted-2">{r.vInfo}</td>
              <td>
                <ProofFile file={r.vFile} />
              </td>
              <td className="whitespace-nowrap">{fmtDate(r.createTime)}</td>
              <td className="max-w-[180px] break-words text-muted-2">{r.remark || '—'}</td>
              {status === 0 && (
                <td>
                  <div className="flex flex-wrap gap-1.5">
                    <Button size="sm" variant="default" disabled={busyId === r.uid} onClick={() => pass(r.uid)}>
                      {t('audit_pass', '通过')}
                    </Button>
                    <Button size="sm" variant="default" disabled={busyId === r.uid} onClick={() => reject(r.uid)}>
                      {t('audit_reject', '拒绝')}
                    </Button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </Table>
        {rows.length === 0 && !q.isFetching && (
          <p className="py-6 text-center text-sm text-muted">{status === 0 ? t('v_no_applying', '没有待审核的申请。') : t('v_no_passed', '没有已通过的申请。')}</p>
        )}
      </Card>
      <QueuePager page={page} totalPage={q.data?.totalPage ?? 1} path={path} />
    </div>
  );
}

/* ---------------- 手动加V（op=0 查询 / op=1 设置 1:1） ---------------- */

function ManualVTab() {
  const t = useAdminT();
  const [username, setUsername] = useState('');
  const [title, setTitle] = useState('');
  const [found, setFound] = useState<AdminVUser | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [querying, setQuerying] = useState(false);
  const [saving, setSaving] = useState(false);

  /* 查询（op=0）：命中后把当前头衔回填进认证信息框 */
  const inquire = async () => {
    const name = username.trim();
    if (!name) {
      setFlash({ tone: 'warn', text: t('v_input_username', '请输入用户名') });
      return;
    }
    setQuerying(true);
    setFlash(null);
    try {
      const u = await getVUser(name);
      setFound(u);
      setTitle(u.v === '0' ? '' : u.v);
      setFlash({ tone: 'ok', text: u.v === '0' ? t('v_user_not_certified', '该用户当前未认证') : t('v_current_title_value', '当前认证头衔：{title}', { title: u.v }) });
    } catch (e) {
      setFound(null);
      setTitle('');
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    } finally {
      setQuerying(false);
    }
  };

  /* 保存（op=1）：认证信息留空按 '0' 提交 = 取消认证（服务端同口径） */
  const submit = async () => {
    const name = username.trim();
    if (!name) {
      setFlash({ tone: 'warn', text: t('v_input_username', '请输入用户名') });
      return;
    }
    setSaving(true);
    setFlash(null);
    try {
      await setVUser({ username: name, v: title.trim() || '0' });
      setFlash({ tone: 'ok', text: t('v_setting_ok', '设置成功！') });
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}
      <Card title={t('idx_verify_user', '手动加V')}>
        <p className="mb-4 text-sm text-muted-2">{t('v_manual_hint', '认证信息填写 0，即取消这个用户的加V认证。')}</p>
        <Field label={t('username', '用户名')} htmlFor="v-username">
          <Input id="v-username" value={username} onChange={(e) => setUsername(e.target.value)} className="w-[280px]" />
        </Field>
        {found && (
          <Field label={t('v_current_title', '当前认证头衔')}>
            <span className="text-ink-soft">{found.v === '0' ? t('v_not_certified', '（未认证）') : found.v}</span>
          </Field>
        )}
        <Field label={t('v_cert_info', '认证信息')} htmlFor="v-title">
          <Input id="v-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} className="w-[420px] max-w-full" />
        </Field>
        <SubmitRow>
          <div className="flex gap-2">
            <Button loading={saving} onClick={() => void submit()}>
              {t('confirm', '确定')}
            </Button>
            <Button variant="default" loading={querying} onClick={() => void inquire()}>
              {t('v_inquire_btn', '查询')}
            </Button>
          </div>
        </SubmitRow>
      </Card>
    </div>
  );
}

/* ---------------- 收费设置（op=2 1:1） ---------------- */

function FeeSettingTab() {
  const t = useAdminT();
  const q = useQuery({ queryKey: ['admin', 'v', 'setting'], queryFn: getVSetting });
  const [type, setType] = useState<VFeeSetting['type']>('golds');
  const [count, setCount] = useState('0');

  useEffect(() => {
    if (!q.data) return;
    setType(q.data.type);
    setCount(String(q.data.count));
  }, [q.data]);

  const save = useAdminAction(() => putVSetting({ type, count: Number(count) || 0 }), {
    ok: t('v_setting_ok', '设置成功！'),
    invalidate: [['admin', 'v', 'setting']],
  });

  return (
    <div className="space-y-3">
      {save.flash && <Alert tone={save.flash.tone}>{save.flash.text}</Alert>}
      {q.isError && <ErrorState error={q.error} />}
      <Card>
        <h4 className="mb-3 text-[1.1rem] font-normal leading-[1.2]">{t('idx_verify_setting', '收费设置')}</h4>
        {q.isLoading ? (
          <p className="py-6 text-center text-sm text-muted">{t('loading')}</p>
        ) : (
          <>
            <Field label={t('v_fee_type', '消耗积分类型')}>
              <Select value={type} onChange={(e) => setType(e.target.value as VFeeSetting['type'])} className="w-[200px]">
                <option value="credits">{t('v_fee_credits', 'credits · 积分')}</option>
                <option value="golds">{t('v_fee_golds', 'golds · 金币')}</option>
                <option value="rmbs">{t('v_fee_rmbs', 'rmbs · 人民币')}</option>
              </Select>
            </Field>
            <Field label={t('v_fee_count', '消耗积分数量')} hint={t('v_fee_count_hint', '单次申请加V认证消耗的数量；如不需要消耗积分请设置为 0')}>
              <Input type="number" min={0} step={1} value={count} onChange={(e) => setCount(e.target.value)} className="w-[200px]" />
            </Field>
            <SubmitRow>
              <Button loading={save.pending} onClick={() => save.mutate()}>
                {t('submit', '提交')}
              </Button>
            </SubmitRow>
          </>
        )}
      </Card>
    </div>
  );
}

/* ---------------- 页面 ---------------- */

export function AdminVPage() {
  const t = useAdminT();
  const active = useActiveTab();
  return (
    <div className="space-y-3">
      <PageTitle>{V_TABS.find((x) => x.k === active)?.fallback ?? t('v_verify_label', '加V认证')}</PageTitle>
      <VTabs />
      {active === 'passed' ? (
        <ApplyQueue status={1} />
      ) : active === 'user' ? (
        <ManualVTab />
      ) : active === 'setting' ? (
        <FeeSettingTab />
      ) : (
        <ApplyQueue status={0} />
      )}
    </div>
  );
}
