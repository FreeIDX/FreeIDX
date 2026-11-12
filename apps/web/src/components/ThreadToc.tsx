/**
 * 文章目录（toc 插件）：帖子详情页右栏「作者卡下方」的标题目录（契约⑧ sidebar 位）。
 *
 * 数据来源：**已渲染的首帖 DOM**（由 ThreadPage 给首帖正文 article 挂 `id={sourceId}`），
 * 组件在 mount / 正文变化后扫描 h1~h6，按后台配置的层级范围与最少条数筛出条目——
 * 不新增接口、不占 D1 预算；插件停用或标题不足时整块不渲染。
 *
 * 交互：
 *  - 点击条目：平滑滚动到对应标题（扣掉固定顶栏高度，避免标题被顶栏遮住）；
 *  - 滚动联动（scrollSync 开启）：按「最后一个已滚过顶栏的标题」高亮，滚到底部时强制最后一项；
 *  - 目录条目多时列表自身可滚动（max-h + overflow-y），不把右栏拉出视口。
 *
 * 说明：核心 sanitize 的属性白名单不含 id，正文里的标题锚点由本组件在扫描后临时写入
 * （`fi-toc-<i>`），便于无障碍与复制链接，不依赖作者手写锚点。
 */
import { useEffect, useState } from 'react';
import type { PostItem } from '@freeidx/shared';
import { useT } from '../lib/i18n';
import { useAuth } from '../store/auth';
import { cx } from './ui';
import { Icon } from './icons';

/** bootstrap ext.toc 载荷（apps/api/src/extensions/toc.ts publicTocConfig） */
interface TocExt {
  enabled: boolean;
  title: string;
  minLevel: number;
  maxLevel: number;
  minCount: number;
  scrollSync: boolean;
  showIndex: boolean;
}

interface TocItem {
  /** 目标标题元素（点击滚动 / 滚动联动都以它的实时位置为准） */
  el: HTMLElement;
  /** 标题层级（1~6） */
  level: number;
  /** 标题文本（已压空白） */
  text: string;
}

/** 固定顶栏高度 + 视觉留白：滚动落点与 scroll-spy 共用同一口径 */
function headerOffset(): number {
  const header = document.querySelector('header');
  const h = header instanceof HTMLElement ? Math.round(header.getBoundingClientRect().height) : 0;
  return (h > 0 ? h : 75) + 12;
}

/** 扫描首帖正文里的标题：按层级范围筛选、跳过引用块内的标题与空标题，并写入临时锚点 id */
function collectHeadings(root: HTMLElement, minLevel: number, maxLevel: number): TocItem[] {
  const out: TocItem[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))) {
    const level = Number(el.tagName.slice(1));
    if (level < minLevel || level > maxLevel) continue;
    // 引用块是别人的原话，其内部标题不算本文章节
    if (el.closest('blockquote')) continue;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    el.id = `fi-toc-${out.length}`;
    out.push({ el, level, text });
  }
  return out;
}

export function ThreadToc({ sourceId, post }: { sourceId: string; post?: PostItem }) {
  const t = useT();
  const ext = useAuth((s) => s.ext);
  const cfg = ext?.toc as TocExt | undefined;
  const enabled = cfg?.enabled === true;
  const minLevel = cfg?.minLevel ?? 2;
  const maxLevel = cfg?.maxLevel ?? 4;
  const minCount = cfg?.minCount ?? 2;
  const scrollSync = cfg?.scrollSync !== false;
  const showIndex = cfg?.showIndex === true;
  const title = cfg?.title?.trim() || t('thread_toc');

  const [items, setItems] = useState<TocItem[]>([]);
  const [active, setActive] = useState(0);

  /* 正文渲染后扫描标题：post 引用变化（编辑 / 购买后付费段展开 / 重新拉取）都会重扫 */
  useEffect(() => {
    if (!enabled || !post) {
      setItems([]);
      return;
    }
    const root = document.getElementById(sourceId);
    if (!root) {
      setItems([]);
      return;
    }
    const next = collectHeadings(root, minLevel, maxLevel);
    setItems(next.length >= minCount ? next : []);
    setActive(0);
  }, [enabled, sourceId, post, minLevel, maxLevel, minCount]);

  /* scroll-spy：rAF 节流，只在滚动/尺寸变化时量一次 */
  useEffect(() => {
    if (!items.length || !scrollSync) return;
    let raf = 0;
    const measure = (): void => {
      raf = 0;
      const offset = headerOffset();
      let idx = 0;
      for (let i = 0; i < items.length; i += 1) {
        if (items[i]!.el.getBoundingClientRect().top <= offset + 8) idx = i;
        else break;
      }
      // 内容短于视口或已滚到底：最后一段可能永远滚不过顶栏，直接高亮末项
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) idx = items.length - 1;
      setActive((prev) => (prev === idx ? prev : idx));
    };
    const onScroll = (): void => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    window.addEventListener('load', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      window.removeEventListener('load', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [items, scrollSync]);

  if (!enabled || !items.length) return null;

  const jump = (index: number): void => {
    const el = items[index]?.el;
    if (!el) return;
    setActive(index);
    const top = el.getBoundingClientRect().top + window.scrollY - headerOffset();
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  };

  return (
    <section className="zh-card mb-4" aria-label={title}>
      <div className="zh-card-header flex items-center gap-2 px-4 py-2.5 text-sm font-medium">
        <Icon name="menu" className="size-4 shrink-0 text-brand" />
        <span className="truncate">{title}</span>
      </div>
      <nav className="max-h-[40vh] overscroll-contain overflow-y-auto p-2">
        <div className="relative">
          {/* 时间轴竖线：dots 模式才有；index 模式用序号，不需要导轨 */}
          {!showIndex && <span aria-hidden="true" className="absolute top-2 bottom-2 left-[13px] w-px bg-zh-line" />}
          <ul className="relative m-0 list-none">
            {items.map((it, i) => (
              <li key={it.el.id || `${i}-${it.text}`}>
                <button
                  type="button"
                  aria-current={i === active ? 'true' : undefined}
                  onClick={() => jump(i)}
                  title={it.text}
                  className={cx(
                    'flex w-full items-start gap-2 rounded-[4px] py-1.5 pr-2 pl-2.5 text-left text-sm transition-colors',
                    i === active ? 'bg-brand/10 font-medium text-brand' : 'text-ink-soft hover:bg-lt-soft hover:text-brand',
                  )}
                >
                  {showIndex ? (
                    <span
                      className={cx(
                        'mt-px w-4 shrink-0 text-right text-[11px] leading-5 font-semibold tabular-nums',
                        i === active ? 'text-brand' : 'text-lt-grey',
                      )}
                    >
                      {i + 1}
                    </span>
                  ) : (
                    <span
                      aria-hidden="true"
                      className={cx(
                        'relative z-10 mt-[6px] size-[7px] shrink-0 rounded-full border transition-colors',
                        i === active ? 'border-brand bg-brand ring-2 ring-brand/25' : 'border-[#c9ced6] bg-card',
                      )}
                    />
                  )}
                  <span
                    className="min-w-0 flex-1 leading-5 line-clamp-2 break-words"
                    style={{ paddingLeft: Math.max(0, it.level - minLevel) * 10 }}
                  >
                    {it.text}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </nav>
    </section>
  );
}
