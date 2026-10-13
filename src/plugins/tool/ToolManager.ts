import type { ExecutionContext, MiniContext, PermissionService, Tool, ToolCall, ToolDefinition, ToolResult, ToolService } from "../../types";
import { SERVICES, EVENTS } from "../../constants";
import { isRecord, toErrorMessage, validateToolArguments } from "../../utils";

/**
 * ToolManager：聚合多个 Tool 并统一分发，是工具执行的唯一入口。
 *
 * 职责：
 * 1. 维护工具注册表（name -> Tool）
 * 2. 解析 ToolCall 参数并路由到对应工具
 * 3. 执行前统一做权限校验（Permission 插件，可选）
 * 4. 统一异常捕获，把「未注册工具 / 参数非法 / 权限拒绝」转成可回喂模型的消息
 */
export class ToolManager implements ToolService {
  private tools = new Map<string, Tool>();

  constructor(private ctx: MiniContext) {}

  register(tool: Tool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`[ToolManager] 工具名重复: "${tool.definition.name}"`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  listDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  async execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { output: "", error: `未注册的工具: "${call.name}"` };
    }

    let args: Record<string, unknown>;
    try {
      const parsed = JSON.parse(call.arguments || "{}") as unknown;
      if (!isRecord(parsed)) throw new Error("参数根节点必须是 object");
      args = parsed;
    } catch {
      return { output: "", error: `工具 "${call.name}" 的参数不是合法 JSON: ${call.arguments}` };
    }

    const schemaError = validateToolArguments(tool.definition.parameters, args);
    if (schemaError) {
      return { output: "", error: `工具 "${call.name}" 参数校验失败: ${schemaError}` };
    }

    // 权限校验（Permission 插件，可选注入）
    const permission = this.ctx.tryInject<PermissionService>(SERVICES.PERMISSION);
    if (permission) {
      try {
        await permission.checkTool(call.name, args, ctx);
      } catch (err) {
        this.ctx.emit(EVENTS.PERMISSION_DENIED, { name: call.name, args });
        return { output: "", error: `权限校验未通过: ${toErrorMessage(err)}` };
      }
    }

    const startedAt = Date.now();
    try {
      const result = await tool.execute(args, ctx);
      return {
        ...result,
        metadata: {
          ...(result.metadata ?? {}),
          durationMs: Date.now() - startedAt,
        },
      };
    } catch (err) {
      return {
        output: "",
        error: toErrorMessage(err),
        metadata: { durationMs: Date.now() - startedAt },
      };
    }
  }
}
