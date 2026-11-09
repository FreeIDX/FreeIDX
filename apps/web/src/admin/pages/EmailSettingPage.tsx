/**
 * 邮箱设置：SMTP 账号池（Workers 等价实现，§11.3，§19 决策 4）。
 * 形态为 SMTP 服务器池内联表（Email/SMTP Host/Port/Username/Password/删除 多行 + [+]增加一行，
 * 确定后整池重写，发信随机选台）；Workers 版口径：
 *  - cloudflare:sockets 直连（465 隐式 TLS / 587 STARTTLS，其余端口明文仅限本地联调）；
 *  - 发信 round-robin 轮询选账号（单账号免费额度 → N 倍），失败自动顺延下一账号（failover）；
 *  - 密码 AES-GCM 加密落 ext:email:secret、永不回显（只回 hasPass，提交留空即保持原值）。
 * 池为空时自动降级：注册邮箱验证 / 找回密码邮件不发送（基本设置里的开关保留），流程完整可用。
 *
 * 「测试发信」区块：正式发信走 waitUntil，失败只落服务端日志、前台永远提示已发送，
 * 现场排查「注册收不到验证码」只能靠猜。这里按已保存的池同步实发一封，
 * 把每个账号的失败阶段（auth/rcpt/data…）与 SMTP 原文直接显示出来；
 * 同时回显服务端记录的「最近一次发信」（含前台注册发码的真实结果）。
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getEmailSetting, putEmailSetting, testEmailSetting } from '../api';
import type { EmailSettingView, MailReport, SmtpAccountInput } from '../types';
import { apiErrorMessage } from '../../lib/errors';
import { useAdminT } from '../t';
import { useAdminAction } from '../use-action';
import { SETTING_TABS } from '../tabs';
import { Alert, Button, Card, ErrorState, Input, PageTitle, SubmitRow, TabBar } from '../ui';

interface PoolRow {
  from: string;
  host: string;
  port: string;
  user: string;
  limit: string;
  pass: string;
  hasPass: boolean;
}

const emptyRow = (): PoolRow => ({ from: '', host: '', port: '465', user: '', limit: '0', pass: '', hasPass: false });

/** 服务端回包 → 表单行（密码永不下发：只留 hasPass 决定占位文案） */
const rowsOf = (v: EmailSettingView): PoolRow[] =>
  v.pool.length
    ? v.pool.map((a) => ({
        from: a.from,
        host: a.host,
        port: String(a.port),
        user: a.user,
        limit: String(a.dailyLimit ?? 0),
        pass: '',
        hasPass: a.hasPass,
      }))
    : [emptyRow()];

const th = 'px-2 py-2 text-left font-medium text-muted';

/**
 * 一份发信报告：收件人 + 结果 + 逐账号尝试明细（失败时带阶段与 SMTP 原文）。
 * 「注册收不到验证码」靠这块定位：535 是授权码/密码错，550 是发件人被拒，
 * connect 阶段失败是 Cloudflare 运行时拒绝建连（与密码无关，见下方定向提示），
 * 而「全部成功但没收到」则是反垃圾/垃圾邮件箱问题。
 */
function ReportView({ report }: { report: MailReport }) {
  const t = useAdminT();
  /** 连接阶段失败（TCP Loop / 目标被拦截）与凭证无关，给出定向提示，避免管理员反复改密码 */
  const connectFailed = report.attempts.some((a) => !a.ok && a.stage === 'connect');
  return (
    <div className="mt-2 rounded-[6px] border border-line px-3 py-2 text-sm">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={report.ok ? 'font-medium text-success' : 'font-medium text-destructive'}>
          {report.ok ? '✓' : '✗'}
        </span>
        <span className="break-all font-mono text-xs text-ink-soft">{report.to}</span>
        <span className="text-xs text-muted-2">{new Date(report.at * 1000).toLocaleString()}</span>
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
      {connectFailed && (
        <p className="mt-2 rounded-[4px] bg-brand/5 px-2 py-1.5 text-xs leading-relaxed text-ink-soft">
          {t(
            'admin_email_connect_hint',
            '连接阶段失败：Cloudflare 运行时拒绝了到该目标的 TCP 连接（多为「TCP Loop」判定——出站被打回自身或 Cloudflare 网络），与授权码/密码无关。可先改用 587 端口，或换其他 SMTP 服务商验证。',
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
   * 若无条件覆盖就会静默清空正在编辑的 SMTP 池（保存后本地 rows 已是提交值，无需回灌）。
   */
  const initedRef = useRef(false);
  useEffect(() => {
    if (initedRef.current || !loaded) return;
    initedRef.current = true;
    setRows(rowsOf(loaded));
  }, [loaded]);

  const save = useAdminAction(
    () => {
      // 全空行（点了「增加一行」没填）直接丢弃：否则端口 0 会把整池保存打回「第 N 行端口非法」。
      // 全部为空 ⇒ 提交空池 ⇒ 发信降级（注册验证码/找回密码邮件停发，其余功能不受影响）。
      const pool: SmtpAccountInput[] = rows
        .filter((r) => r.from.trim() || r.host.trim() || r.user.trim() || r.pass.trim())
        .map((r) => ({
          from: r.from.trim(),
          host: r.host.trim(),
          port: Number(r.port),
          user: r.user.trim(),
          dailyLimit: Math.floor(Number(r.limit)) || 0,
          pass: r.pass.trim() || undefined,
        }));
      return putEmailSetting(pool);
    },
    {
      ok: t('admin_email_save_ok', '保存成功，发信配置即时生效'),
      invalidate: [['admin', 'email-setting']],
      // 用回包重置表单：清掉已验证保存的明文密码、把 hasPass 刷成最新（否则占位仍显示「授权码/密码」）
      onData: (d) => setRows(rowsOf(d)),
    },
  );

  /**
   * 测试发信：按**已保存**的配置实发一封（后端逐账号尝试并回每个账号的失败阶段 + SMTP 原文）。
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
            '测试按「已保存」的配置逐账号实发（最多 3 个），失败会显示 SMTP 服务商返回的原文；修改后请先点下方「确定」保存。',
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
          {t('admin_email_help', '配置多个 SMTP 账号（推荐 465 隐式 TLS 或 587 STARTTLS 端口；25 端口在 Cloudflare Workers 上被封禁）。发送时在多账号间轮询分摊额度，单个账号失败自动切换下一个；每个账号可设每日发送上限（0 为不限），当天达到上限后自动跳过该账号改用其他账号，次日自动恢复。全部账号留空则注册邮箱验证与找回密码邮件不发送（其余功能不受影响）。')}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[780px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className={`${th} w-[21%]`}>{t('admin_email_from', '发件地址')}</th>
                <th className={`${th} w-[19%]`}>{t('admin_email_host', 'SMTP 服务器')}</th>
                <th className={`${th} w-[9%]`}>{t('port', '端口')}</th>
                <th className={`${th} w-[15%]`}>{t('username', '用户名')}</th>
                <th className={`${th} w-[12%]`}>{t('admin_email_daily_limit', '每日限额')}</th>
                <th className={`${th} w-[18%]`}>{t('password', '密码')}</th>
                <th className={`${th} w-[6%]`}>{t('delete', '删除')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-b border-line-soft last:border-0">
                  <td className="px-2 py-2">
                    <Input type="email" value={r.from} placeholder="no-reply@example.com" onChange={(e) => patch(i, { from: e.target.value })} />
                  </td>
                  <td className="px-2 py-2">
                    <Input value={r.host} placeholder="smtp.example.com" onChange={(e) => patch(i, { host: e.target.value })} />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      type="number"
                      min={1}
                      max={65535}
                      value={r.port}
                      placeholder="465"
                      onChange={(e) => patch(i, { port: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input value={r.user} placeholder={t('admin_email_login_account', '登录账号')} onChange={(e) => patch(i, { user: e.target.value })} />
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
                      value={r.pass}
                      placeholder={r.hasPass ? t('admin_email_pass_configured', '已配置——留空保持不变') : t('admin_email_pass_authcode', '授权码/密码')}
                      onChange={(e) => patch(i, { pass: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-2 text-center">
                    {/* 允许删到空：空池 = 发信降级（注册验证码/找回密码邮件停发），是文档化的关闭方式；
                        此前限制「至少保留一行」会让后台永远关不掉邮件功能。 */}
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

        <SubmitRow>
          <Button block loading={save.pending} onClick={() => save.mutate()}>
            {t('confirm', '确定')}
          </Button>
        </SubmitRow>
      </Card>
      <p className="text-xs text-muted-2">
        {t('admin_email_note', '注：密码仅加密存储、永不回显。QQ/163 等个人邮箱需在邮箱设置里开启 SMTP 并使用「授权码」作为密码；发件地址须与登录账号一致（多数服务商强制校验）。')}
      </p>
    </div>
  );
}
