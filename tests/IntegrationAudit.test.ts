import assert from "node:assert/strict";
import { test } from "node:test";
import type { MainMessage } from "../src/agents/MainAgent.js";
import type { ModelProvider } from "../src/types/model.js";
import { createWebRuntime } from "../src/web/runtime.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import { AgentRegistry } from "../src/runtime/AgentRegistry.js";
import { AgentOperation } from "../src/runtime/AgentOperation.js";
import { isLocalUiToolCall } from "../src/web/ui-contracts.js";

// These fixtures test wiring, not a live model's linguistic competence.
const intents = new Map<string, object>([
  ["Abra configurações.", { name: "ui.openWindow", arguments: { component: "settings" } }],
  ["Modo workspace.", { name: "ui.switchMode", arguments: { mode: "workspace" } }],
  ["Abra a configuração.", { name: "ui.openWindow", arguments: { component: "settings" } }],
  ["Quero acessar meus ajustes.", { name: "ui.openWindow", arguments: { component: "settings" } }],
  ["Quero voltar à interface principal.", { name: "ui.switchMode", arguments: { mode: "workspace" } }],
  ["Prefiro só aquele anel no centro.", { name: "ui.switchMode", arguments: { mode: "focus" } }],
  ["Deixe a disposição inicial novamente.", { name: "ui.resetLayout", arguments: {} }],
  ["Preciso contar as entregas por aqui.", { name: "ui.render", arguments: { brief: "Contador de entregas", key: "entregas" } }],
]);

test("semantic fixtures reach real registered tools without vocabulary gates", async (t) => {
  const prompts: string[] = [];
  let authors = 0;
  const mock: ModelProvider = { id: "audit", async generate({ model, messages }) {
    const system = messages[0]?.content ?? "";
    if (system.startsWith("VOID_UI_DESIGN")) return { model, content: JSON.stringify({
      kind: "author", key: "entregas", brief: "Contador de entregas", review: false,
    }) };
    if (system.startsWith("VOID_UI_AUTHOR")) { authors++; return { model, content: JSON.stringify({ title: "Entregas",
      source: 'export default function Component() { return (<section><Counter label="Entregas" /></section>); }' }) }; }
    prompts.push(system);
    const input = messages.at(-1)?.content ?? "";
    return { model, content: JSON.stringify(intents.has(input) ? { mode: "tool", call: intents.get(input) }
      : { mode: "direct", response: "AgentRenderer abre janelas, reutiliza componentes e delega ao DevAgent." }) };
  } };
  const app = createWebRuntime({ filename: ":memory:", mock });
  t.after(() => app.close());
  app.conversations.createSession("audit");
  async function run(message: string, permissions = app.permissions) {
    const events: MainMessage[] = [];
    await app.main.run({ sessionId: "audit", message, context: { executionId: "audit", permissions,
      signal: new AbortController().signal, budgetLimit: 0, metadata: {} } }, (event) => { events.push(event); });
    return events;
  }
  const expected = ["open_panel", "switch_mode", "open_panel", "open_panel", "switch_mode", "switch_mode", "reset_layout", "open_component"];
  for (const [i, text] of [...intents.keys()].entries()) {
    const events = await run(text);
    assert.equal(events.find(e => e.type === "ui")?.action.type, expected[i], text);
    assert.equal(events.some(e => e.type === "error"), false, text);
  }
  const reopened = await run("Preciso contar as entregas por aqui.");
  assert.equal(reopened.find(e => e.type === "ui")?.action.type, "open_component");
  assert.equal(authors, 1, "saved component reused without another author call");
  assert.match(prompts.at(-1) ?? "", /"key":"entregas"/);
  for (const text of ["Não abra configurações.", "Como funcionam os ajustes?", "Se eu pedisse uma janela, seria possível?", "Abra aquela coisa."]) {
    const events = await run(text);
    assert.equal(events.some(e => e.type === "ui"), false);
  }
  for (const text of ["Abra configurações.", "Modo workspace."]) {
    const calls = prompts.length;
    assert.ok((await run(text)).some(e => e.type === "ui"));
    assert.equal(prompts.length, calls + 1, "even familiar phrases go through the decision model");
  }
  assert.match((await run("Quais agentes estão disponíveis?")).at(-1)?.text ?? "", /AgentRenderer/);
  await run("O que o AgentRenderer consegue fazer?");
  assert.match(prompts.at(-1) ?? "", /AgentRenderer/);
  assert.match(prompts.at(-1) ?? "", /ui.switchMode/);
  assert.match(prompts.at(-1) ?? "", /ui.render/);
  const denied = await run("Quero acessar meus ajustes.", new Set(["code-analysis"]));
  assert.equal(denied.find(e => e.type === "error")?.failure.category, "invalid_response");
  assert.equal(denied.some(e => e.type === "ui"), false);
  assert.doesNotMatch(prompts.at(-1) ?? "", /"name":"ui.openWindow"/);
});

test("tool discovery and execution follow operation ownership and caller permissions", async () => {
  const registry = new AgentRegistry();
  registry.register({ definition: { id: "new-agent", name: "New Agent", description: "New", capabilities: [] } });
  const tool = { name: "test.tool", description: "Only this operation", example: { name: "test.tool", arguments: {} }, accepts: () => true, prepare: () => ({}) };
  const operation = new AgentOperation<object, object>("new-agent", "new-capability", [tool]);
  assert.deepEqual(registry.toolCatalog("main-agent", new Set(["new-capability"])), []);
  registry.registerOperation(operation, ["main-agent"], async input => input);
  assert.deepEqual(registry.toolCatalog("main-agent", new Set(["new-capability"])), [tool]);
  assert.deepEqual(registry.toolCatalog("main-agent", new Set()), []);
  assert.deepEqual(registry.toolCatalog("other", new Set(["new-capability"])), []);
  const runtime = new AgentRuntime(registry);
  const context = { executionId: "new-agent-test", permissions: new Set(["new-capability"]), budgetLimit: 0,
    signal: new AbortController().signal, metadata: {} };
  const resources = { sessionId: "test", generate: async () => { throw new Error("No model needed"); } };
  assert.deepEqual(await runtime.invokeTool("main-agent", tool.example, resources, context, { maxTasks: 1 }), {});
  await assert.rejects(runtime.invokeTool("other", tool.example, resources, context, { maxTasks: 1 }), /indisponível/);
  await assert.rejects(runtime.invokeTool("main-agent", tool.example, resources, { ...context, permissions: new Set() }, { maxTasks: 1 }), /indisponível/);
  const duplicate = new AgentOperation<object, object>("new-agent", "other-capability", [tool]);
  assert.throws(() => registry.registerOperation(duplicate, ["main-agent"], async input => input), /already registered/);
});

test("layout contracts reject unknown modes, extra fields and privileged operations", () => {
  for (const call of [
    { name: "ui.switchMode", arguments: { mode: "shell" } },
    { name: "ui.switchMode", arguments: { mode: "focus", script: "bad" } },
    { name: "ui.resetLayout", arguments: { deleteHistory: true } },
    { name: "ui.shell", arguments: {} },
  ]) assert.equal(isLocalUiToolCall(call), false);
});

for (const scenario of ["invalid", "author-failure", "budget", "permission", "cancel"] as const) {
  test("render failure is explicit and persists no component: " + scenario, async (t) => {
    let authors = 0;
    const controller = new AbortController();
    const mock: ModelProvider = { id: "audit-failure", async generate({ model, messages }) {
      if (messages[0]?.content.startsWith("VOID_UI_DESIGN")) return { model, content: JSON.stringify({
        kind: "author", key: "failed-counter", brief: "Contador", review: false,
      }) };
      if (messages[0]?.content.startsWith("VOID_UI_AUTHOR")) {
        authors++;
        if (scenario === "author-failure") throw new Error("Provider unavailable");
        if (scenario === "cancel") controller.abort();
        return { model, content: JSON.stringify({ title: "Invalid", source: "export default function ( {" }) };
      }
      return { model, content: JSON.stringify({ mode: "tool", call: { name: "ui.render",
        arguments: { brief: "Contador", key: "failed-counter" } } }) };
    } };
    const app = createWebRuntime({ filename: ":memory:", mock });
    t.after(() => app.close());
    app.conversations.createSession("failure");
    const permissions = new Set(app.permissions);
    if (scenario === "permission") permissions.delete("ui-author");
    const events: MainMessage[] = [];
    const result = await app.main.run({ sessionId: "failure", message: "Crie uma janela com contador interativo.",
      limits: { calls: scenario === "budget" ? 1 : 4 }, context: { executionId: "failure", permissions,
        budgetLimit: 0, signal: controller.signal, metadata: {} } }, event => { events.push(event); });
    assert.equal(result.kind, "error");
    assert.equal(events.some(e => e.type === "ui"), false);
    assert.deepEqual(app.components.catalog("failure"), []);
    const failure = events.find(e => e.type === "error")?.failure;
    assert.ok(failure);
    if (scenario === "invalid") { assert.equal(failure.code, "component_invalid"); assert.equal(authors, 2); }
    if (scenario === "budget") { assert.equal(failure.category, "budget_exceeded"); assert.equal(authors, 0); }
    if (scenario === "permission") { assert.equal(failure.category, "permission_denied"); assert.equal(authors, 0); }
    if (scenario === "cancel") assert.equal(failure.category, "cancelled");
  });
}

test("MainAgent discovers and executes a new nonvisual operation without a routing branch", async (t) => {
  const { MainAgent } = await import("../src/agents/MainAgent.js");
  const { ModelRouter } = await import("../src/models/ModelRouter.js");
  const { ExecutionGovernance } = await import("../src/governance/ExecutionGovernance.js");
  const { SQLiteCheckpointStore } = await import("../src/governance/CheckpointStore.js");
  const { SQLiteConversationStore } = await import("../src/conversation/ConversationStore.js");
  const registry = new AgentRegistry();
  registry.register({ definition: { id: "new-agent", name: "New Agent", description: "A test specialist",
    capabilities: ["greet"], model: { configKey: "NEW", fallback: "openrouter/free" } },
    async execute(task, context) {
      assert.equal(context.modelRoute?.model, "greeting-model");
      return { content: task.objective };
    },
  });
  const call = { name: "test.greet", arguments: {} };
  const operation = new AgentOperation<string, { response: string }>("new-agent", "greet", [{
    name: call.name, description: "Return a greeting", example: call,
    accepts: value => JSON.stringify(value) === JSON.stringify(call), prepare: () => "Hello",
  }]);
  registry.registerOperation(operation, ["main-agent"], async greeting => ({ response: greeting }));
  const runtime = new AgentRuntime(registry);
  const router = new ModelRouter([{ id: "audit", async generate({ model, messages }) {
    const system = messages[0]?.content ?? "";
    if (system.startsWith("VOID_SYNTHESIS")) {
      return { model, content: JSON.stringify({ answer: "Olá", sources: { greet: "Olá" } }) };
    }
    assert.match(system, /test.greet/);
    assert.match(system, /"id":"new-agent".*"planCapabilities":\["greet"\]/);
    const decision = messages.at(-1)?.content === "Use um especialista" ? { mode: "delegate",
      steps: [{ id: "greet", agentId: "new-agent", requiredCapability: "greet", objective: "Olá", dependsOn: [] }],
    } : { mode: "tool", call };
    return { model, content: JSON.stringify(decision) };
  } }]);
  const checkpoints = new SQLiteCheckpointStore(":memory:");
  const conversations = new SQLiteConversationStore(":memory:");
  t.after(() => { checkpoints.close(); conversations.close(); });
  const governance = new ExecutionGovernance(runtime, checkpoints, { trustedLocalProviders: ["audit"] });
  const main = new MainAgent(router, registry, governance, conversations, { providerId: "audit", model: "fixture",
    routesForEffort: () => ({
      decision: { providerId: "audit", model: "fixture" },
      synthesis: { providerId: "audit", model: "fixture" },
      "new-agent": { providerId: "audit", model: "greeting-model" },
    }),
    tool: (call, resources, context, maxTasks) => runtime.invokeTool("main-agent", call, resources, context, { maxTasks }),
  });
  const events: MainMessage[] = [];
  const result = await main.run({ sessionId: "new-tool", message: "Cumprimente-me", context: {
    executionId: "new-tool", permissions: new Set(["greet"]), budgetLimit: 0,
    signal: new AbortController().signal, metadata: {},
  } }, event => { events.push(event); });
  assert.equal(result.kind, "direct");
  assert.deepEqual(events, [{ type: "final", text: "Hello" }]);
  const planned = await main.run({ sessionId: "new-tool", message: "Use um especialista", context: {
    executionId: "new-tool", permissions: new Set(["greet"]), budgetLimit: 0,
    signal: new AbortController().signal, metadata: {},
  } }, event => { events.push(event); });
  assert.equal(planned.kind, "finished");
  if (planned.kind === "finished") {
    assert.equal(planned.checkpoint.status, "completed");
    assert.equal(planned.checkpoint.steps[0]?.output, "Olá");
  }
});

test("the browser bootstrap plans a dashboard through the Renderer and tracks Dev review corrections", async (t) => {
  const calls: string[] = [];
  let reviews = 0;
  let authors = 0;
  const mock: ModelProvider = {
    id: "cognitive-fixture",
    async generate({ model, messages }) {
      const system = messages[0]?.content ?? "";
      const prompt = messages.at(-1)?.content ?? "";
      calls.push(model);
      let decision: object;
      if (system.startsWith("VOID_DECISION")) {
        const catalog = JSON.parse(system.slice(system.indexOf("Authorized catalog: ") + "Authorized catalog: ".length)
          .split("\n\n")[0] ?? "[]") as { id: string; name: string; planCapabilities: string[] }[];
        const renderer = catalog.find(({ id }) => id === "agent-renderer");
        assert.deepEqual(renderer?.planCapabilities, ["ui-render"]);
        if (prompt === "Quais agentes você possui?") {
          decision = { mode: "direct", response: catalog.map(({ name, planCapabilities }) =>
            name + " (" + planCapabilities.join(", ") + ")").join("; ") };
        } else {
          decision = { mode: "delegate", steps: [{ id: "dashboard", agentId: renderer?.id, requiredCapability: "ui-render",
            objective: prompt, dependsOn: [] }] };
        }
      } else if (system.startsWith("VOID_UI_DESIGN")) {
        assert.match(prompt, /painel interativo de despesas/);
        decision = { kind: "author", key: "despesas", brief: "Total e campo para incluir um lançamento.", review: true };
      } else if (system.startsWith("VOID_UI_REVIEW")) {
        decision = ++reviews === 1 ? { kind: "revise", diagnostic: "Use um rótulo no campo." } : { kind: "accept" };
      } else {
        assert.match(system, /^VOID_UI_AUTHOR/);
        if (++authors > 1) assert.match(prompt, /Use um rótulo no campo/);
        decision = { title: "Despesas", source: `export default function Dashboard() {
          const [value, setValue] = React.useState("");
          return <label>Valor<input value={value} onChange={e => setValue(e.target.value)} /></label>;
        }` };
      }
      return { model, content: JSON.stringify(decision), usage: { inputTokens: 30, outputTokens: 20 } };
    },
  };
  const app = createWebRuntime({ filename: ":memory:", mock });
  t.after(() => app.close());
  const sessionId = "cognitive";
  app.conversations.createSession(sessionId);
  const run = async (message: string) => {
    const events: MainMessage[] = [];
    const result = await app.main.run({ sessionId, message, effort: "high",
      context: { executionId: sessionId, permissions: app.permissions, signal: new AbortController().signal,
        budgetLimit: 0, metadata: {} } }, event => { events.push(event); });
    return { result, events };
  };
  const inventory = await run("Quais agentes você possui?");
  const text = inventory.events.find(event => event.type === "final")?.text ?? "";
  for (const name of ["Dev Agent", "Research Agent", "AgentRenderer"]) assert.match(text, new RegExp(name));
  calls.length = 0;

  const { result, events } = await run("Crie um painel interativo de despesas.");
  assert.equal(result.kind, "finished");
  if (result.kind !== "finished") return;
  assert.equal(result.checkpoint.status, "completed");
  assert.equal(result.checkpoint.plan[0]?.agentId, "agent-renderer");
  assert.deepEqual(calls, ["main-local", "renderer-local", "dev-local", "renderer-local", "dev-local", "renderer-local"]);
  assert.deepEqual(result.checkpoint.servedModels?.map(({ role }) => role),
    ["decision", "agent-renderer", "dev-agent", "agent-renderer", "dev-agent", "agent-renderer"]);
  assert.equal(result.checkpoint.usage.callsStarted, calls.length);
  const ui = events.find(event => event.type === "ui");
  assert.equal(ui?.action.type, "open_component");
  assert.deepEqual(result.checkpoint.steps[0]?.action, ui?.action);
  assert.equal(app.components.catalog(sessionId)[0]?.version, 1, "only the reviewed artifact is published");
  assert.equal(app.conversations.turns(sessionId).at(-1)?.ui, 1);
});
