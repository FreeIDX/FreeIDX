import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { loadLocaleBundle } from '@freeidx/shared/i18n/bundles';
import { App } from './App';
import { I18nProvider, initialLocale } from './lib/i18n';
import { queryClient } from './lib/query-client';
import './styles/globals.css';

/* 主题彩蛋：控制台版权输出（配色 #409EFF / #f2f3f5） */
console.log(
  '%c FreeIDX %c Powered by FreeIDX ',
  'background:#409eff;color:#fff;font-weight:bold;border-radius:2px 0 0 2px;padding:1px 4px',
  'background:#f2f3f5;color:#606060;border-radius:2px 2px 2px 0;padding:1px 4px',
);

/**
 * 首屏语言包预载：词典改为按需加载后，先取回当前语言的词条再挂载，
 * 保证首次渲染即有文案（否则会先显示 key 再补文案）；加载失败也照常挂载，由 useLocaleBundle 回落。
 */
void (async () => {
  await loadLocaleBundle(initialLocale()).catch(() => undefined);
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <I18nProvider>
            <App />
          </I18nProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
})();
