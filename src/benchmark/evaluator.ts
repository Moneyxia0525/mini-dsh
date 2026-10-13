import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness, type HarnessOptions } from "../harness";
import type { MockStep } from "../plugins/model/MockModelPlugin";
import type { BenchmarkTask, TaskRunResult } from "./types";

export interface RunTaskOptions {
  model?: "deepseek" | "mock";
  mockScript?: MockStep[];
  deepseek?: HarnessOptions["deepseek"];
  contextManager?: HarnessOptions["contextManager"];
  promptOptimizer?: HarnessOptions["promptOptimizer"];
  maxModelRequests?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
}

/** 在独立临时工作目录中执行单个任务：setup -> run -> evaluate -> 清理 */
export async function runTask(task: BenchmarkTask, options: RunTaskOptions = {}): Promise<TaskRunResult> {
  const workdir = mkdtempSync(join(tmpdir(), "mini-dsh-bench-"));

  try {
    await task.setup(workdir);

    const harness = await Harness.create({
      model: options.model ?? "deepseek",
      mockScript: options.mockScript,
      deepseek: options.deepseek,
      workdir,
      session: false,
      contextManager: options.contextManager,
      promptOptimizer: options.promptOptimizer,
    });

    const result = await harness.run(task.description, {
      maxModelRequests: options.maxModelRequests,
      maxToolCalls: options.maxToolCalls,
      timeoutMs: options.timeoutMs,
    });
    await harness.dispose();

    const evaluation = await task.evaluate(workdir);

    return {
      taskId: task.id,
      category: task.category,
      passed: evaluation.passed,
      detail: evaluation.detail,
      status: result.status,
      metrics: result.metrics,
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}
