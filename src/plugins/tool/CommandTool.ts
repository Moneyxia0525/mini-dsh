import { exec } from "node:child_process";
import type { ExecutionContext, Tool, ToolResult } from "../../types";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * run_command 工具：在会话工作目录执行命令（运行测试、构建、git 等）。
 * 返回结构化输出（stdout/stderr/退出码），模型可据此迭代修复。
 */
export const runCommandTool: Tool = {
  definition: {
    name: "run_command",
    description:
      "在工作目录执行 shell 命令并返回退出码、标准输出与标准错误。用于运行测试、构建、git 等。命令有 30 秒超时。",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令", minLength: 1, maxLength: 4000 },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  execute(args, ctx: ExecutionContext): Promise<ToolResult> {
    const command = String(args.command ?? "");
    if (!command.trim()) {
      return Promise.resolve({ output: "", error: "命令为空" });
    }

    return new Promise<ToolResult>((resolveResult) => {
      exec(
        command,
        {
          cwd: ctx.workdir,
          timeout: DEFAULT_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          signal: ctx.signal,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const code = (error as { code?: number } | null)?.code ?? 0;
          const out = [`$ ${command}`];
          if (stdout) out.push(stdout.trimEnd());
          if (stderr) out.push(`[stderr]\n${stderr.trimEnd()}`);
          out.push(`[exit code: ${code}]`);
          const output = out.join("\n").slice(0, 8000);

          if (code !== 0) {
            resolveResult({ output, error: `命令退出码非 0（${code}）` });
          } else {
            resolveResult({ output });
          }
        },
      );
    });
  },
};
