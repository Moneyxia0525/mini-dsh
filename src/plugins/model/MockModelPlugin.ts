import type { Message, ModelRequest, ModelResponse, ModelService, MiniContext, MiniPlugin, ToolCall } from "../../types";
import { SERVICES } from "../../constants";

/** MockModel 的单步脚本：要么返回工具调用，要么返回最终回答 */
export interface MockStep {
  toolCalls?: Array<{ name: string; arguments?: Record<string, unknown> }>;
  content?: string;
}

/**
 * MockModel：确定性的脚本化模型，用于在没有 API Key 的情况下
 * 冒烟测试 Agent Loop 的完整链路（预算、工具分发、指标、会话记录）。
 */
export class MockModel implements ModelService {
  readonly name = "mock";
  private cursor = 0;
  private callCount = 0;

  constructor(private script: MockStep[]) {}

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    this.callCount++;
    const step = this.script[this.cursor] ?? this.script[this.script.length - 1];
    if (this.cursor < this.script.length) this.cursor++;

    const toolCalls: ToolCall[] = (step.toolCalls ?? []).map((tc, i) => ({
      id: `mock_call_${this.callCount}_${i}`,
      name: tc.name,
      arguments: JSON.stringify(tc.arguments ?? {}),
    }));

    return {
      content: toolCalls.length === 0 ? (step.content ?? "done") : step.content ?? null,
      toolCalls,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }

  /**
   * 流式补全（确定性）：复用 complete() 保证结果一致，再把内容按小片段
   * 回调 onDelta，用于验证 Agent Loop 的流式消费链路（无需真实 API）。
   */
  async streamComplete(req: ModelRequest, onDelta: (delta: string) => void): Promise<ModelResponse> {
    const resp = await this.complete(req);
    if (resp.content) {
      const chunks = resp.content.match(/[\s\S]{1,8}/g) ?? [];
      for (const c of chunks) onDelta(c);
    }
    return resp;
  }

  async summarize(messages: Message[]): Promise<string> {
    return `[mock summary] ${messages.length} 条历史消息被压缩。`;
  }
}

/** 插件外壳：将 MockModel 注册为模型服务 */
export class MockModelPlugin implements MiniPlugin {
  readonly name = "plugin.mock-model";

  constructor(private script: MockStep[]) {}

  setup(ctx: MiniContext): void {
    ctx.provide<ModelService>(SERVICES.MODEL, new MockModel(this.script));
  }
}
