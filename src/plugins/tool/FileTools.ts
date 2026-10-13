import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveRealPathWithin, isSensitivePath } from "../../utils";
import type { ExecutionContext, Tool, ToolResult } from "../../types";

const DEFAULT_LIMIT = 200;

async function resolveFilePath(workdir: string, relPath: string): Promise<string> {
  if (isSensitivePath(relPath)) {
    throw new Error(`拒绝访问敏感路径: ${relPath}`);
  }
  return resolveRealPathWithin(workdir, relPath);
}

/** 读取文件（带行号、分块返回） */
export const readFileTool: Tool = {
  definition: {
    name: "read_file",
    description: "读取工作目录内指定文件的内容，返回带行号、分块显示的文本。适合先定位再修改。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作目录的文件路径", minLength: 1 },
        offset: { type: "integer", description: "起始行号（从 1 开始），默认 1" },
        limit: { type: "integer", description: "最多返回的行数，默认 200" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async execute(args, ctx: ExecutionContext): Promise<ToolResult> {
    const path = await resolveFilePath(ctx.workdir, String(args.path ?? ""));
    const offset = Math.max(1, Number(args.offset ?? 1));
    const limit = Math.max(1, Number(args.limit ?? DEFAULT_LIMIT));

    const content = await readFile(path, "utf-8");
    const lines = content.split(/\r?\n/);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((line, i) => `${String(offset + i).padStart(4, " ")}|${line}`).join("\n");
    const truncNote = lines.length > offset - 1 + limit ? `\n...（共 ${lines.length} 行，已截断显示 ${slice.length} 行）` : "";
    return { output: numbered + truncNote };
  },
};

/** 写入文件（自动创建父目录） */
export const writeFileTool: Tool = {
  definition: {
    name: "write_file",
    description: "将内容写入工作目录内的指定文件（覆盖写）。父目录不存在会自动创建。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作目录的文件路径", minLength: 1 },
        content: { type: "string", description: "要写入的完整内容" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  async execute(args, ctx: ExecutionContext): Promise<ToolResult> {
    const path = await resolveFilePath(ctx.workdir, String(args.path ?? ""));
    const content = String(args.content ?? "");
    const { dirname } = await import("node:path");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, "utf-8");
    return { output: `已写入 ${path}（${content.length} 字符）` };
  },
};

/** 列出目录 */
export const listDirTool: Tool = {
  definition: {
    name: "list_dir",
    description: "列出工作目录内指定子目录的文件与文件夹，标注类型与大小。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作目录的目录路径，默认为根目录", minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  async execute(args, ctx: ExecutionContext): Promise<ToolResult> {
    const path = await resolveFilePath(ctx.workdir, String(args.path ?? "."));
    const entries = await readdir(path);
    const rows: string[] = [];
    for (const name of entries) {
      const full = resolve(path, name);
      const st = await stat(full);
      rows.push(`${st.isDirectory() ? "d" : "-"} ${name}`);
    }
    return { output: rows.length ? rows.join("\n") : "(空目录)" };
  },
};

export const fileTools: Tool[] = [readFileTool, writeFileTool, listDirTool];
