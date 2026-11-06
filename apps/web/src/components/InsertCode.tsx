/**
 * 插入代码扩展渲染（八处注入位直出原始 HTML 的 SPA 等价）。
 * useInsertCodes：全站共享 useQuery（注入码后台低频变更，staleTime 拉长）；
 * InsertCode：接收原始 html —— 纯标记直接 dangerouslySetInnerHTML（空串不渲染）；
 * 含 <script> 时 dangerouslySetInnerHTML 里的脚本不会执行，故 DOMParser 解析后
 * 以 createElement 重建脚本节点 append（保留 src/type/async 等属性与内联代码）。
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchInsertCodes, INSERT_CODE_KEYS, type InsertCodes } from '../lib/api';

const EMPTY_CODES = Object.fromEntries(INSERT_CODE_KEYS.map((k) => [k, ''])) as InsertCodes;

/**
 * 「首帧之后」开关：注入码是页脚/正文里的装饰性 HTML（多数站点根本没配），
 * 立即请求会让**每个页面**在首屏多一个并发请求，与 bootstrap/列表/字体抢同一条连接。
 * 推到浏览器空闲（或 1.5s 兜底）再发；注入位本身在页脚，晚一拍出现不影响首屏。
 */
function useAfterFirstPaint(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(() => setReady(true), { timeout: 1500 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(() => setReady(true), 1500);
    return () => window.clearTimeout(id);
  }, []);
  return ready;
}

/** 八个注入位原始 HTML（全站共享缓存；未加载/插件停用时返回全空串 → 渲染点零残留） */
export function useInsertCodes(): InsertCodes {
  const afterPaint = useAfterFirstPaint();
  const q = useQuery({
    queryKey: ['insert-codes'],
    queryFn: fetchInsertCodes,
    staleTime: 10 * 60_000,
    enabled: afterPaint,
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
    // 注入码变更/组件卸载时清掉上次注入的节点，避免旧脚本产生的 DOM 残留、重复渲染
    return () => host.replaceChildren();
  }, [html, hasScript]);

  if (!html) return null;
  // 不同分支换 key 强制重建 DOM 节点：脚本注入分支里由 JS 插入的子节点不受 React 管理，
  // 复用同一 div 会让旧注入内容在切回普通 HTML 分支时残留。
  if (hasScript) return <div key="with-script" ref={ref} className={className} />;
  return <div key="plain" className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
