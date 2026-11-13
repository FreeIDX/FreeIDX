/**
 * 「列表 → 帖子详情」的意图预取（性能项 P1-10）。
 *
 * 为什么需要：站内导航是 SPA 客户端路由，点击帖子不会重新取 HTML，但仍要等
 * `GET /api/threads/:tid` 一个完整 RTT（跨境 ~200–500ms）再渲染。列表页用户从「想点」到
 * 「真的点下去」通常有 100ms 以上的指针停留，这段时间足够把详情数据预取回 react-query 缓存。
 *
 * 为什么用全局委托而不是改造每个 `<Link>`：帖子的入口遍布 ThreadList / 发现页 / 相关帖 /
 * 排行榜 / 个人中心等 20+ 处，逐处包一层组件既容易漏、也会带来无谓的 diff。这里在 `document`
 * 上监听 `pointerover`（被动监听，不阻塞滚动），只认 `a[href^="/thread/"]`，与 react-router
 * 的 `<Link>` 渲染出的真实 href 天然一致。
 *
 * 边界（避免把「优化」变成「放大请求」）：
 *  - 停留 120ms 才算意图：快速划过一屏列表不会产生任何请求；
 *  - 游客单次页面加载最多 12 条、登录用户最多 3 条：登录用户不吃边缘缓存（响应含 me / 点赞态），
 *    每条预取都是一次真 Worker + 20~35 条 D1 查询，是列表页最贵的隐藏开销，必须按身份分级封顶
 *    （免费层 10 万 Worker 请求/天，12 条预取 ≈ 12 次请求 + 300 条 SQL，比打开一个帖子贵一个量级）；
 *  - 弱网/省流量（`saveData` 或 2g/3g）直接不预取——预取是纯优化，不能抢首屏带宽；
 *  - 已成功预取过的 `tid:page` 不重复请求；预取失败（403 无权 / 404 已删）立刻把这条查询从
 *    缓存摘掉，否则点进去会先命中 error 状态闪一下错误页；
 *  - 触摸设备没有 hover 语义，`pointerType === 'touch'` 一律跳过；键盘/读屏用户走 `focusin`。
 */
import type { ThreadDetail } from '@freeidx/shared';
import { apiGet } from './api';
import { queryClient } from './query-client';
import { useAuth } from '../store/auth';

/** 悬停意图判定阈值（ms） */
const HOVER_DELAY_MS = 120;
/** 游客：URL 级边缘缓存可命中，只是 1 次 Worker 请求 */
const MAX_PREFETCH_GUEST = 12;
/** 登录用户：每条都是真 Worker + 完整 D1 回源，压到 3 条换取额度 */
const MAX_PREFETCH_MEMBER = 3;
/** bootstrap 尚未返回时不知道身份，按登录用户的保守值走 */
const MAX_PREFETCH_UNKNOWN = 3;

/** 当前会话的预取上限：身份决定「一次预取值不值得」，与页面路径无关 */
function prefetchLimit(): number {
  const s = useAuth.getState();
  if (!s.loaded) return MAX_PREFETCH_UNKNOWN;
  return s.me ? MAX_PREFETCH_MEMBER : MAX_PREFETCH_GUEST;
}

interface Target {
  tid: number;
  /** 1 = 首页楼层，与 ThreadPage 的 `posInt` 口径一致（非法/0 归一到 1） */
  page: number;
}

/**
 * `/thread/5`、`/thread/5/p/3`、带尾斜杠或查询串/哈希 → { tid, page }。
 * 口径与 `pages/ThreadPage` 的 idParam/posInt 对齐：非正整数一律归一，非法 tid 返回 null。
 */
export function parseThreadHref(href: string | null | undefined): Target | null {
  const m = /^\/thread\/(\d+)(?:\/p\/(\d+))?\/?(?:[?#].*)?$/.exec(String(href ?? '').trim());
  if (!m) return null;
  const tid = Number(m[1]);
  if (!Number.isSafeInteger(tid) || tid <= 0) return null;
  const rawPage = m[2] === undefined ? 1 : Number(m[2]);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  return { tid, page };
}

/** 弱网/省流量时不预取（Navigator.connection 非标准，缺失即按可用处理） */
function allowPrefetch(): boolean {
  if (typeof navigator === 'undefined') return false;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData) return false;
  if (conn?.effectiveType && /^(slow-2g|2g|3g)$/.test(conn.effectiveType)) return false;
  return true;
}

let timer: ReturnType<typeof setTimeout> | null = null;
let pending: Target | null = null;
let started = 0;
/** 已发起过预取的 `tid:page`（失败也记一次，避免反复打无权/已删的帖子） */
const attempted = new Set<string>();

function clearPending(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  pending = null;
}

function prefetch(t: Target): void {
  const id = `${t.tid}:${t.page}`;
  if (attempted.has(id) || started >= prefetchLimit()) return;
  const queryKey = ['thread', t.tid, t.page] as const;
  // 已有成功数据（例如刚从另一个列表点进来又返回）→ 无需再取
  if (queryClient.getQueryState(queryKey)?.status === 'success') return;
  if (!allowPrefetch()) return;

  attempted.add(id);
  started += 1;
  void queryClient
    .prefetchQuery({
      queryKey,
      queryFn: () => apiGet<ThreadDetail>(`/api/threads/${t.tid}?page=${t.page}`),
      staleTime: 30_000,
      retry: false,
    })
    .then(() => {
      if (queryClient.getQueryState(queryKey)?.status !== 'error') return;
      /* 失败（403 无权 / 404 已删）把这条预取摘掉，免得点进去先命中一份 error 缓存。
       * 但如果用户已经点进这条帖子了，状态要留给页面自己的错误 UI 与重试，不能在这里删。 */
      if (isCurrentThread(t.tid)) return;
      queryClient.removeQueries({ queryKey, exact: true });
    });
}

/** 当前路由是否就是该帖子（点击已发生 → 不再干预这条查询的生命周期） */
function isCurrentThread(tid: number): boolean {
  return new RegExp(`^/thread/${tid}(?:/|$)`).test(window.location.pathname);
}

function anchorOf(node: EventTarget | null): HTMLAnchorElement | null {
  const el = node as Element | null;
  if (!el || typeof el.closest !== 'function') return null;
  return el.closest('a[href^="/thread/"]') as HTMLAnchorElement | null;
}

function targetOf(node: EventTarget | null): Target | null {
  const a = anchorOf(node);
  return a ? parseThreadHref(a.getAttribute('href')) : null;
}

function schedule(t: Target): void {
  if (pending && pending.tid === t.tid && pending.page === t.page) return;
  clearPending();
  pending = t;
  timer = setTimeout(() => {
    timer = null;
    pending = null;
    prefetch(t);
  }, HOVER_DELAY_MS);
}

function onPointerOver(e: PointerEvent): void {
  if (e.pointerType === 'touch') return;
  const t = targetOf(e.target);
  if (t) schedule(t);
}

function onPointerOut(e: PointerEvent): void {
  const a = anchorOf(e.target);
  if (!a) return;
  /* 在同一链接内部从文字移到图标也会冒泡出 pointerout：只要 relatedTarget 还在这条 a 里，
     指针就没有真正离开，不能取消已排队的预取。 */
  const to = e.relatedTarget as Node | null;
  if (to && typeof a.contains === 'function' && a.contains(to)) return;
  const t = parseThreadHref(a.getAttribute('href'));
  if (t && pending && pending.tid === t.tid && pending.page === t.page) clearPending();
}

/** 键盘 Tab / 读屏聚焦即视为明确意图，立即预取（没有 hover 停留的概念） */
function onFocusIn(e: FocusEvent): void {
  const t = targetOf(e.target);
  if (t) prefetch(t);
}

/**
 * 安装全局意图预取（在 `main.tsx` 求值期调用一次）。
 * 后台走独立外壳、帖子链接极少且以管理操作为主，跳过以免占用管理端的 D1 预算。
 */
export function installThreadPrefetch(): void {
  if (typeof window === 'undefined') return;
  if (/^\/admin(\/|$)/.test(window.location.pathname)) return;
  window.addEventListener('pointerover', onPointerOver, { passive: true });
  window.addEventListener('pointerout', onPointerOut, { passive: true });
  window.addEventListener('focusin', onFocusIn, { passive: true });
}
