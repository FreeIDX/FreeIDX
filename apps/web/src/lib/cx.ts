/**
 * className 合并（唯一实现，前后台共用）。
 * 原先 components/ui.tsx 与 admin/ui.tsx 各有一份完全相同的定义，收敛到此处后
 * 由两个 ui 模块各自 re-export，既有 import 站点无需改动。
 */
export const cx = (...parts: Array<string | false | null | undefined>): string =>
  parts.filter(Boolean).join(' ');
