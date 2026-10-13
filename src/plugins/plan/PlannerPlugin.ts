import type { MiniContext, MiniPlugin, PlannerService, TaskPlan } from "../../types";
import { SERVICES } from "../../constants";

/**
 * 轻量 Plan 服务。
 *
 * 计划本身不额外消耗模型请求，先把常见 Coding Agent 工作拆成可观测步骤。
 * 后续可以用同一服务契约替换为模型规划器或 DAG 调度器。
 */
export class BasicPlanner implements PlannerService {
  async createPlan(task: string, _ctx: { workdir: string; toolNames: string[] }): Promise<TaskPlan> {
    const action = /理解|读取|总结|查找|列出/.test(task)
      ? ["定位相关文件", "读取并分析代码", "整理结果并检查输出"]
      : ["定位相关文件", "理解现有实现", "修改代码或测试", "运行验证并修复问题"];
    return {
      goal: task,
      createdAt: Date.now(),
      steps: action.map((description, index) => ({
        id: `step_${index + 1}`,
        description,
        status: "pending" as const,
        verification: index === action.length - 1 ? "检查测试、构建或最终产物" : undefined,
      })),
    };
  }
}

export class PlannerPlugin implements MiniPlugin {
  readonly name = "plugin.planner";

  setup(ctx: MiniContext): void {
    ctx.provide<PlannerService>(SERVICES.PLANNER, new BasicPlanner());
  }
}
