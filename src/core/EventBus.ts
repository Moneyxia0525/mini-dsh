/** 事件发布/订阅总线：内核与插件间的解耦通道 */
export class EventBus {
  private handlers = new Map<string, Set<(payload: unknown) => void>>();

  on(event: string, handler: (payload: unknown) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  off(event: string, handler: (payload: unknown) => void): void {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, payload: unknown): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch (err) {
        // 单个订阅者抛错不阻断其它订阅者
        // eslint-disable-next-line no-console
        console.error(`[EventBus] handler for "${event}" threw:`, err);
      }
    }
  }

  clear(): void {
    this.handlers.clear();
  }
}
