import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AgentRenderer } from "../src/agents/AgentRenderer.js";
import { DevAgent } from "../src/agents/DevAgent.js";
import { MainAgent, type MainAgentOptions, type MainMessage } from "../src/agents/MainAgent.js";
import { SQLiteConversationStore } from "../src/conversation/ConversationStore.js";
import { SQLiteCheckpointStore } from "../src/governance/CheckpointStore.js";
import { ExecutionGovernance } from "../src/governance/ExecutionGovernance.js";
import { ModelRouter } from "../src/models/ModelRouter.js";
import { AgentRegistry } from "../src/runtime/AgentRegistry.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import type { ModelRequest, ModelToolCall } from "../src/types/model.js";
import { ComponentRegistry } from "../src/web/ComponentRegistry.js";
import { interfaceCommand } from "../src/web/ui-intents.js";
import { UiRuntimeService } from "../src/web/ui-runtime.js";

const providerId = "test-local";
const call = (name: string, args: unknown, id = "call_1"): ModelToolCall => ({ id, name, arguments: JSON.stringify(args) });

// The real registry wiring of the web runtime (renderer, UI service, operations), with a scripted model.
type Scripted = { content?: string; toolCalls?: ModelToolCall[] };
function fixture(t: TestContext, handle: (request: ModelRequest) => Scripted | Promise<Scripted>,
  overrides: Partial<MainAgentOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "void-ui-"));
  const filename = join(directory, "chat.sqlite");
  const requests: ModelRequest[] = [];
  const checkpoints = new SQLiteCheckpointStore(filename);
  const conversations = new SQLiteConversationStore(filename);
  const components = new ComponentRegistry(filename);
  t.after(() => { checkpoints.close(); conversations.close(); components.close(); rmSync(filename, { force: true }); rmdirSync(directory); });
  const router = new ModelRouter([{ id: providerId, async generate(request) {
    requests.push(request);
    const { content = "", toolCalls } = await handle(request);
    return { model: request.model, content, ...(toolCalls ? { toolCalls } : {}), usage: { inputTokens: 2, outputTokens: 1 } };
  } }]);
  const defaults = { providerId, model: "main" };
  const registry = new AgentRegistry();
  const dev = new DevAgent(router, defaults);
  registry.register(dev);
  dev.registerUiAuthor(registry);
  const renderer = new AgentRenderer(router, components, new UiRuntimeService(), defaults);
  registry.register(renderer);
  renderer.register(registry);
  const runtime = new AgentRuntime(registry);
  const governance = new ExecutionGovernance(runtime, checkpoints, { trustedLocalProviders: [providerId] });
  const main = new MainAgent(router, registry, governance, conversations, { ...defaults, conversationMode: "tools",
    specialist: (task, context, max) => runtime.execute(task, context, max),
    tool: (value, resources, context, maxTasks) => runtime.invokeTool("main-agent", value, resources, context, { maxTasks }),
    ...overrides });
  const permissions = registry.capabilities();
  const ask = async (message: string, allowed: ReadonlySet<string> = permissions) => {
    const messages: MainMessage[] = [];
    await main.run({ sessionId: "s", message, context: { executionId: "s", signal: new AbortController().signal,
      permissions: allowed, budgetLimit: 0, metadata: {} } }, (m) => { messages.push(m); });
    return messages;
  };
  return { ask, requests, conversations };
}

const hasResult = (request: ModelRequest) => request.messages.some(({ role }) => role === "tool");
const last = (request: ModelRequest) => request.messages.at(-1)?.content ?? "";

test("the interface tools carry real schemas, so the model knows which arguments to send", async (t) => {
  const { ask, requests } = fixture(t, () => ({ content: "Oi." }));
  await ask("oi");
  const specs = new Map((requests[0]?.tools ?? []).map((tool) => [tool.name, tool]));
  const mode = specs.get("ui_switchMode");
  assert.ok(mode, "ui_switchMode must be offered");
  assert.deepEqual({ ...mode.parameters, properties: undefined }, { type: "object", additionalProperties: false,
    required: ["mode"], properties: undefined });
  assert.deepEqual((mode.parameters.properties as { mode: { enum: string[] } }).mode.enum, ["workspace", "focus"]);
  assert.match(mode.description, /workspace/i);
  assert.match(mode.description, /conversa, sessões, configurações e painel de uso/);
  const open = specs.get("ui_openWindow")?.parameters as { properties: { component: { enum: string[] } } };
  assert.deepEqual(open.properties.component.enum, ["settings", "usage", "sessions", "operations"]);
  assert.match(requests[0]?.messages[0]?.content ?? "", /Você controla esta interface/);
});

test("asking to open the workspace calls the tool and reaches the interface as a switch_mode action", async (t) => {
  const { ask } = fixture(t, (request) => hasResult(request)
    ? { content: "Workspace aberto." } : { toolCalls: [call("ui_switchMode", { mode: "workspace" })] });
  const messages = await ask("abre o workspace");
  assert.deepEqual(messages.filter(({ type }) => type === "ui" || type === "final"), [
    { type: "ui", text: "Modo Workspace ativado.", action: { type: "switch_mode", mode: "workspace" } },
    { type: "final", text: "Workspace aberto." }]);
});

test("a call with the wrong arguments gets an error with the example, and the corrected retry opens the panel", async (t) => {
  let step = 0;
  const { ask, requests } = fixture(t, (request) => {
    if (!hasResult(request)) return { toolCalls: [call("ui_openWindow", {})] };
    if (step++ === 0) return { toolCalls: [call("ui_openWindow", { component: "usage" }, "call_2")] };
    return { content: "Painel de uso aberto." };
  });
  const messages = await ask("mostra o painel de uso");
  assert.match(last(requests[1]!), /^Erro: Argumentos inválidos\. Exemplo: \{"component":"settings"\}/);
  assert.deepEqual(messages.filter(({ type }) => type === "ui"), [
    { type: "ui", text: "Uso e limites na tela.", action: { type: "open_panel", panel: "usage" } }]);
});

test("the prompt has no interface paragraph when no interface tool is offered", async () => {
  const { chatSystemPrompt } = await import("../src/conversation/persona.js");
  assert.doesNotMatch(chatSystemPrompt(undefined, { voice: false, tools: ["ask_dev"] }), /controla esta interface/);
  assert.match(chatSystemPrompt(undefined, { voice: false, tools: ["ask_dev", "ui_switchMode"] }), /nunca afirme sucesso depois de um erro/);
});

// Opening the main interface must not depend on a free model emitting a well-formed tool call. In the real database
// the last session asked for the workspace three times and got no interface action: the model answered in text, once
// claiming it had opened it. The model is still asked first; the host runs the command when the turn would end without it.
test("a plain interface command is recognized by the host, and anything else is left to the model", () => {
  const cases: [string, string, object][] = [
    ["abre o workspace", "ui.switchMode", { mode: "workspace" }],
    ["Abra o Workspace.", "ui.switchMode", { mode: "workspace" }],
    ["VOID, abre o workspace por favor", "ui.switchMode", { mode: "workspace" }],
    ["pode abrir o workspace?", "ui.switchMode", { mode: "workspace" }],
    ["modo workspace", "ui.switchMode", { mode: "workspace" }],
    ["workspace", "ui.switchMode", { mode: "workspace" }],
    ["volta pro anel", "ui.switchMode", { mode: "focus" }],
    ["voltar ao focus", "ui.switchMode", { mode: "focus" }],
    ["abre as configurações", "ui.openWindow", { component: "settings" }],
    ["mostra o painel de uso", "ui.openWindow", { component: "usage" }],
    ["abra sessões", "ui.openWindow", { component: "sessions" }],
    ["mostre operações", "ui.openWindow", { component: "operations" }],
    ["fecha as configurações", "ui.closeWindow", { component: "settings" }],
    ["restaure o layout", "ui.resetLayout", {}],
  ];
  for (const [message, name, args] of cases) assert.deepEqual(interfaceCommand(message), { name, arguments: args }, message);
  for (const message of ["não abre o workspace", "como abre o workspace?", "o que é o workspace?", "abre o workspace e me diz as horas",
    "se eu abrir o workspace o que acontece", "o workspace tá lento", "explica o modo workspace", "onde posso personalizar você?",
    "quero trabalhar com minhas conversas e sessões", "abre o arquivo de configurações do nginx", "foco", "anel", "uso", "abre",
    "abre o workspace " + "por favor ".repeat(10)]) {
    assert.equal(interfaceCommand(message), undefined, message);
  }
});

const opened = [
  { type: "ui", text: "Modo Workspace ativado.", action: { type: "switch_mode", mode: "workspace" } },
  { type: "final", text: "Modo Workspace ativado." }];

for (const mode of ["tools", "decision"] as const) {
  const say = (text: string) => ({ content: mode === "decision" ? JSON.stringify({ mode: "direct", response: text }) : text });
  const failures: [string, () => { content: string }][] = [
    ["refuses", () => say("Não consigo abrir a interface por aqui.")],
    ["claims it opened without calling anything", () => say("Workspace aberto.")],
    ["answers something that is not even valid", () => ({ content: mode === "decision" ? "isto não é JSON" : "…" })],
    ["cannot be reached", () => { throw new Error("429"); }],
  ];
  for (const [what, reply] of failures) {
    test(`[${mode}] "abre o workspace" reaches the interface when the model ${what}`, async (t) => {
      const { ask, requests, conversations } = fixture(t, reply, { conversationMode: mode, shortcut: interfaceCommand });
      assert.deepEqual(await ask("abre o workspace"), opened);
      assert.equal(requests.length, 1, "the model was asked first, once");
      // Interface turns stay out of the conversation the model sees later.
      assert.deepEqual(conversations.history("s", 10), []);
    });
  }
}

test("when the model does act, the host adds nothing to the turn", async (t) => {
  const { ask, requests } = fixture(t, (request) => hasResult(request)
    ? { content: "Workspace aberto." } : { toolCalls: [call("ui_switchMode", { mode: "workspace" })] }, { shortcut: interfaceCommand });
  assert.deepEqual(await ask("abre o workspace"), [
    { type: "ui", text: "Modo Workspace ativado.", action: { type: "switch_mode", mode: "workspace" } },
    { type: "final", text: "Workspace aberto." }]);
  assert.equal(requests.length, 2);
});

test("a sentence that is more than the command, or a channel without the operation, gets only what the model answers", async (t) => {
  const { ask, requests } = fixture(t, () => ({ content: "O workspace é a tela completa." }), { shortcut: interfaceCommand });
  assert.deepEqual(await ask("o que é o workspace?"), [{ type: "final", text: "O workspace é a tela completa." }]);
  // Without the permission the registry does not offer the operation, so the host has nothing to run on its own.
  assert.deepEqual(await ask("abre o workspace", new Set()), [{ type: "final", text: "O workspace é a tela completa." }]);
  assert.equal(requests.length, 2);
});

test("a recognized call the registry would not accept changes nothing: the model's answer stands, with no error", async (t) => {
  const { ask, requests } = fixture(t, () => ({ content: "Não sei abrir isso." }),
    { shortcut: () => ({ name: "ui.switchMode", arguments: { mode: "painel-secreto" } }) });
  assert.deepEqual(await ask("abre o painel secreto"), [{ type: "final", text: "Não sei abrir isso." }]);
  assert.equal(requests.length, 1);
});

// Seen with the real conversation model: "abre o workspace" was answered by opening the sessions panel.
for (const mode of ["tools", "decision"] as const) {
  test(`[${mode}] "abre o workspace" opens the workspace even when the model opens something else`, async (t) => {
    const { ask } = fixture(t, (request) => mode === "decision"
      ? { content: JSON.stringify({ mode: "tool", call: { name: "ui.openWindow", arguments: { component: "sessions" } } }) }
      : hasResult(request) ? { content: "Aberto. O painel de sessões tá na tela agora." }
        : { toolCalls: [call("ui_openWindow", { component: "sessions" })] },
    { conversationMode: mode, shortcut: interfaceCommand });
    assert.deepEqual(await ask("abre o workspace"), opened);
  });
}

test("when the model opens the workspace and something more, only the action that was asked for reaches the interface", async (t) => {
  const { ask } = fixture(t, (request) => hasResult(request) ? { content: "Workspace aberto." }
    : { toolCalls: [call("ui_openWindow", { component: "sessions" }, "call_1"), call("ui_switchMode", { mode: "workspace" }, "call_2")] },
  { shortcut: interfaceCommand });
  assert.deepEqual(await ask("abre o workspace"), [opened[0], { type: "final", text: "Workspace aberto." }]);
});

// In a live run a free route took 29 s to answer "abre o workspace". The host does not wait that long for it.
test("a slow model does not hold a plain interface command: after a short wait the host opens it", { timeout: 5_000 }, async (t) => {
  // AbortSignal.timeout does not keep the process alive by itself; a server or a terminal does. Here a timer stands in.
  const alive = setTimeout(() => {}, 4_000);
  t.after(() => clearTimeout(alive));
  let abandoned = false;
  const never =(request: ModelRequest) => new Promise<Scripted>((_, reject) => {
    request.signal?.addEventListener("abort", () => { abandoned = true; reject(request.signal?.reason); });
  });
  const { ask, requests } = fixture(t, never, { shortcut: interfaceCommand, shortcutWaitMs: 40 });
  const startedAt = performance.now();
  assert.deepEqual(await ask("abre o workspace"), opened);
  assert.ok(performance.now() - startedAt < 2_000);
  assert.equal(requests.length, 1);
  assert.equal(abandoned, true, "the model call was cancelled, not left running");
});
