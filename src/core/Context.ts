import type { MiniContext } from "../types";
import { ServiceRegistry } from "./ServiceRegistry";
import { EventBus } from "./EventBus";

/**
 * MiniContext：插件在运行时拿到的唯一上下文。
 *
 * 它聚合 ServiceRegistry（提供/注入）与 EventBus（收发事件），
 * 插件之间不直接引用彼此实现，只通过 key 与事件协作。
 */
export class Context implements MiniContext {
  readonly services: ServiceRegistry;
  readonly events: EventBus;

  constructor(services?: ServiceRegistry, events?: EventBus) {
    this.services = services ?? new ServiceRegistry();
    this.events = events ?? new EventBus();
  }

  provide<T>(key: string, service: T): void {
    this.services.register(key, service);
  }

  inject<T>(key: string): T {
    return this.services.get<T>(key);
  }

  tryInject<T>(key: string): T | undefined {
    return this.services.tryGet<T>(key);
  }

  on(event: string, handler: (payload: unknown) => void): () => void {
    return this.events.on(event, handler);
  }

  emit(event: string, payload: unknown): void {
    this.events.emit(event, payload);
  }
}
