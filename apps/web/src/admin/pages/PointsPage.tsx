/**
 * 积分管理页（本项目新增）：设置 / 用户积分 / 流水三档，按子路径切换（/admin/points[/users|/logs]）。
 *  - 积分设置：credit_thread / credit_reply / credit_daily_first 三键（PUT /api/admin/setting 白名单合并，
 *    只提交这三键，其余键服务端原样保留），grantForPost 在发帖/回帖时消费；
 *  - 用户积分：台账（uid/username 精确搜索）+ 手工 ±——走 applyPointChange（reason='admin'），余额与流水同批事务；
 *  - 积分流水：全站积分账本（发帖/回帖/每日首帖/附件买卖/会员订单/管理员调整），可按 uid、reason 过滤。
 * 表头列名用中文字面量（新增页约定，与「用户列表」等页的处理一致）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { adjustPoint, getGroups, getPointLogs, getPointUsers, getRegisterCredits, getSetting, putRegisterCredits, putSetting } from '../api';
import { uiLocale } from '../../lib/api';
import type { AdminUserRow } from '../types';
import { useAdminT } from '../t';
import { useGroupName } from '../../lib/i18n';
import { useAdminAction } from '../use-action';
import { POINT_TABS } from '../tabs';
import { PageTitle, TabBar, Card, Table, Badge, Button, Input, Select, Field, Alert, ErrorState } from '../ui';
import { BalanceCard, PaylogCard, RankCard, RulesCard, SellGroupsCard, ToolsCard } from './points-extra';

const PAGE_SIZE = 20;

const fmtDate = (ts: number) => (ts > 0 ? new Date(ts * 1000).toLocaleString(uiLocale(), { hour12: false }) : '—');
const fmtChange = (n: number) => (n > 0 ? `+${n}` : String(n));

/** point_log.reason 是存库枚举，无 lang 键，直接给中文映射。
 *  与实际写入点对齐（批次 3E）：补 v_apply/checkin；移除幽灵枚举 exchange（兑换只动 golds/rmbs 不写 point_log） */
const REASON_KEYS = [
  'thread', 'reply', 'daily_first', 'attach_purchase', 'attach_income',
  'order', 'admin', 'register', 'thread_purchase', 'thread_income',
  'transfer_out', 'transfer_in', 'digest', 'checkin', 'v_apply',
] as const;
const asInt = (v: string): number | null => (/^-?\d+$/.test(v.trim()) ? Number(v.trim()) : null);

/** setSearchParams 的对象写法不接受 undefined（RR v7 类型收紧），统一走 URLSearchParams 增删 */
function useSetQuery(): [URLSearchParams, (patch: Record<string, string | undefined>) => void] {
  const [sp, setSp] = useSearchParams();
  const set = (patch: Record<string, string | undefined>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '') next.delete(k);
      else next.set(k, v);
    }
    setSp(next);
  };
  return [sp, set];
}

function useActiveTab(): 'setting' | 'users' | 'log' {
  const { pathname } = useLocation();
  if (pathname.startsWith('/admin/points/users')) return 'users';
  if (pathname.startsWith('/admin/points/logs')) return 'log';
  return 'setting';
}

function PointsTabs() {
  const t = useAdminT();
  const active = useActiveTab();
  return <TabBar active={active} items={POINT_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />;
}

/* ---------------- 积分设置 ---------------- */

function SettingTab() {
  const t = useAdminT();
  // queryKey 与 SettingPage/NavBarSettingPage 统一为 ['admin','setting']：
  // 三页读的是同一份 /api/admin/setting，键不一致会形成互不失效的双缓存（改完再进另一页读到旧值）。
  const q = useQuery({ queryKey: ['admin', 'setting'], queryFn: getSetting });
  const [thread, setThread] = useState('');
  const [reply, setReply] = useState('');
  const [daily, setDaily] = useState('');

  useEffect(() => {
    if (!q.data) return;
    const s = q.data as Record<string, unknown>;
    setThread(String(Number(s.credit_thread ?? 0)));
    setReply(String(Number(s.credit_reply ?? 0)));
    setDaily(String(Number(s.credit_daily_first ?? 0)));
  }, [q.data]);

  const save = useAdminAction(
    () =>
      putSetting({
        credit_thread: Number(thread),
        credit_reply: Number(reply),
        credit_daily_first: Number(daily),
      }),
    { ok: t('point_saved_tip', '已保存，下一次发帖/回帖即按新值发放'), invalidate: [['admin', 'setting']] },
  );

  const submit = () => {
    for (const [key, v] of [['point_reward_thread', thread], ['point_reward_reply', reply], ['point_reward_daily', daily]] as const) {
      const n = asInt(v);
      if (n === null || n < 0) {
        save.setFlash({ tone: 'warn', text: t('point_reward_invalid', '{label}需为非负整数', { label: t(key) }) });
        return;
      }
    }
    save.mutate();
  };

  return (
    <div className="space-y-3">
      {q.isError && <ErrorState error={q.error} />}
      {save.flash && <Alert tone={save.flash.tone}>{save.flash.text}</Alert>}
      <Card title={t('point_reward_card', '奖励发放')}>
        {q.isLoading ? (
          <p className="py-6 text-center text-sm text-muted">{t('loading')}</p>
        ) : (
          <>
            <Field label={t('point_reward_thread', '发帖奖励')} hint={t('point_reward_thread_hint', '每发布一个主题发放的积分，0 = 关闭')}>
              <Input type="number" min={0} value={thread} onChange={(e) => setThread(e.target.value)} className="w-[160px]" />
            </Field>
            <Field label={t('point_reward_reply', '回帖奖励')} hint={t('point_reward_reply_hint', '每发布一个回复发放的积分，0 = 关闭')}>
              <Input type="number" min={0} value={reply} onChange={(e) => setReply(e.target.value)} className="w-[160px]" />
            </Field>
            <Field label={t('point_reward_daily', '每日首帖奖励')} hint={t('point_reward_daily_hint', '每天第一个主题额外发放的积分，0 = 关闭')}>
              <Input type="number" min={0} value={daily} onChange={(e) => setDaily(e.target.value)} className="w-[160px]" />
            </Field>
            <div className="mt-3">
              <Button onClick={submit} loading={save.pending}>
                {t('point_save_setting', '保存设置')}
              </Button>
            </div>
          </>
        )}
      </Card>
      <RegisterCreditsCard />
      <RulesCard />
      <SellGroupsCard />
    </div>
  );
}

/** 注册默认积分（新用户注册即发放 经验/金币/人民币 三项初始值） */
function RegisterCreditsCard() {
  const t = useAdminT();
  const q = useQuery({ queryKey: ['register-credits'], queryFn: getRegisterCredits });
  const [credits, setCredits] = useState('');
  const [golds, setGolds] = useState('');
  const [rmbs, setRmbs] = useState('');

  useEffect(() => {
    if (!q.data) return;
    setCredits(String(q.data.credits));
    setGolds(String(q.data.golds));
    setRmbs(String(q.data.rmbs));
  }, [q.data]);

  const save = useAdminAction(() => putRegisterCredits({ credits: Number(credits), golds: Number(golds), rmbs: Number(rmbs) }), {
    ok: t('point_register_saved_tip', '已保存，新用户注册即按此发放'),
    invalidate: [['register-credits']],
  });

  const submit = () => {
    for (const [key, v] of [['credits_experience', credits], ['credits_gold', golds], ['point_register_rmbs_label', rmbs]] as const) {
      const n = asInt(v);
      if (n === null || n < 0) {
        save.setFlash({ tone: 'warn', text: t('point_reward_invalid', '{label}需为非负整数', { label: t(key) }) });
        return;
      }
    }
    save.mutate();
  };

  return (
    <Card title={t('point_register_card', '注册默认积分')}>
      {q.isError && <ErrorState error={q.error} />}
      {save.flash && <Alert tone={save.flash.tone}>{save.flash.text}</Alert>}
      {q.isLoading ? (
        <p className="py-6 text-center text-sm text-muted">{t('loading')}</p>
      ) : (
        <>
          <Field label={t('credits_experience', '经验')} hint={t('point_register_credits_hint', '新用户注册即发放的经验值')}>
            <Input type="number" min={0} value={credits} onChange={(e) => setCredits(e.target.value)} className="w-[160px]" />
          </Field>
          <Field label={t('credits_gold', '金币')} hint={t('point_register_golds_hint', '新用户注册即发放的金币数')}>
            <Input type="number" min={0} value={golds} onChange={(e) => setGolds(e.target.value)} className="w-[160px]" />
          </Field>
          <Field label={t('point_register_rmbs_unit', '人民币(单位:分)')} hint={t('point_register_rmbs_hint', '新用户注册即发放的人民币（分），100 = ¥1')}>
            <Input type="number" min={0} value={rmbs} onChange={(e) => setRmbs(e.target.value)} className="w-[160px]" />
          </Field>
          <div className="mt-3">
            <Button onClick={submit} loading={save.pending}>
              {t('point_save_setting', '保存设置')}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

/* ---------------- 用户积分 ---------------- */

function UsersTab() {
  const t = useAdminT();
  const gn = useGroupName();
  const [sp, setQ] = useSetQuery();
  const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);
  const type = sp.get('type') === 'uid' ? 'uid' : 'username';
  const keyword = sp.get('keyword') ?? '';
  const [searchType, setSearchType] = useState(type);
  const [searchKw, setSearchKw] = useState(keyword);

  const q = useQuery({
    queryKey: ['point-users', type, keyword, page],
    queryFn: () => getPointUsers({ type, keyword, page, size: PAGE_SIZE }),
  });
  const gq = useQuery({ queryKey: ['point-user-groups'], queryFn: getGroups });
  const groupName = (gid: number) => {
    const g = gq.data?.groups.find((x) => x.gid === gid);
    return g ? gn(g.gid, g.name) : String(gid);
  };

  const [target, setTarget] = useState<AdminUserRow | null>(null);
  const [amount, setAmount] = useState('');
  const adjust = useAdminAction(
    () => adjustPoint(target!.uid, Number(amount)),
    {
      ok: (d) => t('point_adjust_ok', '已调整「{name}」，当前余额 {credits}', { name: target?.username ?? target?.uid ?? '', credits: d.credits }),
      invalidate: [['point-users'], ['point-logs']],
    },
  );

  const submitAdjust = () => {
    if (!target) return;
    const n = asInt(amount);
    if (n === null || n === 0) {
      adjust.setFlash({ tone: 'warn', text: t('point_adjust_invalid', '变动值需为非零整数') });
      return;
    }
    adjust.mutate();
  };

  const search = () => setQ({ type: searchType, keyword: searchKw, page: '1' });
  const rows = q.data?.list ?? [];
  const totalPage = q.data?.totalPage ?? 1;

  return (
    <div className="space-y-3">
      {q.isError && <ErrorState error={q.error} />}
      {adjust.flash && <Alert tone={adjust.flash.tone}>{adjust.flash.text}</Alert>}

      {target && (
        <Card title={t('point_adjust_card', '调整积分 — {username}（UID {uid}，当前 {credits}）', { username: target.username ?? '', uid: target.uid, credits: target.credits })}>
          <Field label={t('point_adjust_amount_label', '变动值')} hint={t('point_adjust_amount_hint', '正数 = 增加积分，负数 = 扣减积分；将记一条「管理员调整」流水')}>
            <Input
              type="number"
              value={amount}
              placeholder={t('point_adjust_placeholder', '如 +100 或 -50')}
              onChange={(e) => setAmount(e.target.value)}
              className="w-[160px]"
            />
          </Field>
          <div className="mt-3 flex gap-2">
            <Button onClick={submitAdjust} loading={adjust.pending}>
              {t('point_adjust_confirm', '确认调整')}
            </Button>
            <Button variant="default" onClick={() => { setTarget(null); setAmount(''); }}>
              {t('cancel', '取消')}
            </Button>
          </div>
        </Card>
      )}

      <Card title={t('admin_credit_users', '用户积分')}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Select value={searchType} onChange={(e) => setSearchType(e.target.value)} className="w-[120px]">
            <option value="username">{t('username', '用户名')}</option>
            <option value="uid">UID</option>
          </Select>
          <Input
            value={searchKw}
            placeholder={searchType === 'uid' ? t('point_search_uid', '按 UID 精确查询') : t('point_search_username', '按用户名精确查询')}
            className="w-[200px]"
            onChange={(e) => setSearchKw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
          />
          <Button onClick={search}>{t('search', '搜索')}</Button>
        </div>
        <Table head={[t('admin_group_id', 'ID'), t('username', '用户名'), t('user_group', '用户组'), t('thread', '主题'), t('reply', '回复'), t('credits_label', '积分'), t('operation', '操作')]} minWidth="min-w-[760px]">
          {rows.map((r) => (
            <tr key={r.uid}>
              <td className="tabular-nums">{r.uid}</td>
              <td>{r.username}</td>
              <td>{groupName(r.gid)}</td>
              <td className="tabular-nums">{r.threads}</td>
              <td className="tabular-nums">{r.posts}</td>
              <td className="tabular-nums">{r.credits}</td>
              <td className="whitespace-nowrap">
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => { setTarget(r); setAmount(''); }}
                >
                  {t('point_adjust_btn', '调整')}
                </Button>
              </td>
            </tr>
          ))}
        </Table>
        {rows.length === 0 && !q.isFetching && <p className="py-6 text-center text-sm text-muted">{t('point_no_match_users', '没有符合条件的用户。')}</p>}
        {totalPage > 1 && (
          <div className="mt-3 flex justify-end">
            <Pagination page={page} totalPage={totalPage} toPage={(p) => setQ({ type, keyword: keyword || undefined, page: String(p) })} />
          </div>
        )}
      </Card>
      <BalanceCard />
      <ToolsCard />
    </div>
  );
}

/* ---------------- 积分流水 ---------------- */

function Pagination({ page, totalPage, toPage }: { page: number; totalPage: number; toPage: (p: number) => void }) {
  const t = useAdminT();
  const btn = (p: number, text: string, disabled = false) => (
    <Button key={`${text}-${p}`} size="sm" variant="default" disabled={disabled} onClick={() => toPage(p)}>
      {text}
    </Button>
  );
  const parts: ReactNode[] = [];
  parts.push(btn(page - 1, t('last_page', '上一页'), page <= 1));
  parts.push(btn(page, `${page} / ${totalPage}`, true));
  parts.push(btn(page + 1, t('next_page', '下一页'), page >= totalPage));
  return <div className="flex gap-1">{parts}</div>;
}

function LogsTab() {
  const t = useAdminT();
  const [sp, setQ] = useSetQuery();
  const page = Math.max(1, Number(sp.get('page') ?? 1) || 1);
  const fUid = sp.get('uid') ?? '';
  const fReason = sp.get('reason') ?? '';
  const [uidInput, setUidInput] = useState(fUid);
  const [reasonInput, setReasonInput] = useState(fReason);

  const q = useQuery({
    queryKey: ['point-logs', fUid, fReason, page],
    queryFn: () => getPointLogs({ uid: Number(fUid) || undefined, reason: fReason || undefined, page, size: PAGE_SIZE }),
  });
  const rows = q.data?.list ?? [];
  const totalPage = q.data?.totalPage ?? 1;

  const reasonLabel = (reason: string): string => {
    switch (reason) {
      case 'thread': return t('create_thread', '发帖');
      case 'reply': return t('reply_btn', '回帖');
      case 'daily_first': return t('point_reason_daily_first', '每日首帖');
      case 'attach_purchase': return t('point_reason_attach_purchase', '购买附件');
      case 'attach_income': return t('point_reason_attach_income', '附件收益');
      case 'order': return t('point_reason_order', '会员订单');
      case 'admin': return t('point_reason_admin', '管理员调整');
      case 'register': return t('point_reason_register', '注册赠送');
      case 'thread_purchase': return t('point_reason_thread_purchase', '购买主题');
      case 'thread_income': return t('point_reason_thread_income', '主题收益');
      case 'transfer_out': return t('point_reason_transfer_out', '转出');
      case 'transfer_in': return t('point_reason_transfer_in', '转入');
      case 'digest': return t('digest_label', '精华');
      case 'checkin': return t('point_reason_checkin', '每日签到');
      case 'v_apply': return t('point_reason_v_apply', '加V申请');
      default: return reason;
    }
  };

  const search = () =>
    setQ({ uid: uidInput.trim() || undefined, reason: reasonInput || undefined, page: '1' });

  return (
    <div className="space-y-3">
      {q.isError && <ErrorState error={q.error} />}
      <Card title={t('admin_credit_logs', '积分流水')}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input
            value={uidInput}
            placeholder={t('point_log_filter_uid', '按 UID 过滤')}
            className="w-[140px]"
            onChange={(e) => setUidInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
          />
          <Select value={reasonInput} onChange={(e) => setReasonInput(e.target.value)} className="w-[140px]">
            <option value="">{t('point_log_all_source', '全部来源')}</option>
            {REASON_KEYS.map((k) => (
              <option key={k} value={k}>
                {reasonLabel(k)}
              </option>
            ))}
          </Select>
          <Button onClick={search}>{t('point_filter_btn', '筛选')}</Button>
        </div>
        <Table head={[t('point_log_no', '流水号'), t('time_label', '时间'), 'UID', t('username', '用户名'), t('point_log_change', '变动'), t('point_log_balance', '变动后余额'), t('point_log_source', '来源')]} minWidth="min-w-[820px]">
          {rows.map((r) => (
            <tr key={r.logid}>
              <td className="tabular-nums">{r.logid}</td>
              <td className="whitespace-nowrap">{fmtDate(r.create_date)}</td>
              <td className="tabular-nums">{r.uid}</td>
              <td>{r.username ?? '—'}</td>
              <td>
                <Badge tone={r.change > 0 ? 'success' : 'secondary'}>{fmtChange(r.change)}</Badge>
              </td>
              <td className="tabular-nums">{r.balance}</td>
              <td>{reasonLabel(r.reason)}</td>
            </tr>
          ))}
        </Table>
        {rows.length === 0 && !q.isFetching && <p className="py-6 text-center text-sm text-muted">{t('point_no_match_logs', '没有符合条件的流水。')}</p>}
        {totalPage > 1 && (
          <div className="mt-3 flex justify-end">
            <Pagination
              page={page}
              totalPage={totalPage}
              toPage={(p) => setQ({ uid: fUid || undefined, reason: fReason || undefined, page: String(p) })}
            />
          </div>
        )}
      </Card>
      <PaylogCard />
      <RankCard />
    </div>
  );
}

export function PointsPage() {
  const t = useAdminT();
  const active = useActiveTab();
  return (
    <div className="space-y-3">
      <PageTitle>{POINT_TABS.find((x) => x.k === active)?.fallback ?? t('credits_label', '积分')}</PageTitle>
      <PointsTabs />
      {active === 'users' ? <UsersTab /> : active === 'log' ? <LogsTab /> : <SettingTab />}
    </div>
  );
}
