import type { LoopStrategy, MiniContext, MiniPlugin } from "../../types";
import { SERVICES } from "../../constants";
import { AgentLoop } from "../../core/AgentLoop";

/**
 * Loop 插件：把默认循环策略 AgentLoop 注册为可注入服务（SERVICES.LOOP）。
 *
 * 这样 Harness 不再硬编码 `new AgentLoop(ctx)`，而是从 ServiceRegistry
 * 注入循环策略。替换循环策略（如 Plan-Execute、多智能体编排）只需提供
 * 一个实现 LoopStrategy 的插件，并让它在 setup 中 provide SERVICES.LOOP，
 * 即可整体替换执行引擎而不改 Harness —— 与其它插件的替换方式完全一致。
 */
export class LoopPlugin implements MiniPlugin {
  readonly name = "plugin.loop";
  private loop?: AgentLoop;

  setup(ctx: MiniContext): void {
    this.loop = new AgentLoop(ctx);
    ctx.provide<LoopStrategy>(SERVICES.LOOP, this.loop);
  }

  dispose(): void {
    this.loop = undefined;
  }
}
