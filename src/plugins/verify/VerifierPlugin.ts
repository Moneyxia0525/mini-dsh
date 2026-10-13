import type {
  Message,
  MiniContext,
  MiniPlugin,
  VerificationRequest,
  VerificationResult,
  VerifierService,
} from "../../types";
import { SERVICES } from "../../constants";

/**
 * 默认验证器只做确定性的安全检查：
 * - 最近一次工具结果是否报错
 * - 最近一次命令是否以非 0 退出
 *
 * 它不会假装知道业务测试标准；用户可以通过插件协议替换成项目测试、
 * 编译器或更严格的任务级 Verifier。
 */
export class BasicVerifier implements VerifierService {
  async verify(request: VerificationRequest): Promise<VerificationResult> {
    const last = request.messages.at(-2)?.role === "tool"
      ? request.messages.at(-2)
      : undefined;
    if (!last) {
      return { passed: true, summary: "没有工具错误，按当前任务完成。" };
    }

    if (/^ERROR:/i.test(last.content)) {
      return {
        passed: false,
        summary: `最近一次工具调用失败：${last.content.slice(0, 800)}`,
        checks: [{ name: "last_tool_result", passed: false, detail: last.content.slice(0, 800) }],
      };
    }

    const exitCode = /\[exit code:\s*(-?\d+)\]/i.exec(last.content)?.[1];
    if (exitCode && Number(exitCode) !== 0) {
      return {
        passed: false,
        summary: `最近一次命令退出码为 ${exitCode}，需要继续修复。`,
        checks: [{ name: "command_exit_code", passed: false, detail: last.content.slice(-800) }],
      };
    }

    return { passed: true, summary: "最近一次工具调用成功。" };
  }
}

export class VerifierPlugin implements MiniPlugin {
  readonly name = "plugin.verifier";

  setup(ctx: MiniContext): void {
    ctx.provide<VerifierService>(SERVICES.VERIFIER, new BasicVerifier());
  }
}
