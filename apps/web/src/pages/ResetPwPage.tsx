import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../store/auth';
import { confirmPasswordReset, requestPasswordReset } from '../lib/api';
import { apiErrorMessage } from '../lib/errors';
import { md5 } from '../lib/md5';
import { Turnstile } from '../components/Turnstile';
import { authSubmitCls, AuthAnnouncement } from '../components/AuthForms';
import { IconInput } from '../components/ui';
import { Icon } from '../components/icons';
import { useT } from '../lib/i18n';
import { useLight } from '../store/theme';

/**
 * 找回密码（§4.7，两步 token 流）：
 *  ① GET /resetpw：Email + Turnstile → POST /api/auth/password-reset/request（发放一次性 token 并发信）。
 *  ② 邮件链接 /reset-password?email=…&token=… → 识别 query → 邮箱只读 + 新密码 + 重复新密码 → POST /api/auth/password-reset/confirm。
 *  版式同登录/注册：900px 白卡两栏。
 */
export function ResetPwPage() {
  const t = useT();
  const light = useLight();
  const [params] = useSearchParams();
  const setting = useAuth((s) => s.setting);
  const emailFromLink = params.get('email') ?? '';
  const token = params.get('token') ?? '';
  const isConfirmStep = emailFromLink !== '' && token !== '';

  const [email, setEmail] = useState(emailFromLink);
  const [turnstile, setTurnstile] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    setNotice('');
    try {
      if (isConfirmStep) {
        if (password !== password2) {
          setErr(t('repeat_password_incorrect'));
          return;
        }
        await confirmPasswordReset({ email: emailFromLink, token, password: md5(password) });
        setDone(true);
      } else {
        await requestPasswordReset({ email, turnstileToken: turnstile || undefined });
        setNotice(t('reset_email_sent'));
      }
    } catch (ex) {
      setErr(apiErrorMessage(ex));
    } finally {
      setBusy(false);
    }
  };

  /** 提交按钮（整行主色大按钮） */
  const submitButton = (
    <button
      type="submit"
      className={authSubmitCls}
      disabled={busy || (isConfirmStep ? password.length < 6 || !password2 : !email)}
    >
      {busy ? (
        <span className="inline-flex items-center justify-center gap-1.5">
          <Icon name="refresh" className="size-4 animate-spin" />
          {t('submitting')}
        </span>
      ) : (
        t('next_step')
      )}
    </button>
  );

  return (
    <div className="flex min-h-[calc(100vh_-_10rem)] items-center justify-center py-10">
      <section className="zh-card mx-auto w-full max-w-[900px] overflow-hidden">
        <div className="flex">
          {/* 左栏：登录背景图（<lg 隐藏） */}
          <div
            className={
              light.loginPageBanner
                ? 'hidden w-1/2 bg-cover bg-center lg:block'
                : 'hidden w-1/2 bg-[url(/theme-light/login_bg.webp)] bg-cover bg-center lg:block'
            }
            style={light.loginPageBanner ? { backgroundImage: `url(${light.loginPageBanner})` } : undefined}
            aria-hidden="true"
          />
          {/* 右栏：表单 */}
          <div className="relative flex-1 p-8 lg:p-12">
            {/* 右上角装饰图 */}
            <div
              className="pointer-events-none absolute right-0 top-0 size-[400px] bg-[url(/theme-light/login_top_bg.webp)] bg-contain bg-no-repeat opacity-70"
              aria-hidden="true"
            />
            <div className="relative">
              {/* 站点 logo/站名，点击回首页 */}
              <Link to="/" className="mb-6 flex items-center gap-2" aria-label={setting?.sitename || 'FreeIDX'}>
                {setting?.logo_url ? (
                  <img src={String(setting.logo_url)} alt={setting.sitename} className="h-9 w-auto max-w-none" />
                ) : (
                  <span className="text-lg font-bold text-brand">{setting?.sitename || 'FreeIDX'}</span>
                )}
              </Link>
              <p className="text-sm text-lt-grey">{t('resetpw')}</p>
              <AuthAnnouncement />

              {done ? (
                <>
                  <h2 className="mt-2 text-xl font-bold text-success">{t('resetpw_success')}</h2>
                  <div className="mt-6 text-right text-sm">
                    <Link to="/login" className="text-brand hover:underline">
                      {t('go_login')}
                    </Link>
                  </div>
                </>
              ) : isConfirmStep ? (
                <>
                  <h2 className="mt-2 text-xl font-bold text-foreground">{t('set_new_password_for', { email: emailFromLink })}</h2>
                  <form className="mt-5 mb-6 space-y-3" onSubmit={(e) => void submit(e)}>
                    {/* 邮箱只读 */}
                    <IconInput icon="envelope" id="reset-email-ro" type="email" value={emailFromLink} readOnly disabled />
                    <IconInput
                      icon="lock"
                      id="reset-new-pw"
                      type="password"
                      placeholder={t('password_new')}
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <IconInput
                      icon="lock"
                      id="reset-new-pw2"
                      type="password"
                      placeholder={t('password_new_repeat')}
                      autoComplete="new-password"
                      value={password2}
                      onChange={(e) => setPassword2(e.target.value)}
                    />
                    {err && <p className="text-sm text-destructive">{err}</p>}
                    {submitButton}
                  </form>
                  <div className="text-right text-sm">
                    <Link to="/login" className="text-brand hover:underline">
                      {t('back_to_login')}
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <h2 className="mt-2 text-xl font-bold text-foreground">{t('input_email_send_link')}</h2>
                  <form className="mt-5 mb-6 space-y-3" onSubmit={(e) => void submit(e)}>
                    <IconInput
                      icon="envelope"
                      id="reset-email"
                      type="email"
                      placeholder={t('email')}
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                    <Turnstile onToken={setTurnstile} />
                    {notice && <p className="text-sm text-success">{notice}</p>}
                    {err && <p className="text-sm text-destructive">{err}</p>}
                    {submitButton}
                  </form>
                  <div className="text-right text-sm">
                    <Link to="/login" className="text-brand hover:underline">
                      {t('back_to_login')}
                    </Link>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}