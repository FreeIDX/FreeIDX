/**
 * 相关帖子（related 插件）：帖子详情页「主贴下方、评论区上方」区块（契约⑧ thread_bottom 位）。
 *
 * 启用与展示参数随 bootstrap 下发（ext.related，§12 契约⑦）：插件停用 → 组件整体不渲染、不发请求。
 * 列表经 GET /api/related-threads?tid= 拉取（服务端按后台配置的规则组合筛选并排序）。
 * 版式两态（卡片栅格 / 紧凑文字），后台 allowSwitch 开启时区块右上角可切换，
 * 访客选择记在 localStorage（freeidx.related.layout），默认值取后台 mode。
 * 无任何可展示条目时整块不渲染（零残留）。
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { apiGet } from '../lib/api';
import { useT } from '../lib/i18n';
import { useAuth } from '../store/auth';
import { Card, cx } from './ui';
import { Icon } from './icons';

type RelatedLayout = 'card' | 'text';

/** bootstrap ext.related 载荷（apps/api/src/extensions/related.ts publicRelatedConfig） */
interface RelatedExt {
  enabled: boolean;
  mode: RelatedLayout;
  allowSwitch: boolean;
  limit: number;
  showMeta: boolean;
  title: string;
}

/** GET /api/related-threads 条目（reasons = 命中的规则来源：tags/forum/author，全站补齐为空） */
interface RelatedItem {
  tid: number;
  fid: number;
  subject: string;
  username: string;
  posts: number;
  views: number;
  createDate: number;
  lastDate: number;
  reasons: string[];
}
interface RelatedResp {
  enabled: boolean;
  list: RelatedItem[];
}

/** 访客选择的版式（浏览器本地；隐私模式下读写失败按未选择处理） */
const LAYOUT_KEY = 'freeidx.related.layout';

function readStoredLayout(): RelatedLayout | null {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === 'card' || v === 'text' ? v : null;
  } catch {
    return null;
  }
}

function storeLayout(v: RelatedLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, v);
  } catch {
    /* 本地存储不可用（隐私模式/被禁用）：仅本次会话生效 */
  }
}

/** 版式切换按钮（卡片/文字两态胶囊） */
function LayoutTabs({ value, onChange }: { value: RelatedLayout; onChange: (v: RelatedLayout) => void }) {
  const t = useT();
  const items: { key: RelatedLayout; icon: 'grid' | 'menu'; label: string }[] = [
    { key: 'card', icon: 'grid', label: t('related_view_card') },
    { key: 'text', icon: 'menu', label: t('related_view_text') },
  ];
  return (
    <span role="group" aria-label={t('related_view_switch')} className="flex items-center gap-1">
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          aria-pressed={value === it.key}
          title={it.label}
          onClick={() => onChange(it.key)}
          className={cx(
            'inline-flex h-7 items-center gap-1 rounded-[4px] border px-2 text-xs transition-colors',
            value === it.key
              ? 'border-brand bg-brand/10 text-brand'
              : 'border-transparent text-lt-grey hover:text-brand',
          )}
        >
          <Icon name={it.icon} className="size-3.5" />
          <span className="max-sm:hidden">{it.label}</span>
        </button>
      ))}
    </span>
  );
}

/** 条目元信息（作者 · 回复 · 浏览），后台 showMeta 关闭时不渲染 */
function ItemMeta({ item }: { item: RelatedItem }) {
  const t = useT();
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-lt-grey">
      <span className="truncate">{item.username}</span>
      <span className="inline-flex shrink-0 items-center gap-1" title={t('reply')}>
        <Icon name="comment" className="size-3" />
        <span className="tabular-nums">{item.posts}</span>
      </span>
      <span className="inline-flex shrink-0 items-center gap-1" title={t('views_label')}>
        <Icon name="eye" className="size-3" />
        <span className="tabular-nums">{item.views}</span>
      </span>
    </span>
  );
}

/** 卡片版式：两列栅格（窄屏单列），标题两行截断 + 元信息 */
function CardGrid({ list, showMeta }: { list: RelatedItem[]; showMeta: boolean }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {list.map((it) => (
        <Link
          key={it.tid}
          to={`/thread/${it.tid}`}
          className="group flex min-w-0 flex-col gap-1.5 rounded-[4px] border border-zh-line bg-card px-3 py-2.5 transition-colors hover:border-brand hover:bg-lt-soft"
        >
          <span className="line-clamp-2 text-sm leading-5 text-foreground transition-colors group-hover:text-brand">
            {it.subject}
          </span>
          {showMeta && <ItemMeta item={it} />}
        </Link>
      ))}
    </div>
  );
}

/** 文字版式：单列紧凑列表（序号 + 标题 + 元信息，分隔线） */
function TextList({ list, showMeta }: { list: RelatedItem[]; showMeta: boolean }) {
  return (
    <ol className="m-0 list-none divide-y divide-zh-line">
      {list.map((it, i) => (
        <li key={it.tid} className="flex min-w-0 items-center gap-2 py-2 first:pt-0 last:pb-0">
          <span
            className={cx(
              'inline-flex size-5 shrink-0 items-center justify-center rounded-[3px] text-[12px] font-semibold tabular-nums',
              i < 3 ? 'bg-brand text-white' : 'bg-lt-soft text-lt-grey',
            )}
          >
            {i + 1}
          </span>
          <Link className="min-w-0 flex-1 truncate text-sm text-foreground transition-colors hover:text-brand" to={`/thread/${it.tid}`}>
            {it.subject}
          </Link>
          {showMeta && <span className="hidden shrink-0 sm:block"><ItemMeta item={it} /></span>}
        </li>
      ))}
    </ol>
  );
}

export function RelatedThreads({ tid }: { tid: number }) {
  const t = useT();
  const ext = useAuth((s) => s.ext);
  const cfg = ext?.related as RelatedExt | undefined;
  const [picked, setPicked] = useState<RelatedLayout | null>(() => readStoredLayout());

  const enabled = cfg?.enabled === true;
  const q = useQuery({
    queryKey: ['related-threads', tid],
    queryFn: () => apiGet<RelatedResp>(`/api/related-threads?tid=${tid}`),
    enabled: enabled && tid > 0,
    staleTime: 5 * 60_000,
  });

  // 插件停用 / 服务端已关闭 / 无内容：整块零残留
  if (!cfg || !enabled || q.data?.enabled === false) return null;
  const list = q.data?.list ?? [];
  if (!list.length) return null;

  // 版式：允许切换时优先访客选择，否则固定后台默认值
  const layout: RelatedLayout = cfg.allowSwitch ? (picked ?? cfg.mode) : cfg.mode;
  const onPick = (v: RelatedLayout): void => {
    setPicked(v);
    storeLayout(v);
  };

  return (
    <Card
      bodyClass="p-4"
      header={
        <span className="flex w-full items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <Icon name="link" className="size-4 shrink-0 text-brand" />
            <span className="truncate">{cfg.title || t('related_threads')}</span>
          </span>
          {cfg.allowSwitch && <LayoutTabs value={layout} onChange={onPick} />}
        </span>
      }
    >
      {layout === 'text' ? <TextList list={list} showMeta={cfg.showMeta} /> : <CardGrid list={list} showMeta={cfg.showMeta} />}
    </Card>
  );
}
