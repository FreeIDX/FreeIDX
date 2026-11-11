/**
 * 主题列表骨架（首页 / 版块页列表接口未返回时）。
 * 此前这两处只渲染卡片外壳，数据没到位时正文是一片空白，看着像版块没有帖子；
 * 这里按列表样式 1 的行结构（左头像 + 标题 + 次行元信息）给同构占位，
 * 并在顶部给一行「加载中… + 旋转图标」，明确这是加载而不是空数据。
 * 数据到达后整块替换为真实列表（同高行距，不跳版）。
 */
import { Icon } from './icons';
import { Skeleton } from './Skeleton';
import { useT } from '../lib/i18n';

/** 标题宽度轮换，避免多行等宽显得生硬 */
const TITLE_W = ['w-1/2', 'w-2/3', 'w-[45%]', 'w-3/5'];

export function ThreadListSkeleton({ rows = 6 }: { rows?: number }) {
  const t = useT();
  return (
    <div aria-busy="true">
      <div className="flex items-center gap-2 border-b border-zh-line px-5 py-2.5 text-sm text-lt-grey" role="status" aria-live="polite">
        <Icon name="refresh" className="size-3.5 animate-spin motion-reduce:animate-none" />
        {t('loading')}
      </div>
      <ul className="m-0 list-none p-0">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i} className="border-b border-zh-line px-5 py-[0.7rem] last:border-b-0">
            <div className="flex items-start gap-3">
              {/* 与 ThreadList 样式 1 的左头像同尺寸（avatar-3 = 2.4rem，soft 圆角） */}
              <Skeleton radius="rounded-[22%]" className="size-[2.4rem] shrink-0" />
              <div className="min-w-0 flex-1">
                <Skeleton className={`h-4 ${TITLE_W[i % TITLE_W.length]}`} />
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-3 w-14" />
                  <Skeleton className="ml-auto h-3 w-16" />
                </div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
