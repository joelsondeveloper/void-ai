import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { DevAgent } from "../src/agents/DevAgent.js";
import { ExecutionGovernance } from "../src/governance/ExecutionGovernance.js";
import { resolveEffort } from "../src/governance/effort.js";
import { SQLiteCheckpointStore, type CheckpointStore } from "../src/governance/CheckpointStore.js";
import { encodeCheckpoint, transition } from "../src/governance/checkpoint.js";
import { ModelRouter } from "../src/models/ModelRouter.js";
import { OpenRouterProvider } from "../src/models/providers/OpenRouterProvider.js";
import { AgentRegistry } from "../src/runtime/AgentRegistry.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import type { ExecutableAgent } from "../src/types/agent.js";
import type { AgentContext } from "../src/types/context.js";
import type { ModelProvider, ModelResponse } from "../src/types/model.js";
import type { PlanStep } from "../src/types/plan.js";

function context(signal = new AbortController().signal): AgentContext {
  return { executionId: "input", signal, permissions: new Set(), budgetLimit: 0, metadata: {} };
}

function step(id: string, dependsOn: string[] = []): PlanStep {
  return { id, agentId: "dev-agent", objective: id, dependsOn };
}

function runtime(generate: ModelProvider["generate"], provider = "local", model = "test", maxOutputTokens = 2): AgentRuntime {
  const registry = new AgentRegistry();
  const router = new ModelRouter([{ id: provider, generate }]);
  registry.register(new DevAgent(router, { providerId: provider, model, maxOutputTokens }));
  return new AgentRuntime(registry);
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "void-governance-"));
  const filename = join(directory, "checkpoint.sqlite");
  const store = new SQLiteCheckpointStore(filename);
  t.after(() => {
    store.close();
    rmSync(filename, { force: true });
    rmdirSync(directory);
  });
  return { filename, store };
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const local = { trustedLocalProviders: ["local"] };
function response(model: string, content = "done"): ModelResponse {
  return { model, content, usage: { inputTokens: 2, outputTokens: 1 } };
}

test("effort profiles, auto and overrides are deterministic", () => {
  const levels = ["low", "medium", "high", "max"] as const;
  assert.deepEqual(levels.map((level) => resolveEffort(level).limits.calls), [5, 15, 30, 60]);
  assert.equal(resolveEffort().effort, "low");
  assert.equal(resolveEffort("auto", { concurrency: 1 }, "medium").limits.concurrency, 1);
  assert.equal(resolveEffort("max").limits.pauseAfterMs, undefined);
  assert.throws(() => resolveEffort("low", { calls: 0 }), /Invalid execution limits/);
  assert.throws(() => resolveEffort("max", { concurrency: 33 }), /Invalid execution limits/);
  assert.throws(() => resolveEffort("medium", { pauseAfterMs: 1.5 }), /Invalid execution limits/);
});

test("persists an effort warning and a step limit, then resumes on another store without replay", async (t) => {
  const { filename, store } = fixture(t);
  const seen: string[] = [];
  const events: string[] = [];
  let now = 0;
  const agents = runtime(async ({ model, messages }) => {
    const objective = messages.at(-1)?.content ?? "";
    seen.push(objective);
    now += 10;
    return response(model, objective);
  });
  const first = new ExecutionGovernance(agents, store, {
    ...local, now: () => now, onProgress: (event) => { events.push(event.type); },
  });
  const paused = await first.start({ id: "plan", plan: [step("B", ["A"]), step("A")], context: context(),
    effort: "low", limits: { steps: 1, warnAfterMs: 5, concurrency: 1 } });
  assert.equal(paused.status, "awaiting_approval");
  assert.equal(paused.pauseReason, "steps");
  assert.deepEqual(seen, ["A"]);
  assert.equal(paused.usage.elapsedMs, 10);
  assert.ok(events.includes("warning_threshold_reached"));
  assert.ok(events.includes("approval_required"));

  const reopened = new SQLiteCheckpointStore(filename);
  try {
    const second = new ExecutionGovernance(agents, reopened, { ...local, now: () => now });
    assert.equal(second.partial("plan")?.steps.find(({ stepId }) => stepId === "A")?.output, "A");
    assert.throws(() => second.resume("plan", context(), { steps: 1000 }), /Invalid execution limits/);
    const done = await second.resume("plan", context(), { steps: 1 });
    assert.equal(done.status, "completed");
    assert.deepEqual(seen, ["A", "B"]);
    assert.deepEqual(done.steps.map(({ output }) => output), ["B", "A"]);
    assert.equal(done.usage.elapsedMs, 20);
    assert.equal(done.usage.stepsStarted, 2);
    assert.equal(done.usage.callsCompleted, 2);
    assert.equal(done.usage.inputTokens, 4);
    assert.equal(done.usage.outputTokens, 2);
    assert.equal(done.usage.financialCostUsd, null);
    assert.deepEqual(done.extensions.map(({ limits }) => limits), [{ steps: 1 }]);
    assert.throws(() => second.resume("plan", context()), /cannot be resumed/);
    assert.throws(() => transition(done, "running"), /Invalid execution transition/);
  } finally { reopened.close(); }
});

test("operational time pauses only at a safe point and an explicit time extension resumes", async (t) => {
  const { store } = fixture(t);
  let now = 0;
  const gov = new ExecutionGovernance(runtime(async ({ model }) => {
    now += 5;
    return response(model);
  }), store, { ...local, now: () => now });
  const paused = await gov.start({ plan: [step("A"), step("B")], context: context(),
    limits: { pauseAfterMs: 4, warnAfterMs: 3, concurrency: 1 } });
  assert.equal(paused.pauseReason, "time");
  assert.deepEqual(paused.steps.map(({ status }) => status), ["completed", "pending"]);
  const done = await gov.resume(paused.id, context(), { timeMs: 10 });
  assert.equal(done.status, "completed");
  assert.equal(done.limits.pauseAfterMs, 14);
  assert.equal(done.usage.elapsedMs, 10);
});

test("manual pause drains two active calls, leaves new work pending and prevents concurrent resume", async (t) => {
  const { store, filename } = fixture(t);
  const wait = gate();
  const seen: string[] = [];
  const agentRuntime = runtime(async ({ model, messages }) => {
    const objective = messages.at(-1)?.content ?? "";
    seen.push(objective);
    await wait.promise;
    return response(model, objective);
  });
  const gov = new ExecutionGovernance(agentRuntime, store, local);
  const otherStore = new SQLiteCheckpointStore(filename);
  try {
    const other = new ExecutionGovernance(agentRuntime, otherStore, local);
    const running = gov.start({ id: "manual", plan: ["A", "B", "C"].map((id) => step(id)), context: context(),
      limits: { concurrency: 2 } });
    try {
      await setImmediate();
      assert.deepEqual(seen, ["A", "B"]);
      assert.equal(gov.partial("manual")?.usage.callsActive, 2);
      gov.pause("manual");
      assert.equal(gov.partial("manual")?.status, "pausing");
      assert.throws(() => other.resume("manual", context()), /already owned/);
    } finally { wait.release(); }
    const paused = await running;
    assert.equal(paused.status, "paused");
    assert.deepEqual(paused.steps.map(({ status }) => status), ["completed", "completed", "pending"]);
    const done = await other.resume("manual", context());
    assert.equal(done.status, "completed");
    assert.deepEqual(seen, ["A", "B", "C"]);
  } finally { otherStore.close(); }
});

test("global concurrency shares capacity across executions without busy waiting", async (t) => {
  const { store } = fixture(t);
  const wait = gate();
  const seen: string[] = [];
  const gov = new ExecutionGovernance(runtime(async ({ model, messages }) => {
    seen.push(messages.at(-1)?.content ?? "");
    await wait.promise;
    return response(model);
  }), store, { ...local, globalConcurrency: 1 });
  const first = gov.start({ id: "one", plan: [step("A")], context: context() });
  const second = gov.start({ id: "two", plan: [step("B")], context: context() });
  try {
    await setImmediate();
    assert.deepEqual(seen, ["A"]);
    assert.equal(gov.partial("one")?.usage.stepsActive, 1);
    assert.equal(gov.partial("two")?.usage.stepsActive, 0);
  } finally { wait.release(); }
  assert.deepEqual((await Promise.all([first, second])).map(({ status }) => status), ["completed", "completed"]);
  assert.deepEqual(seen, ["A", "B"]);
});

test("simultaneous model calls cannot spend the same call reservation", async (t) => {
  const { store } = fixture(t);
  const ready = gate();
  const router = new ModelRouter([{ id: "local", async generate({ model }) { return response(model); } }]);
  const registry = new AgentRegistry();
  const agent: ExecutableAgent = {
    definition: { id: "dev-agent", name: "Test", description: "Test", capabilities: [] },
    async execute({ objective }) {
      await ready.promise;
      return router.generate("local", { model: "test", messages: [{ role: "user", content: objective }] });
    },
  };
  registry.register(agent);
  const gov = new ExecutionGovernance(new AgentRuntime(registry), store, local);
  const pending = gov.start({ plan: [step("A"), step("B")], context: context(), limits: { calls: 1 } });
  try { await setImmediate(); } finally { ready.release(); }
  const paused = await pending;
  assert.equal(paused.status, "awaiting_approval");
  assert.equal(paused.pauseReason, "calls");
  assert.equal(paused.usage.callsStarted, 1);
  assert.equal(paused.usage.callsCompleted, 1);
  assert.equal(paused.steps.filter(({ status }) => status === "pending").length, 1);
  assert.equal((await gov.resume(paused.id, context(), { calls: 1 })).status, "completed");
});

test("output token reservation is tracked and explicitly extendable", async (t) => {
  const { store } = fixture(t);
  const reserved: number[] = [];
  const gov = new ExecutionGovernance(runtime(async ({ model }) => response(model)), store, {
    ...local,
    onProgress: ({ usage }) => { reserved.push(usage.outputTokensReserved); },
  });
  const paused = await gov.start({ plan: [step("A"), step("B")], context: context(),
    limits: { outputTokens: 2, concurrency: 1 } });
  assert.equal(paused.pauseReason, "tokens");
  assert.equal(paused.usage.outputTokens, 1);
  assert.equal(paused.usage.outputTokensReserved, 0);
  assert.ok(reserved.includes(2));
  assert.equal((await gov.resume(paused.id, context(), { outputTokens: 1 })).status, "completed");
});

test("missing metrics pause further work when a token budget is in force", async (t) => {
  const { store } = fixture(t);
  const gov = new ExecutionGovernance(runtime(async ({ model }) => ({ model, content: "done" })), store, local);
  const result = await gov.start({ plan: [step("A"), step("B")], context: context(),
    limits: { outputTokens: 10, concurrency: 1 } });
  assert.equal(result.pauseReason, "usage_unknown");
  assert.equal(result.usage.callsCompleted, 1);
  assert.equal(result.usage.unknownUsageCalls, 1);
  assert.equal(result.usage.outputTokens, 0);
  assert.equal(result.usage.financialCostUsd, null);
});

test("paid calls cannot bypass free-only policy even with an OpenRouter local allowlist entry", async (t) => {
  const { store } = fixture(t);
  let calls = 0;
  const gov = new ExecutionGovernance(runtime(async ({ model }) => {
    calls++;
    return response(model);
  }, "openrouter", "vendor/paid"), store, { trustedLocalProviders: ["openrouter"] });
  const failed = await gov.start({ plan: [step("A"), step("B")], context: context(), limits: { concurrency: 1 } });
  assert.equal(calls, 0);
  assert.equal(failed.status, "failed");
  assert.equal(failed.steps[0]?.failure?.category, "permission_denied");
  assert.equal(failed.steps[1]?.status, "pending");
  assert.equal(failed.usage.callsStarted, 0);
});

test("cancelled calls retain accounting and cannot be resumed", async (t) => {
  const { store } = fixture(t);
  const gov = new ExecutionGovernance(runtime(async ({ signal }) => {
    assert.ok(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }), store, local);
  const running = gov.start({ id: "cancel", plan: [step("A"), step("B")], context: context(), limits: { concurrency: 1 } });
  await setImmediate();
  gov.cancel("cancel");
  const cancelled = await running;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.steps[0]?.failure?.category, "cancelled");
  assert.equal(cancelled.steps[0]?.failure?.retryable, false);
  assert.equal(cancelled.usage.callsFailed, 1);
  assert.equal(cancelled.usage.unknownUsageCalls, 1);
  assert.throws(() => gov.resume("cancel", context()), /cannot be resumed/);
});

test("OpenRouter structured rate limit and safe metadata survive all layers", async (t) => {
  const { store } = fixture(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({
    error: { code: 429, message: "private upstream error", metadata: { error_type: "rate_limit_exceeded" } },
  }, { status: 429 }));
  const registry = new AgentRegistry();
  registry.register(new DevAgent(new ModelRouter([new OpenRouterProvider("fake-test-key")])));
  const gov = new ExecutionGovernance(new AgentRuntime(registry), store);
  const failed = await gov.start({ plan: [step("A"), step("B", ["A"])], context: context() });
  assert.equal(failed.status, "failed");
  assert.equal(failed.steps[0]?.failure?.category, "rate_limited");
  assert.equal(failed.steps[0]?.failure?.model, "openrouter/free");
  assert.equal(failed.steps[0]?.failure?.httpStatus, 429);
  assert.equal(failed.steps[0]?.failure?.retryable, true);
  assert.equal(failed.steps[1]?.status, "pending");
  assert.equal(failed.usage.callsFailed, 1);
  assert.equal(failed.usage.unknownUsageCalls, 1);
  assert.doesNotMatch(JSON.stringify(failed), /fake-test-key|private upstream error/);
});

test("checkpoint write failure blocks dispatch and the prior durable checkpoint remains recoverable", async (t) => {
  const { store } = fixture(t);
  const failing: CheckpointStore = {
    load: (id) => store.load(id),
    claim(id, initial) {
      const lease = store.claim(id, initial);
      return { ...lease, save(checkpoint) {
        if (checkpoint.usage.callsStarted === 1) throw new Error("disk failed");
        lease.save(checkpoint);
      } };
    },
  };
  let calls = 0;
  const agents = runtime(async ({ model }) => { calls++; return response(model); });
  const gov = new ExecutionGovernance(agents, failing, local);
  await assert.rejects(gov.start({ id: "disk", plan: [step("A")], context: context() }), /Could not persist/);
  assert.equal(calls, 0);
  const recovered = new ExecutionGovernance(agents, store, local).recover("disk");
  assert.equal(recovered.status, "paused");
  assert.equal(recovered.steps[0]?.failure?.category, "interrupted");
  assert.equal(recovered.usage.callsStarted, 0);
});

test("checkpoints reject non-serializable input, damaged data and incompatible versions", async (t) => {
  const { store, filename } = fixture(t);
  const gov = new ExecutionGovernance(runtime(async ({ model }) => response(model)), store, local);
  const supplied = context();
  supplied.metadata = { transientSecret: "not persisted", signal: supplied.signal, fn: () => {} };
  const done = await gov.start({ id: "validation", plan: [step("A")], context: supplied });
  assert.doesNotMatch(encodeCheckpoint(done), /transientSecret|not persisted/);
  assert.throws(() => encodeCheckpoint({ ...done, ...{ signal: supplied.signal } }), /Non-serializable/);
  const db = new DatabaseSync(filename);
  try {
    const replace = db.prepare("UPDATE executions SET json = ?, hash = ? WHERE id = ?");
    replace.run("{}", "wrong checksum", "validation");
    assert.throws(() => gov.partial("validation"), /integrity check failed/);
    const incompatible = JSON.stringify({ ...done, version: 99 });
    replace.run(incompatible, createHash("sha256").update(incompatible).digest("hex"), "validation");
    assert.throws(() => gov.partial("validation"), /Unsupported execution checkpoint version/);
  } finally { db.close(); }
});

test("recovers a dead process without replaying completed or uncertain steps", async (t) => {
  const { store, filename } = fixture(t);
  const code = `
    import { ExecutionGovernance } from "./src/governance/ExecutionGovernance.ts";
    import { SQLiteCheckpointStore } from "./src/governance/CheckpointStore.ts";
    import { AgentRegistry } from "./src/runtime/AgentRegistry.ts";
    import { AgentRuntime } from "./src/runtime/AgentRuntime.ts";
    import { ModelRouter } from "./src/models/ModelRouter.ts";
    import { DevAgent } from "./src/agents/DevAgent.ts";
    const db = new SQLiteCheckpointStore(process.argv[1]);
    const router = new ModelRouter([{id: "local", async generate(request) {
      const content = request.messages.at(-1).content;
      if (content === "B") process.exit(23);
      return { model: request.model, content };
    }}]);
    const registry = new AgentRegistry();
    registry.register(new DevAgent(router, {providerId: "local", model: "test"}));
    const gov = new ExecutionGovernance(new AgentRuntime(registry), db, {trustedLocalProviders:["local"]});
    const plan = ["A","B","C"].map(id => ({id, agentId:"dev-agent", objective:id, dependsOn:[]}));
    const context = {executionId:"input",signal:new AbortController().signal,permissions:new Set(),budgetLimit:0,metadata:{}};
    await gov.start({id:"crash",plan,context,limits:{concurrency:1}});
  `;
  const child = spawnSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", code, filename], {
    cwd: process.cwd(), encoding: "utf8", timeout: 10_000,
  });
  assert.equal(child.status, 23, child.stderr);
  const seen: string[] = [];
  const gov = new ExecutionGovernance(runtime(async ({ model, messages }) => {
    seen.push(messages.at(-1)?.content ?? "");
    return response(model);
  }), store, local);
  const recovered = gov.recover("crash");
  assert.equal(recovered.pauseReason, "recovery");
  assert.equal(recovered.steps[0]?.output, "A");
  assert.equal(recovered.steps[1]?.failure?.category, "interrupted");
  assert.equal(recovered.usage.callsInterrupted, 1);
  assert.equal(recovered.usage.unknownUsageCalls, 2);
  const finished = await gov.resume("crash", context());
  assert.deepEqual(seen, ["C"]);
  assert.equal(finished.status, "failed");
  assert.deepEqual(finished.steps.map(({ status }) => status), ["completed", "failed", "completed"]);
});

test("approval events expose available actions after the execution lease is released", async (t) => {
  const { store } = fixture(t);
  let resumed: Promise<unknown> | undefined;
  const gov = new ExecutionGovernance(runtime(async ({ model }) => response(model)), store, {
    ...local,
    onProgress(event) {
      if (event.type !== "approval_required") return;
      assert.deepEqual(event.actions, ["partial", "cancel", "extend_steps"]);
      resumed = gov.resume(event.executionId, context(), { steps: 1 });
    },
  });
  const paused = await gov.start({ id: "event", plan: [step("A"), step("B")], context: context(),
    limits: { steps: 1, concurrency: 1 } });
  assert.equal(paused.status, "awaiting_approval");
  assert.ok(resumed);
  await resumed;
  assert.equal(gov.partial("event")?.status, "completed");
});

test("the model and output limit cannot be changed after admission begins", async (t) => {
  const { store } = fixture(t);
  const router = new ModelRouter([{ id: "openrouter", async generate(request) {
    assert.equal(request.maxOutputTokens, 2);
    return response(request.model, request.model);
  } }]);
  const registry = new AgentRegistry();
  registry.register({
    definition: { id: "dev-agent", name: "Test", description: "Test", capabilities: [] },
    async execute() {
      const request = { model: "openrouter/free", messages: [], maxOutputTokens: 2 };
      const pending = router.generate("openrouter", request);
      request.model = "vendor/paid";
      request.maxOutputTokens = 999;
      return pending;
    },
  });
  const gov = new ExecutionGovernance(new AgentRuntime(registry), store);
  const done = await gov.start({ plan: [step("A")], context: context(), limits: { outputTokens: 2 } });
  assert.equal(done.status, "completed");
  assert.equal(done.steps[0]?.output, "openrouter/free");
});

test("reported output over a reservation is counted and blocks further dispatch", async (t) => {
  const { store } = fixture(t);
  let calls = 0;
  const gov = new ExecutionGovernance(runtime(async ({ model }) => {
    calls++;
    return { model, content: "overrun", usage: { inputTokens: 2, outputTokens: 3 } };
  }), store, local);
  const result = await gov.start({ plan: [step("A"), step("B")], context: context(),
    limits: { outputTokens: 10, concurrency: 1 } });
  assert.equal(result.status, "failed");
  assert.equal(result.usage.callsFailed, 1);
  assert.equal(result.usage.outputTokens, 3);
  assert.equal(result.steps[0]?.failure?.code, "token_overrun");
  assert.equal(result.steps[1]?.status, "pending");
  assert.equal(calls, 1);
});
