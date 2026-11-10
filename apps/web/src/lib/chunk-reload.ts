/**
 * 资产版本错位的自愈（稳定性项 D1 的共用实现）。
 *
 * 场景：客户端仍持有旧 index.html（发版前就打开的标签页），点进某个懒加载页面时
 * `import('./pages/X')` 请求的是**旧 hash** 的 chunk；部署后该文件已不存在，
 * 资产层回 404（旧的 SPA 兜底则回 index.html），React.lazy 拿不到模块 / 拿到不含导出的模块，
 * 整个渲染树被卸载。唯一确定有效的恢复动作是**整页导航**（重新取 index.html → 新 assets），
 * 而不是 SPA 的 navigate。
 *
 * 节流 10s：新版本本身坏掉时避免无限刷新循环（第二次起由 ErrorBoundary 展示兜底页）。
 */
const RELOAD_KEY = 'fi:chunk-reload-at';
const RELOAD_WINDOW_MS = 10_000;

/** 是否为「页面/依赖 chunk 取不到」类错误（浏览器原生消息 + 自建 ChunkLoadError 标记） */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ChunkLoadError') return true;
  const msg = error.message.toLowerCase();
  return (
    // Chrome / Edge
    msg.includes('failed to fetch dynamically imported module') ||
    // Firefox
    msg.includes('error loading dynamically imported module') ||
    // Safari
    msg.includes('importing a module script failed') ||
    // Vite 预加载（modulepreload/CSS）失败
    msg.includes('unable to preload') ||
    // chunk 请求被 HTML 兜底顶替（MIME 校验）
    msg.includes('is not a valid javascript mime type')
  );
}

/**
 * 整页刷新拿新 assets。10s 内已经刷过一次则**不刷**并返回 false，
 * 让调用方落到兜底页（否则新版本自身报错时会无限刷新，用户永远看不到任何提示）。
 */
export function reloadForNewAssets(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Number.isFinite(last) && Date.now() - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // 隐私模式禁用 storage：无从节流，直接刷新（坏版本场景由 ErrorBoundary 兜底页承接）
  }
  window.location.reload();
  return true;
}
