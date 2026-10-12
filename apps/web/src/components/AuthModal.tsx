import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useAuthModal } from '../store/authModal';
import { LoginForm, RegisterForm } from './AuthForms';
import { Icon } from './icons';
import { cx } from './ui';
import { useT } from '../lib/i18n';

/**
 * 登录/注册弹窗（Layout 挂载，全前台可用）：
 * 遮罩 + 居中白卡，卡顶登录/注册小切换，成功后关弹窗留在当前页；
 * 忘记密码跳独立页 /resetpw（找回密码流程保留页面形态）。
 */
export function AuthModal() {
  const open = useAuthModal((s) => s.open);
  const tab = useAuthModal((s) => s.tab);
  const openAuth = useAuthModal((s) => s.openAuth);
  const closeAuth = useAuthModal((s) => s.closeAuth);
  const t = useT();
  const navigate = useNavigate();

  /* Esc 关闭 */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeAuth();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closeAuth]);

  if (!open) return null;

  const goResetPw = () => {
    closeAuth();
    navigate('/resetpw');
  };

  return (
    <div className="fixed inset-0 z-[1500]">
      <div className="modal-fade absolute inset-0 bg-black/50" onClick={closeAuth} aria-hidden="true" />
      <div className="absolute left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 px-4">
        <section className="auth-panel modal-pop relative max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-[6px] px-6 py-8 sm:px-10">
          <button
            type="button"
            className="absolute right-2 top-2 flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label={t('close_nav')}
            onClick={closeAuth}
          >
            <Icon name="close" className="size-5" />
          </button>
          {/* 登录/注册切换（下划线式 tab） */}
          <div className="flex gap-6 border-b border-zh-line" role="tablist">
            {(
              [
                ['login', t('user_login')],
                ['register', t('user_create')],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={cx(
                  '-mb-px border-b-2 pb-2.5 text-[15px] transition-colors',
                  tab === key
                    ? 'border-brand font-semibold text-brand'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
                onClick={() => openAuth(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'login' ? <LoginForm onSuccess={closeAuth} /> : <RegisterForm onSuccess={closeAuth} />}
          <div className="mt-6 text-center text-sm text-muted-foreground">
            {tab === 'login' ? (
              <>
                {t('no_account_yet')}
                <button type="button" className="text-brand hover:underline" onClick={() => openAuth('register')}>
                  {t('register_new_account')}
                </button>
              </>
            ) : (
              <>
                {t('have_account')}
                <button type="button" className="text-brand hover:underline" onClick={() => openAuth('login')}>
                  {t('direct_login')}
                </button>
              </>
            )}
            <span className="mx-2 opacity-40">·</span>
            <button type="button" className="text-brand hover:underline" onClick={goResetPw}>
              {t('forgot_pw')}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
