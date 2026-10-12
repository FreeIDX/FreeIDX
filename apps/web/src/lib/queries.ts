/**
 * 跨页共用查询描述符。
 * 动机：首页与发现页请求的是同一个 URL（/api/threads?page=1&orderby=tid），
 * 但此前各自写了不同的 queryKey（['threads',0,1,0,'tid'] vs ['discovery','latest']），
 * React Query 按 key 去重 → 同一份数据被请求两次，切页时白跑一次列表接口。
 * 统一到此处后，key 与 URL 由同一函数产出，不会再漂移。
 */
import { apiGet } from './api';
import type { ThreadPageData } from '../components/ThreadList';

/**
 * 全站主题列表（fid=0）查询描述：page / digest / orderby 三元组同时决定 queryKey 与 URL，
 * 口径与后端 `?page=&digest=&orderby=` 参数一致。首页与发现页共用，缓存自动命中。
 */
export function siteThreadsQuery(page: number, digest: 0 | 1, orderby: 'tid' | 'lastpid') {
  return {
    queryKey: ['threads', 0, page, digest, orderby] as const,
    queryFn: () =>
      apiGet<ThreadPageData>(`/api/threads?page=${page}${digest ? '&digest=1' : ''}&orderby=${orderby}`),
  };
}
