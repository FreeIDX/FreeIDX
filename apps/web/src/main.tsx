import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router';
import { loadLocaleBundle } from '@freeidx/shared/i18n/bundles';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { I18nProvider, initialLocale } from './lib/i18n';
import { queryClient } from './lib/query-client';
import { getRankThreads, getRankUsers } from './lib/api';
import { useAuth } from './store/auth';
import { ThemeProvider } from './lib/theme/provider';
import { resolveActiveTheme } from './lib/theme/active';
import { pageNameOfPath } from './lib/theme/page-of-path';
import { reloadForNewAssets } from './lib/chunk-reload';
import { installThreadPrefetch } from './lib/prefetch-thread';
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
 * 节流/刷新动作与 ErrorBoundary 共用 lib/chunk-reload：10s 内最多重载一次，
 * 若新版本本身有问题则不再刷新，由 ErrorBoundary 展示兜底页。
 */
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault();
  reloadForNewAssets();
});

/**
 * 首屏并行（性能项 C1）：bootstrap 与「主题 + 词典」同时发起。
 * 原实现是挂载后才在 Layout 的 useEffect 里拉 bootstrap，首屏因此串行两级：
 * (主题 ‖ 词典) → render → bootstrap → 内容。提前到这里后两者并行，挂载时通常已就绪。
 * load() 自身有单飞保护，Layout 的 useEffect 仍会兜底（首载失败重试 / HMR），不会重复请求。
 */
void useAuth.getState().load();

/**
 * 右栏排行预取（性能项）：首页右栏的「总排行 / 新会员」是两份与 bootstrap 完全独立的数据，
 * 原本要等 Page chunk 下载 → 渲染到 HomePage 才由 useQuery 发出，等于比 bootstrap 晚一整段
 * chunk 时间。这里在模块求值期就与 bootstrap 并行发出，命中后 useQuery 直接取缓存（key 与
 * 组件内一致、staleTime 同值）。仅首页路径参与，其他页面不产生额外请求。
 * 服务端这两条接口本身是公共只读 + 边缘缓存（600s/1h），预取成本可忽略。
 */
if (/^\/(?:page\/\d+)?$/.test(window.location.pathname)) {
  void queryClient.prefetchQuery({ queryKey: ['rank-threads', 'all'], queryFn: () => getRankThreads('all', 10), staleTime: 300_000 });
  void queryClient.prefetchQuery({ queryKey: ['rank-users', 'new'], queryFn: () => getRankUsers('new', 16), staleTime: 300_000 });
}

/**
 * 列表 → 帖子详情的「意图预取」：指针在帖子链接上停留 120ms 即预取详情（游客通常直接命中边缘缓存），
 * 点击时数据已在 react-query 里，省掉整段跨洋 RTT。容量/弱网/失败清理等边界见 lib/prefetch-thread.ts。
 */
installThreadPrefetch();

/**
 * 首屏预载：语言包（词典按需加载）与启用主题（外观层）并行取回后再挂载，
 * 保证首次渲染即有文案与正确外观（否则会先显示 key / 先闪默认主题再换肤）。
 * 两者失败都照常挂载：语言由 useLocaleBundle 回落，主题由 resolveActiveTheme 回落 light。
 *
 * 当前路径的**页面 chunk 也在这一步并行预取**（性能项 C4）：页面 chunk 原本要等 React
 * 渲染到该路由才由 lazy 触发，于是首屏是「主包 → 词典 → 渲染 → chunk → 数据」四级串行。
 * 主题模块（基底 light 为静态引入）一到位就按路径预取，chunk 与词典同批下载，少一个 RTT。
 */
void (async () => {
  const themePromise = resolveActiveTheme();
  /* 后台是独立外壳（自带懒加载树），不参与前台页面 chunk 预取 */
  if (!window.location.pathname.startsWith('/admin')) {
    void themePromise
      .then((t) => t.module.pages?.[pageNameOfPath(window.location.pathname)]?.preload?.())
      .catch(() => undefined);
  }
  const [theme] = await Promise.all([
    themePromise,
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
