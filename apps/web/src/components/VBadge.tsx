/**
 * 加V认证徽章：认证用户头像右下角小 V 标。
 * 各头像位置（主题列表 / 回帖列表 / 用户卡 / 用户名旁）在头像 bottom:2px;right:2px 处
 * 此处等价为 CSS 绘制圆徽章（#0084ff 底白字 V），尺寸随头像档位缩放。
 * v 为空或 '0'（未认证）时不渲染；使用处须有 relative 定位容器包裹头像。
 */
import { useT } from '../lib/i18n';

const PX: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 10, 2: 11, 3: 14, 4: 16, 5: 18 };

export function VBadge(props: { v?: string; size?: 1 | 2 | 3 | 4 | 5; dim?: string; className?: string }) {
  const { v, size = 3, dim, className } = props;
  const t = useT();
  if (!v || v === '0') return null;
  const px = dim ? Math.max(14, Math.round((parseFloat(dim) || 0) * 0.22)) : PX[size];
  return (
    <span
      title={v}
      aria-label={t('verified')}
      className={`absolute right-0 bottom-0 z-10 inline-flex items-center justify-center rounded-full bg-brand font-bold leading-none text-white ring-1 ring-white ${className ?? ''}`}
      style={{ width: px, height: px, fontSize: Math.max(8, Math.round(px * 0.62)) }}
    >
      V
    </span>
  );
}
