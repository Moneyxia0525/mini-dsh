import { realpath } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * 解析并校验工作目录内的真实路径。
 * 对已存在目标检查最终 realpath；对新文件检查父目录 realpath，
 * 从而避免通过 symlink 绕出授权根目录。
 */
export async function resolveRealPathWithin(workdir: string, relPath: string): Promise<string> {
  const base = await realpath(resolve(workdir));
  const candidate = resolve(base, relPath);

  try {
    const actual = await realpath(candidate);
    assertWithin(base, actual, relPath);
    return actual;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const parent = await realpathExistingParent(dirname(candidate));
    assertWithin(base, parent, relPath);
    return candidate;
  }
}

async function realpathExistingParent(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const parent = await realpathExistingParent(dirname(path));
    return parent;
  }
}

export function assertWithin(root: string, target: string, displayPath: string): void {
  const base = resolve(root);
  const abs = resolve(target);
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`路径越界（超出授权目录）: ${displayPath}`);
  }
}

export function isSensitivePath(relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\.\/+/, "");
  return normalized === ".env"
    || normalized.startsWith(".env.")
    || normalized === ".git"
    || normalized.startsWith(".git/")
    || normalized === ".sessions"
    || normalized.startsWith(".sessions/");
}
