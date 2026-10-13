import type { AgentMetrics } from "../types";

/** 任务类别（对应文档 §7.1 五类代码能力） */
export type TaskCategory = "code_understanding" | "bug_fix" | "feature_impl" | "refactor" | "test_write";

export const CATEGORY_LABELS: Record<TaskCategory, string> = {
  code_understanding: "代码理解",
  bug_fix: "Bug 修复",
  feature_impl: "功能实现",
  refactor: "重构",
  test_write: "测试编写",
};

export interface TaskEvaluation {
  passed: boolean;
  detail: string;
}

export interface BenchmarkTask {
  id: string;
  category: TaskCategory;
  /** 交给 Agent 的任务描述 */
  description: string;
  /** 初始化工作目录（写入初始文件） */
  setup(workdir: string): Promise<void> | void;
  /** 客观判定成功/失败 */
  evaluate(workdir: string): Promise<TaskEvaluation> | TaskEvaluation;
}

/** 单个任务执行结果 */
export interface TaskRunResult {
  taskId: string;
  category: TaskCategory;
  passed: boolean;
  detail: string;
  status: string;
  metrics: AgentMetrics;
}
