import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../store/auth';
import { useLight } from '../store/theme';
import { Turnstile } from './Turnstile';
import { sendEmailCode } from '../lib/api';
import { apiErrorMessage } from '../lib/errors';
import { useT } from '../lib/i18n';
import { IconInput } from './ui';
import { Icon } from './icons';

/** 登录/注册/找回页公告（light.loginAnnouncement）；留空不渲染 */
export function AuthAnnouncement() {
  const light = useLight();
  if (!light.loginAnnouncement) return null;
  return (
    <div role="note" className="mt-4 whitespace-pre-line rounded-[6px] bg-[rgba(0,132,255,0.08)] px-4 py-2.5 text-sm leading-6 text-foreground">
      {light.loginAnnouncement}
    </div>
  );
}

/** 提交按钮：44px 高、整行宽、6px 圆角、#409EFF 底，hover #006fe6 */
export const authSubmitCls =
  'h-[44px] w-full rounded-[6px] border-0 bg-brand text-base text-white transition-colors hover:bg-brand-hover disabled:pointer-events-none disabled:opacity-50';

/** 发送验证码按钮：38px 高、4px 圆角、主色描边字 */
const sendCodeCls =
  'h-[38px] shrink-0 rounded-[4px] border border-brand px-3 text-sm text-brand transition-colors hover:bg-[#ecf5ff] disabled:cursor-not-allowed disabled:opacity-50';

/** 提交按钮内容（busy 时前置旋转图标 + 提交中） */
function SubmitInner({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  const t = useT();
  if (!busy) return <>{children}</>;
  return (
    <span className="inline-flex items-center justify-center gap-1.5">
      <Icon name="refresh" className="size-4 animate-spin" />
      {t('submitting')}
    </span>
  );
}

/**
 * 登录表单（§4.5）：独立页（LoginPage）与弹窗（AuthModal）共用。
 * 每字段 = 图标前缀 + 输入框，提交为整行主色大按钮。
 * 成功后仅回调 onSuccess（页面模式跳首页，弹窗模式关弹窗），鉴权态刷新由 store.signIn 内部完成。
 */
export function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const signIn = useAuth((s) => s.signIn);
  const t = useT();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [tsNonce, setTsNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await signIn({ account, password, turnstileToken: token || undefined });
      onSuccess();
    } catch (ex) {
      setErr(apiErrorMessage(ex));
    } finally {
      // token 一次性（siteverify 校验即消耗）⇒ 不论成败都重挂换发，否则密码错一次后无法重试
      setToken('');
      setTsNonce((n) => n + 1);
      setBusy(false);
    }
  };

  return (
    <form className="mt-5 space-y-3" onSubmit={(e) => void submit(e)}>
      <IconInput
        icon="user"
        id="login-account"
        placeholder={t('email_or_username')}
        autoComplete="username"
        value={account}
        onChange={(e) => setAccount(e.target.value)}
      />
      {/* 明文仅存于此，提交前由 store 走 md5 预哈希（§8.4） */}
      <IconInput
        icon="lock"
        id="login-password"
        type="password"
        placeholder={t('password')}
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Turnstile key={tsNonce} onToken={setToken} />
      {err && <p className="text-sm text-destructive">{err}</p>}
      <button type="submit" disabled={!account || !password || busy} className={authSubmitCls}>
        <SubmitInner busy={busy}>{t('login')}</SubmitInner>
      </button>
    </form>
  );
}

/**
 * 注册表单（§4.6）：Email/用户名/密码(/验证码) + 发送验证码 60s 倒计时。
 * 站点关闭注册（userCreateOn=false）时仅渲染闭站提示。
 */
export function RegisterForm({ onSuccess }: { onSuccess: () => void }) {
  const setting = useAuth((s) => s.setting);
  const signUp = useAuth((s) => s.signUp);
  const t = useT();

  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [token, setToken] = useState('');
  const [tsNonce, setTsNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const timer = useRef<number | null>(null);

  // 验证码框按「实际生效」口径渲染：后台开关打开但没有 SMTP 池时，后端按验证关闭降级（§11.3），
  // 此时仍显示验证码输入框会给出「必填但发码永远失败」的死路。mailOn 缺省（旧缓存/未下发）视为可用。
  const emailOn = Boolean(setting?.userCreateEmailOn) && setting?.mailOn !== false;
  const createOn = setting?.userCreateOn !== false;

  /** 倒计时由发码成功启动一次 interval（不再依赖 cooldown，避免每秒重建定时器） */
  const startCooldown = () => {
    setCooldown(60);
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
  };

  // 归零即停表；卸载清理（两处都幂等）
  useEffect(() => {
    if (cooldown === 0 && timer.current) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }, [cooldown]);
  useEffect(
    () => () => {
      if (timer.current) window.clearInterval(timer.current);
    },
    [],
  );

  const sendCode = async () => {
    setErr('');
    setNotice('');
    setSending(true);
    try {
      await sendEmailCode({ scene: 'user_create', email, turnstileToken: token || undefined });
      setNotice(t('code_sent_notice'));
      startCooldown();
    } catch (ex) {
      setErr(apiErrorMessage(ex));
    } finally {
      // token 一次性：发码即消耗 ⇒ 不论成败都重挂换发，注册提交需重新获取
      setToken('');
      setTsNonce((n) => n + 1);
      setSending(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await signUp({ username, email, password, emailCode: emailOn ? emailCode : undefined, turnstileToken: token || undefined });
      onSuccess();
    } catch (ex) {
      setErr(apiErrorMessage(ex));
    } finally {
      // token 一次性 ⇒ 不论成败都重挂换发
      setToken('');
      setTsNonce((n) => n + 1);
      setBusy(false);
    }
  };

  if (!createOn) {
    return <p className="text-sm text-lt-grey">{t('registration_closed')}</p>;
  }

  return (
    <form className="mt-5 space-y-3" onSubmit={(e) => void submit(e)}>
      <IconInput
        icon="envelope"
        id="reg-email"
        type="email"
        placeholder={t('email')}
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <IconInput
        icon="user"
        id="reg-username"
        placeholder={t('username_label')}
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      {/* 明文仅存于此，提交前由 store 走 md5 预哈希（§8.4） */}
      <IconInput
        icon="lock"
        id="reg-password"
        type="password"
        placeholder={t('password')}
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      {emailOn && (
        <div className="flex items-stretch gap-2">
          <div className="min-w-0 flex-1">
            <IconInput
              icon="key"
              id="reg-code"
              placeholder={t('verify_code')}
              value={emailCode}
              onChange={(e) => setEmailCode(e.target.value)}
            />
          </div>
          <button
            type="button"
            className={sendCodeCls}
            disabled={cooldown > 0 || !email || sending}
            onClick={() => void sendCode()}
          >
            {sending ? t('sending') : cooldown > 0 ? t('send_code_success', { cooldown }) : t('send_verification_code')}
          </button>
        </div>
      )}
      <Turnstile key={tsNonce} onToken={setToken} />
      {notice && <p className="text-sm text-success">{notice}</p>}
      {err && <p className="text-sm text-destructive">{err}</p>}
      <button type="submit" disabled={!username || !email || !password || busy} className={authSubmitCls}>
        <SubmitInner busy={busy}>{t('next_step')}</SubmitInner>
      </button>
    </form>
  );
}