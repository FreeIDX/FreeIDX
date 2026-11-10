import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

/**
 * 页面 chunk 加载失败：与「业务渲染错误」区分开，ErrorBoundary 据此走整页刷新自愈
 * （见 lib/chunk-reload）。消息保持英文技术描述，不占用 i18n 词条——
 * 它只在自动刷新被节流、兜底页展示原始错误时出现，属于给站长的排查信息。
 */
export class ChunkLoadError extends Error {
  constructor(
    /** 期望的导出名（同时就是页面名，便于在 Network 里对照 chunk） */
    public readonly chunk: string,
    cause?: unknown,
  ) {
    super(`Failed to load page chunk "${chunk}"`);
    this.name = 'ChunkLoadError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** 路由页不接收 props（数据自取），统一用空 props 类型免得每处手写泛型 */
type RoutePage = ComponentType<Record<string, never>>;

/**
 * 路由页懒加载，替代裸 `lazy(() => import(...).then((m) => ({ default: m.XxxPage })))`。
 *
 * 裸写法的两个问题（线上都真实出现过）：
 *  1. `import()` 拿到的模块对象异常（旧 hash 被删 / 请求被兜底成 HTML）时，`m` 是 undefined，
 *     React 只报 `Cannot read properties of undefined (reading 'XxxPage')`，看不出是资产问题；
 *  2. 导出改名/漏导出时 React 报 `Element type is invalid ... got: undefined`，同样难定位。
 * 这里统一成带 `ChunkLoadError` 名字的错误，ErrorBoundary 就能识别并整页刷新取新版本。
 */
export function lazyPage<M extends object, K extends string>(
  loader: () => Promise<M>,
  name: K,
): LazyExoticComponent<RoutePage> {
  return lazy(async () => {
    let mod: M;
    try {
      mod = await loader();
    } catch (e) {
      // 网络/404/MIME 校验失败（chunk 已被新部署替换或资产未上传）
      throw new ChunkLoadError(name, e);
    }
    const comp = (mod as Record<string, unknown>)[name];
    if (typeof comp !== 'function' && (typeof comp !== 'object' || comp === null)) {
      // 模块拿到了但导出缺失：构建不完整或页面被改名
      throw new ChunkLoadError(name, new Error(`export "${name}" is missing or not a component`));
    }
    return { default: comp as RoutePage };
  });
}
