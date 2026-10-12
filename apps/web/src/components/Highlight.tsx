/**
 * 关键词高亮（搜索命中片段包 <mark>，前端渲染不注入 HTML）。
 * 原先 ThreadList（HighlightText）与 SearchPage（Highlight）各有一份等价实现，收敛到此处共用。
 */
import type { ReactNode } from 'react';

export function Highlight({ text, kw }: { text: string; kw?: string }) {
  if (!kw) return <>{text}</>;
  const lc = kw.toLowerCase();
  const out: ReactNode[] = [];
  let rest = text;
  let pos = rest.toLowerCase().indexOf(lc);
  if (pos < 0) return <>{text}</>;
  let key = 0;
  while (pos >= 0) {
    out.push(rest.slice(0, pos));
    out.push(
      <mark key={key++} className="bg-transparent font-normal text-brand">
        {rest.slice(pos, pos + kw.length)}
      </mark>,
    );
    rest = rest.slice(pos + kw.length);
    pos = rest.toLowerCase().indexOf(lc);
  }
  out.push(rest);
  return <>{out}</>;
}
