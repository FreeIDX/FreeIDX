import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../store/auth';

/**
 * 游客页闸门（登录页 / 注册页）：
 * 只要本地鉴权态变成已登录，就 replace 回首页，不停留在表单页。
 *
 * 覆盖三条路径：
 * 1. 停在 /login 时从顶栏头像入口打开登录弹窗并登录成功——弹窗只是 closeAuth，
 *    底层仍是「欢迎回来，请登录你的账号」的登录页骨架（本次修复的场景）；
 * 2. 已登录用户手动访问 /login、/register（地址栏 / 前进后退 / 收藏夹）；
 * 3. 首屏 bootstrap 恢复会话（登录态在 load 后才落地，故必须监听 me 而不是只看首次渲染）。
 * 用 replace 而非 push：回退键不该退回已无意义的登录页。
 */
export function useGuestOnly() {
  const navigate = useNavigate();
  const me = useAuth((s) => s.me);

  useEffect(() => {
    if (me) navigate('/', { replace: true });
  }, [me, navigate]);
}
