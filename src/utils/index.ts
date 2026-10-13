import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 极简 .env 加载器（零运行时依赖，契合「从零实现」定位）。
 * 仅做 KEY=VALUE 的逐行解析，不覆盖已存在的环境变量。
 */
export function loadEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  const raw = readFileSync(path, "utf-8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

/** 生成简短唯一 id */
export function generateId(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 基于字符数的粗略 token 估算（约 4 字符/token，中文约 1.5 字符/token 差异已折中处理） */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/** 将任意错误规范为字符串 */
export function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}

/** 解析工作目录（默认当前目录） */
export function resolveWorkdir(workdir?: string): string {
  return resolve(workdir || process.cwd());
}

export { validateToolArguments, isRecord } from "./SchemaValidator";
export { assertWithin, isSensitivePath, resolveRealPathWithin } from "./paths";
