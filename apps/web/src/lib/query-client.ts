/** 共享 QueryClient：main.tsx 挂载用，auth store 在登录/登出后失效全量查询以刷新服务端按访问者下发的权限/计数 */
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      /** 缓存保留 5min：列表/详情来回切换不重复请求，超出后释放内存 */
      gcTime: 5 * 60_000,
      retry: 1,
      /**
       * 关闭「回到标签页就重取」（性能/用量项 D3）。
       * 长驻标签页的用户每次切回来都会让全部过期查询各打一次 Worker 请求（首页 5~8 个），
       * 对免费层请求额度是纯放大，而 30s 新鲜度对论坛内容已经够用。
       * 需要即时性的场景由写操作/登录态变更显式 invalidate（见 store/auth 与各页 mutation）。
       */
      refetchOnWindowFocus: false,
    },
  },
});
