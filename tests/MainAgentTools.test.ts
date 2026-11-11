import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DevAgent } from "../src/agents/DevAgent.js";
import { MainAgent, type MainAgentOptions, type MainMessage } from "../src/agents/MainAgent.js";
import { ResearchAgent } from "../src/agents/ResearchAgent.js";
import { SQLiteConversationStore } from "../src/conversation/ConversationStore.js";
import { resolvePersona } from "../src/conversation/persona.js";
import { SQLiteCheckpointStore } from "../src/governance/CheckpointStore.js";
import { ExecutionGovernance } from "../src/governance/ExecutionGovernance.js";
import { ModelRouter } from "../src/models/ModelRouter.js";
import { AgentRegistry } from "../src/runtime/AgentRegistry.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import type { AgentContext } from "../src/types/context.js";
import { ExecutionError } from "../src/types/failure.js";
import type { ModelRequest, ModelToolCall } from "../src/types/model.js";

const providerId = "test-local";
const permissions = ["code-analysis", "comparative-analysis"];
const context = (allowed = permissions): AgentContext =>
  ({ executionId: "session", signal: new AbortController().signal, permissions: new Set(allowed), budgetLimit: 0, metadata: {} });

type Reply = string | { content?: string; toolCalls?: ModelToolCall[] };
const askDev = (task = "Revise esta função"): ModelToolCall =>
  ({ id: "call_1", name: "ask_dev", arguments: JSON.stringify({ task }) });
const hasToolResult = (request: ModelRequest) => request.messages.some(({ role }) => role === "tool");

function fixture(t: TestContext, handle: (request: ModelRequest) => Reply | Promise<Reply>,
  overrides: Partial<MainAgentOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "void-tools-"));
  const filename = join(directory, "chat.sqlite");
  const requests: ModelRequest[] = [];
  const checkpoints = new SQLiteCheckpointStore(filename);
  const conversations = new SQLiteConversationStore(filename);
  const router = new ModelRouter([{ id: providerId, async generate(request) {
    requests.push(request);
    const reply = await handle(request);
    const { content = "", toolCalls } = typeof reply === "string" ? { content: reply } : reply;
    return { model: request.model, content, ...(toolCalls ? { toolCalls } : {}), usage: { inputTokens: 2, outputTokens: 1 } };
  } }]);
  // Registered before constructing the agent, so a constructor that throws still cleans up.
  t.after(() => {
    checkpoints.close();
    conversations.close();
    rmSync(filename, { force: true });
    rmdirSync(directory);
  });
  const registry = new AgentRegistry();
  registry.register(new DevAgent(router, { providerId, model: "dev" }));
  registry.register(new ResearchAgent(router, { providerId, model: "research" }));
  const runtime = new AgentRuntime(registry);
  const governance = new ExecutionGovernance(runtime, checkpoints, { trustedLocalProviders: [providerId] });
  const main = new MainAgent(router, registry, governance, conversations, {
    providerId, model: "main", conversationMode: "tools",
    specialist: (task, agentContext, maxDelegations) => runtime.execute(task, agentContext, maxDelegations),
    ...overrides,
  });
  return { main, conversations, requests };
}

async function ask(main: MainAgent, message: string, extra: Partial<Parameters<MainAgent["run"]>[0]> = {}) {
  const messages: MainMessage[] = [];
  const result = await main.run({ sessionId: "s", message, context: context(), ...extra }, (m) => { messages.push(m); });
  return { result, messages };
}

test("a conversation turn is free text: no JSON envelope, the v2 voice, and the specialists offered as tools", async (t) => {
  const reply = "Bom dia. O que a gente resolve hoje?";
  const { main, conversations, requests } = fixture(t, () => reply);
  const { result, messages } = await ask(main, "bom dia");
  assert.equal(result.kind, "direct");
  assert.deepEqual(messages, [{ type: "final", text: reply }]);
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request?.responseFormat, undefined);
  assert.deepEqual(request?.tools?.map(({ name }) => name), ["ask_dev", "ask_research"]);
  assert.equal(request?.toolChoice, "auto");
  const system = request?.messages[0]?.content ?? "";
  assert.match(system, /^Você é o VOID: um parceiro de trabalho sênior/);
  assert.match(system, /Exemplos do tom/);
  assert.doesNotMatch(system, /VOID_DECISION|mode|JSON/);
  assert.deepEqual(conversations.history("s", 1).map(({ content }) => content), ["bom dia", reply]);
});

test("the model calls a specialist as a tool and answers in its own voice with the result", async (t) => {
  const final = "Teste o caso limite antes de mexer na função.";
  const { main, conversations, requests } = fixture(t, (request) => {
    if (request.model === "dev") return "Cheque o caso limite.";
    return hasToolResult(request) ? final : { toolCalls: [askDev()] };
  });
  const { result, messages } = await ask(main, "revisa essa função pra mim");
  assert.equal(result.kind, "direct");
  assert.deepEqual(messages, [{ type: "final", text: final }]);
  assert.deepEqual(requests.map(({ model }) => model), ["main", "dev", "main"]);
  assert.match(requests[1]?.messages.at(-1)?.content ?? "", /^Revise esta função$/);
  const followUp = requests[2]?.messages ?? [];
  assert.deepEqual(followUp.at(-2)?.toolCalls, [askDev()]);
  assert.deepEqual({ role: followUp.at(-1)?.role, id: followUp.at(-1)?.toolCallId, content: followUp.at(-1)?.content },
    { role: "tool", id: "call_1", content: "Cheque o caso limite." });
  assert.deepEqual(conversations.history("s", 1).map(({ content }) => content), ["revisa essa função pra mim", final]);
  assert.equal(main.pending("s").length, 0);
});

test("while streaming, the draft shows which specialist is being consulted", async (t) => {
  const { main } = fixture(t, (request) => {
    if (request.model === "dev") return "ok";
    return hasToolResult(request) ? "Pronto." : { toolCalls: [askDev()] };
  });
  const { messages } = await ask(main, "revisa", { stream: true });
  assert.deepEqual(messages.filter(({ type }) => type === "draft").map(({ text }) => text), ["Consultando Dev Agent…"]);
  assert.deepEqual(messages.at(-1), { type: "final", text: "Pronto." });
});

test("specialists the session may not use are not offered", async (t) => {
  const { main, requests } = fixture(t, () => "ok");
  await main.run({ sessionId: "s", message: "oi", context: context(["comparative-analysis"]) }, () => {});
  assert.deepEqual(requests[0]?.tools?.map(({ name }) => name), ["ask_research"]);
  const none = fixture(t, () => "ok");
  await none.main.run({ sessionId: "s", message: "oi", context: context([]) }, () => {});
  assert.equal(none.requests[0]?.tools, undefined);
  assert.match(none.requests[0]?.messages[0]?.content ?? "", /Nenhuma ferramenta está autorizada/);
});

test("a failing specialist reaches the model as an error result without leaking internals", async (t) => {
  const final = "O Dev Agent falhou, mas dá pra seguir sem ele.";
  const { main, requests } = fixture(t, (request) => {
    if (request.model === "dev") throw new Error("segredo: /home/joelson/.env");
    return hasToolResult(request) ? final : { toolCalls: [askDev()] };
  });
  const { result, messages } = await ask(main, "revisa");
  assert.equal(result.kind, "direct");
  assert.deepEqual(messages, [{ type: "final", text: final }]);
  const toolMessage = requests.at(-1)?.messages.at(-1);
  assert.equal(toolMessage?.role, "tool");
  assert.match(toolMessage?.content ?? "", /^Erro: /);
  assert.doesNotMatch(toolMessage?.content ?? "", /segredo|joelson/);
});

test("the per-turn call budget reserves the last call for the answer and disables tools on it", async (t) => {
  const { main, requests } = fixture(t, (request) =>
    request.toolChoice === "none" ? "Sem o especialista, minha leitura é esta." : { toolCalls: [askDev()] });
  const { result, messages } = await ask(main, "revisa", { limits: { calls: 2 } });
  assert.equal(result.kind, "direct");
  assert.deepEqual(messages, [{ type: "final", text: "Sem o especialista, minha leitura é esta." }]);
  // The specialist never ran: only the two conversation calls were made.
  assert.deepEqual(requests.map(({ model }) => model), ["main", "main"]);
  assert.deepEqual(requests.map(({ toolChoice }) => toolChoice), ["auto", "none"]);
  assert.match(requests[1]?.messages.at(-1)?.content ?? "", /^Erro: O limite de chamadas deste turno acabou/);
});

test("a model without tool support falls back to the strict-JSON coordinator", async (t) => {
  const { main, requests } = fixture(t, (request) => {
    if (request.tools) throw new ExecutionError({ category: "permission_denied", code: "tools_unsupported",
      message: "Sem suporte a ferramentas.", retryable: false });
    return JSON.stringify({ mode: "direct", response: "Resposta pelo caminho antigo." });
  });
  const { result, messages } = await ask(main, "oi");
  assert.equal(result.kind, "direct");
  assert.deepEqual(messages, [{ type: "final", text: "Resposta pelo caminho antigo." }]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.responseFormat, "json_object");
  assert.match(requests[1]?.messages[0]?.content ?? "", /^VOID_DECISION/);
});

test("other model failures are reported, not silently retried on the old path", async (t) => {
  const { main, requests } = fixture(t, () => { throw new ExecutionError({ category: "rate_limited",
    message: "Limite atingido.", retryable: true }); });
  const { result, messages } = await ask(main, "oi");
  assert.equal(result.kind, "error");
  assert.equal(messages.at(-1)?.type, "error");
  assert.equal(requests.length, 1);
});

test("a voice turn may be answered with the silence marker, which is neither shown nor remembered", async (t) => {
  const { main, conversations, requests } = fixture(t, () => "<ignore/>");
  const { result, messages } = await ask(main, "fala ao fundo", { source: "voice", stream: true });
  assert.equal(result.kind, "ignored");
  assert.deepEqual(messages, []);
  assert.match(requests[0]?.messages[0]?.content ?? "", /transcrição de fala[\s\S]*<ignore\/>/);
  assert.deepEqual(conversations.history("s", 1), []);
});

test("the silence marker is only described to the model on voice turns", async (t) => {
  const { main, requests } = fixture(t, () => "Oi.");
  await ask(main, "oi");
  assert.doesNotMatch(requests[0]?.messages[0]?.content ?? "", /<ignore\/>/);
});

test("earlier turns are sent as history, with a longer window than the JSON mode", async (t) => {
  const { main, requests } = fixture(t, (request) => `resposta ${request.messages.length}`);
  for (const message of ["um", "dois", "três"]) await ask(main, message);
  const roles = requests[2]?.messages.map(({ role }) => role);
  assert.deepEqual(roles, ["system", "user", "assistant", "user", "assistant", "user"]);
});

test("the persona can be switched off, leaving a neutral base prompt", async (t) => {
  const { main, requests } = fixture(t, () => "ok", { persona: "off" });
  await ask(main, "oi");
  const system = requests[0]?.messages[0]?.content ?? "";
  assert.match(system, /^Você é o VOID, um assistente conversacional/);
  assert.doesNotMatch(system, /Exemplos do tom/);
});

test("invalid mode and persona settings are rejected at construction", (t) => {
  assert.throws(() => fixture(t, () => "ok", { conversationMode: "stream" as never }), /VOID_CONVERSATION_MODE/);
  assert.throws(() => resolvePersona("void-v9"), /void-v1, void-v2 ou off/);
});

test("the default mode is unchanged: the strict-JSON coordinator, without tools", async (t) => {
  const { main, requests } = fixture(t, () => JSON.stringify({ mode: "direct", response: "Pelo coordenador." }),
    { conversationMode: "decision" });
  const { messages } = await ask(main, "oi");
  assert.deepEqual(messages, [{ type: "final", text: "Pelo coordenador." }]);
  assert.equal(requests[0]?.tools, undefined);
  assert.equal(requests[0]?.responseFormat, "json_object");
});
