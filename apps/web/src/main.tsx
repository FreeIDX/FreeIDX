import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { loadLocaleBundle } from '@freeidx/shared/i18n/bundles';
import { App } from './App';
import { I18nProvider, initialLocale } from './lib/i18n';
import { queryClient } from './lib/query-client';
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
              <App />
            </ThemeProvider>
          </I18nProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
})();
