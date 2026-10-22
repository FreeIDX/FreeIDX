/**
 * Cloudflare Turnstile 挂件（T2-10，人机验证替代图形验证码）。
 * 无 VITE_TURNSTILE_SITEKEY ⇒ 本地/测试现实：不渲染、token 直接以 '' 回调（后端无 TURNSTILE_SECRET 时直通，铁律 8）。
 */
import { useEffect, useRef } from 'react';

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement | string,
        opts: {
          sitekey: string;
          callback: (token: string) => void;
          'expired-callback'?: () => void;
          'error-callback'?: () => void;
          theme?: 'light' | 'dark' | 'auto';
        },
      ) => string;
      remove?: (id: string) => void;
    };
  }
}

function turnstileSitekey(): string {
  return import.meta.env.VITE_TURNSTILE_SITEKEY ?? '';
}

export function turnstileDisabled(): boolean {
  return !turnstileSitekey();
}

function loadScript(): Promise<boolean> {
  if (typeof document === 'undefined') return Promise.resolve(false);
  if (window.turnstile) return Promise.resolve(true);
  return new Promise((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src^="${SCRIPT_SRC}"]`);
    const onReady = () => resolve(true);
    if (existing) {
      // 已存在 script：若它已加载完毕，load 事件不会再触发，只挂监听会让 Promise 永不 resolve
      // → turnstile.render 不执行 → 表单被「请完成验证」永久拦下；故先按 readyState 判定。
      // TS lib.dom 的 HTMLScriptElement 未声明 readyState（运行时存在），故按结构读取
      const ready = (existing as { readyState?: string }).readyState;
      const done = ready === 'complete' || ready === 'loaded';
      if (done || window.turnstile) {
        resolve(true);
        return;
      }
      existing.addEventListener('load', onReady, { once: true });
      existing.addEventListener('error', () => resolve(false), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.src = `${SCRIPT_SRC}?render=explicit`;
    s.async = true;
    s.defer = true;
    s.onload = onReady;
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

interface TurnstileProps {
  onToken: (token: string) => void;
}

export function Turnstile({ onToken }: TurnstileProps) {
  const sitekey = turnstileSitekey();
  const ref = useRef<HTMLDivElement>(null);
  const tokenCb = useRef(onToken);
  tokenCb.current = onToken;

  useEffect(() => {
    if (!sitekey) {
      // 禁用态：占位表单仍需 token ⇒ 以空串放行
      tokenCb.current('');
      return;
    }
    let widgetId = '';
    let cancelled = false;
    void loadScript().then((ok) => {
      if (cancelled || !ok || !ref.current || !window.turnstile) return;
      widgetId = window.turnstile.render(ref.current, {
        sitekey,
        callback: (t) => tokenCb.current(t),
        'expired-callback': () => tokenCb.current(''),
        'error-callback': () => tokenCb.current(''),
      });
    });
    return () => {
      cancelled = true;
      if (widgetId && window.turnstile?.remove) window.turnstile.remove(widgetId);
    };
  }, [sitekey]);

  if (!sitekey) return null;
  return <div ref={ref} className="cf-turnstile my-2" />;
}
