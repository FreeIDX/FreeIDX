/** 登录/注册弹窗全局态（Zustand）：任意入口 openAuth 打开，AuthModal 消费显隐 */
import { create } from 'zustand';

type AuthTab = 'login' | 'register';

interface AuthModalState {
  open: boolean;
  tab: AuthTab;
  openAuth: (tab?: AuthTab) => void;
  closeAuth: () => void;
}

export const useAuthModal = create<AuthModalState>((set) => ({
  open: false,
  tab: 'login',
  openAuth: (tab = 'login') => set({ open: true, tab }),
  closeAuth: () => set({ open: false }),
}));
