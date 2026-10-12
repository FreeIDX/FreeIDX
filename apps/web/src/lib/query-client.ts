/** 共享 QueryClient：main.tsx 挂载用，auth store 在登录/登出后失效全量查询以刷新服务端按访问者下发的权限/计数 */
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});
