import type { MiniContext, MiniPlugin, ToolService } from "../../types";
import { SERVICES } from "../../constants";
import { ToolManager } from "./ToolManager";
import { fileTools } from "./FileTools";
import { runCommandTool } from "./CommandTool";
import { codingTools } from "./CodingTools";

/**
 * Tool 插件：把基础工具装配进 ToolManager 并注册为服务。
 * 新增工具只需在 setup 里多 register 一次，无需改动 Agent Loop。
 */
export class ToolPlugin implements MiniPlugin {
  readonly name = "plugin.tools";

  setup(ctx: MiniContext): void {
    const manager = new ToolManager(ctx);
    for (const tool of fileTools) manager.register(tool);
    manager.register(runCommandTool);
    for (const tool of codingTools) manager.register(tool);
    ctx.provide<ToolService>(SERVICES.TOOLS, manager);
  }
}
