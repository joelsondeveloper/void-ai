import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MainMessage } from "../src/agents/MainAgent.js";
import { parseDecision } from "../src/conversation/mainDecision.js";
import { openLocalDatabase } from "../src/governance/CheckpointStore.js";
import { AgentOperation, type AgentTaskEvent } from "../src/runtime/AgentOperation.js";
import { AgentRegistry } from "../src/runtime/AgentRegistry.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import { ExecutionError } from "../src/types/failure.js";
import type { ModelProvider } from "../src/types/model.js";
import { ComponentRegistry } from "../src/web/ComponentRegistry.js";
import { compileComponent } from "../src/web/component-compiler.js";
import { createWebRuntime } from "../src/web/runtime.js";

const source = (jsx: string) => "export default function Component() { return (" + jsx + "); }";

test("the preview compiler accepts bounded React TSX and rejects executable or external capabilities", () => {
  const draft = compileComponent("Expedições", source('<section><Counter label="Expedições" /><Toggle label="Revisado" /></section>'));
  assert.match(draft.compiled, /React\.createElement\(Counter/);
  for (const unsafe of [
    '<img src="https://example.org" />',
    '<section onClick="x">Unsafe</section>',
    '<p>{fetch("/api/sessions")}</p>',
    '<div {...globalThis} />',
    '<section><script>window.top.location</script></section>',
    '<a href="https://example.org">Link</a>',
    '<Counter label={document.cookie} />',
  ]) assert.throws(() => compileComponent("Unsafe", source(unsafe)), unsafe);
  assert.throws(() => compileComponent("Unsafe", "import React from 'react'; " + source("<p>Hi</p>")));
});

test("the model cannot use the render tool without opt-in or add capabilities", () => {
  const decision = (args: object) => JSON.stringify({ mode: "tool", call: { name: "ui.render", arguments: args } });
  assert.throws(() => parseDecision(decision({ brief: "Crie uma interface" }), 5));
  assert.throws(() => parseDecision(decision({ brief: "Crie uma interface", permissions: ["network"] }), 5, false, false, [], true));
  assert.equal(parseDecision(decision({ brief: "Crie uma interface", key: "teste" }), 5, false, false, [], true).mode, "tool");
});

test("typed delegation propagates context and rejects unauthorized calls, cycles and excess tasks", async () => {
  const registry = new AgentRegistry();
  const runtime = new AgentRuntime(registry);
  const first = new AgentOperation<string, string>("renderer", "render");
  const second = new AgentOperation<string, string>("dev", "author");
  const root = new AbortController();
  const context = { executionId: "execution", permissions: new Set(["render", "author"]),
    budgetLimit: 0, signal: root.signal, metadata: { session: "example" } };
  const events: AgentTaskEvent[] = [];
  const policy = { maxTasks: 3, trace: (event: AgentTaskEvent) => { events.push(event); } };
  for (const id of ["renderer", "dev"]) registry.register({ definition: { id, name: id, description: id, capabilities: [] } });
  registry.registerOperation(first, ["main", "dev"], async (input, ctx) => ctx.invoke(second, input));
  assert.deepEqual(registry.catalog("main", context.permissions).map(({ id, operations }) => ({ id, operations })),
    [{ id: "renderer", operations: ["render"] }]);
  registry.registerOperation(second, ["renderer"], async (input, ctx) => {
    assert.equal(ctx.executionId, context.executionId);
    assert.equal(ctx.metadata.session, "example");
    assert.equal(ctx.budgetLimit, 0);
    if (input === "cycle") return ctx.invoke(first, input);
    if (input === "cancel") root.abort();
    return input.toUpperCase();
  });
  assert.deepEqual(registry.catalog("main", context.permissions).map(({ id }) => id), ["renderer"]);
  assert.deepEqual(registry.catalog("renderer", context.permissions).map(({ id }) => id), ["dev"]);
  assert.equal(await runtime.invoke("main", first, "hello", context, policy), "HELLO");
  assert.deepEqual(events.map(({ status }) => status), ["running", "running", "completed", "completed"]);
  assert.equal(events[1]?.parentTaskId, events[0]?.taskId);
  await assert.rejects(runtime.invoke("main", second, "hello", context, policy), /permissão/);
  await assert.rejects(runtime.invoke("main", first, "hello", { ...context, permissions: new Set(["render"]) }, policy), /permissão/);
  await assert.rejects(runtime.invoke("main", first, "cycle", context, policy), /ciclo/);
  await assert.rejects(runtime.invoke("main", first, "hello", context, { maxTasks: 1 }), /limite/);
  await assert.rejects(runtime.invoke("main", first, "cancel", context, policy), { name: "AbortError" });
  assert.deepEqual(events.slice(-2).map(({ status }) => status), ["cancelled", "cancelled"]);
});

test("MainAgent delivers a versioned React window after DevAgent repairs it and reuses it by key", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "void-component-"));
  const filename = join(dir, "void.sqlite");
  const authorPrompts: string[] = [];
  const mock: ModelProvider = {
    id: "component-test",
    async generate({ model, messages }) {
      const input = messages.at(-1)?.content ?? "";
      if (messages[0]?.content.startsWith("VOID_UI_AUTHOR")) {
        authorPrompts.push(input);
        const code = authorPrompts.length === 1 ? source("<p>{process.env.SECRET}</p>") :
          source(authorPrompts.length === 2 ? '<section><Counter label="Expedições" /></section>' :
            '<section><Counter label="Expedições" /><Toggle label="Revisado" /></section>');
        return { model, content: JSON.stringify({ title: "Expedições", source: code }) };
      }
      return { model, content: JSON.stringify({ mode: "tool", call: { name: "ui.render",
        arguments: { brief: input, key: "expedicoes", ...(input.includes("atualize") ? { revise: true } : {}) } } }) };
    },
  };
  const app = createWebRuntime({ filename, mock });
  t.after(() => { app.close(); rmSync(dir, { recursive: true, force: true }); });
  const sessionId = "expedicoes-test";
  app.conversations.createSession(sessionId);

  const submit = async (message: string, calls = 5) => {
    const events: MainMessage[] = [];
    const result = await app.main.run({
      sessionId, message, limits: { calls },
      context: { executionId: sessionId, permissions: app.permissions, budgetLimit: 0,
        signal: new AbortController().signal, metadata: {} },
    }, (event) => { events.push(event); });
    return { result, events };
  };
  const initial = await submit("Crie uma interface para contar expedições");
  assert.equal(initial.result.kind, "direct");
  const first = initial.events.find((event) => event.type === "ui")?.action;
  assert.equal(first?.type, "open_component");
  if (first?.type !== "open_component") return;
  assert.equal(first.window.component.version, 1);
  assert.equal(authorPrompts.length, 2);
  assert.match(authorPrompts[1] ?? "", /diagnostic/);
  assert.equal(app.conversations.turns(sessionId).at(-1)?.ui, 1);

  const reused = await submit("Reabra a interface de expedições", 1);
  assert.deepEqual(reused.events.find((event) => event.type === "ui")?.action, first);
  assert.equal(authorPrompts.length, 2);

  const denied = await submit("Por favor, atualize a interface", 1);
  assert.equal(denied.result.kind, "error");
  assert.equal(denied.events.find((event) => event.type === "error")?.failure.category, "budget_exceeded");
  assert.equal(authorPrompts.length, 2);

  const revised = await submit("Por favor, atualize a interface de expedições com uma lista");
  const revision = revised.events.find((event) => event.type === "ui")?.action;
  assert.equal(revision?.type, "open_component");
  if (revision?.type !== "open_component") return;
  assert.equal(revision.window.component.id, first.window.component.id);
  assert.equal(revision.window.component.version, 2);
  assert.match(authorPrompts[2] ?? "", /previousSource/);

  const reopened = new ComponentRegistry(filename);
  try {
    assert.equal(reopened.preview("other-session", first.window.component), undefined);
    assert.doesNotMatch(reopened.preview(sessionId, first.window.component)?.source ?? "", /Toggle/);
    assert.match(reopened.preview(sessionId, revision.window.component)?.source ?? "", /Toggle/);
  } finally { reopened.close(); }

  const db = openLocalDatabase(filename);
  try {
    const ancestry = db.prepare("SELECT child.agent_id, child.status, parent.agent_id AS parent FROM ui_agent_tasks child JOIN ui_agent_tasks parent ON parent.task_id = child.parent_task_id ORDER BY child.rowid").all();
    assert.equal(db.prepare("SELECT failure_category FROM ui_agent_tasks WHERE agent_id = 'dev-agent' AND status = 'failed'").get()?.failure_category, "budget_exceeded");
    assert.deepEqual(ancestry.map((row) => ({ ...row })), [
      { agent_id: "dev-agent", status: "completed", parent: "agent-renderer" },
      { agent_id: "dev-agent", status: "failed", parent: "agent-renderer" },
      { agent_id: "dev-agent", status: "completed", parent: "agent-renderer" },
    ]);
  } finally { db.close(); }
});

test("a visual request recovers once at each truncated stage within its call and token budgets", async (t) => {
  const requests: { system: string; prompt: string; cap?: number }[] = [];
  const mock: ModelProvider = {
    id: "truncation-test",
    async generate({ model, messages, maxOutputTokens }) {
      const system = messages[0]?.content ?? "";
      const prompt = messages.at(-1)?.content ?? "";
      requests.push({ system, prompt, ...(maxOutputTokens === undefined ? {} : { cap: maxOutputTokens }) });
      if (requests.length === 1 || requests.length === 3) {
        const error = new ExecutionError({ category: "incomplete", retryable: false,
          message: "Truncated", ...(requests.length === 1 ? { finishReason: "length" } : { code: "max_tokens_exceeded" }) });
        error.usage = { inputTokens: 100, outputTokens: 100 };
        throw error;
      }
      const content = system.startsWith("VOID_UI_AUTHOR")
        ? { title: "Contador", source: source('<section><Counter label="Contador" /></section>') }
        : { mode: "tool", call: { name: "ui.render", arguments: { brief: prompt, key: "contador" } } };
      return { model, content: JSON.stringify(content), usage: { inputTokens: 100, outputTokens: 100 } };
    },
  };
  const app = createWebRuntime({ filename: ":memory:", mock });
  t.after(() => app.close());
  const sessionId = "compact";
  app.conversations.createSession(sessionId);
  const run = async (message: string, calls: number) => {
    const events: MainMessage[] = [];
    const result = await app.main.run({ sessionId, message, limits: { calls, outputTokens: 900 },
      context: { executionId: sessionId, permissions: app.permissions, budgetLimit: 0,
        signal: new AbortController().signal, metadata: {} },
    }, (event) => { events.push(event); });
    return { result, events };
  };

  const inventory = await run("Quais agentes estão disponíveis?", 1);
  assert.match(inventory.events.find(({ type }) => type === "final")?.text ?? "", /AgentRenderer/);
  assert.equal(requests.length, 0);

  const creation = await run("Crie uma janela com contador", 4);
  assert.equal(creation.result.kind, "direct");
  assert.equal(creation.events.find((event) => event.type === "ui")?.action.type, "open_component");
  assert.match(requests[1]?.system ?? "", /compact JSON/);
  assert.match(requests[3]?.prompt ?? "", /previous output was truncated/);
  assert.deepEqual(requests.map(({ cap }) => cap), [900, 768, 700, 600]);

  requests.length = 0;
  const exhausted = await run("Crie uma janela com contador", 2);
  assert.equal(exhausted.events.find((event) => event.type === "error")?.failure.finishReason, "length");
  assert.equal(requests.length, 1);
});
