/**
 * 发现页轮播：4 秒自动播放、高 18rem、cover 裁切、圆角 5px（移动端 0）。
 * 数据来自 light 扩展 slides（每行 名称|链接|图片，最多 8 条）；无数据时整块不渲染（插件停用零残留）。
 * 交互：上一张/下一张圆钮 + 右下指示点；自动播放 4000ms，hover 暂停。
 */
import { useEffect, useState } from 'react';
import type { LightSlide } from '../store/theme';
import { Icon } from './icons';
import { cx } from './ui';

const INTERVAL_MS = 4000;

/**
 * 轮播条目 key（两张 map 必须同源）：原实现一张图用 `${pic}-${i}`、指示点只用 `pic`，
 * 一旦两行 slide 指向同一张图（或 slides 增删重排），React 会按错位 key 复用 DOM，
 * 出现图片与指示点状态错位。
 */
const slideKey = (s: LightSlide, i: number): string => `${s.name}|${s.pic}|${i}`;

export function Carousel({ slides }: { slides: LightSlide[] }) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const count = slides.length;

  useEffect(() => {
    if (count < 2 || paused) return;
    const timer = window.setInterval(() => setIdx((i) => (i + 1) % count), INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [count, paused]);

  useEffect(() => {
    if (idx >= count) setIdx(0);
  }, [idx, count]);

  if (!count) return null;
  const go = (n: number) => setIdx(((n % count) + count) % count);

  return (
    <div
      className="discovery-carousel relative mb-4 bg-lt-soft"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      role="region"
      aria-label="carousel"
    >
      {slides.map((s, i) => (
        <div
          key={slideKey(s, i)}
          className={cx('absolute inset-0 transition-opacity duration-500', i === idx ? 'opacity-100' : 'pointer-events-none opacity-0')}
        >
          {s.url ? (
            <a href={s.url} target="_blank" rel="noreferrer" className="block size-full">
              <img src={s.pic} alt={s.name} className="size-full object-cover" loading={i === 0 ? 'eager' : 'lazy'} />
            </a>
          ) : (
            <img src={s.pic} alt={s.name} className="size-full object-cover" loading="lazy" />
          )}
        </div>
      ))}
      {count > 1 && (
        <>
          <button
            type="button"
            aria-label="prev"
            className="absolute left-3 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/25 text-white transition-colors hover:bg-black/45"
            onClick={() => go(idx - 1)}
          >
            <Icon name="chevron_left" className="size-5" />
          </button>
          <button
            type="button"
            aria-label="next"
            className="absolute right-3 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-black/25 text-white transition-colors hover:bg-black/45"
            onClick={() => go(idx + 1)}
          >
            <Icon name="chevron_right" className="size-5" />
          </button>
          <div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5">
            {slides.map((s, i) => (
              <button
                key={slideKey(s, i)}
                type="button"
                aria-label={`slide ${i + 1}`}
                className={cx('size-2 rounded-full transition-colors', i === idx ? 'bg-white' : 'bg-white/50 hover:bg-white/80')}
                onClick={() => go(i)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}