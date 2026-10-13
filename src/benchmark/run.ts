import { loadEnv } from "../utils";
import { benchmarkTasks } from "./tasks";
import { runTask } from "./evaluator";
import type { TaskRunResult } from "./types";

/**
 * Benchmark 批量跑分器（对应文档 §7 消融实验）。
 *
 * 4 组配置（Baseline / +ContextManager / +PromptOptimizer / Full Harness）
 * 依次跑 20 个任务，汇总 6 类指标（成功率、模型轮次、工具调用、
 * 工具失败、Token、耗时），输出对照表。
 *
 * 用法：
 *   node dist/benchmark/run.js                 # 真实跑分（需要 DEEPSEEK_API_KEY）
 *   node dist/benchmark/run.js --mock          # 用 MockModel 验证跑分链路（无需 Key，成功率≈0）
 *   node dist/benchmark/run.js --config full   # 只跑 Full Harness
 *   node dist/benchmark/run.js --task b1_add   # 只跑单个任务
 */

interface AblationConfig {
  id: string;
  label: string;
  contextManager: boolean;
  promptOptimizer: boolean;
}

const ABLATIONS: AblationConfig[] = [
  { id: "baseline", label: "Baseline", contextManager: false, promptOptimizer: false },
  { id: "ctx", label: "+ContextManager", contextManager: true, promptOptimizer: false },
  { id: "opt", label: "+PromptOptimizer", contextManager: false, promptOptimizer: true },
  { id: "full", label: "Full Harness", contextManager: true, promptOptimizer: true },
];

interface CliFlags {
  mock: boolean;
  configId?: string;
  taskId?: string;
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { mock: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mock") flags.mock = true;
    else if (a === "--config") flags.configId = argv[++i];
    else if (a === "--task") flags.taskId = argv[++i];
  }
  return flags;
}

interface Summary {
  passed: number;
  total: number;
  modelRequests: number;
  toolCalls: number;
  toolErrors: number;
  tokens: number;
  latencyMs: number;
}

function summarize(results: TaskRunResult[]): Summary {
  const s: Summary = {
    passed: 0,
    total: results.length,
    modelRequests: 0,
    toolCalls: 0,
    toolErrors: 0,
    tokens: 0,
    latencyMs: 0,
  };
  for (const r of results) {
    if (r.passed) s.passed++;
    s.modelRequests += r.metrics.modelRequests;
    s.toolCalls += r.metrics.toolCalls;
    s.toolErrors += r.metrics.toolErrors;
    s.tokens += r.metrics.promptTokens + r.metrics.completionTokens;
    s.latencyMs += r.metrics.elapsedMs;
  }
  return s;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/** 平均值（保留 1 位小数），total 为 0 时返回 "-" */
function avg(n: number, total: number): string {
  return total === 0 ? "    -" : (n / total).toFixed(1).padStart(5);
}

function printRow(label: string, s: Summary): void {
  const rate = s.total === 0 ? "   -" : `${((s.passed / s.total) * 100).toFixed(0).padStart(3)}%`;
  const rnd = avg(s.modelRequests, s.total);
  const tc = avg(s.toolCalls, s.total);
  const te = avg(s.toolErrors, s.total);
  const tk = avg(s.tokens, s.total);
  const lat = avg(s.latencyMs / 1000, s.total);
  console.log(
    `${pad(label, 18)} 成功率 ${rate}  | 轮次 ${rnd} | 工具 ${tc} | 工具失败 ${te} | Token ${tk} | 耗时(s) ${lat}  (${s.passed}/${s.total})`,
  );
}

async function runConfig(cfg: AblationConfig, flags: CliFlags): Promise<TaskRunResult[]> {
  const tasks = flags.taskId ? benchmarkTasks.filter((t) => t.id === flags.taskId) : benchmarkTasks;
  const results: TaskRunResult[] = [];

  console.log(`\n== ${cfg.label} ==`);
  for (const task of tasks) {
    process.stdout.write(`  ${pad(task.id, 20)} ... `);
    const r = await runTask(task, {
      model: flags.mock ? "mock" : "deepseek",
      // MockModel 仅用于验证跑分链路，脚本不真正解题（见文件头注释）
      mockScript: flags.mock
        ? [{ toolCalls: [{ name: "list_dir", arguments: { path: "." } }] }, { content: "mock 完成" }]
        : undefined,
      contextManager: cfg.contextManager ? {} : false,
      promptOptimizer: cfg.promptOptimizer ? {} : false,
      maxModelRequests: 30,
      maxToolCalls: 60,
      timeoutMs: 5 * 60 * 1000,
    });
    results.push(r);
    console.log(`${r.passed ? "PASS" : "FAIL"}  (${r.status})`);
    if (!r.passed) console.log(`        ↳ ${r.detail}`);
  }
  return results;
}

async function main(): Promise<void> {
  loadEnv();
  const flags = parseFlags(process.argv.slice(2));

  if (flags.mock) {
    console.log("⚠ 使用 MockModel（无需 API Key）。此模式仅验证 Benchmark 跑分链路，MockModel 不会真正解题，成功率将接近 0。");
  }

  const configs = flags.configId ? ABLATIONS.filter((c) => c.id === flags.configId) : ABLATIONS;
  if (configs.length === 0) {
    console.error(`未知配置 id: ${flags.configId}（可选: baseline / ctx / opt / full）`);
    process.exitCode = 1;
    return;
  }

  console.log(`Benchmark 任务数: ${benchmarkTasks.length}`);
  console.log("指标: 成功率 | 平均模型轮次 | 平均工具调用 | 平均工具失败 | 平均 Token | 平均耗时(秒)");
  console.log("=".repeat(112));

  const resultsByConfig: Array<{ label: string; results: TaskRunResult[] }> = [];
  for (const cfg of configs) {
    const results = await runConfig(cfg, flags);
    resultsByConfig.push({ label: cfg.label, results });
  }

  console.log("\n" + "=".repeat(112));
  console.log("消融实验对照表:");
  for (const { label, results } of resultsByConfig) {
    printRow(label, summarize(results));
  }

  // 单任务模式不打印明细
  if (!flags.taskId && resultsByConfig.length > 0) {
    const last = resultsByConfig[resultsByConfig.length - 1];
    console.log(`\n== 分任务明细（${last.label}） ==`);
    for (const r of last.results) {
      console.log(`  ${pad(r.taskId, 20)} ${r.passed ? "PASS" : "FAIL"}  status=${r.status}${r.passed ? "" : "  " + r.detail}`);
    }
  }
}

main().catch((err) => {
  console.error("[benchmark] 致命错误:", err);
  process.exitCode = 1;
});
