/**
 * 骨架屏灰块（结构复杂页面的首屏占位）。
 * 与「居中灰字 loading」并存：简单的行内区块仍用文本，整页数据未到位时用骨架，
 * 让页面在加载期保持与真实版式同构，既不空白也不产生布局跳动。
 * aria-hidden：读屏只读调用方的状态文案，不朗读一堆空块；motion-reduce 下停止脉动。
 */
import { cx } from '../lib/cx';

export function Skeleton({ className, circle = false }: { className?: string; circle?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cx('animate-pulse bg-zh-line/70 motion-reduce:animate-none', circle ? 'rounded-full' : 'rounded-[4px]', className)}
    />
  );
}
