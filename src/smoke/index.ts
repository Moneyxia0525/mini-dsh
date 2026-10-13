import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Harness } from "../harness";
import { JsonlSessionService } from "../plugins/session/SessionPlugin";
import type { MockStep } from "../plugins/model/MockModelPlugin";
import { EVENTS, SERVICES } from "../constants";

/**
 * 冒烟测试（无需 API Key，使用 MockModel）。
 * 覆盖：插件装配、Agent Loop、工具分发、指标统计、
 * Session JSONL 持久化、预算控制、会话恢复。
 */

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    const line = `  ✗ ${name}${detail ? ` — ${detail}` : ""}`;
    failures.push(line);
    console.log(line);
  }
}

async function main(): Promise<void> {
  console.log("Mini-dsh 冒烟测试（使用 MockModel）\n");

  // [1] Agent Loop 完整链路
  {
    console.log("[1] Agent Loop 完整链路");
    const dir = mkdtempSync(join(tmpdir(), "mini-dsh-smoke-"));
    writeFileSync(join(dir, "README.md"), "# smoke\nhello\n");
    const script: MockStep[] = [
      { toolCalls: [{ name: "list_dir", arguments: { path: "." } }] },
      { toolCalls: [{ name: "read_file", arguments: { path: "README.md" } }] },
      { content: "smoke done" },
    ];
    const h = await Harness.create({ model: "mock", mockScript: script, workdir: dir });
    const r = await h.run("冒烟测试任务", {});
    await h.dispose();

    check("状态为 done", r.status === "done", `status=${r.status}`);
    check("工具调用 2 次", r.metrics.toolCalls === 2, `toolCalls=${r.metrics.toolCalls}`);
    check("模型请求 3 次", r.metrics.modelRequests === 3, `modelRequests=${r.metrics.modelRequests}`);
    check("最终回答正确", r.finalAnswer === "smoke done", `finalAnswer=${r.finalAnswer}`);
    check("消息数 = 7（system+user+2×(assistant+tool)+assistant）", r.messages.length === 7, `messages=${r.messages.length}`);

    rmSync(dir, { recursive: true, force: true });
  }

  // [2] Session JSONL 持久化
  {
    console.log("[2] Session JSONL 持久化");
    const dir = mkdtempSync(join(tmpdir(), "mini-dsh-session-"));
    const sessionDir = join(dir, ".sessions");
    const h = await Harness.create({
      model: "mock",
      mockScript: [{ content: "answer 123" }],
      workdir: dir,
      session: { dir: sessionDir },
    });
    await h.run("会话测试任务", {});
    await h.dispose();

    const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    check("生成 1 个 JSONL 文件", files.length === 1, `files=${files.length}`);
    if (files.length > 0) {
      const raw = readFileSync(join(sessionDir, files[0]), "utf-8");
      check("记录 user 消息", raw.includes("会话测试任务"));
      check("记录 assistant 回答", raw.includes("answer 123"));
    }
    rmSync(dir, { recursive: true, force: true });
  }

  // [3] 预算控制（模型请求上限）
  {
    console.log("[3] 预算控制（模型请求上限）");
    const dir = mkdtempSync(join(tmpdir(), "mini-dsh-budget-"));
    const h = await Harness.create({
      model: "mock",
      mockScript: [{ toolCalls: [{ name: "list_dir", arguments: { path: "." } }] }],
      workdir: dir,
    });
    const r = await h.run("无限循环任务", { maxModelRequests: 3 });
    await h.dispose();

    check("状态为 budget_exhausted", r.status === "budget_exhausted", `status=${r.status}`);
    check("模型请求被限制为 3 次", r.metrics.modelRequests === 3, `modelRequests=${r.metrics.modelRequests}`);
    rmSync(dir, { recursive: true, force: true });
  }

  // [4] 会话恢复（toMessages）
  {
    console.log("[4] 会话恢复（toMessages）");
    const dir = mkdtempSync(join(tmpdir(), "mini-dsh-continue-"));
    const session = new JsonlSessionService({ dir: join(dir, ".sessions"), sessionId: "s1" });
    session.append({ kind: "user", content: "第一步" });
    session.append({ kind: "assistant", content: "已收到" });
    const msgs = session.toMessages();

    check("恢复 2 条消息", msgs.length === 2, `msgs=${msgs.length}`);
    check("第一条为 user", msgs[0]?.role === "user" && msgs[0]?.content === "第一步");
    check("第二条为 assistant", msgs[1]?.role === "assistant" && msgs[1]?.content === "已收到");
    rmSync(dir, { recursive: true, force: true });
  }

  // [5] 流式输出（streamComplete + delta 事件）
  {
    console.log("[5] 流式输出（streamComplete）");
    const dir = mkdtempSync(join(tmpdir(), "mini-dsh-stream-"));
    writeFileSync(join(dir, "README.md"), "# hi\n");
    const script: MockStep[] = [
      { toolCalls: [{ name: "read_file", arguments: { path: "README.md" } }] },
      { content: "streamed final answer" },
    ];
    const h = await Harness.create({ model: "mock", mockScript: script, workdir: dir });
    let deltas = "";
    h.ctx.on(EVENTS.AGENT_MODEL_DELTA, (p) => { deltas += (p as { delta: string }).delta; });
    const r = await h.run("流式任务", {});
    await h.dispose();

    check("流式 delta 拼接出完整内容", deltas.includes("streamed final answer"), `deltas=${deltas.slice(0, 60)}`);
    check("最终回答仍正确", r.finalAnswer === "streamed final answer", `finalAnswer=${r.finalAnswer}`);
    check("流式不改变消息数（system+user+assistant+tool+assistant = 5）", r.messages.length === 5, `messages=${r.messages.length}`);
    rmSync(dir, { recursive: true, force: true });
  }

  // [6] human-in-the-loop 确认拦截
  {
    console.log("[6] human-in-the-loop 确认拦截");
    const dir = mkdtempSync(join(tmpdir(), "mini-dsh-hitl-"));
    const script: MockStep[] = [
      { toolCalls: [{ name: "run_command", arguments: { command: "echo hi" } }] },
      { content: "hitl done" },
    ];
    let confirmCalls = 0;
    const h = await Harness.create({
      model: "mock",
      mockScript: script,
      workdir: dir,
      permission: {
        confirm: async () => { confirmCalls++; return false; },
        confirmTools: ["run_command"],
      },
    });
    const r = await h.run("hitl 任务", {});
    await h.dispose();

    check("确认回调被调用 1 次", confirmCalls === 1, `confirmCalls=${confirmCalls}`);
    check("拒绝错误回喂模型（含「用户拒绝」）", r.messages.some((m) => m.content.includes("用户拒绝")), "未在消息中找到拒绝错误");
    check("任务仍能继续到完成", r.status === "done", `status=${r.status}`);
    rmSync(dir, { recursive: true, force: true });
  }

  // [7] 事件持久化 + Event/Loop 插件化
  {
    console.log("[7] 事件持久化 + Event/Loop 插件化");
    const dir = mkdtempSync(join(tmpdir(), "mini-dsh-event-"));
    const sessionDir = join(dir, ".sessions");
    const h = await Harness.create({
      model: "mock",
      mockScript: [{ content: "evt done" }],
      workdir: dir,
      session: { dir: sessionDir },
    });
    check("EventBus 作为服务可注入", h.ctx.tryInject(SERVICES.EVENT_BUS) !== undefined, "EventBus 服务未注册");
    check("LoopStrategy 作为服务可注入", h.ctx.tryInject(SERVICES.LOOP) !== undefined, "Loop 服务未注册");

    await h.run("事件任务", {});
    await h.dispose();

    const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl"));
    check("生成 1 个 JSONL 文件", files.length === 1, `files=${files.length}`);
    if (files.length > 0) {
      const raw = readFileSync(join(sessionDir, files[0]), "utf-8");
      const records = raw.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { kind: string; name?: string });
      const eventRecords = records.filter((r) => r.kind === "event");
      check("JSONL 含 event 记录", eventRecords.length > 0, "无 event 记录");
      check("含 agent.start 事件", eventRecords.some((r) => r.name === EVENTS.AGENT_START), "缺少 agent.start");
      check("含 agent.done 事件", eventRecords.some((r) => r.name === EVENTS.AGENT_DONE), "缺少 agent.done");
    }
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) {
    console.log(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("全部通过 ✓");
  }
}

main().catch((err) => {
  console.error("[smoke] 致命错误:", err);
  process.exitCode = 1;
});
