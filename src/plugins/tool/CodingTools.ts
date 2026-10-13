import { readFile, writeFile, readdir, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative } from "node:path";
import type { ExecutionContext, Tool, ToolResult } from "../../types";
import { isSensitivePath, resolveRealPathWithin } from "../../utils";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_RESULTS = 100;

async function walk(root: string, current: string, out: string[], ctx: ExecutionContext): Promise<void> {
  if (ctx.signal.aborted) throw new Error("操作已取消");
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (ctx.signal.aborted) throw new Error("操作已取消");
    if ([".git", "node_modules", "dist", ".sessions"].includes(entry.name)) continue;
    const absolute = `${current}\\${entry.name}`;
    const rel = relative(root, absolute).replaceAll("\\", "/");
    if (isSensitivePath(rel)) continue;
    if (entry.isDirectory()) await walk(root, absolute, out, ctx);
    else if (entry.isFile()) out.push(rel);
  }
}

export const findFilesTool: Tool = {
  definition: {
    name: "find_files",
    description: "递归查找工作目录内的文件，默认忽略 .git、node_modules、dist 和 .sessions。",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "文件名包含的文本或简单后缀，例如 .ts", minLength: 1 },
        maxResults: { type: "integer", description: "最多返回数量，默认 100" },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const all: string[] = [];
    await walk(ctx.workdir, ctx.workdir, all, ctx);
    const pattern = String(args.pattern).toLowerCase();
    const maxResults = Math.max(1, Number(args.maxResults ?? DEFAULT_MAX_RESULTS));
    const matches = all.filter((p) => p.toLowerCase().includes(pattern)).slice(0, maxResults);
    return { output: matches.length ? matches.join("\n") : "(没有匹配文件)" };
  },
};

export const searchTextTool: Tool = {
  definition: {
    name: "search_text",
    description: "在工作目录内的文本文件中搜索字符串，返回文件、行号和匹配行。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搜索的文本", minLength: 1 },
        path: { type: "string", description: "可选的相对目录或文件路径" },
        caseSensitive: { type: "boolean", description: "是否区分大小写，默认 false" },
        maxResults: { type: "integer", description: "最多返回数量，默认 100" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const query = String(args.query);
    const caseSensitive = Boolean(args.caseSensitive ?? false);
    const maxResults = Math.max(1, Number(args.maxResults ?? DEFAULT_MAX_RESULTS));
    const target = String(args.path ?? ".");
    const absolute = await resolveRealPathWithin(ctx.workdir, target);
    const targetStat = await stat(absolute);
    const files: string[] = [];
    if (targetStat.isFile()) {
      files.push(absolute);
    } else {
      await walk(ctx.workdir, absolute, files, ctx);
      for (let i = 0; i < files.length; i++) files[i] = `${ctx.workdir}\\${files[i]}`;
    }

    const needle = caseSensitive ? query : query.toLowerCase();
    const results: string[] = [];
    for (const file of files) {
      if (results.length >= maxResults) break;
      if (ctx.signal.aborted) throw new Error("操作已取消");
      let content: string;
      try {
        content = await readFile(file, "utf-8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        const haystack = caseSensitive ? lines[i] : lines[i].toLowerCase();
        if (haystack.includes(needle)) {
          results.push(`${relative(ctx.workdir, file).replaceAll("\\", "/")}:${i + 1}|${lines[i]}`);
        }
      }
    }
    return { output: results.length ? results.join("\n") : "(没有匹配内容)" };
  },
};

export const applyPatchTool: Tool = {
  definition: {
    name: "apply_patch",
    description: "对工作目录内的文件应用 unified diff。修改后应使用 git_diff 或 run_command 验证。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作目录的文件路径", minLength: 1 },
        patch: { type: "string", description: "unified diff 内容", minLength: 1 },
      },
      required: ["path", "patch"],
      additionalProperties: false,
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const relPath = String(args.path);
    if (isSensitivePath(relPath)) return { output: "", error: `拒绝修改敏感路径: ${relPath}` };
    const path = await resolveRealPathWithin(ctx.workdir, relPath);
    const original = await readFile(path, "utf-8");
    const patch = String(args.patch);
    const updated = applyUnifiedPatch(original, patch);
    await writeFile(path, updated, "utf-8");
    return { output: `已应用 patch: ${relPath}` };
  },
};

export const gitStatusTool: Tool = {
  definition: {
    name: "git_status",
    description: "查看当前工作目录的 git 状态。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  async execute(_args, ctx): Promise<ToolResult> {
    return runGit(ctx, ["status", "--short"]);
  },
};

export const gitDiffTool: Tool = {
  definition: {
    name: "git_diff",
    description: "查看当前工作目录的 git diff，可选指定文件。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "可选的相对文件路径" } },
      additionalProperties: false,
    },
  },
  async execute(args, ctx): Promise<ToolResult> {
    const path = args.path ? String(args.path) : undefined;
    if (path && isSensitivePath(path)) return { output: "", error: `拒绝读取敏感路径: ${path}` };
    return runGit(ctx, path ? ["diff", "--", path] : ["diff"]);
  },
};

async function runGit(ctx: ExecutionContext, args: string[]): Promise<ToolResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd: ctx.workdir,
      timeout: 30_000,
      windowsHide: true,
      signal: ctx.signal,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { output: (result.stdout || "(无输出)") + (result.stderr ? `\n[stderr]\n${result.stderr}` : "") };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: string | number; message?: string };
    return {
      output: [e.stdout, e.stderr].filter(Boolean).join("\n") || "",
      error: `git 命令失败（${String(e.code ?? "unknown")}）：${e.message ?? "unknown error"}`,
    };
  }
}

function applyUnifiedPatch(original: string, patch: string): string {
  const source = original.split(/\r?\n/);
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const hunks: Array<{ oldStart: number; body: string[] }> = [];
  let current: { oldStart: number; body: string[] } | undefined;

  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
    if (match) {
      current = { oldStart: Number(match[1]), body: [] };
      hunks.push(current);
    } else if (current && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
      current.body.push(line);
    }
  }
  if (!hunks.length) throw new Error("patch 缺少 unified diff hunk（@@ ... @@）");

  const result: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const target = hunk.oldStart - 1;
    if (target < cursor || target > source.length) throw new Error("patch 行号超出文件范围");
    result.push(...source.slice(cursor, target));
    let oldOffset = target;
    for (const line of hunk.body) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " ") {
        if (source[oldOffset] !== text) throw new Error(`patch 上下文不匹配: "${text}"`);
        result.push(text);
        oldOffset++;
      } else if (marker === "-") {
        if (source[oldOffset] !== text) throw new Error(`patch 删除内容不匹配: "${text}"`);
        oldOffset++;
      } else if (marker === "+") {
        result.push(text);
      }
    }
    cursor = oldOffset;
  }
  result.push(...source.slice(cursor));
  return result.join("\n");
}

export const codingTools: Tool[] = [
  findFilesTool,
  searchTextTool,
  applyPatchTool,
  gitStatusTool,
  gitDiffTool,
];
