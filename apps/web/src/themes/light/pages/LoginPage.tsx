import { Link, useNavigate } from 'react-router';
import { LoginForm, AuthAnnouncement } from '../../../components/AuthForms';
import { useLocalizedSetting, useT } from '../../../lib/i18n';
import { useLight } from '../../../store/theme';
import { SiteLogo } from '../../../components/SiteLogo';

/**
 * §4.5 登录页：认证版式——
 * 900px 白卡两栏（左栏 login_bg 背景图 <lg 隐藏 / 右栏表单 + 右上角 login_top_bg 装饰图）。
 * 表单本体在 AuthForms（登录/注册弹窗共用）。
 */
export function LoginPage() {
  const navigate = useNavigate();
  /* 站点名称等基础设置按当前界面语言取词 */
  const setting = useLocalizedSetting();
  const t = useT();
  const light = useLight();

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
            style={
              light.loginPageBanner
                ? { backgroundImage: `url(${light.loginPageBanner})` }
                : undefined
            }
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
              <Link
                to="/"
                className="mb-6 flex items-center gap-2"
                aria-label={setting?.sitename || 'FreeIDX'}
              >
                <SiteLogo setting={setting} className="h-9 w-auto max-w-none" />
              </Link>
              <p className="text-sm text-lt-grey">{t('user_login')}</p>
              <h2 className="mt-2 text-xl font-bold text-foreground">{t('welcome_login')}</h2>
              <AuthAnnouncement />
              <div className="mb-6">
                <LoginForm onSuccess={() => navigate('/')} />
              </div>
              {/* 底部链接行：注册 / 找回密码（右对齐） */}
              <div className="text-right text-sm">
                <Link to="/register" className="text-brand hover:underline">
                  {t('register_new_account')}
                </Link>
                <Link to="/resetpw" className="ml-3 text-brand hover:underline">
                  {t('forgot_pw')}
                </Link>
              </div>
              {/* 随便逛逛（回首页） */}
              <Link to="/" className="mt-4 block text-center text-sm text-brand hover:underline">
                {t('go_home')}
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
