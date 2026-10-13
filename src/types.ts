/**
 * Mini-dsh 核心类型定义
 *
 * 所有模块共享的类型契约。文档见 docs 与 README；此处接口与
 * 技术设计文档 §4 / §5 / §8 保持一致。
 */

/* ------------------------------------------------------------------ *
 * 消息与工具调用
 * ------------------------------------------------------------------ */

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string;
  /** tool 角色：关联的 tool_call id */
  toolCallId?: string;
  /** assistant 角色：结构化工具调用 */
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  /** JSON 序列化后的参数 */
  arguments: string;
}

/** 工具定义（对齐 OpenAI function-calling schema） */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema 参数描述 */
  parameters: Record<string, unknown>;
}

export interface ToolResult {
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * 统一模型抽象
 * ------------------------------------------------------------------ */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModelRequest {
  messages: Message[];
  tools: ToolDefinition[];
  signal: AbortSignal;
}

export interface ModelResponse {
  content: string | null;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  /** 请求因网络/限流/5xx 重试的次数 */
  retries?: number;
}

/* ------------------------------------------------------------------ *
 * 插件协议
 * ------------------------------------------------------------------ */

export interface MiniContext {
  /** 向 ServiceRegistry 注册服务 */
  provide<T>(key: string, service: T): void;
  /** 从 ServiceRegistry 注入服务，缺失即抛错 */
  inject<T>(key: string): T;
  /** 尝试注入，缺失返回 undefined */
  tryInject<T>(key: string): T | undefined;
  /** 订阅事件，返回取消订阅函数 */
  on(event: string, handler: (payload: unknown) => void): () => void;
  /** 发布事件 */
  emit(event: string, payload: unknown): void;
}

export interface MiniPlugin {
  name: string;
  /** 依赖的其他插件 name（按插件名做拓扑排序与依赖校验） */
  dependsOn?: string[];
  setup(ctx: MiniContext): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

/* ------------------------------------------------------------------ *
 * 服务接口（插件通过 ServiceRegistry 对外提供能力）
 * ------------------------------------------------------------------ */

/** 模型服务 */
export interface ModelService {
  readonly name: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
  /** 流式补全；onDelta 在每收到一段文本增量时回调，最终返回完整响应（含工具调用） */
  streamComplete?(req: ModelRequest, onDelta: (delta: string) => void): Promise<ModelResponse>;
  /** 用于 Context Manager 的历史摘要 */
  summarize(messages: Message[]): Promise<string>;
}

/** 工具执行上下文 */
export interface ExecutionContext {
  /** 会话工作目录 */
  workdir: string;
  signal: AbortSignal;
  sessionId?: string;
}

/** 单个工具 */
export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, ctx: ExecutionContext): Promise<ToolResult>;
}

/** 工具服务（聚合多个 Tool 并统一分发） */
export interface ToolService {
  listDefinitions(): ToolDefinition[];
  execute(call: ToolCall, ctx: ExecutionContext): Promise<ToolResult>;
}

/** 权限风险等级（供 human-in-the-loop 确认时展示） */
export type RiskLevel = "low" | "medium" | "high";

/** 交互式确认请求：交给 ConfirmationHandler 决定是否放行 */
export interface PermissionRequest {
  toolName: string;
  args: Record<string, unknown>;
  riskLevel: RiskLevel;
  /** 风险说明，便于人类决策 */
  reason: string;
}

/** 交互式确认回调：返回 false 即拒绝（由 PermissionService 转为错误） */
export type ConfirmationHandler = (req: PermissionRequest) => Promise<boolean>;

/** 权限服务：校验不过直接抛错 */
export interface PermissionService {
  checkTool(toolName: string, args: Record<string, unknown>, ctx: ExecutionContext): void | Promise<void>;
}

/** 任务计划中的一个可验证步骤。 */
export interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "running" | "passed" | "failed";
  verification?: string;
}

export interface TaskPlan {
  goal: string;
  steps: PlanStep[];
  createdAt: number;
}

export interface PlannerService {
  createPlan(task: string, ctx: { workdir: string; toolNames: string[] }): Promise<TaskPlan>;
}

export interface VerificationRequest {
  task: string;
  workdir: string;
  messages: Message[];
  signal: AbortSignal;
  plan?: TaskPlan;
}

export interface VerificationResult {
  passed: boolean;
  summary: string;
  checks?: Array<{ name: string; passed: boolean; detail: string }>;
}

export interface VerifierService {
  verify(request: VerificationRequest): Promise<VerificationResult>;
}

/** 会话持久化记录（一条 JSONL） */
export interface SessionRecord {
  kind: "system" | "user" | "assistant" | "tool" | "event" | "checkpoint";
  content?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  name?: string;
  result?: string;
  error?: string;
  /** kind === "event" 时携带的事件负载 */
  payload?: unknown;
  ts: number;
}

export interface RunCheckpoint {
  runId: string;
  phase: "plan" | "execute" | "verify" | "done" | "aborted" | "error";
  task: string;
  plan?: TaskPlan;
  metrics: AgentMetrics;
  updatedAt: number;
}

/** 会话服务 */
export interface SessionService {
  getSessionId(): string;
  append(record: Omit<SessionRecord, "ts">): void;
  load(): SessionRecord[];
  getFilePath(): string;
  saveCheckpoint?(checkpoint: RunCheckpoint): void;
  loadLatestCheckpoint?(): RunCheckpoint | undefined;
}

/** 上下文管理服务：接收原始消息，返回压缩后的消息 */
export interface ContextManagerService {
  manage(messages: Message[], model?: ModelService): Promise<Message[]>;
}

/** Prompt 优化服务：模糊需求 -> 结构化 Worker Prompt */
export interface PromptOptimizerService {
  optimize(request: string, ctx: { workdir: string; toolNames?: string[] }): Promise<string>;
}

/* ------------------------------------------------------------------ *
 * Agent Loop 配置与结果
 * ------------------------------------------------------------------ */

export interface AgentRunConfig {
  /** 系统提示词 */
  systemPrompt: string;
  /** 工作目录 */
  workdir: string;
  /** 模型请求上限（默认 64） */
  maxModelRequests?: number;
  /** 工具调用上限（默认 128） */
  maxToolCalls?: number;
  /** 超时时间 ms（默认 10 分钟） */
  timeoutMs?: number;
  /** 续接时的历史消息（不含 system），用于 /continue */
  priorMessages?: Message[];
  /** 最大验证次数；默认 2。设为 0 可关闭自动验证。 */
  maxVerificationAttempts?: number;
}

export type AgentRunStatus = "done" | "aborted" | "budget_exhausted" | "error";

export interface AgentMetrics {
  modelRequests: number;
  auxiliaryModelRequests: number;
  toolCalls: number;
  toolErrors: number;
  promptTokens: number;
  completionTokens: number;
  auxiliaryPromptTokens: number;
  auxiliaryCompletionTokens: number;
  verificationRuns: number;
  retries: number;
  elapsedMs: number;
}

export interface AgentRunResult {
  runId: string;
  status: AgentRunStatus;
  messages: Message[];
  finalAnswer: string;
  metrics: AgentMetrics;
  /** 出错信息（status === "error" 时） */
  error?: string;
}

/**
 * 循环策略：驱动 Model -> Tool -> Result 推进的抽象。
 *
 * AgentLoop 是默认实现；把它做成可注入的服务（SERVICES.LOOP），
 * 即可替换为其它循环策略（如 Plan-Execute、多智能体编排）而不改 Harness。
 */
export interface LoopStrategy {
  run(task: string, config: AgentRunConfig, externalSignal?: AbortSignal): Promise<AgentRunResult>;
}
