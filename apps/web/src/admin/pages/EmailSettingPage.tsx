/**
 * 邮箱设置：SMTP 账号池（Workers 等价实现，§11.3，§19 决策 4）。
 * 形态为 SMTP 服务器池内联表（Email/SMTP Host/Port/Username/Password/删除 多行 + [+]增加一行，
 * 确定后整池重写，发信随机选台）；Workers 版口径：
 *  - cloudflare:sockets 直连（465 隐式 TLS / 587 STARTTLS，其余端口明文仅限本地联调）；
 *  - 发信 round-robin 轮询选账号（单账号免费额度 → N 倍），失败自动顺延下一账号（failover）；
 *  - 密码 AES-GCM 加密落 ext:email:secret、永不回显（只回 hasPass，提交留空即保持原值）。
 * 池为空时自动降级：注册邮箱验证 / 找回密码邮件不发送（基本设置里的开关保留），流程完整可用。
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getEmailSetting, putEmailSetting } from '../api';
import type { EmailSettingView, SmtpAccountInput } from '../types';
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

  if (q.isError) return <ErrorState error={q.error} />;

  const patch = (i: number, p: Partial<PoolRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));

  return (
    <div className="space-y-3">
      <PageTitle>{t('admin_site_setting', '站点设置')}</PageTitle>
      <TabBar active="email" items={SETTING_TABS.map((x) => ({ k: x.k, to: x.to, text: t(x.textKey, x.fallback) }))} />
      {save.flash && <Alert tone={save.flash.tone}>{save.flash.text}</Alert>}
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
