import type {
  AgentMetrics,
  AgentRunConfig,
  AgentRunResult,
  ContextManagerService,
  LoopStrategy,
  Message,
  ModelResponse,
  ModelService,
  PlannerService,
  PromptOptimizerService,
  RunCheckpoint,
  SessionService,
  TaskPlan,
  ToolResult,
  ToolService,
  VerifierService,
} from "../types";
import { MiniContext } from "../types";
import { SERVICES, EVENTS } from "../constants";
import { generateId, toErrorMessage } from "../utils";

export const DEFAULT_MAX_MODEL_REQUESTS = 64;
export const DEFAULT_MAX_TOOL_CALLS = 128;
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

/**
 * Agent Loop 引擎：驱动 Model -> Tool -> Result 的多轮状态推进。
 *
 * 循环本身不含业务逻辑，所有能力（模型、工具、会话、上下文管理、
 * 权限、Prompt 优化）都通过 ServiceRegistry 注入。这样替换任意一个
 * 组件都不必改动执行循环——这是插件化 Harness 的核心收益。
 */
export class AgentLoop implements LoopStrategy {
  constructor(private ctx: MiniContext) {}

  /**
   * 发布事件并同步持久化到 Session（事件轨迹落盘）。
   * AGENT_MODEL_DELTA 是高频增量事件，不落盘以避免 JSONL 膨胀。
   */
  private emitEvent(session: SessionService | undefined, event: string, payload: unknown): void {
    this.ctx.emit(event, payload);
    if (session && event !== EVENTS.AGENT_MODEL_DELTA) {
      session.append({ kind: "event", name: event, payload });
    }
  }

  async run(task: string, config: AgentRunConfig, externalSignal?: AbortSignal): Promise<AgentRunResult> {
    const model = this.ctx.inject<ModelService>(SERVICES.MODEL);
    const tools = this.ctx.inject<ToolService>(SERVICES.TOOLS);
    const session = this.ctx.tryInject<SessionService>(SERVICES.SESSION);
    const ctxMgr = this.ctx.tryInject<ContextManagerService>(SERVICES.CONTEXT_MANAGER);
    const optimizer = this.ctx.tryInject<PromptOptimizerService>(SERVICES.PROMPT_OPTIMIZER);
    const planner = this.ctx.tryInject<PlannerService>(SERVICES.PLANNER);
    const verifier = this.ctx.tryInject<VerifierService>(SERVICES.VERIFIER);

    const maxModelRequests = config.maxModelRequests ?? DEFAULT_MAX_MODEL_REQUESTS;
    const maxToolCalls = config.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxVerificationAttempts = Math.max(0, config.maxVerificationAttempts ?? 2);
    const runId = generateId("run");

    const aborter = new AbortController();
    const timeoutHandle = setTimeout(() => aborter.abort(), timeoutMs);
    const onExternalAbort = () => aborter.abort();
    if (externalSignal) {
      if (externalSignal.aborted) aborter.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    const startTime = Date.now();
    const metrics: AgentMetrics = {
      modelRequests: 0,
      auxiliaryModelRequests: 0,
      toolCalls: 0,
      toolErrors: 0,
      promptTokens: 0,
      completionTokens: 0,
      auxiliaryPromptTokens: 0,
      auxiliaryCompletionTokens: 0,
      verificationRuns: 0,
      retries: 0,
      elapsedMs: 0,
    };
    const removeAuxUsageListener = this.ctx.on(EVENTS.MODEL_AUX_USAGE, (payload) => {
      const usage = payload as {
        requests?: number;
        promptTokens?: number;
        completionTokens?: number;
      };
      metrics.auxiliaryModelRequests += usage.requests ?? 1;
      metrics.auxiliaryPromptTokens += usage.promptTokens ?? 0;
      metrics.auxiliaryCompletionTokens += usage.completionTokens ?? 0;
    });

    const messages: Message[] = [];
    messages.push({ role: "system", content: config.systemPrompt });
    if (config.priorMessages?.length) {
      messages.push(...config.priorMessages);
    }

    let plan: TaskPlan | undefined;
    if (planner) {
      try {
        plan = await planner.createPlan(task, {
          workdir: config.workdir,
          toolNames: tools.listDefinitions().map((t) => t.name),
        });
        this.emitEvent(session, EVENTS.PLAN_CREATED, { runId, plan });
        this.saveCheckpoint(session, {
          runId,
          phase: "plan",
          task,
          plan,
          metrics,
          updatedAt: Date.now(),
        });
      } catch {
        // 规划是增强能力，规划失败不阻断基础 Agent Loop。
      }
    }

    // 1. Prompt Optimizer：模糊需求 -> 结构化 Worker Prompt
    let userContent = task;
    if (optimizer) {
      try {
        userContent = await optimizer.optimize(task, {
          workdir: config.workdir,
          toolNames: tools.listDefinitions().map((t) => t.name),
        });
      } catch (err) {
        // 优化失败不阻断主流程，回退到原始需求
        userContent = task;
      }
    }
    messages.push({ role: "user", content: userContent });
    session?.append({ kind: "user", content: userContent });

    this.emitEvent(session, EVENTS.AGENT_START, { task, workdir: config.workdir });
    let verificationAttempts = 0;

    try {
      while (true) {
        // --- 预算 / 取消检查 ---
        if (aborter.signal.aborted) {
          this.emitEvent(session, EVENTS.AGENT_ABORT, { runId, reason: "cancelled_or_timeout" });
          this.saveCheckpoint(session, { runId, phase: "aborted", task, plan, metrics, updatedAt: Date.now() });
          return this.finish(runId, "aborted", messages, "", metrics, startTime);
        }
        if (Date.now() - startTime >= timeoutMs) {
          this.saveCheckpoint(session, { runId, phase: "aborted", task, plan, metrics, updatedAt: Date.now() });
          return this.finish(runId, "budget_exhausted", messages, "任务超时（超过 " + timeoutMs + "ms）", metrics, startTime);
        }
        if (metrics.modelRequests >= maxModelRequests) {
          this.saveCheckpoint(session, { runId, phase: "aborted", task, plan, metrics, updatedAt: Date.now() });
          return this.finish(runId, "budget_exhausted", messages, "已达模型请求上限（" + maxModelRequests + " 次），可用 /continue 续接", metrics, startTime);
        }

        // --- Context Manager 压缩（可选插件） ---
        let requestMessages = messages;
        if (ctxMgr) {
          requestMessages = await ctxMgr.manage(messages, model);
        }

        // --- 请求模型（优先流式，回退到非流式） ---
        this.emitEvent(session, EVENTS.AGENT_MODEL_REQUEST, { round: metrics.modelRequests + 1, messages: requestMessages.length });
        const modelReq = {
          messages: requestMessages,
          tools: tools.listDefinitions(),
          signal: aborter.signal,
        };
        let response: ModelResponse;
        if (typeof model.streamComplete === "function") {
          response = await model.streamComplete(modelReq, (delta) => {
            this.emitEvent(session, EVENTS.AGENT_MODEL_DELTA, { delta });
          });
        } else {
          response = await model.complete(modelReq);
        }
        metrics.modelRequests++;
        metrics.retries += response.retries ?? 0;
        metrics.promptTokens += response.usage.promptTokens;
        metrics.completionTokens += response.usage.completionTokens;
        this.emitEvent(session, EVENTS.AGENT_MODEL_RESPONSE, {
          content: response.content,
          toolCallCount: response.toolCalls.length,
          usage: response.usage,
        });

        // --- 记录 assistant 消息 ---
        const assistantMsg: Message = {
          role: "assistant",
          content: response.content ?? "",
          toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
        };
        messages.push(assistantMsg);
        session?.append({
          kind: "assistant",
          content: response.content ?? "",
          toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
        });

        // --- 无工具调用 => 最终回答 ---
        if (response.toolCalls.length === 0) {
          if (verifier && verificationAttempts < maxVerificationAttempts) {
            verificationAttempts++;
            metrics.verificationRuns++;
            this.emitEvent(session, EVENTS.VERIFICATION_STARTED, { runId, attempt: verificationAttempts });
            const verification = await verifier.verify({
              task,
              workdir: config.workdir,
              messages,
              signal: aborter.signal,
              plan,
            });
            this.emitEvent(session, EVENTS.VERIFICATION_RESULT, { runId, ...verification });
            if (!verification.passed) {
              messages.push({ role: "user", content: `验证未通过，请继续修复：${verification.summary}` });
              session?.append({ kind: "user", content: `验证未通过，请继续修复：${verification.summary}` });
              continue;
            }
          }
          this.saveCheckpoint(session, { runId, phase: "done", task, plan, metrics, updatedAt: Date.now() });
          return this.finish(runId, "done", messages, response.content ?? "", metrics, startTime);
        }

        // --- 逐个执行工具 ---
        for (const call of response.toolCalls) {
          if (metrics.toolCalls >= maxToolCalls) {
            this.saveCheckpoint(session, { runId, phase: "aborted", task, plan, metrics, updatedAt: Date.now() });
            return this.finish(runId, "budget_exhausted", messages, "已达工具调用上限（" + maxToolCalls + " 次）", metrics, startTime);
          }
          if (aborter.signal.aborted) {
            this.saveCheckpoint(session, { runId, phase: "aborted", task, plan, metrics, updatedAt: Date.now() });
            return this.finish(runId, "aborted", messages, "", metrics, startTime);
          }
          metrics.toolCalls++;
          this.emitEvent(session, EVENTS.AGENT_TOOL_CALL, { name: call.name, args: call.arguments });

          const execCtx = {
            workdir: config.workdir,
            signal: aborter.signal,
            sessionId: session?.getSessionId(),
          };

          let result: ToolResult;
          try {
            result = await tools.execute(call, execCtx);
          } catch (err) {
            result = { output: "", error: toErrorMessage(err) };
          }
          if (result.error) metrics.toolErrors++;

          this.emitEvent(session, EVENTS.AGENT_TOOL_RESULT, { name: call.name, hasError: !!result.error });

          const toolMsg: Message = {
            role: "tool",
            content: result.error ? `ERROR: ${result.error}\n${result.output}` : result.output,
            toolCallId: call.id,
          };
          messages.push(toolMsg);
          session?.append({
            kind: "tool",
            name: call.name,
            toolCallId: call.id,
            result: result.output,
            error: result.error,
          });
        }
      }
    } catch (err) {
      if (aborter.signal.aborted) {
        this.emitEvent(session, EVENTS.AGENT_ABORT, { runId, reason: "cancelled_or_timeout" });
        this.saveCheckpoint(session, { runId, phase: "aborted", task, plan, metrics, updatedAt: Date.now() });
        return this.finish(runId, "aborted", messages, "", metrics, startTime);
      }
      const msg = toErrorMessage(err);
      this.emitEvent(session, EVENTS.AGENT_ERROR, { error: msg });
      this.saveCheckpoint(session, { runId, phase: "error", task, plan, metrics, updatedAt: Date.now() });
      const result = this.finish(runId, "error", messages, "", metrics, startTime);
      result.error = msg;
      return result;
    } finally {
      clearTimeout(timeoutHandle);
      removeAuxUsageListener();
      if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
      this.emitEvent(session, EVENTS.AGENT_DONE, { metrics });
    }
  }

  private saveCheckpoint(session: SessionService | undefined, checkpoint: RunCheckpoint): void {
    session?.saveCheckpoint?.(checkpoint);
    this.emitEvent(session, EVENTS.CHECKPOINT_SAVED, {
      runId: checkpoint.runId,
      phase: checkpoint.phase,
      updatedAt: checkpoint.updatedAt,
    });
  }

  private finish(
    runId: string,
    status: AgentRunResult["status"],
    messages: Message[],
    finalAnswer: string,
    metrics: AgentMetrics,
    startTime: number,
  ): AgentRunResult {
    metrics.elapsedMs = Date.now() - startTime;
    return { runId, status, messages, finalAnswer, metrics };
  }
}
