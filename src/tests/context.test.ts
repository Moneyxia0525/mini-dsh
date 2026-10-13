import assert from "node:assert/strict";
import test from "node:test";
import { Context } from "../core/Context";
import { ContextManager } from "../plugins/context/ContextManagerPlugin";
import type { Message } from "../types";

test("context compression keeps assistant tool calls paired with results", async () => {
  const ctx = new Context();
  const manager = new ContextManager(ctx, {
    maxTokens: 20,
    triggerRatio: 0.1,
    keepWindow: 1,
    maxToolResultChars: 100,
  });
  const messages: Message[] = [
    { role: "system", content: "system" },
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "1", name: "read_file", arguments: "{}" }],
    },
    { role: "tool", toolCallId: "1", content: "result" },
    { role: "assistant", content: "done" },
  ];

  const result = await manager.manage(messages);
  const assistantIndexes = result
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.role === "assistant" && message.toolCalls?.length);
  for (const { index } of assistantIndexes) {
    assert.equal(result[index + 1]?.role, "tool");
  }
});
