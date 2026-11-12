import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { AgentRenderer } from "../src/agents/AgentRenderer.js";
import { DevAgent } from "../src/agents/DevAgent.js";
import { MainAgent, type MainMessage } from "../src/agents/MainAgent.js";
import { SQLiteConversationStore } from "../src/conversation/ConversationStore.js";
import { SQLiteCheckpointStore } from "../src/governance/CheckpointStore.js";
import { ExecutionGovernance } from "../src/governance/ExecutionGovernance.js";
import { ModelRouter } from "../src/models/ModelRouter.js";
import { AgentRegistry } from "../src/runtime/AgentRegistry.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import type { ModelRequest, ModelToolCall } from "../src/types/model.js";
import { ComponentRegistry } from "../src/web/ComponentRegistry.js";
import { UiRuntimeService } from "../src/web/ui-runtime.js";

const providerId = "test-local";
const call = (name: string, args: unknown, id = "call_1"): ModelToolCall => ({ id, name, arguments: JSON.stringify(args) });

// The real registry wiring of the web runtime (renderer, UI service, operations), with a scripted model.
function fixture(t: TestContext, handle: (request: ModelRequest) => { content?: string; toolCalls?: ModelToolCall[] }) {
  const directory = mkdtempSync(join(tmpdir(), "void-ui-"));
  const filename = join(directory, "chat.sqlite");
  const requests: ModelRequest[] = [];
  const checkpoints = new SQLiteCheckpointStore(filename);
  const conversations = new SQLiteConversationStore(filename);
  const components = new ComponentRegistry(filename);
  t.after(() => { checkpoints.close(); conversations.close(); components.close(); rmSync(filename, { force: true }); rmdirSync(directory); });
  const router = new ModelRouter([{ id: providerId, async generate(request) {
    requests.push(request);
    const { content = "", toolCalls } = handle(request);
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
    tool: (value, resources, context, maxTasks) => runtime.invokeTool("main-agent", value, resources, context, { maxTasks }) });
  const permissions = registry.capabilities();
  const ask = async (message: string) => {
    const messages: MainMessage[] = [];
    await main.run({ sessionId: "s", message, context: { executionId: "s", signal: new AbortController().signal,
      permissions, budgetLimit: 0, metadata: {} } }, (m) => { messages.push(m); });
    return messages;
  };
  return { ask, requests };
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
