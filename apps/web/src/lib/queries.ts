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
 * 全站主题列表（fid=0）查询描述：page / digest / orderby / lang 四元组同时决定 queryKey 与 URL，
 * 口径与后端 `?page=&digest=&orderby=&lang=` 参数一致。首页与发现页共用，缓存自动命中。
 *
 * lang 必须显式拼进 URL（空串 = 全部语言）：边缘缓存键只认 URL，隐式默认值会导致
 * 不同语言用户命中同一份缓存副本。
 */
export function siteThreadsQuery(page: number, digest: 0 | 1, orderby: 'tid' | 'lastpid', lang = '') {
  const qs = `page=${page}${digest ? '&digest=1' : ''}&orderby=${orderby}${lang ? `&lang=${encodeURIComponent(lang)}` : ''}`;
  return {
    queryKey: ['threads', 0, page, digest, orderby, lang] as const,
    queryFn: () => apiGet<ThreadPageData>(`/api/threads?${qs}`),
  };
}
