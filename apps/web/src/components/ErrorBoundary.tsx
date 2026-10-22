/**
 * 全局渲染错误兜底（稳定性项 D1）。
 *
 * 没有它时，任何渲染期异常（典型场景：发版后仍持有旧 index.html 的客户端去取已不存在的
 * hash chunk，`import()` reject）都会让 React 卸载整棵树 → 用户看到纯白页面，且无法自愈。
 *
 * 兜底动作只做一件确定有效的事：整页导航回首页（不是 SPA 的 navigate，而是重新取 index.html），
 * 从而拿到新的 assets 版本。文案复用既有词条，不新增 i18n 键。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { uiT } from '../lib/api';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 保留到控制台便于线上排查（接入 Sentry 之类的观测点也在这里）
    console.error('[ui] render crashed:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-6">
        <div className="w-full max-w-md rounded-[4px] border border-zh-line bg-card p-6 text-center">
          <p className="text-base font-medium text-foreground">{uiT('err_system_busy')}</p>
          <pre className="mt-3 max-h-32 overflow-auto rounded-[4px] bg-canvas p-2 text-left text-xs text-muted-foreground">
            {error.message}
          </pre>
          <button
            type="button"
            className="mt-4 inline-flex h-9 items-center rounded-[4px] bg-brand px-4 text-sm text-white"
            onClick={() => window.location.assign('/')}
          >
            {uiT('back_to_home')}
          </button>
        </div>
      </div>
    );
  }
}
