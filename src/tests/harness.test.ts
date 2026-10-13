import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Harness } from "../harness";

test("harness exposes run id, plan, verification and cancellation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mini-dsh-harness-"));
  try {
    await writeFile(join(dir, "README.md"), "hello\n", "utf-8");
    const harness = await Harness.create({
      model: "mock",
      mockScript: [{ content: "done" }],
      workdir: dir,
    });
    const result = await harness.run("读取 README.md", {});
    await harness.dispose();

    assert.match(result.runId, /^run_/);
    assert.equal(result.status, "done");
    assert.equal(result.metrics.verificationRuns, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tool schema errors are fed back instead of crashing the loop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mini-dsh-schema-"));
  try {
    const harness = await Harness.create({
      model: "mock",
      mockScript: [
        { toolCalls: [{ name: "read_file", arguments: {} as Record<string, unknown> }] },
        { content: "recovered" },
      ],
      workdir: dir,
    });
    const result = await harness.run("schema", {});
    await harness.dispose();
    assert.equal(result.status, "done");
    assert.ok(result.messages.some((message) => message.content.includes("缺少必填参数")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
