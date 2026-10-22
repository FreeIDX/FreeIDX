/**
 * 后台登录弹窗的全局开关（与组件分离存放：ui.tsx 的 ErrorState 与 AdminLoginModal
 * 都要用它，拆开可避免共享控件 ↔ 弹窗组件的循环依赖）。
 */
import { create } from 'zustand';

interface AdminLoginModalState {
  open: boolean;
  show: () => void;
  hide: () => void;
}

export const useAdminLoginModal = create<AdminLoginModalState>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));
