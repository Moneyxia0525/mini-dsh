import type { ContextManagerService, Message, MiniContext, MiniPlugin, ModelService } from "../../types";
import { SERVICES, EVENTS } from "../../constants";
import { estimateTokens } from "../../utils";

export interface ContextManagerConfig {
  /** 上下文 token 上限 */
  maxTokens?: number;
  /** 触发压缩的占用比例（默认 80%） */
  triggerRatio?: number;
  /** 压缩后保留的最近消息条数 */
  keepWindow?: number;
  /** 大工具结果截断阈值（字符） */
  maxToolResultChars?: number;
}

const DEFAULTS = {
  maxTokens: 16000,
  triggerRatio: 0.8,
  keepWindow: 12,
  maxToolResultChars: 4000,
};

/**
 * Context Manager 插件：防上下文膨胀。
 *
 * 机制（对应文档 §6.3）：
 * 1. 大体积工具结果先截断
 * 2. 占用达阈值（80%）时触发压缩
 * 3. 用模型把较早历史生成摘要，仅保留最近 keepWindow 条消息完整内容
 */
export class ContextManager implements ContextManagerService {
  private cfg: Required<ContextManagerConfig>;
  private states = new WeakMap<Message[], { summary: string; summarizedGroups: number }>();

  constructor(private ctx: MiniContext, config: ContextManagerConfig = {}) {
    this.cfg = { ...DEFAULTS, ...config } as Required<ContextManagerConfig>;
  }

  async manage(messages: Message[], model?: ModelService): Promise<Message[]> {
    // 1. 结果截断（始终生效）
    const truncated = messages.map((m) => {
      if (m.role === "tool" && m.content.length > this.cfg.maxToolResultChars) {
        return {
          ...m,
          content: m.content.slice(0, this.cfg.maxToolResultChars) +
            `\n...（工具结果过长，已截断，原 ${m.content.length} 字符）`,
        };
      }
      return m;
    });

    // 2. 估算占用，未达阈值则直接返回
    const total = truncated.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    if (total <= this.cfg.maxTokens * this.cfg.triggerRatio) {
      return truncated;
    }

    // 3. 压缩：拆出 system，按「assistant tool call + 对应 tool results」
    // 组成不可拆分的 turn，避免生成非法的 Tool Calling 消息序列。
    const systemIdx = truncated.findIndex((m) => m.role === "system");
    const system = systemIdx >= 0 ? [truncated[systemIdx]] : [];
    const history = systemIdx >= 0 ? truncated.slice(systemIdx + 1) : truncated;

    const groups = groupMessages(history);
    if (groups.length <= this.cfg.keepWindow) {
      return truncated;
    }

    const oldGroups = groups.slice(0, groups.length - this.cfg.keepWindow);
    const old = oldGroups.flat();
    const recent = groups.slice(-this.cfg.keepWindow).flat();

    let summary: string;
    const previous = this.states.get(messages);
    try {
      const newOld = previous ? oldGroups.slice(previous.summarizedGroups).flat() : old;
      if (previous && newOld.length === 0) {
        summary = previous.summary;
      } else if (model) {
        const input = previous
          ? [{ role: "user" as const, content: `[已有历史摘要]\n${previous.summary}` }, ...newOld]
          : old;
        summary = await model.summarize(input);
      } else {
        summary = previous
          ? `${previous.summary}\n${this.heuristicSummary(newOld)}`
          : this.heuristicSummary(old);
      }
      if (model) {
        this.ctx.emit(EVENTS.MODEL_AUX_USAGE, {
          kind: "context-summary",
          requests: 1,
          promptTokens: 0,
          completionTokens: 0,
        });
      }
    } catch {
      summary = previous
        ? `${previous.summary}\n${this.heuristicSummary(oldGroups.slice(previous.summarizedGroups).flat())}`
        : this.heuristicSummary(old);
    }
    this.states.set(messages, { summary, summarizedGroups: oldGroups.length });

    this.ctx.emit(EVENTS.CONTEXT_COMPRESSED, {
      compressedCount: old.length,
      keptCount: recent.length,
      beforeTokens: total,
    });

    return [
      ...system,
      { role: "user" as const, content: `[历史摘要（由 Context Manager 生成）]\n${summary}` },
      ...recent,
    ];
  }

  private heuristicSummary(old: Message[]): string {
    const parts = old.slice(0, 20).map((m) => {
      if (m.role === "tool") return `- 工具结果(${m.toolCallId ?? ""}): ${m.content.slice(0, 80)}`;
      if (m.role === "assistant" && m.toolCalls?.length) return `- 调用工具: ${m.toolCalls.map((t) => t.name).join(", ")}`;
      return `- ${m.role}: ${m.content.slice(0, 80)}`;
    });
    return `共 ${old.length} 条历史。摘要：\n${parts.join("\n")}`;
  }
}

function groupMessages(messages: Message[]): Message[][] {
  const groups: Message[][] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant" && message.toolCalls?.length) {
      const group = [message];
      while (messages[i + 1]?.role === "tool") group.push(messages[++i]);
      groups.push(group);
    } else {
      groups.push([message]);
    }
  }
  return groups;
}

export class ContextManagerPlugin implements MiniPlugin {
  readonly name = "plugin.context-manager";

  constructor(private config: ContextManagerConfig = {}) {}

  setup(ctx: MiniContext): void {
    ctx.provide<ContextManagerService>(SERVICES.CONTEXT_MANAGER, new ContextManager(ctx, this.config));
  }
}
