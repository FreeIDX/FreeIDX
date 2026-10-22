/**
 * 后台二次验证弹窗：由整页 /admin/login 锁屏版式改为**弹出登录框**（现代扁平风）。
 * 背景：admin_at 与前台会话是两枚 Cookie，前台登录着但 admin_at 过期（1h 闲置/改密吊销）时，
 * 各页请求 403 NO_PERMISSION → ErrorState 就地唤起本弹窗重验，不再跳整页。
 * 提交口径与原锁屏页一致：明文不出前端，服务端拿到 32 位 md5 预哈希；成功后关闭弹窗并
 * 失效全量 react-query 缓存，让当前后台页立即重取数据（原地恢复，无跳转）。
 * 弹窗版式沿用 ConfirmModal 的遮罩口径（bg-black/50 + Esc/点遮罩关闭 + 锁滚动），
 * 内容保留原锁屏页的「头像 + {username}，您好！」身份确认语境。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { md5Hex } from '@freeidx/shared';
import { ApiError } from '../lib/api';
import { queryClient } from '../lib/query-client';
import { useAuth } from '../store/auth';
import { postAdminToken } from './api';
import { useAdminT } from './t';
import { Avatar } from '../components/Avatar';
import { Icon } from '../components/icons';
import { Button, cx, inputCls } from './ui';
import { useAdminLoginModal } from './loginModal';

export function AdminLoginModal() {
  const t = useAdminT();
  const me = useAuth((s) => s.me);
  const open = useAdminLoginModal((s) => s.open);
  const hide = useAdminLoginModal((s) => s.hide);

  const [password, setPassword] = useState('');
  const [state, setState] = useState<'idle' | 'loading' | 'ok'>('idle');
  /** 成功后延迟收起的定时器句柄：关闭/卸载必须清掉，否则弹窗已关仍会触发全量 invalidateQueries */
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );
  const [error, setError] = useState('');

  const dismissible = state === 'idle';
  const dismiss = () => {
    if (!dismissible) return;
    hide();
  };

  /* 打开期间：锁滚动 + Esc 关闭（提交中/成功落定前不响应，防中途打断） */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // 提交中/成功落定前不响应 Esc（防中途打断），等价于 dismiss() 的守卫
      if (e.key === 'Escape' && dismissible) hide();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, dismissible, hide]);

  /* 关闭即复位表单，下次打开是干净的输入态 */
  useEffect(() => {
    if (!open) {
      setPassword('');
      setState('idle');
      setError('');
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (state !== 'idle') return;
    setState('loading');
    setError('');
    try {
      // 与前台登录同口径：明文不出前端，服务端拿到的是 32 位 md5 预哈希
      await postAdminToken(md5Hex(password));
      setState('ok');
      setPassword('');
      // 成功：短暂展示「登录成功」后收起弹窗，失效全量查询让当前页带着新 admin_at 重取
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        hide();
        void queryClient.invalidateQueries();
      }, 800);
    } catch (ex) {
      setState('idle');
      setError(ex instanceof ApiError || ex instanceof Error ? ex.message : String(ex));
    }
  };

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[1050] flex items-center justify-center bg-black/50 p-4 transition-opacity duration-150"
      onClick={dismiss}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-login-modal-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[360px] rounded-[8px] bg-surface px-6 py-7 text-center shadow-[0_12px_32px_rgba(0,0,0,.18)]"
      >
        {/* 标题行：原锁屏 logo 文案（35px light）收进弹窗后缩为 15px medium，与 ConfirmModal 标题同口径 */}
        <div className="flex items-center justify-between">
          <span />
          <h5 id="admin-login-modal-title" className="m-0 text-[15px] font-medium leading-[1.5]">
            {t('admin_login', '管理登陆')}
          </h5>
          <button
            type="button"
            onClick={dismiss}
            className="-mr-2 cursor-pointer border-0 bg-transparent p-2 text-muted hover:text-ink"
            aria-label={t('close', '关闭')}
          >
            <Icon name="close" />
          </button>
        </div>

        {me ? (
          <>
            {/* 身份确认：原锁屏页的「头像 + {username}，您好！」语境（头像 64px 圆形居中） */}
            <div className="mt-4 flex justify-center">
              <Avatar uid={me.uid} avatar={me.avatar} username={me.username} dim="64px" />
            </div>
            <div className="mt-2 text-sm font-semibold">
              {me.username}，{t('admin_login_hello', '您好！')}
            </div>

            <form className="mt-4 flex gap-2" onSubmit={(e) => void submit(e)}>
              <input
                type="password"
                name="password"
                autoFocus
                placeholder="password"
                aria-label={t('password', '密码')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={state !== 'idle'}
                className={cx(inputCls, 'border-none bg-canvas')}
              />
              <Button type="submit" loading={state === 'loading'} disabled={state !== 'idle'} className="shrink-0">
                {state === 'loading'
                  ? `${t('submiting', '提交中')}...`
                  : state === 'ok'
                    ? t('login_success', '登录成功')
                    : t('login', '登录')}
              </Button>
            </form>

            <div className={cx('mt-3 text-sm', error ? 'text-danger' : 'text-muted')}>
              {error || t('for_safe_input_password_again', '为了您的安全，请再次输入账户密码')}
            </div>
          </>
        ) : (
          <>
            {/* 无前台会话：重验无从谈起（admin_at 由前台会话换发），给出前台登录入口 */}
            <div className="mt-4 text-sm text-muted">{t('please_login', '请登录')}</div>
            <Link
              to="/login"
              onClick={hide}
              className="mt-4 inline-flex w-full items-center justify-center rounded-[6px] border border-transparent bg-brand px-3 py-[.375rem] text-base text-white hover:bg-brand-hover"
            >
              {t('login', '登录')}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
