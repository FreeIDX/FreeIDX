/**
 * 卡密管理（§15.4 /api/admin/cards，支付分组第三个 Tab；本项目新增页）。
 * 版式沿用后台「表单 + 筛选 + 数据表」范式，差异记账：
 *  - 生成接口 POST /api/admin/cards 返回的 cards 明文卡号是**唯一一次**回显（之后列表不再强调），
 *    故生成成功后在本页单独一张卡里用只读文本域展示明文，支持全选/一键复制，并提示立即保存；
 *  - 列表 GET 返回 {list,page,size} 但**没有 total**，同订单页用 AdminCursorPager 的上一页/下一页，
 *    下一页可用性约定为「返回条数 === size」（size 固定 50，服务端默认值即 50）；
 *  - 筛选：batch 批次号精确匹配（服务端 batch_no = ?）、status ''=全部 / '0'=未用 / '1'=已用 / '2'=已作废；
 *  - 批量操作：勾选未使用/已作废的卡后可作废（0→2，兑换侧 status=0 认领天然拒绝作废卡）或删除；
 *    已使用卡为保兑换账目不可作废/删除（服务端 WHERE 条件跳过并回告实际张数）；
 *  - 所属计划下拉复用 getVipPlans（与 VIP 计划页同一 queryKey，命中缓存不再重复请求）。
 */
import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { deleteCards, generateCards, getAdminCards, getVipPlans, voidCards } from '../api';
import type { CardGenResult } from '../types';
import { useAdminT } from '../t';
import { useAdminAction } from '../use-action';
import { fmtDate } from '../../lib/api';
import { posInt } from '../../lib/params';
import { PAY_TABS } from '../tabs';
import {
  AdminCursorPager,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ErrorState,
  Field,
  Input,
  PageTitle,
  Select,
  SubmitRow,
  TabBar,
  Table,
  Textarea,
  Toast as ToastView,
  useToast,
} from '../ui';
import { Icon } from '../../components/icons';

const SIZE = 50;

const STATUS_VALUES = ['', '0', '1', '2'] as const;

/** date 输入的 YYYY-MM-DD → unix 秒（UTC 日界，与 ThreadAdminPage/服务端同口径） */
const dayStart = (v: string): number | undefined => (v ? Math.floor(Date.parse(`${v}T00:00:00Z`) / 1000) : undefined);

export function CardAdminPage() {
  const t = useAdminT();
  const [sp, setSp] = useSearchParams();
  const batchParam = sp.get('batch') ?? '';
  const status = sp.get('status') ?? '';
  const page = posInt(sp.get('page'));

  const plans = useQuery({ queryKey: ['admin', 'vip', 'plans'], queryFn: getVipPlans });
  const q = useQuery({
    queryKey: ['admin', 'cards', { batch: batchParam, status, page }],
    queryFn: () => getAdminCards({ batch: batchParam || undefined, status, page, size: SIZE }),
    placeholderData: keepPreviousData,
  });

  const { toast, show, close } = useToast();
  const [form, setForm] = useState({ planId: '', count: '10', batchNo: '', expire: '' });
  const [formBatch, setFormBatch] = useState(batchParam);
  const [generated, setGenerated] = useState<CardGenResult | null>(null);
  const [sel, setSel] = useState<ReadonlySet<number>>(new Set());
  useEffect(() => setFormBatch(batchParam), [batchParam]);

  const statusLabel = (v: string): string => {
    switch (v) {
      case '': return t('card_status_all', '全部状态');
      case '0': return t('card_status_unused', '未使用');
      case '1': return t('card_status_used', '已使用');
      case '2': return t('card_status_void', '已作废');
      default: return v;
    }
  };

  /* 生成是写操作，但需要拿到返回的明文卡密——用 useAdminAction 在 mutationFn 里落状态，ok 只负责提示文案 */
  const gen = useAdminAction(
    async () => {
      const r = await generateCards({
        planId: Number(form.planId),
        count: Math.trunc(Number(form.count || 0)),
        batch_no: form.batchNo.trim() || undefined,
        expire_date: dayStart(form.expire) ?? 0,
      });
      setGenerated(r);
      return r;
    },
    {
      ok: (r) => t('card_gen_ok', '已生成 {count} 张卡密（批次 {batch}），明文仅此一次展示，请立即复制保存。', { count: r.count, batch: r.batch_no }),
      invalidate: [['admin', 'cards']],
    },
  );

  /* 记忆化：`?? []` 每次渲染都会新建数组，会让依赖它的 useMemo（selectable）每渲染都重算 */
  const rows = useMemo(() => q.data?.list ?? [], [q.data]);
  const hasNext = rows.length === SIZE;
  const planName = useMemo(() => new Map((plans.data?.list ?? []).map((p) => [p.id, p.name])), [plans.data]);

  /* 数据变化（翻页/筛选/写后失效刷新）即清空勾选，避免跨页勾选误操作 */
  useEffect(() => setSel(new Set()), [q.data]);
  /** 可勾选行：未使用/已作废；已使用卡不可作废也不可删除，直接不给勾 */
  const selectable = useMemo(() => rows.filter((c) => c.status !== 1).map((c) => c.id), [rows]);
  const allChecked = selectable.length > 0 && selectable.every((id) => sel.has(id));
  const toggleAll = () => setSel(allChecked ? new Set() : new Set(selectable));
  const toggleOne = (id: number, on: boolean) =>
    setSel((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /* 作废/删除同生成一样是写操作：mutationFn 里清勾选，ok 只负责提示文案；服务端按状态过滤并回告实际张数 */
  const voidAct = useAdminAction(
    async () => {
      const r = await voidCards([...sel]);
      setSel(new Set());
      return r;
    },
    { ok: (r) => t('card_void_ok', '已作废 {count} 张卡密（已使用的卡会被跳过）。', { count: r.voided }), invalidate: [['admin', 'cards']] },
  );
  const delAct = useAdminAction(
    async () => {
      const r = await deleteCards([...sel]);
      setSel(new Set());
      return r;
    },
    { ok: (r) => t('card_del_ok', '已删除 {count} 张卡密（已使用的卡不可删除，会自动跳过）。', { count: r.deleted }), invalidate: [['admin', 'cards']] },
  );

  const doVoid = () => {
    if (!sel.size) return;
    if (!window.confirm(t('card_void_confirm', '确定作废选中的 {count} 张卡密吗？作废后不可再兑换，且不可恢复。', { count: sel.size }))) return;
    voidAct.mutate();
  };
  const doDelete = () => {
    if (!sel.size) return;
    if (!window.confirm(t('card_del_confirm', '确定删除选中的 {count} 张卡密吗？删除后不可恢复（已使用的卡不会被删除）。', { count: sel.size }))) return;
    delAct.mutate();
  };

  /** 只把非默认值写进 URL：改筛选回到第 1 页，翻页保留筛选 */
  const goto = (nextBatch: string, nextStatus: string, nextPage: number) => {
    const params = new URLSearchParams();
    if (nextBatch) params.set('batch', nextBatch);
    if (nextStatus) params.set('status', nextStatus);
    if (nextPage > 1) params.set('page', String(nextPage));
    setSp(params);
  };

  const doGenerate = () => {
    const planId = Number(form.planId);
    if (!planId) {
      gen.setFlash({ tone: 'warn', text: t('card_plan_required', '请选择所属计划') });
      return;
    }
    const count = Math.trunc(Number(form.count || 0));
    if (!Number.isFinite(count) || count < 1 || count > 200) {
      gen.setFlash({ tone: 'warn', text: t('card_count_invalid', '数量需为 1-200') });
      return;
    }
    gen.setFlash(null);
    gen.mutate();
  };

  const copyAll = async () => {
    if (!generated) return;
    const text = generated.cards.map((c) => c.code).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      show(t('card_copy_ok', '已复制全部卡号到剪贴板'));
    } catch {
      show(t('card_copy_fail', '复制失败，请手动全选复制'), 'warn');
    }
  };

  return (
    <div className="space-y-3">
      <PageTitle>{t('admin_cards', '卡密')}</PageTitle>
      <TabBar active="card" items={PAY_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {toast && <ToastView text={toast.text} tone={toast.tone} onDone={close} />}

      <Card title={t('card_gen_title', '批量生成卡密')}>
        {gen.flash && <Alert tone={gen.flash.tone}>{gen.flash.text}</Alert>}
        {plans.isError && <ErrorState error={plans.error} />}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            doGenerate();
          }}
        >
          <Field label={t('card_plan_label', '所属计划')} htmlFor="card-plan">
            <Select id="card-plan" value={form.planId} onChange={(e) => setForm((f) => ({ ...f, planId: e.target.value }))}>
              <option value="">{t('card_plan_placeholder', '请选择计划')}</option>
              {(plans.data?.list ?? []).map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {t('card_plan_option', '{name}（{days} 天）', { name: p.name, days: p.duration_days })}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('quantity', '数量')} htmlFor="card-count" hint={t('card_count_hint', '每次可生成 1-200 张')}>
            <Input id="card-count" type="number" min={1} max={200} value={form.count} onChange={(e) => setForm((f) => ({ ...f, count: e.target.value }))} />
          </Field>
          <Field label={t('card_batch_label', '批次号')} htmlFor="card-batch" hint={t('card_batch_hint', '留空由服务端自动生成')}>
            <Input id="card-batch" value={form.batchNo} onChange={(e) => setForm((f) => ({ ...f, batchNo: e.target.value }))} />
          </Field>
          <Field label={t('card_expire_label', '过期时间')} htmlFor="card-expire" hint={t('card_expire_hint', '留空表示永久有效')}>
            <Input id="card-expire" type="date" value={form.expire} onChange={(e) => setForm((f) => ({ ...f, expire: e.target.value }))} />
          </Field>
          <SubmitRow>
            <Button type="submit" loading={gen.pending}>
              <Icon name="key" />
              {t('card_gen_btn', '生成卡密')}
            </Button>
          </SubmitRow>
        </form>
      </Card>

      {generated && (
        <Card
          title={t('card_gen_result_title', '本次生成的卡密（批次 {batch}）', { batch: generated.batch_no })}
          tools={
            <Button size="sm" variant="default" onClick={() => void copyAll()}>
              <Icon name="copy" />
              {t('card_copy_btn', '复制全部')}
            </Button>
          }
        >
          <Alert tone="warn">{t('card_plaintext_warn', '明文卡号仅在生成时返回一次，刷新或离开页面后不可再查看，请立即复制保存。')}</Alert>
          <Textarea
            readOnly
            className="h-48 font-mono text-sm"
            value={generated.cards.map((c) => c.code).join('\n')}
            onFocus={(e) => e.currentTarget.select()}
          />
        </Card>
      )}

      {q.isError && <ErrorState error={q.error} />}
      {voidAct.flash && <Alert tone={voidAct.flash.tone}>{voidAct.flash.text}</Alert>}
      {delAct.flash && <Alert tone={delAct.flash.tone}>{delAct.flash.text}</Alert>}

      <Card
        title={t('admin_cards', '卡密')}
        tools={
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              goto(formBatch.trim(), status, 1);
            }}
          >
            {/* inputCls 自带 w-full，且 Tailwind v4 把 .w-full 排在 .w-[..] 之后（同属性后者胜，与 className 顺序无关），
                故不能直接给控件写 w-[..]；改用定宽包裹层锁宽，内层 w-full 即等于该宽度，不依赖 CSS 顺序 */}
            <div className="w-[10rem]">
              <Select aria-label={t('card_filter_status', '按状态筛选')} value={status} onChange={(e) => goto(formBatch.trim(), e.target.value, 1)}>
                {STATUS_VALUES.map((v) => (
                  <option key={v} value={v}>
                    {statusLabel(v)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="w-[13rem]">
              <Input
                aria-label={t('card_filter_batch', '按批次号筛选')}
                placeholder={t('card_batch_placeholder', '批次号')}
                value={formBatch}
                onChange={(e) => setFormBatch(e.target.value)}
              />
            </div>
            <Button type="submit" size="sm" loading={q.isFetching}>
              <Icon name="search" />
              {t('card_filter_btn', '筛选')}
            </Button>
          </form>
        }
        footer={
          sel.size > 0 ? (
            /* 勾选后翻页器仍绝对定位水平居中（inset-x-0 + justify-center），不随左侧操作条挤出居中位；
               pointer-events 穿透保证两侧都可点，窄屏换行时操作条在下层、翻页器置顶 */
            <div className="relative flex min-h-[2rem] flex-wrap items-center gap-2">
              <div className="z-0 flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted">{t('card_selected', '已选 {count} 张', { count: sel.size })}</span>
                <Button size="sm" variant="default" loading={voidAct.pending} onClick={doVoid}>
                  <Icon name="close" />
                  {t('card_void_btn', '作废')}
                </Button>
                <Button size="sm" variant="danger" loading={delAct.pending} onClick={doDelete}>
                  <Icon name="trash" />
                  {t('delete', '删除')}
                </Button>
              </div>
              <div className="pointer-events-none absolute inset-x-0 z-10 flex justify-center">
                <div className="pointer-events-auto bg-surface">
                  <AdminCursorPager page={page} hasPrev={page > 1} hasNext={hasNext} onPrev={() => goto(batchParam, status, page - 1)} onNext={() => goto(batchParam, status, page + 1)} />
                </div>
              </div>
            </div>
          ) : (
            <AdminCursorPager page={page} hasPrev={page > 1} hasNext={hasNext} onPrev={() => goto(batchParam, status, page - 1)} onNext={() => goto(batchParam, status, page + 1)} />
          )
        }
      >
        <Table
          head={[
            <Checkbox key="all" title={t('card_select_all', '全选本页可操作卡密')} checked={allChecked} onChange={toggleAll} disabled={!selectable.length} />,
            t('card_col_code', '卡号'),
            t('card_col_batch', '批次'),
            t('card_plan_label', '所属计划'),
            t('card_col_status', '状态'),
            t('card_col_redeemer', '兑换用户'),
            t('create_date', '创建时间'),
            t('card_col_expire', '过期时间'),
          ]}
          headCls={['w-[2.25rem]']}
          minWidth="min-w-[980px]"
        >
          {rows.map((c) => (
            <tr key={c.id}>
              <td>{c.status !== 1 && <Checkbox title={t('card_select_one', '选择 {code}', { code: c.code })} checked={sel.has(c.id)} onChange={(on) => toggleOne(c.id, on)} />}</td>
              <td className="font-mono text-xs">{c.code}</td>
              <td className="font-mono text-xs">{c.batch_no}</td>
              <td>{planName.get(c.plan_id) ?? `#${c.plan_id}`}</td>
              <td>
                {c.status === 1 ? <Badge tone="secondary">{t('card_status_used', '已使用')}</Badge> : c.status === 2 ? <Badge tone="danger">{t('card_status_void', '已作废')}</Badge> : <Badge tone="success">{t('card_status_unused', '未使用')}</Badge>}
              </td>
              <td className="tabular-nums">
                {c.redeemed_uid > 0 ? (
                  <Link className="text-brand hover:underline" to={`/user/${c.redeemed_uid}`}>
                    {c.redeemed_uid}
                  </Link>
                ) : (
                  '-'
                )}
              </td>
              <td className="whitespace-nowrap text-xs text-muted">{fmtDate(c.create_date) || '-'}</td>
              <td className="whitespace-nowrap text-xs text-muted">{c.expire_date ? fmtDate(c.expire_date) : t('card_forever', '永久')}</td>
            </tr>
          ))}
        </Table>
        {rows.length === 0 && !q.isFetching && <p className="py-6 text-center text-sm text-muted">{t('card_no_match', '没有符合条件的卡密。')}</p>}
      </Card>
    </div>
  );
}
