import type { Message, ModelRequest, ModelResponse, ModelService, MiniContext, MiniPlugin, TokenUsage, ToolCall, ToolDefinition } from "../../types";
import { SERVICES } from "../../constants";

export interface DeepSeekConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  maxRetries?: number;
  retryBaseMs?: number;
}

type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * DeepSeek Model Provider（OpenAI 兼容协议，使用原生 fetch）。
 *
 * 上层 Agent Loop 只面向 ModelRequest/ModelResponse 编程，
 * 此处负责把统一抽象映射到 DeepSeek 的 /chat/completions。
 */
export class DeepSeekModel implements ModelService {
  readonly name = "deepseek";

  constructor(private config: DeepSeekConfig) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const body = {
      model: this.config.model,
      messages: this.toOpenAIMessages(req.messages),
      tools: req.tools.length > 0 ? this.toOpenAITools(req.tools) : undefined,
      stream: false,
    };

    const { response: resp, retries } = await this.fetchWithRetry(body, req.signal);

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`DeepSeek API 请求失败 (${resp.status}): ${text.slice(0, 500)}`);
    }

    const data = (await resp.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    const choice = data.choices?.[0];
    if (!choice) throw new Error("DeepSeek API 返回空 choices");

    const message = choice.message;
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments || "{}",
    }));

    const usage: TokenUsage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    };

    return {
      content: message.content,
      toolCalls,
      usage,
      retries,
    };
  }

  /**
   * 流式补全：开启 SSE，逐段回调文本增量。
   * OpenAI 流式协议里 tool_calls 是分片到达的（先 name，再 arguments 增量），
   * 此处按 index 聚合，最终拼出完整 ToolCall[] 返回，与非流式结果等价。
   */
  async streamComplete(req: ModelRequest, onDelta: (delta: string) => void): Promise<ModelResponse> {
    const body = {
      model: this.config.model,
      messages: this.toOpenAIMessages(req.messages),
      tools: req.tools.length > 0 ? this.toOpenAITools(req.tools) : undefined,
      stream: true,
      stream_options: { include_usage: true },
    };

    const { response: resp, retries } = await this.fetchWithRetry(body, req.signal);

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`DeepSeek API 请求失败 (${resp.status}): ${text.slice(0, 500)}`);
    }
    if (!resp.body) throw new Error("DeepSeek 流式响应缺少 body");

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    const toolCallMap = new Map<number, { id: string; name: string; args: string }>();
    const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") return;
      let chunk: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const entry = toolCallMap.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;
          toolCallMap.set(tc.index, entry);
        }
      }
      if (chunk.usage) {
        usage.promptTokens = chunk.usage.prompt_tokens ?? 0;
        usage.completionTokens = chunk.usage.completion_tokens ?? 0;
        usage.totalTokens = chunk.usage.total_tokens ?? 0;
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    if (buffer.trim()) handleLine(buffer);

    const toolCalls: ToolCall[] = [...toolCallMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => ({ id: v.id, name: v.name, arguments: v.args || "{}" }));

    return {
      content: content || null,
      toolCalls,
      usage,
      retries,
    };
  }

  private async fetchWithRetry(body: Record<string, unknown>, signal: AbortSignal): Promise<{ response: Response; retries: number }> {
    const maxRetries = Math.max(0, this.config.maxRetries ?? 2);
    const baseMs = Math.max(50, this.config.retryBaseMs ?? 300);
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal.aborted) throw new Error("模型请求已取消");
      try {
        const resp = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
            "X-Client-Request-Id": `mini-dsh-${Date.now().toString(36)}-${attempt}`,
          },
          body: JSON.stringify(body),
          signal,
        });
        if (resp.ok || !isRetryableStatus(resp.status) || attempt === maxRetries) {
          return { response: resp, retries: attempt };
        }
        await delay(baseMs * 2 ** attempt, signal);
      } catch (err) {
        lastError = err;
        if (signal.aborted || attempt === maxRetries) throw err;
        await delay(baseMs * 2 ** attempt, signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("模型请求失败");
  }

  /** 供 Context Manager 使用：对历史做摘要 */
  async summarize(messages: Message[]): Promise<string> {
    const summaryMessages: Message[] = [
      {
        role: "system",
        content:
          "你是会话压缩器。请把下面这段 Agent 与工具的历史对话，压缩成一段不超过 500 字的客观摘要，保留关键事实：任务目标、已完成的步骤、关键文件与修改、尚未完成的事项、以及任何报错。只输出摘要正文。",
      },
      { role: "user", content: this.renderForSummary(messages) },
    ];
    const resp = await this.complete({ messages: summaryMessages, tools: [], signal: new AbortController().signal });
    return resp.content ?? "";
  }

  private renderForSummary(messages: Message[]): string {
    return messages
      .map((m) => {
        if (m.role === "tool") return `[tool ${m.toolCallId ?? ""}]\n${m.content.slice(0, 2000)}`;
        if (m.role === "assistant" && m.toolCalls?.length) {
          return `[assistant -> tool_calls: ${m.toolCalls.map((t) => t.name).join(", ")}]\n${m.content.slice(0, 500)}`;
        }
        return `[${m.role}]\n${m.content.slice(0, 2000)}`;
      })
      .join("\n\n");
  }

  private toOpenAIMessages(messages: Message[]): OpenAIMessage[] {
    return messages.map((m): OpenAIMessage => {
      switch (m.role) {
        case "system":
        case "user":
          return { role: m.role, content: m.content };
        case "assistant":
          return {
            role: "assistant",
            content: m.content || null,
            tool_calls: m.toolCalls?.map((tc): OpenAIToolCall => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            })),
          };
        case "tool":
          return { role: "tool", content: m.content, tool_call_id: m.toolCallId ?? "" };
      }
    });
  }

  private toOpenAITools(tools: ToolDefinition[]): Array<{ type: "function"; function: ToolDefinition }> {
    return tools.map((t) => ({ type: "function" as const, function: t }));
  }
}

/** DeepSeek 模型插件：装配期校验配置并注册服务 */
export class DeepSeekModelPlugin implements MiniPlugin {
  readonly name = "plugin.deepseek-model";
  private model?: DeepSeekModel;

  constructor(private options?: { apiKey?: string; model?: string; baseUrl?: string; maxRetries?: number; retryBaseMs?: number }) {}

  setup(ctx: MiniContext): void {
    const apiKey = this.options?.apiKey ?? process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "[DeepSeekModelPlugin] 缺少 DEEPSEEK_API_KEY，请在 .env 或环境变量中配置，或改用 MockModel",
      );
    }
    const model = this.options?.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
    const baseUrl = this.options?.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";

    this.model = new DeepSeekModel({
      apiKey,
      model,
      baseUrl,
      maxRetries: this.options?.maxRetries ?? Number(process.env.DEEPSEEK_MAX_RETRIES ?? 2),
      retryBaseMs: this.options?.retryBaseMs ?? Number(process.env.DEEPSEEK_RETRY_BASE_MS ?? 300),
    });
    ctx.provide<ModelService>(SERVICES.MODEL, this.model);
  }

  dispose(): void {
    this.model = undefined;
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("模型重试等待已取消"));
    }, { once: true });
  });
}
