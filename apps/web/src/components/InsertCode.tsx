/**
 * 插入代码扩展渲染（八处注入位直出原始 HTML 的 SPA 等价）。
 * useInsertCodes：全站共享 useQuery（注入码后台低频变更，staleTime 拉长）；
 * InsertCode：接收原始 html —— 纯标记直接 dangerouslySetInnerHTML（空串不渲染）；
 * 含 <script> 时 dangerouslySetInnerHTML 里的脚本不会执行，故 DOMParser 解析后
 * 以 createElement 重建脚本节点 append（保留 src/type/async 等属性与内联代码）。
 */
import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchInsertCodes, INSERT_CODE_KEYS, type InsertCodes } from '../lib/api';

const EMPTY_CODES = Object.fromEntries(INSERT_CODE_KEYS.map((k) => [k, ''])) as InsertCodes;

/** 八个注入位原始 HTML（全站共享缓存；未加载/插件停用时返回全空串 → 渲染点零残留） */
export function useInsertCodes(): InsertCodes {
  const q = useQuery({
    queryKey: ['insert-codes'],
    queryFn: fetchInsertCodes,
    staleTime: 10 * 60_000,
  });
  return q.data ?? EMPTY_CODES;
}

export function InsertCode({ html, className }: { html: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const hasScript = /<script/i.test(html);

  useEffect(() => {
    const host = ref.current;
    if (!html || !hasScript || !host) return;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    host.replaceChildren(...Array.from(doc.body.childNodes).map((n) => document.adoptNode(n)));
    /* DOMParser 产出的 <script> 插入文档不会执行：逐个以 createElement 重建（append 后浏览器才求值） */
    host.querySelectorAll('script').forEach((old) => {
      const fresh = document.createElement('script');
      for (const attr of Array.from(old.attributes)) fresh.setAttribute(attr.name, attr.value);
      fresh.text = old.textContent ?? '';
      old.replaceWith(fresh);
    });
  }, [html, hasScript]);

  if (!html) return null;
  if (hasScript) return <div ref={ref} className={className} />;
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
