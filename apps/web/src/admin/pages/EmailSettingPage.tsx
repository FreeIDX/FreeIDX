/**
 * 邮箱设置：HTTP 邮件 API 账号池（§11.3）。
 *
 * 为什么只有 HTTP 通道：部分 Worker 出站环境把到 SMTP 的 TCP 连接判为「TCP Loop」直接拒绝
 * （DNS 正常、465/587 全败，与授权码无关），只有 443 的 HTTPS API 能发信。SMTP 客户端已移除。
 *
 * 形态为账号池内联表（服务商 / 发件地址 / 接口地址 / 每日限额 / API Key / 删除 多行 + [+]增加一行，
 * 确定后整池重写）：
 *  - 发信 round-robin 轮询选账号（单账号免费额度 → N 倍），失败自动顺延下一账号（failover）；
 *  - 每账号可设每日发送上限，达到后当天轮询跳过、次日恢复；
 *  - Key AES-GCM 加密落 ext:email:secret、永不回显（只回 hasKey，提交留空即按账号身份保持原值）。
 * 池为空时自动降级：注册邮箱验证 / 找回密码邮件不发送（基本设置里的开关保留），流程完整可用。
 *
 * 「测试发信」区块：正式发信走 waitUntil，失败只落服务端日志、前台永远提示已发送，
 * 现场排查「注册收不到验证码」只能靠猜。这里按已保存的池同步实发一封，
 * 把每个账号的失败阶段（http / rate-limit / timeout…）与服务商原文直接显示出来；
 * 同时回显服务端记录的「最近一次发信」（含前台注册发码的真实结果）。
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getEmailSetting, putEmailSetting, testEmailSetting } from '../api';
import type { EmailSettingView, HttpMailProvider, MailAccountInput, MailReport } from '../types';
import { apiErrorMessage } from '../../lib/errors';
import { fmtDate } from '../../lib/api';
import { useAdminT } from '../t';
import { useAdminAction } from '../use-action';
import { SETTING_TABS } from '../tabs';
import { Alert, Button, Card, ErrorState, Input, PageTitle, Select, SubmitRow, TabBar } from '../ui';

interface PoolRow {
  provider: HttpMailProvider | '';
  from: string;
  url: string;
  limit: string;
  key: string;
  hasKey: boolean;
}

const emptyRow = (): PoolRow => ({ provider: 'resend', from: '', url: '', limit: '0', key: '', hasKey: false });

/** 服务端回包 → 表单行（Key 永不下发：只留 hasKey 决定占位文案） */
const rowsOf = (v: EmailSettingView): PoolRow[] =>
  v.pool.length
    ? v.pool.map((a) => ({
        provider: a.provider,
        from: a.from,
        url: a.url,
        limit: String(a.dailyLimit ?? 0),
        key: '',
        hasKey: a.hasKey,
      }))
    : [emptyRow()];

const th = 'px-2 py-2 text-left font-medium text-muted';

const PROVIDERS: HttpMailProvider[] = ['resend', 'sendgrid', 'brevo', 'custom'];
/** 下拉显示名（服务商品牌名不翻译） */
const PROVIDER_LABEL: Record<HttpMailProvider, string> = {
  resend: 'Resend',
  sendgrid: 'SendGrid',
  brevo: 'Brevo',
  custom: 'custom',
};

/**
 * 一份发信报告：收件人 + 结果 + 逐账号尝试明细（失败时带阶段与服务商原文）。
 * 「注册收不到验证码」靠这块定位：HTTP 401/403 是 Key 无效或发件域名未验证，
 * 429 是限流（换账号即可绕开），timeout/network 则说明请求结果未知、系统不会换号重发。
 */
function ReportView({ report }: { report: MailReport }) {
  const t = useAdminT();
  /** 结果未知的失败（超时/网络中断）：请求可能已被受理，不换号重发是刻意的 */
  const ambiguous = report.attempts.some((a) => !a.ok && (a.stage === 'timeout' || a.stage === 'network'));
  return (
    <div className="mt-2 rounded-[6px] border border-line px-3 py-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={report.ok ? 'font-medium text-success' : 'font-medium text-destructive'}>
          {report.ok ? '✓' : '✗'}
        </span>
        <span className="break-all font-mono text-xs text-ink-soft">{report.to}</span>
        <span className="text-xs text-muted-2">{fmtDate(report.at)}</span>
      </div>
      {report.attempts.length > 0 && (
        <ul className="mt-2 space-y-1">
          {report.attempts.map((a, i) => (
            <li key={`${a.account}-${i}`} className="flex flex-wrap items-baseline gap-2 text-xs">
              <span className={a.ok ? 'text-success' : 'text-destructive'}>{a.ok ? '✓' : '✗'}</span>
              <span className="font-mono text-ink-soft">{a.account}</span>
              {a.stage && <span className="rounded bg-line-soft px-1 text-[11px] text-muted">{a.stage}</span>}
              {a.error && <span className="break-all text-destructive">{a.error}</span>}
            </li>
          ))}
        </ul>
      )}
      {ambiguous && (
        <p className="mt-2 rounded-[4px] bg-brand/5 px-2 py-1.5 text-xs leading-relaxed text-ink-soft">
          {t(
            'admin_email_ambiguous_hint',
            '超时/网络中断时结果未知（服务商可能已受理），系统不会换号重发，避免同一个人收到两封。请先到收件箱确认，再决定是否稍后手动重试。',
          )}
        </p>
      )}
    </div>
  );
}

export function EmailSettingPage() {
  const t = useAdminT();
  const q = useQuery({ queryKey: ['admin', 'email-setting'], queryFn: getEmailSetting });
  const [rows, setRows] = useState<PoolRow[]>([emptyRow()]);
  const loaded = q.data;
  /**
   * 仅首次装载灌入表单：任何来源的重取（invalidate，以及全局 refetchOnWindowFocus 若恢复开启）都会拿到新 q.data，
   * 若无条件覆盖就会静默清空正在编辑的账号池（保存后本地 rows 已是提交值，无需回灌）。
   */
  const initedRef = useRef(false);
  useEffect(() => {
    if (initedRef.current || !loaded) return;
    initedRef.current = true;
    setRows(rowsOf(loaded));
  }, [loaded]);

  const save = useAdminAction(
    () => {
      // 全空行（点了「增加一行」没填）直接丢弃：否则服务端会把它当成「缺发件地址」整池驳回。
      // 全部为空 ⇒ 提交空池 ⇒ 发信降级（注册验证码/找回密码邮件停发，其余功能不受影响）。
      const pool: MailAccountInput[] = rows
        .filter((r) => r.from.trim() || r.key.trim() || r.url.trim())
        .map((r) => ({
          provider: r.provider as HttpMailProvider,
          from: r.from.trim(),
          url: r.provider === 'custom' ? r.url.trim() : '',
          dailyLimit: Math.floor(Number(r.limit)) || 0,
          // 留空 = 保持原 Key（服务端按账号身份 provider+from 匹配，与密码同口径）
          key: r.key.trim() || undefined,
        }));
      return putEmailSetting(pool);
    },
    {
      ok: t('admin_email_save_ok', '保存成功，发信配置即时生效'),
      invalidate: [['admin', 'email-setting']],
      // 用回包重置表单：清掉已验证保存的明文 Key、把 hasKey 刷成最新
      onData: (d) => setRows(rowsOf(d)),
    },
  );

  /**
   * 测试发信：按**已保存**的配置实发一封（后端逐账号尝试并回每个账号的失败阶段 + 服务商原文）。
   * 与「保存」分开：测试不应改动任何配置，也不能因为表单里有未保存的改动就测出与实际运行不一致的结果。
   */
  const [testTo, setTestTo] = useState('');
  const [testReport, setTestReport] = useState<MailReport | null>(null);
  const [testNotice, setTestNotice] = useState('');
  const [testErr, setTestErr] = useState('');
  const qc = useQueryClient();
  const test = useMutation<MailReport, unknown, void>({
    mutationFn: () => testEmailSetting(testTo.trim() || undefined),
    onSuccess: (d) => {
      setTestErr('');
      setTestReport(d);
      setTestNotice(
        d.ok ? t('admin_email_test_ok', '测试邮件已发出，请到 {to} 查收（也请检查垃圾邮件箱）', { to: d.to }) : t('admin_email_test_fail', '测试发信失败，失败原因见下方每个账号'),
      );
      // 后端同时把这一封记为「最近一次发信」，重取一次让回显卡片与报告一致
      void qc.invalidateQueries({ queryKey: ['admin', 'email-setting'] });
    },
    onError: (e) => {
      setTestReport(null);
      setTestNotice('');
      setTestErr(apiErrorMessage(e));
    },
  });
  /** 报告展示优先级：本次测试结果 > 服务端记录的最近一次发信（含前台注册发码的真实结果） */
  const shownReport = testReport ?? loaded?.last ?? null;

  if (q.isError) return <ErrorState error={q.error} />;

  const patch = (i: number, p: Partial<PoolRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <div className="space-y-3">
      <PageTitle>{t('admin_site_setting', '站点设置')}</PageTitle>
      <TabBar active="email" items={SETTING_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {save.flash && <Alert tone={save.flash.tone}>{save.flash.text}</Alert>}

      {/* 测试邮箱：注册验证码收不到时，先在这里确认「服务商到底回了什么」 */}
      <Card title={t('admin_email_test_send', '发送测试邮件')} bodyClass="space-y-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[16rem] flex-1">
            <label className="mb-1 block text-sm text-muted" htmlFor="email-test-to">
              {t('admin_email_test_to', '测试收件邮箱')}
            </label>
            <Input
              id="email-test-to"
              type="email"
              value={testTo}
              placeholder="you@example.com"
              autoComplete="off"
              onChange={(e) => setTestTo(e.target.value)}
            />
          </div>
          <Button variant="default" loading={test.isPending} onClick={() => test.mutate()}>
            {t('admin_email_test_send', '发送测试邮件')}
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-2">
          {t(
            'admin_email_test_hint',
            '测试按「已保存」的配置逐账号实发（最多 3 个），失败会显示服务商返回的原文；修改后请先点下方「确定」保存。',
          )}
        </p>
        {testErr && <Alert tone="warn">{testErr}</Alert>}
        {testNotice && <Alert tone={testReport?.ok ? 'ok' : 'warn'}>{testNotice}</Alert>}
        <p className="pt-1 text-sm text-muted">{t('admin_email_last_result', '最近一次发信')}</p>
        {shownReport ? (
          <ReportView report={shownReport} />
        ) : (
          <p className="text-xs text-muted-2">
            {t('admin_email_last_none', '暂无发信记录（保存配置后可点「发送测试邮件」验证）')}
          </p>
        )}
      </Card>

      <Card>
        <div className="mb-[1rem] rounded-[6px] bg-brand/5 px-3 py-2 text-sm leading-relaxed text-ink-soft">
          {t('admin_email_help', '配置多个 HTTP 邮件 API 账号（同一服务商多账号或跨服务商均可）。发送时轮询分摊额度，单个账号失败自动顺延下一个；每个账号可设每日发送上限（0 为不限），当天达到上限后自动跳过该账号，次日恢复。全部留空则注册邮箱验证与找回密码邮件不发送（其余功能不受影响）。')}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className={`${th} w-[14%]`}>{t('admin_email_http_provider', '服务商')}</th>
                <th className={`${th} w-[22%]`}>{t('admin_email_from', '发件地址')}</th>
                <th className={`${th} w-[22%]`}>{t('admin_email_http_url', '接口地址（https）')}</th>
                <th className={`${th} w-[11%]`}>{t('admin_email_daily_limit', '每日限额')}</th>
                <th className={`${th} w-[22%]`}>{t('admin_email_http_key', 'API Key')}</th>
                <th className={`${th} w-[9%]`}>{t('delete', '删除')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-line-soft last:border-0">
                  <td className="px-2 py-2">
                    <Select
                      value={r.provider}
                      onChange={(e) => patch(i, { provider: e.target.value as HttpMailProvider })}
                    >
                      {r.provider === '' && (
                        <option value="">{t('admin_email_provider_required', '请选择服务商')}</option>
                      )}
                      {PROVIDERS.map((p) => (
                        <option key={p} value={p}>
                          {p === 'custom' ? t('admin_email_http_custom', '自定义接口') : PROVIDER_LABEL[p]}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="email"
                      value={r.from}
                      placeholder="no-reply@example.com"
                      onChange={(e) => patch(i, { from: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      value={r.url}
                      placeholder="https://mail.example.com/send"
                      autoComplete="off"
                      disabled={r.provider !== 'custom'}
                      onChange={(e) => patch(i, { url: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      min={0}
                      max={100000}
                      value={r.limit}
                      placeholder={t('admin_email_limit_placeholder', '0 = 不限')}
                      onChange={(e) => patch(i, { limit: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="password"
                      autoComplete="new-password"
                      spellCheck={false}
                      value={r.key}
                      placeholder={r.hasKey ? t('admin_email_key_configured', '已配置——留空保持不变') : 'API Key'}
                      onChange={(e) => patch(i, { key: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-2 text-center">
                    {/* 允许删到空：空池 = 发信降级（注册验证码/找回密码邮件停发），是文档化的关闭方式 */}
                    <button
                      type="button"
                      className="text-sm text-brand hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                    >
                      {t('delete', '删除')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <button
          type="button"
          className="mt-2 text-sm text-brand hover:underline"
          onClick={() => setRows((rs) => [...rs, emptyRow()])}
        >
          [+]{t('add_line', '增加一行')}
        </button>
      </Card>

      <SubmitRow indentClass="">
        <Button block loading={save.pending} onClick={() => save.mutate()}>
          {t('confirm', '确定')}
        </Button>
      </SubmitRow>
      <p className="text-xs text-muted-2">
        {t(
          'admin_email_note',
          '注：API Key 仅加密存储、永不回显。发件地址必须已在服务商侧验证（自有域名最佳），QQ/163 等个人邮箱多数服务商不支持；免费额度与速率限制按账号计算，跨服务商配置可互为备份。',
        )}
      </p>
    </div>
  );
}
