import type { AgentRunConfig, AgentRunResult, LoopStrategy, MiniPlugin } from "../types";
import { Context } from "../core/Context";
import { EventBus } from "../core/EventBus";
import { ServiceRegistry } from "../core/ServiceRegistry";
import { PluginRegistry } from "../core/PluginRegistry";
import { DeepSeekModelPlugin } from "../plugins/model/DeepSeekModelPlugin";
import { MockModelPlugin, type MockStep } from "../plugins/model/MockModelPlugin";
import { ToolPlugin } from "../plugins/tool/ToolPlugin";
import { SessionPlugin, type SessionConfig } from "../plugins/session/SessionPlugin";
import { PermissionPlugin, type PermissionConfig } from "../plugins/permission/PermissionPlugin";
import { ContextManagerPlugin, type ContextManagerConfig } from "../plugins/context/ContextManagerPlugin";
import { PromptOptimizerPlugin, type PromptOptimizerConfig } from "../plugins/optimizer/PromptOptimizerPlugin";
import { EventPlugin } from "../plugins/event/EventPlugin";
import { LoopPlugin } from "../plugins/loop/LoopPlugin";
import { PlannerPlugin } from "../plugins/plan/PlannerPlugin";
import { VerifierPlugin } from "../plugins/verify/VerifierPlugin";
import { SERVICES } from "../constants";

const DEFAULT_SYSTEM_PROMPT = [
  "你是一个运行在 Harness 里的 Coding Agent，通过工具调用完成用户的代码任务。",
  "规则：",
  "1. 先用 read_file / list_dir 了解代码现状，不要凭空假设。",
  "2. 分步修改，每步之后用 run_command 运行测试/构建验证。",
  "3. 只修改工作目录内的文件。",
  "4. 完成后用简洁中文总结改动与验证结果。",
].join("\n");

export interface HarnessOptions {
  /** 模型来源 */
  model?: "deepseek" | "mock";
  /** mock 模型的脚本（model === "mock" 时使用） */
  mockScript?: MockStep[];
  /** DeepSeek 覆盖配置 */
  deepseek?: { apiKey?: string; model?: string; baseUrl?: string; maxRetries?: number; retryBaseMs?: number };
  /** 会话工作目录 */
  workdir: string;
  /** 系统提示词 */
  systemPrompt?: string;
  /** 是否启用 Session（JSONL 持久化） */
  session?: false | SessionConfig;
  /** 权限配置 */
  permission?: PermissionConfig;
  /** Context Manager 配置；传 false 禁用（消融 Baseline） */
  contextManager?: false | ContextManagerConfig;
  /** Prompt Optimizer 配置；传 false 禁用（消融 Baseline） */
  promptOptimizer?: false | PromptOptimizerConfig;
  /** 计划服务；默认开启 */
  planner?: false;
  /** 验证服务；默认开启 */
  verifier?: false;
  /** 生命周期日志开关 */
  verbose?: boolean;
}

/**
 * Harness：装配层。把内核（Context + PluginRegistry + AgentLoop）
 * 与各插件按需组装成一个可运行的整体。
 */
export class Harness {
  readonly ctx: Context;
  readonly registry: PluginRegistry;
  readonly loop: LoopStrategy;

  private disposeFn?: () => Promise<void>;
  private defaultWorkdir: string;
  private defaultSystemPrompt: string;

  private constructor(ctx: Context, registry: PluginRegistry, loop: LoopStrategy, defaults: { workdir: string; systemPrompt: string }) {
    this.ctx = ctx;
    this.registry = registry;
    this.loop = loop;
    this.defaultWorkdir = defaults.workdir;
    this.defaultSystemPrompt = defaults.systemPrompt;
  }

  static async create(options: HarnessOptions): Promise<Harness> {
    const eventBus = new EventBus();
    const ctx = new Context(new ServiceRegistry(), eventBus);
    const logger = options.verbose ? console : { log: () => {}, error: console.error };
    const registry = new PluginRegistry({ ctx, logger });

    const plugins: MiniPlugin[] = [];

    // Event 插件：把 EventBus 注册为命名服务
    plugins.push(new EventPlugin(eventBus));

    // Loop 插件：注册默认循环策略（可被同 key 后注册的插件覆盖）
    plugins.push(new LoopPlugin());
    if (options.planner !== false) plugins.push(new PlannerPlugin());
    if (options.verifier !== false) plugins.push(new VerifierPlugin());

    // Model
    if (options.model === "mock") {
      plugins.push(new MockModelPlugin(options.mockScript ?? []));
    } else {
      plugins.push(new DeepSeekModelPlugin(options.deepseek));
    }

    // 基础工具（始终启用）
    plugins.push(new ToolPlugin());

    // Permission
    plugins.push(new PermissionPlugin(options.permission ?? {}));

    // Session（可选）
    if (options.session !== false) {
      plugins.push(new SessionPlugin(options.session ?? {}));
    }

    // Context Manager（消融变量 1）
    if (options.contextManager !== false) {
      plugins.push(new ContextManagerPlugin(options.contextManager ?? {}));
    }

    // Prompt Optimizer（消融变量 2）
    if (options.promptOptimizer !== false) {
      plugins.push(new PromptOptimizerPlugin(options.promptOptimizer ?? {}));
    }

    registry.registerAll(plugins);
    const disposeFn = await registry.setupAll();

    // 循环策略由 LoopPlugin 注册为服务，注入而非硬编码
    const loop = ctx.inject<LoopStrategy>(SERVICES.LOOP);

    const harness = new Harness(ctx, registry, loop, {
      workdir: options.workdir,
      systemPrompt: options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    });
    harness.disposeFn = disposeFn;
    return harness;
  }

  run(task: string, config?: Partial<AgentRunConfig>, signal?: AbortSignal): Promise<AgentRunResult> {
    const full: AgentRunConfig = {
      systemPrompt: this.defaultSystemPrompt,
      workdir: this.defaultWorkdir,
      ...config,
    };
    return this.loop.run(task, full, signal);
  }

  async dispose(): Promise<void> {
    await this.disposeFn?.();
  }
}

export { DEFAULT_SYSTEM_PROMPT };
