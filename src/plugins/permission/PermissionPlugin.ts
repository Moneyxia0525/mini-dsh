import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  ConfirmationHandler,
  ExecutionContext,
  MiniContext,
  MiniPlugin,
  PermissionRequest,
  PermissionService,
  RiskLevel,
} from "../../types";
import { EVENTS, SERVICES } from "../../constants";
import { assertWithin, isSensitivePath } from "../../utils";

export interface PermissionConfig {
  /** 允许的工具名白名单；缺省则放行所有已注册工具 */
  allowedTools?: string[];
  /** 文件工具允许的根目录（默认 = 会话工作目录） */
  allowedRoots?: string[];
  /** 是否允许执行命令（默认 true） */
  allowCommands?: boolean;
  /** 是否允许访问 .env、.git、.sessions 等敏感路径（默认 false） */
  allowSensitivePaths?: boolean;
  /** human-in-the-loop 确认回调；提供后，confirmTools 中的工具执行前会询问用户 */
  confirm?: ConfirmationHandler;
  /** 需要确认的工具名（默认 ["run_command"]） */
  confirmTools?: string[];
}

const PATH_TOOLS = new Set([
  "read_file",
  "write_file",
  "list_dir",
  "search_text",
  "apply_patch",
  "git_diff",
]);
const DEFAULT_CONFIRM_TOOLS = ["run_command"];

/** 高风险命令特征（删除、格式化、提权、强制覆盖、远端推送等） */
const HIGH_RISK_PATTERNS = [
  /\brm\b/i, /\brmdir\b/i, /\bdel\b/i, /\berase\b/i, /\bunlink\b/i,
  /\bformat\b/i, /\bsudo\b/i, /\bchmod\b/i, /\bchown\b/i,
  /\bshutdown\b/i, /\breboot\b/i, /\bkillall\b/i, /\btaskkill\b/i,
  /\bgit\s+push\b/i, /\bgit\s+reset\s+--hard\b/i, /\bnpm\s+publish\b/i,
  />\s*\/dev\//i, /\bdd\b\s+if=/i,
];

function assessRisk(toolName: string, args: Record<string, unknown>): { level: RiskLevel; reason: string } {
  if (toolName === "run_command") {
    const cmd = String(args.command ?? "");
    const high = HIGH_RISK_PATTERNS.some((re) => re.test(cmd));
    if (high) {
      return { level: "high", reason: `命令匹配高风险特征（删除/提权/覆盖/推送等）：${cmd}` };
    }
    return { level: "medium", reason: `将执行命令：${cmd}` };
  }
  if (toolName === "write_file") {
    return { level: "medium", reason: `将写入文件：${args.path ?? ""}` };
  }
  return { level: "low", reason: `工具 ${toolName}` };
}

/**
 * Permission 插件：不引入 Docker 重隔离，改用「工具 + 路径白名单」的轻量约束。
 * 校验不过抛错，ToolManager 捕获后转为可回喂模型的错误消息。
 *
 * 新增 human-in-the-loop：对 confirmTools 中的工具（默认 run_command），
 * 在静态校验通过后调用 confirm 回调询问用户；拒绝即抛错。
 */
export class BasicPermissionService implements PermissionService {
  constructor(private ctx: MiniContext, private config: PermissionConfig) {}

  async checkTool(toolName: string, args: Record<string, unknown>, ctx: ExecutionContext): Promise<void> {
    const allowed = this.config.allowedTools;
    if (allowed && !allowed.includes(toolName)) {
      throw new Error(`工具 "${toolName}" 未授权`);
    }

    if (toolName === "run_command") {
      if (this.config.allowCommands === false) throw new Error("命令执行未授权");
    } else if (PATH_TOOLS.has(toolName) && typeof args.path === "string") {
      if (!this.config.allowSensitivePaths && isSensitivePath(args.path)) {
        throw new Error(`敏感路径未授权: ${args.path}`);
      }
      const abs = resolve(ctx.workdir, args.path);
      const actual = await resolvePermissionPath(abs);
      const roots = await Promise.all((this.config.allowedRoots ?? [ctx.workdir]).map((r) => realpath(resolve(r))));
      const within = roots.some((root) => {
        try {
          assertWithin(root, actual, args.path as string);
          return true;
        } catch {
          return false;
        }
      });
      if (!within) {
        throw new Error(`路径越界（超出授权目录）: ${args.path}`);
      }
    }

    // human-in-the-loop：高风险工具执行前询问用户
    const confirmTools = this.config.confirmTools ?? DEFAULT_CONFIRM_TOOLS;
    if (this.config.confirm && confirmTools.includes(toolName)) {
      const risk = assessRisk(toolName, args);
      const req: PermissionRequest = {
        toolName,
        args,
        riskLevel: risk.level,
        reason: risk.reason,
      };
      this.ctx.emit(EVENTS.PERMISSION_CONFIRM, req);
      const ok = await this.config.confirm(req);
      if (!ok) {
        throw new Error(`用户拒绝执行 ${toolName}（${risk.reason}）`);
      }
    }
  }
}

async function resolvePermissionPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return realpathExistingParent(dirname(candidate));
  }
}

async function realpathExistingParent(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return realpathExistingParent(dirname(path));
  }
}

export class PermissionPlugin implements MiniPlugin {
  readonly name = "plugin.permission";

  constructor(private config: PermissionConfig = {}) {}

  setup(ctx: MiniContext): void {
    ctx.provide<PermissionService>(SERVICES.PERMISSION, new BasicPermissionService(ctx, this.config));
  }
}
