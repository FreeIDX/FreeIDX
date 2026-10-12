/**
 * 路由懒加载的 Suspense 回落（§10.2）。
 * 页面 chunk 首次进入时短暂占位；复用现有「居中灰字」样式口径（与 Button loading / 列表 isPending 一致），
 * 不引入新视觉与布局跳动。
 * 文案：默认取前台翻译器；后台传 label（useAdminT 的结果），避免后台界面语言回落成站点前台语言。
 */
import { useT } from '../lib/i18n';

export function PageLoading({ label }: { label?: string }) {
  const t = useT();
  return <p className="py-10 text-center text-sm text-lt-grey">{label ?? t('loading')}</p>;
}
