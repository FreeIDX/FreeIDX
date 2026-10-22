/**
 * 生命周期事件总线（§12 契约 ②；T1-8）。
 * 错误隔离：单个插件处理器异常不影响核心与其他插件。
 */
import type { EventName, EventPayload } from '@freeidx/shared';

/**
 * 存储态处理器：参数取 `never`。
 * 由逆变规则，任何 `(payload: EventPayload<N>) => …` 都可直接赋给它（无需 any 或断言），
 * 而取出时由 emit 按具体事件名把参数类型还原，保证订阅/派发的载荷一一对应。
 */
type StoredHandler = (payload: never) => void | Promise<void>;

export class EventBus {
  private map = new Map<EventName, StoredHandler[]>();

  on<N extends EventName>(event: N, fn: (payload: EventPayload<N>) => void | Promise<void>): () => void {
    const list = this.map.get(event) ?? [];
    list.push(fn);
    this.map.set(event, list);
    return () => {
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  async emit<N extends EventName>(event: N, payload: EventPayload<N>): Promise<void> {
    for (const fn of [...(this.map.get(event) ?? [])]) {
      try {
        await (fn as (p: EventPayload<N>) => void | Promise<void>)(payload);
      } catch (err) {
        // 插件故障不影响核心（铁律：可停用、可容错）
        console.warn(`[extensions] handler error on ${String(event)}:`, err);
      }
    }
  }

  listenerCount(event: EventName): number {
    return this.map.get(event)?.length ?? 0;
  }
}
