/**
 * VIP 计划管理（§15.4 /api/admin/vip/plans，支付分组第一个 Tab；本项目新增页）。
 * 版式沿用后台数据表 + 就地表单范式（与 ForumListPage/AdSlotGrid 同族），差异记账：
 *  - GET 返回 {list} **不分页**（计划数量少，服务端 listAllPlans 全量），故本页没有分页器；
 *  - 金额存储口径是**分**（price_cents），UI 用**元**展示/输入，提交前换算（保留两位小数、四舍五入到分）；
 *  - perks 服务端已 JSON.parse 成对象，表单用一个小文本域输入 JSON（可留空 = {}），提交前做合法性校验；
 *  - 新建/编辑共用一个就地表单（计划字段少，不必再开独立页），删除走 ConfirmModal 二次确认；
 *  - 启用/停用是一个开关按钮：PUT 是整体替换，故带上该行全部字段、只翻 enabled；
 *  - 关联用户组（0004/0005）：gid **必选**（仅 gid>=100 等级/会员组），开通=挂组、到期 cron 自动回落原组。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { createVipPlan, deleteVipPlan, getGroups, getVipPlans, updateVipPlan } from '../api';
import type { VipPlanInput, VipPlanRow } from '../types';
import { useAdminT } from '../t';
import { useGroupName } from '../../lib/i18n';
import { useBatchAction } from '../use-action';
import { PAY_TABS } from '../tabs';
import {
  Alert,
  Badge,
  Button,
  Card,
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
  Textarea,
} from '../ui';
import { Icon } from '../../components/icons';

/** 金额单位是分（服务端口径），UI 用元展示/输入 */
const centsToYuan = (cents: number): string => (cents / 100).toFixed(2);
const yuanToCents = (yuan: string): number => Math.round(Number(yuan || 0) * 100);

/** 关联组只收等级/会员组（gid>=100；<100 为管理组，服务端同样拒绝），0 = 不关联 */
const GROUP_SELECTABLE_MIN = 100;

/** 就地表单字段：价格/perks/gid 用文本态，提交时再解析换算 */
interface PlanForm {
  name: string;
  duration_days: string;
  price: string;
  currency: string;
  perks: string;
  enabled: number;
  sort: string;
  gid: string;
}

const BLANK_FORM: PlanForm = { name: '', duration_days: '30', price: '0.00', currency: 'CNY', perks: '{}', enabled: 1, sort: '0', gid: '' };

const toForm = (r: VipPlanRow): PlanForm => ({
  name: r.name,
  duration_days: String(r.duration_days),
  price: centsToYuan(r.price_cents),
  currency: r.currency,
  perks: JSON.stringify(r.perks ?? {}),
  enabled: Number(r.enabled) === 1 ? 1 : 0,
  sort: String(r.sort),
  /* 历史数据可能存在 gid=0（旧「不关联」），编辑时回到占位态强制重选 */
  gid: Number(r.gid) > 0 ? String(r.gid) : '',
});

/** PUT 整体替换要带上全字段：开关只翻 enabled，其余原样回传 */
const toInput = (r: VipPlanRow, enabled = r.enabled): VipPlanInput => ({
  name: r.name,
  duration_days: r.duration_days,
  price_cents: r.price_cents,
  currency: r.currency,
  perks: r.perks,
  enabled,
  sort: r.sort,
  gid: r.gid ?? 0,
});

export function VipPlanPage() {
  const t = useAdminT();
  const gn = useGroupName();
  const q = useQuery({ queryKey: ['admin', 'vip', 'plans'], queryFn: getVipPlans });
  const gq = useQuery({ queryKey: ['admin', 'groups'], queryFn: getGroups });
  const batch = useBatchAction([['admin', 'vip', 'plans']]);

  /* editingId：null = 表单收起；0 = 新建；>0 = 编辑该计划 */
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<PlanForm>(BLANK_FORM);
  const [confirming, setConfirming] = useState<VipPlanRow | null>(null);

  const rows = q.data?.list ?? [];
  /* 关联组下拉候选：仅等级/会员组（gid>=100）；列表列同样用这里做 gid→组名映射 */
  const groups = (gq.data?.groups ?? []).filter((g) => g.gid >= GROUP_SELECTABLE_MIN);
  const groupName = (gid: number): string => (gid > 0 ? (groups.find((g) => g.gid === gid)?.name ? gn(gid, groups.find((g) => g.gid === gid)!.name) : `#${gid}`) : '—');
  const setField = <K extends keyof PlanForm>(k: K, v: PlanForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const openNew = () => {
    setEditingId(0);
    setForm(BLANK_FORM);
  };
  const openEdit = (r: VipPlanRow) => {
    setEditingId(r.id);
    setForm(toForm(r));
  };
  const closeForm = () => setEditingId(null);

  const save = async () => {
    if (editingId === null) return;
    const name = form.name.trim();
    if (!name) {
      batch.setFlash({ tone: 'warn', text: t('vip_name_empty', '计划名称不能为空') });
      return;
    }
    const days = Math.trunc(Number(form.duration_days || 0));
    if (!Number.isFinite(days) || days < 0) {
      batch.setFlash({ tone: 'warn', text: t('vip_days_invalid', '时长需为非负整数（天）') });
      return;
    }
    const gid = Math.trunc(Number(form.gid || 0));
    if (gid < GROUP_SELECTABLE_MIN) {
      batch.setFlash({ tone: 'warn', text: t('vip_group_required', '请选择关联用户组（等级/会员组）') });
      return;
    }
    // perks 可留空（视为 {}），非空必须是合法 JSON 对象
    let perks: Record<string, unknown> = {};
    const raw = form.perks.trim();
    if (raw) {
      try {
        const v = JSON.parse(raw) as unknown;
        if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        perks = v as Record<string, unknown>;
      } catch {
        batch.setFlash({ tone: 'warn', text: t('vip_perks_invalid', 'perks 需为合法 JSON 对象，例如 {"color":"gold"}') });
        return;
      }
    }
    const input: VipPlanInput = {
      name,
      duration_days: days,
      price_cents: yuanToCents(form.price),
      currency: form.currency.trim() || 'CNY',
      perks,
      enabled: form.enabled,
      sort: Math.trunc(Number(form.sort || 0)),
      gid,
    };
    const job = editingId > 0 ? () => updateVipPlan(editingId, input) : () => createVipPlan(input);
    if (await batch.run([job], editingId > 0 ? t('vip_updated', '计划已更新') : t('vip_created', '计划已创建'))) closeForm();
  };

  const remove = async (r: VipPlanRow) => {
    if (await batch.run([() => deleteVipPlan(r.id)], t('vip_deleted', '已删除计划「{name}」', { name: r.name }))) setConfirming(null);
  };

  const toggle = async (r: VipPlanRow) => {
    const next = r.enabled === 1 ? 0 : 1;
    await batch.run([() => updateVipPlan(r.id, toInput(r, next))], next === 1 ? t('vip_enabled_ok', '已启用「{name}」', { name: r.name }) : t('vip_disabled_ok', '已停用「{name}」', { name: r.name }));
  };

  return (
    <div className="space-y-3">
      <PageTitle>{t('admin_vip_plans', 'VIP 计划')}</PageTitle>
      <TabBar active="vip" items={PAY_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {q.isError && <ErrorState error={q.error} />}
      {batch.flash && <Alert tone={batch.flash.tone}>{batch.flash.text}</Alert>}

      <Card
        title={t('admin_vip_plans', 'VIP 计划')}
        tools={
          <Button size="sm" onClick={openNew}>
            <Icon name="plus" />
            {t('vip_new_btn', '新建计划')}
          </Button>
        }
      >
        <Table head={[t('admin_group_id', 'ID'), t('vip_name_label', '名称'), t('vip_col_group', '关联组'), t('vip_col_days', '时长(天)'), t('vip_col_price', '价格(元)'), t('vip_col_currency', '币种'), t('card_col_status', '状态'), t('vip_col_sort', '排序'), t('operation', '操作')]} minWidth="min-w-[960px]">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="tabular-nums">{r.id}</td>
              <td>{r.name}</td>
              <td>{groupName(r.gid ?? 0)}</td>
              <td className="tabular-nums">{r.duration_days}</td>
              <td className="tabular-nums">{centsToYuan(r.price_cents)}</td>
              <td>{r.currency}</td>
              <td>{r.enabled === 1 ? <Badge tone="success">{t('enable', '启用')}</Badge> : <Badge tone="secondary">{t('vip_status_disabled', '停用')}</Badge>}</td>
              <td className="tabular-nums">{r.sort}</td>
              <td className="whitespace-nowrap">
                <Button size="sm" variant="default" onClick={() => openEdit(r)}>
                  {t('edit', '编辑')}
                </Button>
                <Button size="sm" variant="default" className="ml-1" loading={batch.pending} onClick={() => void toggle(r)}>
                  {r.enabled === 1 ? t('vip_disable_btn', '停用') : t('enable', '启用')}
                </Button>
                <Button size="sm" variant="danger" className="ml-1" onClick={() => setConfirming(r)}>
                  {t('delete', '删除')}
                </Button>
              </td>
            </tr>
          ))}
        </Table>
        {rows.length === 0 && !q.isFetching && <p className="py-6 text-center text-sm text-muted">{t('vip_empty', '还没有 VIP 计划，点右上「新建计划」添加。')}</p>}
      </Card>

      {editingId !== null && (
        <Card title={editingId > 0 ? t('vip_edit_title', '编辑计划 #{id}', { id: editingId }) : t('vip_new_title', '新建计划')}>
          <Field label={t('vip_name_label', '名称')} htmlFor="plan-name">
            <Input id="plan-name" value={form.name} onChange={(e) => setField('name', e.target.value)} />
          </Field>
          <Field label={t('vip_group_label', '关联用户组')} htmlFor="plan-gid" hint={t('vip_group_hint', '开通会员后加入该用户组，到期后自动恢复原用户组')}>
            <Select id="plan-gid" value={form.gid} onChange={(e) => setField('gid', e.target.value)}>
              <option value="">{t('vip_group_placeholder', '请选择用户组')}</option>
              {groups.map((g) => (
                <option key={g.gid} value={String(g.gid)}>
                  {t('vip_group_option', '{name}（gid={gid}）', { name: gn(g.gid, g.name), gid: g.gid })}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('vip_days_label', '时长（天）')} htmlFor="plan-days">
            <Input id="plan-days" type="number" min={0} value={form.duration_days} onChange={(e) => setField('duration_days', e.target.value)} />
          </Field>
          <Field label={t('vip_price_label', '价格（元）')} htmlFor="plan-price" hint={t('vip_price_hint', '按元输入，保存时换算为分（服务端存 price_cents）')}>
            <Input id="plan-price" type="number" min={0} step="0.01" value={form.price} onChange={(e) => setField('price', e.target.value)} />
          </Field>
          <Field label={t('vip_currency_label', '币种')} htmlFor="plan-currency">
            <Input id="plan-currency" value={form.currency} onChange={(e) => setField('currency', e.target.value)} />
          </Field>
          <Field label={t('vip_sort_label', '排序')} htmlFor="plan-sort" hint={t('vip_sort_hint', '数字越小越靠前（前台按 sort 升序展示）')}>
            <Input id="plan-sort" type="number" value={form.sort} onChange={(e) => setField('sort', e.target.value)} />
          </Field>
          <Field label={t('vip_enabled_label', '启用')}>
            <Checkbox checked={form.enabled === 1} onChange={(v) => setField('enabled', v ? 1 : 0)} label={t('vip_enabled_hint', '启用后前台可选该计划')} />
          </Field>
          <Field label={t('vip_perks_label', 'perks（JSON）')} htmlFor="plan-perks" hint={t('vip_perks_hint', '可留空（视为 {}），例如 {"color":"gold","badge":"VIP"}')}>
            <Textarea id="plan-perks" className="font-mono text-sm" value={form.perks} onChange={(e) => setField('perks', e.target.value)} />
          </Field>
          <SubmitRow>
            <Button loading={batch.pending} onClick={() => void save()}>
              {t('confirm', '确定')}
            </Button>
            <Button variant="default" className="ml-2" onClick={closeForm}>
              {t('cancel', '取消')}
            </Button>
          </SubmitRow>
        </Card>
      )}

      <ConfirmModal
        open={confirming !== null}
        loading={batch.pending}
        text={t('vip_delete_confirm', '删除计划「{name}」不会影响已生成的订单与卡密（它们仍按 plan_id 关联），但之后将无法再为该计划下单或生成卡密。确定删除？', { name: confirming?.name ?? '' })}
        onConfirm={() => void remove(confirming!)}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}
