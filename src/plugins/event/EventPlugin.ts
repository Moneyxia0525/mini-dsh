import type { MiniContext, MiniPlugin } from "../../types";
import { SERVICES } from "../../constants";
import type { EventBus } from "../../core/EventBus";

/**
 * Event 插件：把 EventBus 注册为命名服务（SERVICES.EVENT_BUS）。
 *
 * EventBus 本身仍由 Context 持有（内核最小化），但通过 EventPlugin
 * 它被纳入 ServiceRegistry，可被任意插件 inject，兑现「Event 插件化」
 * 的装配承诺——事件总线不再是隐式核心依赖，而是显式可注入服务。
 */
export class EventPlugin implements MiniPlugin {
  readonly name = "plugin.event";

  constructor(private eventBus: EventBus) {}

  setup(ctx: MiniContext): void {
    ctx.provide<EventBus>(SERVICES.EVENT_BUS, this.eventBus);
  }
}
