import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { loadLocaleBundle } from '@freeidx/shared/i18n/bundles';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { I18nProvider, initialLocale } from './lib/i18n';
import { queryClient } from './lib/query-client';
import { useAuth } from './store/auth';
import { ThemeProvider } from './lib/theme/provider';
import { resolveActiveTheme } from './lib/theme/active';
import './styles/globals.css';

/* 主题彩蛋：控制台版权输出（配色 #409EFF / #f2f3f5） */
console.log(
  '%c FreeIDX %c Powered by FreeIDX ',
  'background:#409eff;color:#fff;font-weight:bold;border-radius:2px 0 0 2px;padding:1px 4px',
  'background:#f2f3f5;color:#606060;border-radius:2px 2px 2px 0;padding:1px 4px',
);

/**
 * chunk 加载失败自愈（稳定性项 D1）：发版后仍持有旧 index.html 的客户端会去取已不存在的 hash，
 * Vite 会派发 `vite:preloadError`。阻止其继续抛出并整页重载，即可拿到新的 assets 版本。
 * 10s 内最多重载一次：若新版本本身有问题，避免无限刷新（届时由 ErrorBoundary 兜底展示）。
 */
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault();
  try {
    const KEY = 'fi:chunk-reload-at';
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 10_000) return;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // 隐私模式禁用 storage：不节流，直接重载
  }
  window.location.reload();
});

/**
 * 首屏并行（性能项 C1）：bootstrap 与「主题 + 词典」同时发起。
 * 原实现是挂载后才在 Layout 的 useEffect 里拉 bootstrap，首屏因此串行两级：
 * (主题 ‖ 词典) → render → bootstrap → 内容。提前到这里后两者并行，挂载时通常已就绪。
 * load() 自身有单飞保护，Layout 的 useEffect 仍会兜底（首载失败重试 / HMR），不会重复请求。
 */
void useAuth.getState().load();

/**
 * 首屏预载：语言包（词典按需加载）与启用主题（外观层）并行取回后再挂载，
 * 保证首次渲染即有文案与正确外观（否则会先显示 key / 先闪默认主题再换肤）。
 * 两者失败都照常挂载：语言由 useLocaleBundle 回落，主题由 resolveActiveTheme 回落 light。
 */
void (async () => {
  const [theme] = await Promise.all([
    resolveActiveTheme(),
    loadLocaleBundle(initialLocale()).catch(() => undefined),
  ]);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <I18nProvider>
            <ThemeProvider theme={theme}>
              <ErrorBoundary>
                <App />
              </ErrorBoundary>
            </ThemeProvider>
          </I18nProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
})();
