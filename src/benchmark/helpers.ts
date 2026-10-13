import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

/** 批量写入文件（自动创建父目录） */
export function writeFiles(workdir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(workdir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf-8");
  }
}

/** 在 workdir 内运行 node -e 脚本，返回退出码 */
export function runNode(workdir: string, script: string): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execSync(`node -e ${JSON.stringify(script)}`, {
      cwd: workdir,
      encoding: "utf-8",
      timeout: 15_000,
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

/** 读取并去除首尾空白 */
export function readTrim(workdir: string, rel: string): string {
  const abs = join(workdir, rel);
  if (!existsSync(abs)) return "";
  return readFileSync(abs, "utf-8").trim();
}

export function fileExists(workdir: string, rel: string): boolean {
  return existsSync(join(workdir, rel));
}
