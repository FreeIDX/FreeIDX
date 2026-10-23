/**
 * 后台写操作三件套：按钮 loading（useMutation）、成功/失败反馈条、按 queryKey 失效列表。
 * mutationFn 无参：React Query v5 每次渲染刷新 options，故表单值用闭包取最新即可。
 * 失败文案统一走 apiErrorMessage——服务端 message 已按场景定制，只在缺失时回落业务码 MAP。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiErrorMessage } from '../lib/errors';
import { useAdminT } from './t';

export interface Flash {
  tone: 'ok' | 'warn';
  text: string;
}

export function useAdminAction<TData>(
  fn: () => Promise<TData>,
  opts: {
    ok?: string | ((d: TData) => string);
    invalidate?: readonly (readonly unknown[])[];
    /** 保存后用服务端回包刷新本地表单（如「邮箱设置」按回包重置 hasPass / 清空明文密码框） */
    onData?: (d: TData) => void;
  } = {},
) {
  const qc = useQueryClient();
  const t = useAdminT();
  const [flash, setFlash] = useState<Flash | null>(null);
  const m = useMutation<TData, unknown, void>({
    mutationFn: () => fn(),
    onSuccess: (d) => {
      for (const key of opts.invalidate ?? []) void qc.invalidateQueries({ queryKey: key });
      opts.onData?.(d);
      setFlash({ tone: 'ok', text: typeof opts.ok === 'function' ? opts.ok(d) : (opts.ok ?? t('operation_success')) });
    },
    onError: (e) => setFlash({ tone: 'warn', text: apiErrorMessage(e) }),
  });
  return { flash, setFlash, mutate: m.mutate, pending: m.isPending };
}

/** 批量逐条提交（逐条串行）：失败即中断并透出首条错误 */
export function useBatchAction(invalidate?: readonly (readonly unknown[])[]) {
  const qc = useQueryClient();
  const t = useAdminT();
  const [flash, setFlash] = useState<Flash | null>(null);
  const [pending, setPending] = useState(false);
  const run = async (jobs: (() => Promise<unknown>)[], okText: string): Promise<boolean> => {
    if (!jobs.length) {
      setFlash({ tone: 'warn', text: t('no_data_to_process') });
      return false;
    }
    setPending(true);
    try {
      for (const job of jobs) await job();
      for (const key of invalidate ?? []) void qc.invalidateQueries({ queryKey: key });
      setFlash({ tone: 'ok', text: t('batch_result_summary', '{text}（{count} 项）', { text: okText, count: jobs.length }) });
      return true;
    } catch (e) {
      setFlash({ tone: 'warn', text: apiErrorMessage(e) });
      return false;
    } finally {
      setPending(false);
    }
  };
  return { flash, setFlash, run, pending };
}
