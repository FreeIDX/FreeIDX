/**
 * 帖子页首屏骨架（/thread/:tid 详情接口未返回时）。
 * 此前该页在数据到位前只有底部「返回」按钮落在空白背景上，很容易被当成页面出错；
 * 这里按真实版式（面包屑 / 首帖卡 / 楼层卡 / 右栏作者卡）给同构占位，
 * 数据到达后整块替换，视觉上不跳版。右栏与真页一致只在 lg+ 出现。
 */
import { Icon } from './icons';
import { Skeleton } from './Skeleton';
import { Card } from './ui';
import { useT } from '../lib/i18n';

const line = 'h-4';

export function ThreadSkeleton() {
  const t = useT();
  return (
    <div className="flex flex-col gap-5 lg:flex-row" aria-busy="true">
      <div className="min-w-0 flex-[3]">
        {/* 明确的加载态：骨架在动之外再给一行文案，避免用户把它当成「页面坏了」 */}
        <div className="mb-3 flex items-center gap-2 text-sm text-lt-grey" role="status" aria-live="polite">
          <Icon name="refresh" className="size-3.5 animate-spin motion-reduce:animate-none" />
          {t('loading')}
        </div>

        {/* 面包屑 */}
        <div className="mb-3 flex items-center gap-2">
          <Skeleton className="h-3.5 w-10" />
          <Skeleton className="h-3.5 w-14" />
          <Skeleton className="h-3.5 w-40" />
        </div>

        {/* 首帖卡：标题 + 作者行 + 正文 + 卡脚 */}
        <Card>
          <Skeleton className="h-6 w-3/5" />
          <div className="mt-3 flex items-center gap-3">
            <Skeleton circle className="size-9" />
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3.5 w-16" />
          </div>
          <div className="mt-5 space-y-2.5">
            <Skeleton className={line} />
            <Skeleton className={line} />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
          <div className="mt-6 flex items-center gap-4 border-t border-zh-line pt-3">
            <Skeleton className="h-3.5 w-14" />
            <Skeleton className="h-3.5 w-14" />
            <Skeleton className="h-3.5 w-14" />
          </div>
        </Card>

        {/* 回复列表卡：表头 + 两条楼层 */}
        <Card header={<Skeleton className="h-4 w-28" />} bodyClass="p-0">
          <ul className="m-0 list-none">
            {[0, 1].map((i) => (
              <li key={i} className="border-b border-zh-line px-5 py-4 last:border-b-0">
                <div className="flex items-center gap-3">
                  <Skeleton circle className="size-9" />
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="ml-auto h-3 w-16" />
                </div>
                <div className="mt-3 space-y-2.5">
                  <Skeleton className={line} />
                  <Skeleton className="h-4 w-5/6" />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* 右栏作者卡（与真页同：仅 lg+ 渲染） */}
      <aside className="hidden w-[285px] shrink-0 self-start lg:block">
        <section className="zh-card mb-4 overflow-hidden">
          <Skeleton className="h-[80px] w-full" />
          <div className="flex flex-col items-center px-4 pb-4">
            <Skeleton circle className="-mt-[25px] size-16 border-[3px] border-white" />
            <Skeleton className="mt-3 h-4 w-24" />
            <Skeleton className="mt-2 h-3.5 w-20" />
            <div className="mt-4 grid w-full grid-cols-3 gap-2 border-t border-zh-line pt-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex flex-col items-center gap-1.5">
                  <Skeleton className="h-3 w-10" />
                  <Skeleton className="h-3.5 w-8" />
                </div>
              ))}
            </div>
            <Skeleton className="mt-4 h-[31px] w-full" />
          </div>
        </section>
      </aside>
    </div>
  );
}
