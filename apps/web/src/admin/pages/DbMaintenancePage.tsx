/**
 * 运行维护 · 数据库维护。
 *
 * 只清「指向已不存在实体的孤儿行」与「已过期的失效行」，且全部按小批量执行：
 *  - 体检（overview）是全表扫描，服务端缓存 1 小时；「重新体检」才重扫。
 *  - 清理一次最多推进 8 批（服务端上限），done=false 时页面显示「再次清理（剩余 N）」。
 *  - 财务/审计数据（积分流水、订单、购买记录、版务日志）不提供清理入口，避免不可逆的账目丢失。
 */
import { useState } from 'react';
import { CONTENT_LANG_NATIVE_NAMES, type AdminKey, type ContentLang } from '@freeidx/shared';
import { backfillMaintContentLang, getMaintLangStats, getMaintOverview, runMaintCronJob, runMaintDbTask } from '../api';
import type { MaintDbRunResult, MaintLangStats, MaintOverview } from '../types';
import { useAdminT } from '../t';
import { apiErrorMessage } from '../../lib/errors';
import { Icon } from '../../components/icons';
import { OTHER_TABS } from '../tabs';
import { Alert, Badge, Button, Card, ConfirmModal, Modal, PageTitle, TabBar, Table } from '../ui';

/** 与后端 CRON_JOBS 对齐的立即执行项 */
const CRON_JOBS = ['session', 'calibrate', 'cache_gc', 'email_code', 'queue', 'attach_tmp'] as const;

/** 每批上限（与后端 DB_TASKS.batch 同口径；仅用于确认文案） */
const BATCH_HINT: Record<string, number> = { attach_orphan: 20 };

type Flash = { tone: 'ok' | 'warn'; text: string };

export function DbMaintenancePage() {
  const t = useAdminT();
  const [overview, setOverview] = useState<MaintOverview | null>(null);
  const [probing, setProbing] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ task: string; rows: Record<string, unknown>[] } | null>(null);
  const [confirm, setConfirm] = useState<{ task: string; count: number; capped: boolean } | null>(null);
  const [lastRun, setLastRun] = useState<Record<string, MaintDbRunResult>>({});
  /** 内容语言回填：最近一次剩余量（null = 本次会话尚未跑过） */
  const [langRemaining, setLangRemaining] = useState<number | null>(null);
  /** 内容语言分布：按需统计（全表聚合，不自动加载） */
  const [langStats, setLangStats] = useState<MaintLangStats | null>(null);

  const taskLabel = (id: string): string => t(('admin_maint_task_' + id) as AdminKey, id);
  const riskLabel = (risk: 1 | 2): string =>
    risk === 2 ? t('admin_maint_risk_2', '中（涉及 R2 对象）') : t('admin_maint_risk_1', '低（社交/倒排孤儿）');

  const probe = async (refresh: boolean): Promise<void> => {
    setProbing(true);
    setFlash(null);
    try {
      setOverview(await getMaintOverview(refresh));
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    } finally {
      setProbing(false);
    }
  };

  const doPreview = async (task: string): Promise<void> => {
    setBusy(`preview:${task}`);
    setFlash(null);
    try {
      const r = await runMaintDbTask(task, { dryRun: true });
      setPreview({ task, rows: r.samples ?? [] });
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const doClean = async (task: string): Promise<void> => {
    setConfirm(null);
    setBusy(`run:${task}`);
    setFlash(null);
    try {
      const r = await runMaintDbTask(task, { batches: 8 });
      setLastRun((prev) => ({ ...prev, [task]: r }));
      if (r.deleted === 0) {
        setFlash({ tone: 'ok', text: t('no_data_to_process') });
      } else {
        setFlash({
          tone: 'ok',
          text: t('admin_maint_clean_done', '已删除 {n} 条，剩余约 {left} 条', { n: r.deleted, left: r.capped ? `${r.remaining}+` : r.remaining }),
        });
      }
      setOverview(await getMaintOverview(true));
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const doCron = async (job: string): Promise<void> => {
    setBusy(`cron:${job}`);
    setFlash(null);
    try {
      const r = await runMaintCronJob(job);
      setFlash({ tone: 'ok', text: t('admin_maint_cron_done', '已执行，影响 {n} 项', { n: r.affected }) });
      setOverview(await getMaintOverview(true));
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  /* 存量主题内容语言回填：前端循环推进（每轮服务端 20 条 / 3 条查询），最多 10 轮即 200 条 */
  const doLangBackfill = async (): Promise<void> => {
    setBusy('lang');
    setFlash(null);
    let updated = 0;
    let left = 0;
    try {
      for (let i = 0; i < 10; i++) {
        const r = await backfillMaintContentLang(20);
        updated += r.updated;
        left = r.remaining;
        if (r.done || r.scanned === 0) break;
      }
      setLangRemaining(left);
      setFlash({
        tone: 'ok',
        text: t('admin_maint_lang_done', '本轮已回填 {n} 条，剩余 {left} 条', { n: updated, left }),
      });
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  /* 语言分布：全表聚合，服务端缓存 10 分钟；「刷新」强制重算 */
  const doLangStats = async (refresh: boolean): Promise<void> => {
    setBusy('langStats');
    setFlash(null);
    try {
      setLangStats(await getMaintLangStats(refresh));
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const rows = overview?.tasks ?? [];

  return (
    <div className="space-y-3">
      <PageTitle>{t('admin_maint_db', '数据库维护')}</PageTitle>
      <TabBar active="db" items={OTHER_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {flash && <Alert tone={flash.tone}>{flash.text}</Alert>}

      <Card
        title={t('admin_maint_db_probe_title', '数据库体检')}
        tools={
          <>
            <Button size="sm" variant="default" loading={probing} onClick={() => void probe(false)}>
              <Icon name="database" />
              {t('admin_maint_probe', '开始体检')}
            </Button>
            <Button size="sm" variant="default" loading={probing} onClick={() => void probe(true)}>
              <Icon name="refresh" />
              {t('admin_maint_reprobe', '重新体检')}
            </Button>
          </>
        }
        noPadding
      >
        <Table
          head={[
            t('admin_maint_col_task', '检查项'),
            t('admin_maint_col_risk', '风险'),
            t('admin_maint_col_hits', '检出'),
            t('admin_maint_col_action', '操作'),
          ]}
          headCls={['', 'w-[150px] text-center', 'w-[110px] text-center', 'w-[220px] text-center']}
          minWidth="min-w-[720px]"
        >
          {rows.map((r) => {
            const run = lastRun[r.id];
            const more = !!run && !run.done && run.remaining > 0;
            return (
              <tr key={r.id} className="border-b border-line-soft">
                <td className="py-2">
                  <div>{taskLabel(r.id)}</div>
                  <div className="mt-0.5 text-xs text-muted-2">
                    <code className="rounded bg-white px-1">{r.id}</code>
                  </div>
                </td>
                <td className="py-2 text-center">
                  <Badge tone={r.risk === 2 ? 'warning' : 'secondary'}>{riskLabel(r.risk)}</Badge>
                </td>
                <td className="py-2 text-center tabular-nums">
                  {r.count === 0 ? <span className="text-muted-2">0</span> : `${r.count}${r.capped ? '+' : ''}`}
                </td>
                <td className="py-2 text-center">
                  <div className="flex items-center justify-center gap-1">
                    <Button size="sm" variant="default" loading={busy === `preview:${r.id}`} onClick={() => void doPreview(r.id)}>
                      {t('admin_maint_preview', '预览')}
                    </Button>
                    <Button
                      size="sm"
                      variant={r.count > 0 || more ? 'danger' : 'default'}
                      disabled={r.count === 0 && !more}
                      loading={busy === `run:${r.id}`}
                      onClick={() => setConfirm({ task: r.id, count: r.count, capped: r.capped })}
                    >
                      <Icon name="trash" />
                      {more ? t('admin_maint_clean_again', '再次清理（剩余 {n}）', { n: run?.capped ? `${run.remaining}+` : run?.remaining }) : t('admin_maint_clean', '清理')}
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </Table>
        {!rows.length && (
          <p className="px-4 py-6 text-center text-sm text-muted">
            {t('admin_maint_probe_empty', '点击「开始体检」扫描一次。体检是全表扫描，结果缓存 1 小时。')}
          </p>
        )}
      </Card>

      {/* 内容语言分布：按需全表聚合（服务端缓存 10 分钟），用于判断是否值得进入分区模式 */}
      <Card
        title={t('admin_maint_lang_stats_title', '内容语言分布')}
        tools={
          /* 首次点击可命中 10 分钟内缓存；已有结果时再点视为强制重算 */
          <Button
            size="sm"
            variant="default"
            loading={busy === 'langStats'}
            onClick={() => void doLangStats(langStats !== null)}
          >
            <Icon name="refresh" />
            {t('admin_maint_lang_stats_run', '统计')}
          </Button>
        }
        noPadding
      >
        <p className="px-4 py-3 text-sm text-muted">{t('admin_maint_lang_stats_help', '按内容语言统计主题总数与近 30 天新增，用于判断是否值得开启语言分区。统计是全表聚合，结果缓存 10 分钟，按需点击即可。')}</p>
        {langStats ? (
          <Table
            head={[
              t('admin_maint_lang_stats_col_lang', '语言'),
              t('admin_maint_lang_stats_col_total', '主题数'),
              t('admin_maint_lang_stats_col_recent', '近 30 天'),
              t('admin_maint_lang_stats_col_share', '占比'),
            ]}
            headCls={['', 'w-[120px] text-center', 'w-[120px] text-center', 'w-[100px] text-center']}
            minWidth="min-w-[560px]"
          >
            {langStats.rows.map((r) => (
              <tr key={r.lang || 'unknown'} className="border-b border-line-soft">
                <td className="py-2">
                  {r.lang
                    ? (CONTENT_LANG_NATIVE_NAMES[r.lang as ContentLang] ?? r.lang)
                    : t('admin_maint_lang_stats_unknown', '未标注')}
                </td>
                <td className="py-2 text-center tabular-nums">{r.total}</td>
                <td className="py-2 text-center tabular-nums">{r.recent}</td>
                <td className="py-2 text-center tabular-nums">
                  {langStats.total ? ((r.total / langStats.total) * 100).toFixed(1) : '0.0'}%
                </td>
              </tr>
            ))}
            {!langStats.rows.length && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-sm text-muted">
                  {t('admin_maint_lang_stats_idle', '暂无主题数据')}
                </td>
              </tr>
            )}
          </Table>
        ) : (
          <p className="px-4 pb-4 text-sm text-muted">{t('admin_maint_lang_stats_idle', '暂无主题数据')}</p>
        )}
      </Card>

      {/* 内容语言回填：为存量帖补算 lang，回填完成后才建议开启「内容语言分区」 */}
      <Card
        title={t('admin_maint_lang_title', '内容语言回填')}
        tools={
          <Button size="sm" variant="default" loading={busy === 'lang'} onClick={() => void doLangBackfill()}>
            <Icon name="refresh" />
            {t('admin_maint_lang_run', '回填一批')}
          </Button>
        }
      >
        <p className="mb-2 text-sm text-muted">
          {t(
            'admin_maint_lang_help',
            '为存量主题按「标题 + 首帖正文」补算内容语言（与发帖时同一检测函数）。分小批执行，可重复点击直到剩余为 0。新帖发帖时已自动定稿，无需回填。',
          )}
        </p>
        {langRemaining !== null && (
          <p className="text-sm">
            {langRemaining > 0
              ? t('admin_maint_lang_left', '仍剩 {left} 条未回填，继续点击「回填一批」', { left: langRemaining })
              : t('admin_maint_lang_all_done', '存量主题已全部回填完成。现在可以到「基本设置 → 内容语言分区」开启过滤。')}
          </p>
        )}
      </Card>

      <Card title={t('admin_maint_cron_title', '立即执行定时任务')}>
        <p className="mb-3 text-sm text-muted">{t('admin_maint_cron_help', '这些任务平时由 Cron 自动执行，这里只用于「不到点但想马上跑一次」。实现与定时任务同一份代码，不会出现两套口径。')}</p>
        <div className="flex flex-wrap gap-2">
          {CRON_JOBS.map((job) => (
            <Button key={job} size="sm" variant="default" loading={busy === `cron:${job}`} onClick={() => void doCron(job)}>
              <Icon name="refresh" />
              {t(('admin_maint_cron_' + job) as AdminKey, job)}
            </Button>
          ))}
        </div>
      </Card>

      <Card title={t('admin_maint_db_note_title', '清理口径说明')}>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li>{t('admin_maint_db_note_orphan', '「孤儿」= 指向已不存在主题/楼层/用户的行。回收站中的主题仍在表里，因此不会被误清。')}</li>
          <li>{t('admin_maint_db_note_money', '积分流水、订单、购买记录、版务日志属于账目与审计数据，本页永不清除。')}</li>
          <li>{t('admin_maint_db_note_attach', '附件孤儿会先删 R2 对象、成功后才删数据行；付费附件（有售价）一律跳过。')}</li>
        </ul>
      </Card>

      <Modal
        open={!!preview}
        title={t('admin_maint_preview', '预览')}
        onClose={() => setPreview(null)}
        footer={
          <Button variant="default" onClick={() => setPreview(null)}>
            {t('close', '关闭')}
          </Button>
        }
        wide
      >
        <p className="mb-2 text-sm text-muted">{preview ? taskLabel(preview.task) : ''}</p>
        {preview && preview.rows.length > 0 ? (
          <ul className="max-h-[360px] space-y-1 overflow-auto text-xs">
            {preview.rows.map((row, i) => (
              <li key={i} className="rounded bg-line-soft/40 px-2 py-1 font-mono">
                {Object.entries(row)
                  .map(([k, v]) => `${k}=${String(v)}`)
                  .join('  ')}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t('admin_maint_preview_empty', '未检出任何记录')}</p>
        )}
      </Modal>

      <ConfirmModal
        open={!!confirm}
        loading={!!busy}
        text={
          confirm
            ? t('admin_maint_clean_confirm', '将分批删除「{task}」命中的记录（每批最多 {batch} 条），删除后不可恢复。确定继续？', {
                task: taskLabel(confirm.task),
                batch: BATCH_HINT[confirm.task] ?? 200,
              })
            : ''
        }
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && void doClean(confirm.task)}
      />
    </div>
  );
}
