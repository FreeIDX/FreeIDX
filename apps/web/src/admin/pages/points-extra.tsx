/**
 * 积分管理扩展卡片（批次 3B）：接入后端既有 10 个 admin/points 端点。
 *  - RulesCard     积分规则矩阵（6 动作 × 三币）+ 兑换参数（GET/PUT /api/admin/points/rules）
 *  - SellGroupsCard 可发收费帖用户组（GET/PUT /api/admin/points/groups）
 *  - BalanceCard   按用户名查/改三币余额（GET/PUT /api/admin/points/balance）
 *  - ToolsCard     模拟购买 + 强制重算等级组（POST simulate / upgrade）
 *  - PaylogCard    购买主题消费记录（GET /api/admin/points/paylog）
 *  - RankCard      三币排行（GET /api/admin/points/rank）
 * 卡片挂在 PointsPage 三个既有 Tab 下（设置/用户积分/流水），不新增路由。
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import {
  forceUpgradeGroup,
  getPointBalance,
  getPointPaylog,
  getPointRank,
  getPointRules,
  getPointSellGroups,
  putPointBalance,
  putPointRules,
  putPointSellGroups,
  simulatePurchase,

} from '../api';
import { useAdminT } from '../t';
import { useGroupName } from '../../lib/i18n';
import { useAdminAction } from '../use-action';
import { Alert, Badge, Button, Card, ErrorState, Field, Input, Select, Table, AdminPagination } from '../ui';

const asInt = (v: string): number | null => (/^-?\d+$/.test(v.trim()) ? Number(v.trim()) : null);
const fmtDate = (ts: number) => (ts > 0 ? new Date(ts * 1000).toLocaleString(undefined, { hour12: false }) : '—');

/* ---------------- 积分规则矩阵 ---------------- */

/** 6 动作 × 3 币 = 18 键（与后端 CREDIT_RULE_KEYS 一一对应） */
const RULE_ROWS = [
  { k: 'digest1', label: (t: ReturnType<typeof useAdminT>) => `${t('digest_label')} Lv.1` },
  { k: 'digest2', label: (t: ReturnType<typeof useAdminT>) => `${t('digest_label')} Lv.2` },
  { k: 'digest3', label: (t: ReturnType<typeof useAdminT>) => `${t('digest_label')} Lv.3` },
  { k: 'thread', label: (t: ReturnType<typeof useAdminT>) => t('point_reason_thread') },
  { k: 'post', label: (t: ReturnType<typeof useAdminT>) => t('reply_btn') },
  { k: 'down', label: (t: ReturnType<typeof useAdminT>) => t('download_dots').replace('· ', '') },
] as const;
const RULE_COLS = [
  { k: 'exp', label: 'credits_experience' },
  { k: 'gold', label: 'credits_gold' },
  { k: 'rmb', label: 'credits_rmb' },
] as const;

export function RulesCard() {
  const t = useAdminT();
  const q = useQuery({ queryKey: ['point-rules'], queryFn: getPointRules });
  const [vals, setVals] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!q.data) return;
    const next: Record<string, string> = {};
    for (const row of RULE_ROWS) for (const col of RULE_COLS) next[`${row.k}_${col.k}`] = String(Number(q.data[`${row.k}_${col.k}`] ?? 0));
    for (const k of ['limit', 'min', 'exchange_n', 'exchange_c', 'convert_exchange']) next[k] = String(Number(q.data[k] ?? 0));
    setVals(next);
  }, [q.data]);

  const save = useAdminAction(
    () => {
    const out: Record<string, number> = {};
    for (const row of RULE_ROWS) for (const col of RULE_COLS) out[`${row.k}_${col.k}`] = asInt(vals[`${row.k}_${col.k}`] ?? '') ?? 0;
    for (const k of ['limit', 'min', 'exchange_n', 'exchange_c'] as const) out[k] = asInt(vals[k] ?? '') ?? 0;
    out.convert_exchange = Number(vals.convert_exchange ?? '0') === 1 ? 1 : 0;
    return putPointRules(out);
    },
    { ok: t('point_rules_saved_tip', '规则已保存，下一次结算即按新值发放'), invalidate: [['point-rules']] },
  );

  const set = (k: string, v: string) => setVals((prev) => ({ ...prev, [k]: v }));

  return (
    <Card title={t('point_rules_card', '积分规则矩阵')}>
      {q.isError && <ErrorState error={q.error} />}
      {save.flash && <Alert tone={save.flash.tone}>{save.flash.text}</Alert>}
      {q.isLoading ? (
        <p className="py-6 text-center text-sm text-muted">{t('loading')}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <Table head={[t('point_log_source'), t('credits_experience'), t('credits_gold'), t('credits_rmb')]} minWidth="min-w-[560px]">
              {RULE_ROWS.map((row) => (
                <tr key={row.k}>
                  <td className="whitespace-nowrap">{row.label(t)}</td>
                  {RULE_COLS.map((col) => (
                    <td key={col.k}>
                      <Input
                        type="number"
                        value={vals[`${row.k}_${col.k}`] ?? ''}
                        onChange={(e) => set(`${row.k}_${col.k}`, e.target.value)}
                        className="w-[120px]"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </Table>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Field label={t('point_rules_limit_label', '每日发放上限')} hint={t('point_rules_limit_hint', '每人每日正向发放总上限（经验），0 = 不限')}>
              <Input type="number" min={0} value={vals.limit ?? ''} onChange={(e) => set('limit', e.target.value)} className="w-[120px]" />
            </Field>
            <Field label={t('point_rules_min_label', '兑换起步额（分）')} hint={t('point_rules_min_hint', '低于该金额的兑换请求直接拒绝')}>
              <Input type="number" min={0} value={vals.min ?? ''} onChange={(e) => set('min', e.target.value)} className="w-[120px]" />
            </Field>
            <Field label={t('point_rules_exchange_n_label', '兑入比例（分/金币）')} hint={t('point_rules_exchange_n_hint', '人民币兑金币：每 1 金币消耗的分')}>
              <Input type="number" min={1} value={vals.exchange_n ?? ''} onChange={(e) => set('exchange_n', e.target.value)} className="w-[120px]" />
            </Field>
            <Field label={t('point_rules_exchange_c_label', '兑出比例（金币/分）')} hint={t('point_rules_exchange_c_hint', '金币兑人民币：每 1 分消耗的金币')}>
              <Input type="number" min={1} value={vals.exchange_c ?? ''} onChange={(e) => set('exchange_c', e.target.value)} className="w-[120px]" />
            </Field>
            <Field label={t('point_rules_convert_label', '开放金币→人民币')}>
              <Select value={vals.convert_exchange ?? '0'} onChange={(e) => set('convert_exchange', e.target.value)} className="w-[120px]">
                <option value="0">{t('no_label')}</option>
                <option value="1">{t('yes_label')}</option>
              </Select>
            </Field>
          </div>
          <div className="mt-3">
            <Button onClick={() => save.mutate()} loading={save.pending}>
              {t('point_save_setting')}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

/* ---------------- 可发收费帖组 ---------------- */

export function SellGroupsCard() {
  const t = useAdminT();
  const gn = useGroupName();
  const q = useQuery({ queryKey: ['point-sell-groups'], queryFn: getPointSellGroups });
  const [checked, setChecked] = useState<number[]>([]);

  useEffect(() => {
    if (!q.data) return;
    setChecked(q.data.list.filter((g) => Number(g.allowsell) === 1).map((g) => g.gid));
  }, [q.data]);

  const save = useAdminAction(() => putPointSellGroups(checked), {
    ok: t('point_sell_groups_saved_tip', '已保存，前台收费发帖权限即时生效'),
    invalidate: [['point-sell-groups']],
  });

  const toggle = (gid: number) => setChecked((prev) => (prev.includes(gid) ? prev.filter((x) => x !== gid) : [...prev, gid]));
  const rows = q.data?.list ?? [];

  return (
    <Card title={t('point_sell_groups_card', '可发收费帖用户组')}>
      {q.isError && <ErrorState error={q.error} />}
      {save.flash && <Alert tone={save.flash.tone}>{save.flash.text}</Alert>}
      {q.isLoading ? (
        <p className="py-6 text-center text-sm text-muted">{t('loading')}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {rows.map((g) => (
              <label key={g.gid} className="flex cursor-pointer items-center gap-1.5 rounded-[4px] border border-border px-2.5 py-1.5 text-sm">
                <input type="checkbox" checked={checked.includes(g.gid)} onChange={() => toggle(g.gid)} />
                {gn(g.gid, g.name)}
              </label>
            ))}
          </div>
          <div className="mt-3">
            <Button onClick={() => save.mutate()} loading={save.pending}>
              {t('point_save_setting')}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

/* ---------------- 按用户名查/改三币余额 ---------------- */

export function BalanceCard() {
  const t = useAdminT();
  const [username, setUsername] = useState('');
  const [lookup, setLookup] = useState('');
  const [exp, setExp] = useState('');
  const [golds, setGolds] = useState('');
  const [rmbs, setRmbs] = useState('');
  const q = useQuery({
    queryKey: ['point-balance', lookup],
    queryFn: () => getPointBalance(lookup),
    enabled: lookup !== '',
  });

  useEffect(() => {
    if (!q.data) return;
    setExp(String(q.data.exp));
    setGolds(String(q.data.golds));
    setRmbs(String(q.data.rmbs));
  }, [q.data]);

  const save = useAdminAction(() => putPointBalance({ username: lookup, exp: Number(exp) || 0, golds: Number(golds) || 0, rmbs: Number(rmbs) || 0 }), {
    ok: t('point_balance_saved_tip', '余额已按绝对值覆盖（经验差额会记一条「管理员调整」流水）'),
    invalidate: [['point-balance'], ['point-users'], ['point-logs']],
  });

  return (
    <Card title={t('point_balance_card', '按用户名修改三币余额')}>
      {q.isError && <ErrorState error={q.error} />}
      {save.flash && <Alert tone={save.flash.tone}>{save.flash.text}</Alert>}
      <div className="flex flex-wrap items-end gap-2">
        <Field label={t('username')}>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && setLookup(username.trim())} className="w-[200px]" />
        </Field>
        <Button onClick={() => setLookup(username.trim())} loading={q.isLoading}>
          {t('point_filter_btn')}
        </Button>
      </div>
      {q.data && (
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <Field label={t('credits_experience')} hint={`UID ${q.data.uid}`}>
            <Input type="number" value={exp} onChange={(e) => setExp(e.target.value)} className="w-[160px]" />
          </Field>
          <Field label={t('credits_gold')}>
            <Input type="number" value={golds} onChange={(e) => setGolds(e.target.value)} className="w-[160px]" />
          </Field>
          <Field label={t('point_register_rmbs_unit')}>
            <Input type="number" value={rmbs} onChange={(e) => setRmbs(e.target.value)} className="w-[160px]" />
          </Field>
          <div className="sm:col-span-3">
            <Button onClick={() => save.mutate()} loading={save.pending}>
              {t('point_save_setting')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* ---------------- 维护工具：模拟购买 + 强制升组 ---------------- */

export function ToolsCard() {
  const t = useAdminT();
  const [simUid, setSimUid] = useState('');
  const [simTid, setSimTid] = useState('');
  const [upName, setUpName] = useState('');

  const sim = useAdminAction(() => simulatePurchase(Number(simUid) || 0, Number(simTid) || 0), {
    ok: t('point_simulate_done_tip', '已写入购买记录（已购则跳过）'),
    invalidate: [['point-users']],
  });
  const up = useAdminAction(() => forceUpgradeGroup(upName.trim()), {
    ok: (d) => (d ? t('point_upgrade_done_tip', '已从 Lv.{old} 升至 Lv.{new}', { old: d.oldGid, new: d.newGid }) : t('point_upgrade_none_tip', '当前经验无需调整组别')),
    invalidate: [['point-users']],
  });

  return (
    <Card title={t('point_tools_card', '维护工具')}>
      {sim.flash && <Alert tone={sim.flash.tone}>{sim.flash.text}</Alert>}
      {up.flash && <Alert tone={up.flash.tone}>{up.flash.text}</Alert>}
      <Field label={t('point_simulate_label', '模拟购买（UID / TID）')} hint={t('point_simulate_hint', '为用户写入一条 0 元购买记录，解锁付费主题阅读权')}>
        <div className="flex items-center gap-2">
          <Input type="number" value={simUid} onChange={(e) => setSimUid(e.target.value)} className="w-[120px]" />
          <Input type="number" value={simTid} onChange={(e) => setSimTid(e.target.value)} className="w-[120px]" />
          <Button onClick={() => sim.mutate()} loading={sim.pending} disabled={!simUid || !simTid}>
            {t('point_filter_btn')}
          </Button>
        </div>
      </Field>
      <Field label={t('point_upgrade_label', '强制重算等级组')} hint={t('point_upgrade_hint', '按当前经验重新判定该用户所属等级组')}>
        <div className="flex items-center gap-2">
          <Input value={upName} onChange={(e) => setUpName(e.target.value)} className="w-[200px]" />
          <Button onClick={() => up.mutate()} loading={up.pending} disabled={!upName.trim()}>
            {t('point_filter_btn')}
          </Button>
        </div>
      </Field>
    </Card>
  );
}

/* ---------------- 购买主题消费记录 ---------------- */

export function PaylogCard() {
  const t = useAdminT();
  const [search] = useSearchParams();
  const page = Math.max(1, Number(search.get('pp') ?? 1) || 1);
  const q = useQuery({ queryKey: ['point-paylog', page], queryFn: () => getPointPaylog(page) });
  const rows = q.data?.list ?? [];

  return (
    <Card title={t('point_paylog_card', '购买主题消费记录')}>
      {q.isError && <ErrorState error={q.error} />}
      <Table head={[t('point_log_no'), t('time_label'), 'UID', t('username_label'), t('subject'), t('point_log_change')]} minWidth="min-w-[760px]">
        {rows.map((r) => (
          <tr key={r.plid}>
            <td className="tabular-nums">{r.plid}</td>
            <td className="whitespace-nowrap">{fmtDate(r.paytime)}</td>
            <td className="tabular-nums">{r.uid}</td>
            <td>{r.username ?? '—'}</td>
            <td className="max-w-[16rem] truncate">{r.subject ?? '—'}</td>
            <td>
              <Badge tone="secondary">{r.num}</Badge>
            </td>
          </tr>
        ))}
      </Table>
      {!q.isError && !q.isLoading && rows.length === 0 && <p className="py-6 text-center text-sm text-muted">{t('point_no_match_logs')}</p>}
      <AdminPagination page={page} totalPage={q.data?.totalPage ?? 1} href={(p) => `/admin/points/logs${p > 1 ? `?pp=${p}` : ''}`} />
    </Card>
  );
}

/* ---------------- 三币排行 ---------------- */

const RANK_TYPES = ['credits', 'golds', 'rmbs'] as const;

export function RankCard() {
  const t = useAdminT();
  const [search] = useSearchParams();
  const page = Math.max(1, Number(search.get('rp') ?? 1) || 1);
  const type = (RANK_TYPES.includes(search.get('rt') as never) ? search.get('rt') : 'rmbs') as (typeof RANK_TYPES)[number];
  const q = useQuery({ queryKey: ['point-rank', type, page], queryFn: () => getPointRank(type, page) });
  const rows = q.data?.list ?? [];
  const href = (p: number) => `/admin/points/logs?rt=${type}${p > 1 ? `&rp=${p}` : ''}`;
  const col = (k: 'credits' | 'golds' | 'rmbs') => (k === 'credits' ? t('credits_experience') : k === 'golds' ? t('credits_gold') : t('credits_rmb'));

  return (
    <Card title={t('point_rank_card', '三币排行')}>
      {q.isError && <ErrorState error={q.error} />}
      <div className="mb-3 flex gap-1">
        {RANK_TYPES.map((k) => (
          <a
            key={k}
            href={`/admin/points/logs?rt=${k}`}
            className={`rounded-[4px] px-2.5 py-1 text-sm transition-colors ${k === type ? 'bg-brand text-white' : 'border border-border text-muted hover:border-brand hover:text-brand'}`}
          >
            {col(k)}
          </a>
        ))}
      </div>
      <Table head={['#', 'UID', t('username_label'), t('credits_experience'), t('credits_gold'), t('credits_rmb')]} minWidth="min-w-[680px]">
        {rows.map((r, i) => (
          <tr key={r.uid}>
            <td className="tabular-nums">{(page - 1) * 20 + i + 1}</td>
            <td className="tabular-nums">{r.uid}</td>
            <td>{r.username}</td>
            <td className="tabular-nums">{r.credits}</td>
            <td className="tabular-nums">{r.golds}</td>
            <td className="tabular-nums">{r.rmbs / 100}</td>
          </tr>
        ))}
      </Table>
      {!q.isError && !q.isLoading && rows.length === 0 && <p className="py-6 text-center text-sm text-muted">{t('point_no_match_logs')}</p>}
      <AdminPagination page={page} totalPage={q.data?.totalPage ?? 1} href={href} />
    </Card>
  );
}