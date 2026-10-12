/**
 * 「发消息」按钮 + 私信弹窗：
 *  - 注入点：他人主页头部与帖子页作者卡；
 *  - 弹窗 = 标题「给 {username} 发送私信」+ 内容文本域（填写私信内容）+「发送」按钮；
 *  - 提交 POST /api/my/notices/pm（type=7 进对方消息中心），成功后 1s 关闭并提示。
 * 未登录 → 走登录弹窗；自己主页/自己的帖不渲染。
 */
import { useEffect, useRef, useState } from 'react';
import { sendPm } from '../lib/api';
import { useAuth } from '../store/auth';
import { useAuthModal } from '../store/authModal';
import { Button, Modal, cx, inputCls } from './ui';
import { Icon } from './icons';
import { useT } from '../lib/i18n';

export function PmButton({ uid, username, block }: { uid: number; username: string; block?: boolean }) {
  const t = useT();
  const me = useAuth((s) => s.me);
  const openAuth = useAuthModal((s) => s.openAuth);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  /** 成功后延迟关闭的定时器句柄：卸载时必须清掉，否则组件已卸载仍在 setState（副作用泄漏） */
  const timerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  /* 行为口径：仅登录用户可见，且不给自己发（游客点击引导登录） */
  if (!me) {
    return (
      <button
        type="button"
        onClick={() => openAuth('login')}
        className={cx(
          'inline-flex h-[31px] items-center justify-center gap-1.5 rounded-[4px] border border-brand px-3 text-sm text-brand transition-colors hover:bg-brand hover:text-white',
          block && 'w-full',
        )}
      >
        <Icon name="message" className="size-4" />
        {t('send_pm')}
      </button>
    );
  }
  if (me.uid === uid) return null;

  const submit = async () => {
    setBusy(true);
    setFlash(null);
    try {
      await sendPm(uid, text);
      setFlash({ tone: 'ok', text: t('pm_sent') });
      setText('');
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setOpen(false);
        setFlash(null);
      }, 1000);
    } catch (e) {
      setFlash({ tone: 'err', text: e instanceof Error ? e.message : t('operation_failed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cx(
          'inline-flex h-[31px] items-center justify-center gap-1.5 rounded-[4px] bg-brand px-3 text-sm text-white transition-colors hover:bg-brand-hover',
          block && 'w-full',
        )}
      >
        <Icon name="message" className="size-4" />
        {t('send_pm')}
      </button>
      {open && (
        <Modal
          title={t('pm_title', { username })}
          onClose={() => setOpen(false)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
                {t('cancel_label')}
              </Button>
              <Button size="sm" loading={busy} disabled={!text.trim()} onClick={() => void submit()}>
                {t('send_label')}
              </Button>
            </div>
          }
        >
          <textarea
            className={cx(inputCls, 'min-h-[8rem] resize-y')}
            placeholder={t('pm_placeholder')}
            maxLength={1000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {flash && <p className={cx('mt-2 text-xs', flash.tone === 'ok' ? 'text-success' : 'text-destructive')}>{flash.text}</p>}
        </Modal>
      )}
    </>
  );
}