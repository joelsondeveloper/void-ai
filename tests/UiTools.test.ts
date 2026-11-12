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
  assert.deepEqual(open.properties.component.enum, ["settings", "usage", "sessions", "operations", "memory"]);
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
// the last session asked for the workspace three times and got no interface action; in a live run the model opened
// the sessions panel instead. A message that is nothing but an interface command is run by the host, with no model call.
test("a short imperative interface command is recognized by the host, and anything else is left to the model", () => {
  const cases: [string, string, object][] = [
    ["abre o workspace", "ui.switchMode", { mode: "workspace" }],
    ["Abra o Workspace.", "ui.switchMode", { mode: "workspace" }],
    ["VOID, abre o workspace por favor", "ui.switchMode", { mode: "workspace" }],
    ["vai pro workspace", "ui.switchMode", { mode: "workspace" }],
    ["modo workspace", "ui.switchMode", { mode: "workspace" }],
    ["workspace", "ui.switchMode", { mode: "workspace" }],
    ["volta pro focus", "ui.switchMode", { mode: "focus" }],
    ["volta pro anel", "ui.switchMode", { mode: "focus" }],
    ["modo focus", "ui.switchMode", { mode: "focus" }],
    ["abre as configurações", "ui.openWindow", { component: "settings" }],
    ["abre o painel de uso", "ui.openWindow", { component: "usage" }],
    ["mostrar uso", "ui.openWindow", { component: "usage" }],
    ["abra sessões", "ui.openWindow", { component: "sessions" }],
    ["mostre operações", "ui.openWindow", { component: "operations" }],
    ["abre a memória", "ui.openWindow", { component: "memory" }],
    ["fecha as configurações", "ui.closeWindow", { component: "settings" }],
    ["fecha o painel", "ui.closeWindow", { component: "current" }],
    ["fechar janela", "ui.closeWindow", { component: "current" }],
    ["restaura o layout", "ui.resetLayout", {}],
  ];
  for (const [message, name, args] of cases) assert.deepEqual(interfaceCommand(message), { name, arguments: args }, message);
  for (const message of ["o que é um workspace?", "pode abrir o workspace?", "como abre o workspace?", "não abre o workspace",
    "abre o workspace e me diz as horas", "se eu abrir o workspace o que acontece", "o workspace tá lento", "explica o modo workspace",
    "onde posso personalizar você?", "quero trabalhar com minhas conversas e sessões", "abre o arquivo de configurações do nginx",
    "foco", "anel", "uso", "abre", "fecha", "minha memória anda ruim", "abre o workspace?", "abre o painel da tela do painel de uso e limites",
    "por favor abre pra mim agora o painel de uso e limites", "abre o workspace " + "por favor ".repeat(10)]) {
    assert.equal(interfaceCommand(message), undefined, message);
  }
});

const opened = [
  { type: "ui", text: "Modo Workspace ativado.", action: { type: "switch_mode", mode: "workspace" } },
  { type: "final", text: "Modo Workspace ativado." }];

for (const mode of ["tools", "decision"] as const) {
  test(`[${mode}] "abre o workspace" reaches the interface with no model call, and is recorded as an interface turn`, async (t) => {
    const { ask, requests, conversations } = fixture(t, () => { throw new Error("the model must not be asked"); },
      { conversationMode: mode, shortcut: interfaceCommand });
    assert.deepEqual(await ask("abre o workspace"), opened);
    assert.deepEqual(await ask("abre a memória"), [
      { type: "ui", text: "Memória na tela.", action: { type: "open_panel", panel: "memory" } },
      { type: "final", text: "Memória na tela." }]);
    assert.deepEqual(await ask("fecha o painel"), [
      { type: "ui", text: "Painel dispensado.", action: { type: "close_current" } },
      { type: "final", text: "Painel dispensado." }]);
    assert.equal(requests.length, 0, "the model was never asked");
    // Recorded like every interface turn: in the store with the interface mark, out of the history the model reads.
    assert.deepEqual(conversations.turns("s").map(({ request, response, ui }) => [request, response, ui]), [
      ["abre o workspace", "Modo Workspace ativado.", 1], ["abre a memória", "Memória na tela.", 1], ["fecha o painel", "Painel dispensado.", 1]]);
    assert.deepEqual(conversations.history("s", 10), []);
  });
}

test("a sentence that is more than the command, or a channel without the operation, goes to the model", async (t) => {
  const { ask, requests } = fixture(t, () => ({ content: "O workspace é a tela completa." }), { shortcut: interfaceCommand });
  assert.deepEqual(await ask("o que é o workspace?"), [{ type: "final", text: "O workspace é a tela completa." }]);
  // Without the permission the registry does not offer the operation, so the host has nothing to run on its own.
  assert.deepEqual(await ask("abre o workspace", new Set()), [{ type: "final", text: "O workspace é a tela completa." }]);
  assert.equal(requests.length, 2);
});

test("a recognized call the registry would not accept is not run: the message goes to the model, with no error", async (t) => {
  const { ask, requests } = fixture(t, () => ({ content: "Não sei abrir isso." }),
    { shortcut: () => ({ name: "ui.switchMode", arguments: { mode: "painel-secreto" } }) });
  assert.deepEqual(await ask("abre o painel secreto"), [{ type: "final", text: "Não sei abrir isso." }]);
  assert.equal(requests.length, 1);
});
