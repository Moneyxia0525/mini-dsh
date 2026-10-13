import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "../core/Context";
import { PluginRegistry } from "../core/PluginRegistry";
import { ServiceRegistry } from "../core/ServiceRegistry";
import { validateToolArguments } from "../utils";

test("schema validator rejects missing and invalid tool arguments", () => {
  const schema = {
    type: "object",
    properties: { path: { type: "string" }, limit: { type: "integer" } },
    required: ["path"],
    additionalProperties: false,
  };
  assert.match(validateToolArguments(schema, {}) ?? "", /缺少必填/);
  assert.match(validateToolArguments(schema, { path: 1 }) ?? "", /类型错误/);
  assert.match(validateToolArguments(schema, { path: "a", extra: true }) ?? "", /不允许/);
  assert.equal(validateToolArguments(schema, { path: "a", limit: 2 }), undefined);
});

test("plugin setup failure disposes already initialized plugins", async () => {
  const ctx = new Context(new ServiceRegistry());
  const disposed: string[] = [];
  const registry = new PluginRegistry({
    ctx,
    logger: { log: () => {}, error: () => {} },
  });
  registry
    .register({
      name: "first",
      setup: () => {},
      dispose: () => { disposed.push("first"); },
    })
    .register({
      name: "second",
      setup: () => { throw new Error("boom"); },
    });

  await assert.rejects(() => registry.setupAll(), /boom/);
  assert.deepEqual(disposed, ["first"]);
});

test("unified patch updates only the requested file content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mini-dsh-test-"));
  try {
    const file = join(dir, "a.txt");
    await writeFile(file, "one\ntwo\n", "utf-8");
    const { applyPatchTool } = await import("../plugins/tool/CodingTools");
    const result = await applyPatchTool.execute({
      path: "a.txt",
      patch: "@@ -1,2 +1,2 @@\n one\n-two\n+changed\n",
    }, { workdir: dir, signal: new AbortController().signal });
    assert.equal(result.error, undefined);
    assert.equal(await readFile(file, "utf-8"), "one\nchanged\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
