/**
 * 广告位维护（§4.10 模式 B 表格式内联编辑，落在扩展页的第二个 tab）。
 * 广告位是本项目的扩展能力（/api/admin/ad-slots），
 * 所以版式沿用 forum_list/group_list 的内联编辑范式：整表一次编辑、[+]增加一行 + 居中确定，
 * 提交时按行差分（新行 POST、变化行 PUT、被删行 DELETE），与 ForumListPage 同口径。
 * config 服务端是 JSON 对象（normalizeSlot 拒收非对象），表格里以单行 JSON 文本呈现，解析失败即拦下不提交。
 * position 建议值取 shared 的 SLOT_POSITIONS（前端插槽点位），但服务端只要求非空，自定义点位仍可用。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { SLOT_POSITIONS } from '@freeidx/shared';
import { createAdSlot, deleteAdSlot, getAdSlots, updateAdSlot } from '../api';
import type { AdSlotRow } from '../types';
import { useAdminT } from '../t';
import { useBatchAction } from '../use-action';
import { Alert, Button, Card, Checkbox, ErrorState, Table, cx, inputCls } from '../ui';
import { Icon } from '../../components/icons';

/** 表内行：config 摊平成文本，id=0 表示新增行 */
interface SlotDraft {
  id: number;
  position: string;
  type: string;
  config: string;
  sort: number;
  enabled: number;
}

const toDraft = (r: AdSlotRow): SlotDraft => ({
  id: r.id,
  position: r.position,
  type: r.type,
  config: JSON.stringify(r.config ?? {}),
  sort: r.sort,
  enabled: r.enabled,
});

const TYPES = [
  { value: 'html', text: 'html' },
  { value: 'image', text: 'image' },
  { value: 'adsense', text: 'adsense' },
];

function CellSelect({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; text: string }[] }) {
  return (
    <select className={cx(inputCls, 'w-full')} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.text}
        </option>
      ))}
    </select>
  );
}

export function AdSlotGrid() {
  const t = useAdminT();
  const q = useQuery({ queryKey: ['admin', 'ad-slots'], queryFn: () => getAdSlots(true), placeholderData: keepPreviousData });
  const batch = useBatchAction([['admin', 'ad-slots'], ['admin', 'extensions']]);

  const [rows, setRows] = useState<SlotDraft[]>([]);
  const loaded = useMemo(() => (q.data?.slots ?? []).map(toDraft), [q.data]);
  const [removed, setRemoved] = useState<number[]>([]);
  /**
   * 未保存草稿保护：任何来源的重取（invalidate / 轮询，以及全局 refetchOnWindowFocus 若恢复开启）
   * 都会产生新的 q.data，
   * 若无条件灌入表单就会静默清空正在编辑的内容（保存成功后会复位此标记再同步）。
   */
  const dirtyRef = useRef(false);
  const markDirty = () => {
    dirtyRef.current = true;
  };
  useEffect(() => {
    if (dirtyRef.current) return;
    setRows(loaded);
    setRemoved([]);
  }, [loaded]);

  const setRow = (index: number, patch: Partial<SlotDraft>) => {
    markDirty();
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  };

  const parseConfig = (raw: string): Record<string, unknown> | null => {
    const trimmed = raw.trim() || '{}';
    try {
      const v = JSON.parse(trimmed) as unknown;
      if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
      return v as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const submit = async () => {
    for (const r of rows) {
      if (!r.position.trim()) {
        batch.setFlash({ tone: 'warn', text: t('admin_slot_position_empty', '槽位 key（position）不能为空') });
        return;
      }
      if (parseConfig(r.config) === null) {
        batch.setFlash({ tone: 'warn', text: t('admin_slot_config_invalid', '槽位 {position} 的配置不是合法 JSON 对象', { position: r.position }) });
        return;
      }
    }
    const jobs: (() => Promise<unknown>)[] = [];
    for (const r of removed) jobs.push(() => deleteAdSlot(r));
    for (const r of rows) {
      const body = {
        position: r.position.trim(),
        type: (TYPES.find((x) => x.value === r.type)?.value ?? 'html') as 'html' | 'image' | 'adsense',
        config: parseConfig(r.config) ?? {},
        enabled: r.enabled,
        sort: r.sort,
      };
      if (r.id > 0) {
        const origin = loaded.find((x) => x.id === r.id);
        if (origin && origin.position === body.position && origin.type === body.type && origin.config === r.config && origin.enabled === r.enabled && origin.sort === r.sort) continue;
        jobs.push(() => updateAdSlot(r.id, body));
      } else {
        jobs.push(() => createAdSlot({ ...body, start_date: 0, end_date: 0 }));
      }
    }
    if (!jobs.length) {
      batch.setFlash({ tone: 'warn', text: t('admin_no_changes_to_save', '没有需要保存的改动') });
      return;
    }
    const ok = await batch.run(jobs, t('admin_save_complete', '保存完成'));
    if (ok) {
      setRemoved([]);
      dirtyRef.current = false; // 已保存：允许下方 refetch 回填服务端最新数据（含新建行的 id）
      await q.refetch();
    }
  };

  return (
    <div className="space-y-3">
      {q.isError && <ErrorState error={q.error} />}
      {batch.flash && <Alert tone={batch.flash.tone}>{batch.flash.text}</Alert>}
      <Card
        title={t('admin_ad_slots', '广告位')}
        tools={
          <span className="text-xs text-muted-2">
            <Icon name="warning" className="mr-1 inline size-3.5" />
            {t('admin_delete_after_submit', '删除要提交后才生效')}
          </span>
        }
        footer={
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                markDirty();
                setRows((rs) => [...rs, { id: 0, position: 'header', type: 'html', config: '{"html":""}', sort: 0, enabled: 0 }]);
              }}
            >
              <Icon name="plus" />
              {t('admin_add_row', '增加一行')}
            </Button>
            <Button loading={batch.pending} onClick={() => void submit()} className="w-[10rem]">
              {t('confirm', '确定')}
            </Button>
          </div>
        }
      >
        <Table head={['ID', t('admin_slot_key', '槽位 key'), t('type_label', '类型'), t('admin_config_json', '配置（JSON）'), t('forum_rank', '排序'), t('enable', '启用'), '']} minWidth="min-w-[900px]">
          {rows.map((r, i) => (
            <tr key={`${r.id}-${i}`}>
              <td className="w-[60px] tabular-nums">{r.id > 0 ? r.id : t('admin_new', '新增')}</td>
              <td className="w-[170px]">
                <CellSelect
                  value={r.position}
                  onChange={(v) => setRow(i, { position: v })}
                  options={[...SLOT_POSITIONS, ...(SLOT_POSITIONS.includes(r.position as (typeof SLOT_POSITIONS)[number]) ? [] : [r.position])].map((p) => ({ value: p, text: p }))}
                />
              </td>
              <td className="w-[130px]">
                <CellSelect value={r.type} onChange={(v) => setRow(i, { type: v })} options={TYPES} />
              </td>
              <td>
                <input className={cx(inputCls, 'w-full font-mono text-xs')} value={r.config} onChange={(e) => setRow(i, { config: e.target.value })} />
              </td>
              <td className="w-[80px]">
                <input type="number" className={cx(inputCls, 'w-full')} value={r.sort} onChange={(e) => setRow(i, { sort: Number(e.target.value || 0) })} />
              </td>
              <td className="w-[70px]">
                <Checkbox checked={r.enabled === 1} onChange={(v) => setRow(i, { enabled: v ? 1 : 0 })} />
              </td>
              <td className="w-[80px]">
                {r.id > 0 ? (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      markDirty();
                      setRows((rs) => rs.filter((_, x) => x !== i));
                      setRemoved((d) => [...d, r.id]);
                    }}
                  >
                    {t('delete', '删除')}
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      markDirty();
                      setRows((rs) => rs.filter((_, x) => x !== i));
                    }}
                  >
                    {t('cancel', '取消')}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </Table>
        {rows.length === 0 && !q.isFetching && <p className="py-6 text-center text-sm text-muted">{t('none', '无')}</p>}
        <p className="mt-2 mb-0 text-xs text-muted-2">
          {t('admin_slot_config_note', '注：配置按类型解释——html 用 {html_ex}、image 用 {image_ex}、adsense 用 {adsense_ex}； 启用=0 的位是草稿位，前台不下发，仅本列表可见。', { html_ex: '{"html":"…"}', image_ex: '{"src":"…","link":"…","alt":"…"}', adsense_ex: '{"client":"ca-…","slot":"…"}' })}
        </p>
      </Card>
    </div>
  );
}
