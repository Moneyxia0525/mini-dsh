import { resolve } from "node:path";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Harness } from "../harness";
import { JsonlSessionService } from "../plugins/session/SessionPlugin";
import { loadEnv, resolveWorkdir } from "../utils";
import { EVENTS } from "../constants";
import type { AgentRunResult, ConfirmationHandler } from "../types";

interface CliArgs {
  task: string;
  workdir: string;
  sessionId?: string;
  continueSession: boolean;
  mock: boolean;
  noContext: boolean;
  noOptimizer: boolean;
  sessionDir: string;
  yes: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const args: Omit<CliArgs, "task"> = {
    workdir: process.cwd(),
    continueSession: false,
    mock: false,
    noContext: false,
    noOptimizer: false,
    sessionDir: process.env.MINI_DSH_SESSION_DIR ?? ".sessions",
    yes: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--workdir":
        args.workdir = resolveWorkdir(argv[++i]);
        break;
      case "--session":
        args.sessionId = argv[++i];
        break;
      case "--session-dir":
        args.sessionDir = argv[++i];
        break;
      case "--continue":
        args.continueSession = true;
        break;
      case "--mock":
        args.mock = true;
        break;
      case "--no-context":
        args.noContext = true;
        break;
      case "--no-optimizer":
        args.noOptimizer = true;
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      default:
        if (!a.startsWith("-")) positional.push(a);
    }
  }

  return { ...args, task: positional.join(" ") };
}

function printResult(r: AgentRunResult, skipFinal = false): void {
  console.log("\n" + "=".repeat(60));
  console.log(`状态: ${r.status}`);
  console.log(`模型请求: ${r.metrics.modelRequests}  工具调用: ${r.metrics.toolCalls}  工具失败: ${r.metrics.toolErrors}`);
  console.log(`Token: ${r.metrics.promptTokens + r.metrics.completionTokens} (prompt ${r.metrics.promptTokens} / completion ${r.metrics.completionTokens})`);
  console.log(`耗时: ${(r.metrics.elapsedMs / 1000).toFixed(1)}s`);
  if (r.error) console.log(`错误: ${r.error}`);
  if (r.finalAnswer && !skipFinal) {
    console.log("\n--- 最终回答 ---");
    console.log(r.finalAnswer);
  } else if (r.finalAnswer && skipFinal) {
    console.log("\n--- 最终回答（已在上方实时输出）---");
  }
  console.log("=".repeat(60));
}

/**
 * 创建 human-in-the-loop 确认处理器：对 run_command 等高风险工具
 * 在执行前用 readline 询问用户。惰性创建 rl，避免无命令执行时占用 stdin。
 */
function createConfirmHandler(): { confirm: ConfirmationHandler; close: () => void } {
  let rl: readline.Interface | null = null;
  const getRl = (): readline.Interface => {
    if (!rl) rl = readline.createInterface({ input, output });
    return rl;
  };
  return {
    confirm: async (req) => {
      const summary = req.toolName === "run_command"
        ? String(req.args.command ?? "")
        : JSON.stringify(req.args);
      const tag = req.riskLevel === "high" ? "⚠️ 高风险" : req.riskLevel === "medium" ? "中风险" : "低风险";
      const ans = await getRl().question(
        `\n[确认 ${tag}] 即将执行 ${req.toolName}：\n  ${summary}\n  原因：${req.reason}\n是否允许？(y/N): `,
      );
      const a = ans.trim().toLowerCase();
      return a === "y" || a === "yes";
    },
    close: () => {
      rl?.close();
      rl = null;
    },
  };
}

async function main(): Promise<void> {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));

  if (!args.task && !args.continueSession) {
    console.log(
      [
        "Mini-dsh — 基于插件化架构的 Coding Agent Harness",
        "",
        "用法:",
        "  node dist/cli/index.js \"任务描述\" [选项]",
        "",
        "选项:",
        "  --workdir <path>      会话工作目录（默认当前目录）",
        "  --session <id>        指定会话 id（用于会话恢复）",
        "  --session-dir <path>  JSONL 持久化目录（默认 .sessions）",
        "  --continue            续接上一个会话（重置预算、保留上下文）",
        "  --mock                使用 MockModel（无需 API Key，用于链路自测）",
        "  --no-context          禁用 Context Manager",
        "  --no-optimizer        禁用 Prompt Optimizer",
        "  --yes / -y            跳过 human-in-the-loop 确认（自动放行所有命令）",
        "",
      ].join("\n"),
    );
    return;
  }

  const mockScript = [
    { toolCalls: [{ name: "list_dir", arguments: { path: "." } }] },
    { toolCalls: [{ name: "read_file", arguments: { path: "README.md" } }] },
    { content: "（MockModel 演示）已完成一次工具调用往返，Harness 链路正常。" },
  ];

  let priorMessages: AgentRunResult["messages"] | undefined;
  if (args.continueSession) {
    if (!args.sessionId) {
      console.error("[CLI] --continue 需要配合 --session <id> 指定要续接的会话");
      return;
    }
    const session = new JsonlSessionService({ dir: args.sessionDir, sessionId: args.sessionId });
    priorMessages = session.toMessages();
    if (priorMessages.length === 0) {
      console.error(`[CLI] 会话 ${args.sessionId} 无历史记录，无法续接`);
      return;
    }
    console.log(`[CLI] 已从 ${session.getFilePath()} 载入 ${priorMessages.length} 条历史消息`);
  }

  // human-in-the-loop：默认对 run_command 交互确认；--yes 跳过
  const confirm = args.yes ? undefined : createConfirmHandler();

  const harness = await Harness.create({
    model: args.mock ? "mock" : "deepseek",
    mockScript,
    workdir: args.workdir,
    session: args.sessionId ? { dir: args.sessionDir, sessionId: args.sessionId } : { dir: args.sessionDir },
    permission: { confirm: confirm?.confirm, confirmTools: ["run_command"] },
    contextManager: args.noContext ? false : {},
    promptOptimizer: args.noOptimizer ? false : {},
    verbose: false,
  });

  const aborter = new AbortController();
  const onSigint = () => {
    console.log("\n[CLI] 收到 Ctrl+C，正在取消当前任务...");
    aborter.abort();
  };
  process.once("SIGINT", onSigint);

  // 流式输出：逐段打印模型文本增量
  let streamedAny = false;
  harness.ctx.on(EVENTS.AGENT_MODEL_DELTA, (p) => {
    streamedAny = true;
    process.stdout.write((p as { delta: string }).delta);
  });

  // 每轮模型响应：流式文本已实时打印，这里只需收尾换行 + 提示工具调用
  let roundStreamed = false;
  harness.ctx.on(EVENTS.AGENT_MODEL_REQUEST, () => { roundStreamed = false; });
  harness.ctx.on(EVENTS.AGENT_MODEL_DELTA, () => { roundStreamed = true; });
  harness.ctx.on(EVENTS.AGENT_MODEL_RESPONSE, (p) => {
    const info = p as { toolCallCount: number; content: string | null };
    if (roundStreamed) process.stdout.write("\n");
    if (info.toolCallCount > 0) console.log(`   → 模型请求工具调用 x${info.toolCallCount}`);
  });
  harness.ctx.on(EVENTS.AGENT_TOOL_CALL, (p) => {
    console.log(`   ⚙ 执行工具: ${(p as { name: string }).name}`);
  });
  harness.ctx.on(EVENTS.PERMISSION_DENIED, (p) => {
    console.log(`   ✋ 权限拒绝: ${(p as { name: string }).name}`);
  });
  harness.ctx.on(EVENTS.CONTEXT_COMPRESSED, (p) => {
    const info = p as { compressedCount: number; keptCount: number };
    console.log(`   ↻ 上下文压缩: 折叠 ${info.compressedCount} 条，保留 ${info.keptCount} 条`);
  });

  const task = args.continueSession ? "继续完成上面未完成的任务。" : args.task;
  const result = await harness.run(task, { priorMessages }, aborter.signal);

  process.removeListener("SIGINT", onSigint);
  confirm?.close();
  printResult(result, streamedAny);
  await harness.dispose();

  if (result.status === "budget_exhausted") {
    console.log(`提示: 可用 --continue --session <id> 续接此会话。`);
  }
}

main().catch((err) => {
  console.error("[CLI] 致命错误:", err);
  process.exitCode = 1;
});
