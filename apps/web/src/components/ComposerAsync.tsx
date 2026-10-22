/**
 * Composer 的懒加载入口（性能项 C3）。
 *
 * 编辑器本体是 TipTap 全套（构建产物 vendor-editor ≈400KB），而「展开编辑器」是低频动作：
 * 帖子页/楼层卡此前静态 import，导致每个访客（含从不点「高级回复」的人）都要先付这 400KB，
 * 直接拖后首屏 LCP。改成懒加载后该 chunk 只在真正渲染编辑器时才下载。
 *
 * `LazyComposer` 而不是让使用方各写一次 `lazy + Suspense`：Suspense 边界必须贴近编辑器局部，
 * 若冒泡到路由级边界，整页会被替换成 PageLoading；封装成一个组件后调用方只需替换标签名，
 * 也就不会漏掉边界。
 */
import { Suspense, lazy, type ComponentProps } from 'react';
import type { Composer as ComposerType } from './Composer';

const ComposerAsync = lazy(() => import('./Composer').then((m) => ({ default: m.Composer })));

/** 编辑器加载占位：高度接近编辑器初始态，减少展开时的布局位移 */
function ComposerFallback() {
  return <div className="h-32 animate-pulse rounded-[4px] border border-zh-line bg-zh-line/30" aria-hidden="true" />;
}

/** 等同于 `<Composer {...props} />`，但编辑器 chunk 按需加载，且自带局部 Suspense 边界 */
export function LazyComposer(props: ComponentProps<typeof ComposerType>) {
  return (
    <Suspense fallback={<ComposerFallback />}>
      <ComposerAsync {...props} />
    </Suspense>
  );
}

/** 空闲期预热（不 await、失败忽略：真正渲染时 lazy 会重新发起） */
export function preloadComposer(): void {
  void import('./Composer').catch(() => undefined);
}
