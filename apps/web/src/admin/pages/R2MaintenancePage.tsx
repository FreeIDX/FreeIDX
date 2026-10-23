/**
 * 运行维护 · R2 存储维护。
 *
 * 判定口径（单向：从 R2 key 反查 D1，绝不按 D1 反推 R2）：
 *  - avatar/  用户仍存在且 avatar>0 才算在用（覆盖写后旧格式残留会被判为多余）
 *  - forum/   bbs_forum.icon_file 指向该 key 才算在用
 *  - site/    kv setting 的 logo_url / favicon_url 指向该 key 才算在用
 *  - attach/  bbs_attach.filename 存在该 key 才算在用（行被删则对象成孤儿）
 *  - seo/     主题仍存在才算在用（预渲染快照，删了会按需重建）
 *
 * 两道硬闸：① 上传不足 24h 的对象一律跳过（防「刚上传尚未关联」被误删）；
 * ② 删除前必须有一次跑到末尾且命中>0 的扫描报告，并二次确认。前缀白名单之外的对象永不触碰。
 */
import { useEffect, useState } from 'react';
import type { AdminKey } from '@freeidx/shared';
import { getMaintR2Status, resetMaintR2, startMaintR2, stepMaintR2 } from '../api';
import type { MaintR2State, MaintR2Status } from '../types';
import { useAdminT } from '../t';
import { apiErrorMessage } from '../../lib/errors';
import { Icon } from '../../components/icons';
import { OTHER_TABS } from '../tabs';
import { Alert, Badge, Button, Card, ConfirmModal, PageTitle, TabBar, Table } from '../ui';

/**
 * 单次点击最多推进的步数（每步 1 个请求）。
 * 扫描 5 页/步；删除走 R2 批量调用，默认 200 个/步（批量不可用时服务端自动降级为 20 个/步）。
 */
const MAX_SCAN_STEPS = 20;
const MAX_DELETE_STEPS = 20;

type Flash = { tone: 'ok' | 'warn'; text: string };

export function R2MaintenancePage() {
  const t = useAdminT();
  const [status, setStatus] = useState<MaintR2Status | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ prefix: string; hits: number } | null>(null);

  const load = async (): Promise<void> => {
    try {
      setStatus(await getMaintR2Status());
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const stateOf = (prefix: string): MaintR2State | null => {
    const i = status?.prefixes.indexOf(prefix) ?? -1;
    return i >= 0 ? (status?.states[i] ?? null) : null;
  };

  const applyState = (st: MaintR2State): void => {
    setStatus((prev) => {
      if (!prev) return prev;
      const i = prev.prefixes.indexOf(st.prefix);
      if (i < 0) return prev;
      const states = prev.states.slice();
      states[i] = st;
      return { ...prev, states };
    });
  };

  /** 连续推进直到完成或达到上限（页面展示逐轮刷新，中途可停止浏览进度） */
  const advance = async (prefix: string, maxSteps: number): Promise<MaintR2State | null> => {
    let last: MaintR2State | null = null;
    for (let i = 0; i < maxSteps; i++) {
      const r = await stepMaintR2(prefix, 5);
      last = r.state;
      applyState(r.state);
      const drained = r.state.done && r.state.pending.length === 0;
      if (drained) break;
      // 删除模式下若本轮没有可删对象（pending 为空且已到末尾），也停下
      if (r.state.mode === 'delete' && r.state.pending.length === 0 && r.state.done) break;
    }
    return last;
  };

  const doScan = async (prefix: string): Promise<void> => {
    setBusy(`scan:${prefix}`);
    setFlash(null);
    try {
      const r = await startMaintR2({ prefix, mode: 'scan' });
      applyState(r.state);
      const last = await advance(prefix, MAX_SCAN_STEPS);
      if (last?.done) {
        setFlash({ tone: 'ok', text: t('admin_maint_r2_scan_done', '扫描完成：共 {scanned} 个对象，其中 {hits} 个未被引用', { scanned: last.scanned, hits: last.hits }) });
      }
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const doContinue = async (prefix: string): Promise<void> => {
    const st = stateOf(prefix);
    setBusy(`step:${prefix}`);
    setFlash(null);
    try {
      const last = await advance(prefix, st?.mode === 'delete' ? MAX_DELETE_STEPS : MAX_SCAN_STEPS);
      if (last?.mode === 'delete') {
        setFlash({ tone: 'ok', text: t('admin_maint_r2_deleted_n', '已删除 {n} 个对象', { n: last.deleted }) });
      } else if (last?.done) {
        setFlash({ tone: 'ok', text: t('admin_maint_r2_scan_done', '扫描完成：共 {scanned} 个对象，其中 {hits} 个未被引用', { scanned: last.scanned, hits: last.hits }) });
      }
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const doDelete = async (prefix: string): Promise<void> => {
    setConfirm(null);
    setBusy(`del:${prefix}`);
    setFlash(null);
    try {
      const r = await startMaintR2({ prefix, mode: 'delete', confirm: true });
      applyState(r.state);
      const last = await advance(prefix, MAX_DELETE_STEPS);
      setFlash({ tone: 'ok', text: t('admin_maint_r2_deleted_n', '已删除 {n} 个对象', { n: last?.deleted ?? 0 }) });
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const doReset = async (prefix: string): Promise<void> => {
    setBusy(`reset:${prefix}`);
    setFlash(null);
    try {
      await resetMaintR2(prefix);
      await load();
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  // 静态映射而非拼接：i18n AST 扫描能识别到 5 个前缀键，避免死键告警
  const PREFIX_LABEL: Record<string, AdminKey> = {
    avatar: 'admin_maint_r2_prefix_avatar',
    forum: 'admin_maint_r2_prefix_forum',
    site: 'admin_maint_r2_prefix_site',
    attach: 'admin_maint_r2_prefix_attach',
    seo: 'admin_maint_r2_prefix_seo',
  };
  const prefixLabel = (p: string): string => t(PREFIX_LABEL[p] ?? 'admin_maint_r2', p);

  const stateText = (st: MaintR2State | null): { tone: 'secondary' | 'info' | 'success' | 'warning'; text: string } => {
    if (!st) return { tone: 'secondary', text: t('admin_maint_r2_idle', '未开始') };
    if (st.mode === 'scan') {
      return st.done
        ? { tone: 'info', text: t('admin_maint_r2_scanned', '扫描完成，未引用 {n} 个', { n: st.hits }) }
        : { tone: 'info', text: t('admin_maint_r2_scanning', '扫描中（已扫 {n}）', { n: st.scanned }) };
    }
    return st.pending.length === 0 && st.deleted > 0
      ? { tone: 'success', text: t('admin_maint_r2_deleted_n', '已删除 {n} 个对象', { n: st.deleted }) }
      : { tone: 'warning', text: t('admin_maint_r2_deleting', '删除中（已删 {n}）', { n: st.deleted }) };
  };

  const prefixes = status?.prefixes ?? ['avatar', 'forum', 'site', 'attach', 'seo'];

  return (
    <div className="space-y-3">
      <PageTitle>{t('admin_maint_r2', 'R2 存储维护')}</PageTitle>
      <TabBar active="r2" items={OTHER_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}

      <Card title={t('admin_maint_r2_title', '对象存储体检与清理')} noPadding>
        <Table
          head={[
            t('admin_maint_r2_col_prefix', '前缀'),
            t('admin_maint_r2_col_scanned', '已扫描'),
            t('admin_maint_r2_col_hits', '未引用'),
            t('admin_maint_r2_col_deleted', '已删除'),
            t('admin_maint_r2_col_status', '状态'),
            t('admin_maint_col_action', '操作'),
          ]}
          headCls={['', 'w-[90px] text-center', 'w-[90px] text-center', 'w-[90px] text-center', 'w-[200px]', 'w-[240px] text-center']}
          minWidth="min-w-[900px]"
        >
          {prefixes.map((p) => {
            const st = stateOf(p);
            const badge = stateText(st);
            const scanned = !!st && st.mode === 'scan' && st.done && st.hits > 0;
            const deleting = st?.mode === 'delete';
            return (
              <tr key={p} className="border-b border-line-soft">
                <td className="py-2">
                  <div>{prefixLabel(p)}</div>
                  <div className="mt-0.5 text-xs text-muted-2">
                    <code className="rounded bg-white px-1">{p}/</code>
                  </div>
                </td>
                <td className="py-2 text-center tabular-nums">{st?.scanned ?? 0}</td>
                <td className="py-2 text-center tabular-nums">{st ? st.hits : 0}</td>
                <td className="py-2 text-center tabular-nums">{st?.deleted ?? 0}</td>
                <td className="py-2">
                  <Badge tone={badge.tone}>{badge.text}</Badge>
                  {!!st?.skipped && (
                    <div className="mt-1 text-xs text-muted-2">
                      {t('admin_maint_r2_skipped', '跳过（宽限期/无法判定）{n}', { n: st.skipped })}
                    </div>
                  )}
                </td>
                <td className="py-2 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Button size="sm" variant="default" loading={busy === `scan:${p}`} onClick={() => void doScan(p)}>
                      {t('admin_maint_r2_scan', '扫描')}
                    </Button>
                    {!!st && !(st.done && st.pending.length === 0) && (
                      <Button size="sm" variant="default" loading={busy === `step:${p}`} onClick={() => void doContinue(p)}>
                        {t('admin_maint_r2_step', '继续')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant={scanned || deleting ? 'danger' : 'default'}
                      disabled={!scanned && !deleting}
                      loading={busy === `del:${p}`}
                      onClick={() => setConfirm({ prefix: p, hits: st?.hits ?? 0 })}
                    >
                      <Icon name="trash" />
                      {t('admin_maint_r2_delete', '删除')}
                    </Button>
                    {!!st && (
                      <Button size="sm" variant="default" loading={busy === `reset:${p}`} onClick={() => void doReset(p)}>
                        {t('admin_maint_r2_reset', '重置')}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <Card title={t('admin_maint_r2_note_title', '判定口径与安全边界')}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>{t('admin_maint_r2_note_scope', '只枚举 avatar / forum / site / attach / seo 五个前缀；tmp/ 与任何未知前缀永不触碰（临时文件由 Cron 与桶生命周期规则负责）。上传不足 {n} 小时的对象一律跳过，防止刚上传、还没发帖关联的附件被误删。', { n: status?.minAgeHours ?? 24 })}</li>
          <li>{t('admin_maint_r2_note_confirm', '必须先跑完一次扫描且命中数大于 0，删除按钮才可用；扫描按游标分页推进，中断后进度保留 7 天，可随时继续或重置。')}</li>
        </ul>
      </Card>

      <ConfirmModal
        open={!!confirm}
        loading={!!busy}
        text={
          confirm
            ? t('admin_maint_r2_confirm', '将删除「{prefix}」下判定为未被引用的对象（共 {n} 个），R2 删除不可恢复。确定继续？', {
                prefix: prefixLabel(confirm.prefix),
                n: confirm.hits,
              })
            : ''
        }
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && void doDelete(confirm.prefix)}
      />
    </div>
  );
}
