import type { MiniContext, MiniPlugin, ModelService, PromptOptimizerService } from "../../types";
import { SERVICES, EVENTS } from "../../constants";

export interface PromptOptimizerConfig {
  /** 是否用模型二次润色（默认 false，使用确定性模板） */
  useModel?: boolean;
}

/**
 * Prompt Optimizer 插件：把模糊需求转换为可执行的 Worker Prompt。
 *
 * 补全目标、约束、验收标准、工作目录、可用工具等要素，
 * 产出结构化任务指令，减少因约束不明确带来的无效执行。
 */
export class PromptOptimizer implements PromptOptimizerService {
  constructor(private ctx: MiniContext, private config: PromptOptimizerConfig = {}) {}

  async optimize(request: string, ctx: { workdir: string; toolNames?: string[] }): Promise<string> {
    const tools = (ctx.toolNames ?? []).map((t) => `- ${t}`).join("\n");
    const template = [
      "# 任务目标",
      request,
      "",
      "# 工作目录",
      ctx.workdir,
      "",
      "# 可用工具",
      tools || "(无)",
      "",
      "# 执行要求",
      "1. 先阅读相关文件，理解现状，不要凭空假设。",
      "2. 分步修改，每完成一步用工具验证，避免一次性大改。",
      "3. 完成所有修改后，运行测试/构建等命令验证结果。",
      "4. 最后用简洁中文总结：改了什么、为什么、验证结果如何。",
    ].join("\n");

    if (!this.config.useModel) {
      return template;
    }

    try {
      const model = this.ctx.tryInject<ModelService>(SERVICES.MODEL);
      if (!model) return template;
      const resp = await model.complete({
        messages: [
          {
            role: "system",
            content:
              "你是任务规划器。请把用户的模糊需求改写为清晰、可执行的任务指令，包含：目标、约束、验收标准、工作目录、建议步骤。保持客观，不编造事实。",
          },
          { role: "user", content: `工作目录: ${ctx.workdir}\n可用工具: ${tools}\n原始需求: ${request}` },
        ],
        tools: [],
        signal: new AbortController().signal,
      });
      this.ctx.emit(EVENTS.MODEL_AUX_USAGE, {
        kind: "prompt-optimizer",
        requests: 1,
        promptTokens: resp.usage.promptTokens,
        completionTokens: resp.usage.completionTokens,
      });
      return resp.content ?? template;
    } catch {
      return template;
    }
  }
}

export class PromptOptimizerPlugin implements MiniPlugin {
  readonly name = "plugin.prompt-optimizer";

  constructor(private config: PromptOptimizerConfig = {}) {}

  setup(ctx: MiniContext): void {
    ctx.provide<PromptOptimizerService>(SERVICES.PROMPT_OPTIMIZER, new PromptOptimizer(ctx, this.config));
  }
}
