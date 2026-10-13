import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MiniContext, MiniPlugin, RunCheckpoint, SessionRecord, SessionService } from "../../types";
import { SERVICES } from "../../constants";

export interface SessionConfig {
  /** JSONL 持久化目录，默认 .sessions */
  dir?: string;
  /** 会话 id，默认自动生成 */
  sessionId?: string;
}

/**
 * Session 插件：追加式 JSONL 持久化。
 *
 * 每条消息 / 工具调用 / 工具结果都作为一行 JSON 追加写入，
 * 顺序天然就是时间线，崩溃恢复只需回读文件，无需事务。
 */
export class JsonlSessionService implements SessionService {
  private sessionId: string;
  private filePath: string;

  constructor(config: SessionConfig = {}) {
    this.sessionId = config.sessionId ?? `session_${Date.now().toString(36)}`;
    const dir = resolve(config.dir ?? ".sessions");
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, `${this.sessionId}.jsonl`);
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getFilePath(): string {
    return this.filePath;
  }

  append(record: Omit<SessionRecord, "ts">): void {
    const line: SessionRecord = { ...record, ts: Date.now() };
    appendFileSync(this.filePath, JSON.stringify(line) + "\n", "utf-8");
  }

  load(): SessionRecord[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, "utf-8");
    const records: SessionRecord[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as SessionRecord);
      } catch {
        // 忽略损坏行，保证恢复健壮
      }
    }
    return records;
  }

  saveCheckpoint(checkpoint: RunCheckpoint): void {
    this.append({ kind: "checkpoint", payload: checkpoint });
  }

  loadLatestCheckpoint(): RunCheckpoint | undefined {
    const record = this.load().reverse().find((item) => item.kind === "checkpoint");
    return record?.payload as RunCheckpoint | undefined;
  }

  /** 重建会话历史为 Message 列表（供 /continue 使用）。event 记录是事件轨迹，不参与重建。 */
  toMessages(): Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string; toolCalls?: SessionRecord["toolCalls"] }> {
    return this.load()
      .filter((r) => r.kind !== "event" && r.kind !== "checkpoint")
      .map((r) => {
        switch (r.kind) {
          case "tool":
            return {
              role: "tool" as const,
              content: r.error ? `ERROR: ${r.error}\n${r.result ?? ""}` : (r.result ?? ""),
              toolCallId: r.toolCallId,
            };
          case "assistant":
            return {
              role: "assistant" as const,
              content: r.content ?? "",
              toolCalls: r.toolCalls,
            };
          default:
            return { role: r.kind as "system" | "user", content: r.content ?? "" };
        }
      });
  }

  clear(): void {
    writeFileSync(this.filePath, "", "utf-8");
  }
}

export class SessionPlugin implements MiniPlugin {
  readonly name = "plugin.session";

  constructor(private config: SessionConfig = {}) {}

  setup(ctx: MiniContext): void {
    ctx.provide<SessionService>(SERVICES.SESSION, new JsonlSessionService(this.config));
  }
}
