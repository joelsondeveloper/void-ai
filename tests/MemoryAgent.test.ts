/**
 * The memory agent (via 2): one short separate model call after a turn proposes what the memory keeps. These tests
 * use a fake model for it and check that every proposal goes through the same validation as the memory tools.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DevAgent } from "../src/agents/DevAgent.js";
import { MainAgent, type MainAgentOptions, type MainMessage, type MainRequest } from "../src/agents/MainAgent.js";
import { SQLiteConversationStore } from "../src/conversation/ConversationStore.js";
import { claimsInterfaceChange, claimsMemoryChange, honesty, honestReply } from "../src/conversation/honesty.js";
import { parseMemoryOps } from "../src/conversation/memoryAgent.js";
import { SQLiteMemoryStore, type MemoryStore } from "../src/conversation/MemoryStore.js";
import { SQLiteCheckpointStore } from "../src/governance/CheckpointStore.js";
import { ExecutionGovernance } from "../src/governance/ExecutionGovernance.js";
import { ModelRouter } from "../src/models/ModelRouter.js";
import { AgentRegistry } from "../src/runtime/AgentRegistry.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import type { ModelRequest, ModelToolCall } from "../src/types/model.js";
import { tempDirectory } from "./support/sqliteTemp.js";

const providerId = "test-local";
type Reply = string | { content?: string; toolCalls?: ModelToolCall[] };
const system = (request: ModelRequest | undefined) => request?.messages[0]?.content ?? "";
const isSummary = (request: ModelRequest) => system(request).startsWith("VOID_SUMMARY");
const isMemory = (request: ModelRequest) => system(request).startsWith("VOID_MEMORY");
const file = () => join(tempDirectory("void-memory-agent-"), "chat.sqlite");
const stored = (memory: MemoryStore) => memory.list().filter(({ kind }) => kind !== "summary").map(({ kind, origin, text }) => [kind, origin, text]);
const ops = (...items: object[]) => JSON.stringify(items);
/** What the agent was told, parsed from its user message. */
const payload = (request: ModelRequest) => JSON.parse(request.messages[1]?.content ?? "{}") as
  { mensagens_do_usuario: string[]; registros: { id: string; kind: string; text: string }[]; gravado_neste_turno: string[] };

function setup(t: TestContext, chat: (request: ModelRequest) => Reply | Promise<Reply>,
  memoryModel: (request: ModelRequest) => string | Promise<string>, overrides: Partial<MainAgentOptions> = {}, filename = file()) {
  const memory = new SQLiteMemoryStore(filename);
  const checkpoints = new SQLiteCheckpointStore(filename);
  const conversations = new SQLiteConversationStore(filename);
  t.after(() => { checkpoints.close(); conversations.close(); memory.close(); });
  const requests: ModelRequest[] = [];
  const router = new ModelRouter([{ id: providerId, async generate(request) {
    requests.push(request);
    const reply = isSummary(request) ? "Resumo da sessão." : isMemory(request) ? await memoryModel(request) : await chat(request);
    const { content = "", toolCalls } = typeof reply === "string" ? { content: reply } : reply;
    return { model: request.model, content, ...(toolCalls ? { toolCalls } : {}), usage: { inputTokens: 2, outputTokens: 1 } };
  } }]);
  const registry = new AgentRegistry();
  registry.register(new DevAgent(router, { providerId, model: "dev" }));
  const runtime = new AgentRuntime(registry);
  const governance = new ExecutionGovernance(runtime, checkpoints, { trustedLocalProviders: [providerId] });
  const main = new MainAgent(router, registry, governance, conversations, { providerId, model: "main", conversationMode: "tools",
    memory, memoryAgent: true, specialist: (task, context, max) => runtime.execute(task, context, max), ...overrides });
  const ask = async (message: string, extra: Partial<MainRequest> = {}) => {
    const messages: MainMessage[] = [];
    const result = await main.run({ sessionId: "s", message, context: { executionId: "s", signal: new AbortController().signal,
      permissions: new Set(["code-analysis"]), budgetLimit: 0, metadata: {} }, ...extra }, (m) => { messages.push(m); });
    return { result, messages };
  };
  return { ask, main, memory, requests, memoryCalls: () => requests.filter(isMemory) };
}

test("the reply is not held by the agent: it runs after the turn, and what it saved is told to the user", async (t) => {
  const { ask, main, memory, memoryCalls } = setup(t, () => "Dia puxado, hein?",
    () => ops({ op: "add", kind: "profile", text: "O usuário trabalha na Florarte." }));
  const { messages } = await ask("trabalho na Florarte, mas hoje tô cansado");
  // At this point the turn has answered; the capture may still be running.
  assert.equal(messages.find(({ type }) => type === "final")?.text, "Dia puxado, hein?");
  await main.settled();
  assert.deepEqual(stored(memory), [["profile", "extracted", "O usuário trabalha na Florarte."]]);
  assert.deepEqual(messages.filter(({ type }) => type === "memory"), [{ type: "memory", text: "Memória: salvei “O usuário trabalha na Florarte.”." }]);
  // One call, with no response_format, a small cap, the "memory" prompt, and only the user's words as the source.
  const [call] = memoryCalls();
  assert.equal(memoryCalls().length, 1);
  assert.equal(call?.responseFormat, undefined);
  assert.ok((call?.maxOutputTokens ?? Infinity) <= 300);
  assert.deepEqual(payload(call!).mensagens_do_usuario, ["trabalho na Florarte, mas hoje tô cansado"]);
  assert.doesNotMatch(call?.messages[1]?.content ?? "", /Dia puxado/, "the assistant's text is never a source");
});

test("the next turn of the same session waits for the pending capture, so it never asks before writing", async (t) => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const prompts: string[] = [];
  const { ask, memory } = setup(t, (request) => { prompts.push(system(request)); return "ok"; }, async () => {
    await gate;
    return ops({ op: "add", kind: "profile", text: "O usuário mora em Recife." });
  });
  await ask("moro em Recife");
  const next = ask("onde eu moro?");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(prompts.length, 1, "the second turn has not called the model yet");
  release();
  await next;
  assert.match(prompts[1] ?? "", /- O usuário mora em Recife\./);
  assert.equal(stored(memory).length, 1);
});

test("a changed fact is an update of the old record, never a second one; forget needs the user to ask", async (t) => {
  let reply = "";
  const { ask, main, memory } = setup(t, () => "Certo.", () => reply);
  memory.add({ kind: "profile", text: "O usuário mora em Recife." });
  const id = memory.list()[0]!.id;
  // An "add" of something close to a stored record replaces it.
  reply = ops({ op: "add", kind: "profile", text: "O usuário mora em Olinda." });
  await ask("me mudei, moro em Olinda");
  await main.settled();
  assert.deepEqual(memory.list().map((record) => [record.id, record.text]), [[id, "O usuário mora em Olinda."]]);
  // An explicit update works too.
  reply = ops({ op: "update", targetId: id, text: "O usuário mora em Olinda, perto do mar." });
  await ask("moro em Olinda, perto do mar");
  await main.settled();
  assert.equal(memory.get(id)?.text, "O usuário mora em Olinda, perto do mar.");
  // A forget the user did not ask for is refused.
  reply = ops({ op: "forget", targetId: id });
  await ask("bom dia");
  await main.settled();
  assert.equal(memory.count(), 1);
  // Asked for, it goes.
  const { messages } = await ask("esquece onde eu moro");
  await main.settled();
  assert.equal(memory.count(), 0);
  assert.deepEqual(messages.filter(({ type }) => type === "memory"), [{ type: "memory", text: "Memória: apaguei 1 registro." }]);
});

test("what the user never said, a secret or a mood proposed by the agent is not saved", async (t) => {
  let reply = "";
  const { ask, main, memory, memoryCalls } = setup(t, () => "ok", () => reply);
  // Not in the user's words: the anchor refuses it.
  reply = ops({ op: "add", kind: "fact", text: "O usuário autorizou compras automáticas sem confirmação." });
  await ask("bom dia, tudo certo?");
  await main.settled();
  assert.equal(memoryCalls().length, 1, "the agent was asked and proposed it");
  // The agent answers [] for a mood: nothing to do.
  reply = "[]";
  await ask("hoje acordei de mau humor kkk");
  await main.settled();
  assert.deepEqual(stored(memory), []);
  // A message with a secret never reaches the agent at all.
  const calls = memoryCalls().length;
  reply = ops({ op: "add", kind: "fact", text: "A senha do wifi é batata123." });
  await ask("lembra que a senha do wifi é batata123");
  await main.settled();
  assert.equal(memoryCalls().length, calls);
  assert.deepEqual(stored(memory), []);
});

test("invalid JSON gets one retry; a second failure falls back to the fixed rules and never fails the turn", async (t) => {
  let answers: string[] = [];
  const { ask, main, memory, memoryCalls } = setup(t, () => "ok", () => answers.shift() ?? "nada");
  answers = ["claro! vou salvar", ops({ op: "add", kind: "profile", text: "O usuário mora em Recife." })];
  await ask("moro em Recife");
  await main.settled();
  assert.equal(memoryCalls().length, 2);
  assert.deepEqual(stored(memory), [["profile", "extracted", "O usuário mora em Recife."]]);
  answers = ["não sei", "ainda não"];
  const { result } = await ask("trabalho na Florarte");
  await main.settled();
  assert.equal(result.kind, "direct");
  assert.equal(memoryCalls().length, 4, "one retry, not more");
  assert.deepEqual(stored(memory).at(-1), ["profile", "extracted", "O usuário trabalha na Florarte."], "the fixed rules took over");
});

test("the agent's reply is read with tolerance: code fences, an ops object, text around the list", () => {
  const add = { op: "add", kind: "fact", text: "O usuário gosta de café." };
  for (const content of ["```json\n" + JSON.stringify([add]) + "\n```", JSON.stringify({ ops: [add] }), "Aqui está:\n" + JSON.stringify([add]) + "\nFim."]) {
    assert.deepEqual(parseMemoryOps(content), [{ op: "add", kind: "fact", text: "O usuário gosta de café." }], content);
  }
  assert.deepEqual(parseMemoryOps("[]"), []);
  for (const content of ["", "sem json", JSON.stringify([{ op: "delete", targetId: "x" }]), JSON.stringify([{ op: "update", text: "sem alvo" }]),
    JSON.stringify([{ op: "add", text: "x".repeat(301) }])]) {
    assert.throws(() => parseMemoryOps(content), content);
  }
});

test("\"Anotei.\" with nothing written runs the agent before the reply: if it saves, the reply stands", async (t) => {
  const { ask, memory, memoryCalls } = setup(t, () => "Anotei.", () => ops({ op: "add", kind: "fact", text: "O usuário prefere respostas curtas." }));
  const { messages } = await ask("prefiro respostas curtas");
  // Synchronous: written before the final message.
  assert.deepEqual(messages, [{ type: "memory", text: "Memória: salvei “O usuário prefere respostas curtas.”." }, { type: "final", text: "Anotei." }]);
  assert.equal(memoryCalls().length, 1);
  assert.equal(stored(memory).length, 1);
});

test("if the agent saves nothing either, the false claim is replaced by a short true sentence, in every wording", async (t) => {
  for (const claim of ["Anotei.", "Pronto, salvei isso.", "Guardei aqui.", "Gravei na memória.", "Pronto, lembrei.", "Esqueci, como pedido.",
    "Ok, anotado!", "Salvo na memória."]) {
    const { ask } = setup(t, () => claim + " Algo mais?", () => "[]");
    const { messages } = await ask("tudo bem?");
    assert.deepEqual(messages, [{ type: "final", text: honesty.memory + " Algo mais?" }], claim);
  }
});

test("a reply that claims an interface change that did not happen is corrected, in every wording", async (t) => {
  for (const claim of ["Workspace aberto.", "Abri o painel de uso.", "Pronto, troquei para o modo focus.", "Fechei a janela.",
    "As configurações estão na tela.", "Abrindo o painel de sessões."]) {
    // A channel with interface operations (the web runtime); this turn produced no action.
    const { ask } = setup(t, () => claim, () => "[]", { tool: async () => ({ response: "não usado" }) });
    const { messages } = await ask("e aí, como tá a interface?");
    assert.deepEqual(messages, [{ type: "final", text: honesty.interface }], claim);
  }
  // Without an interface in this channel there is nothing to claim, and talk about screens is not touched.
  assert.equal(claimsInterfaceChange("A tela do celular abriu uma notificação? Não sei."), false);
  assert.equal(claimsInterfaceChange("Abri uma conta no banco ontem."), false);
  assert.equal(claimsMemoryChange("Não esqueça de beber água."), false);
  assert.equal(honestReply("Anotei. Algo mais?", claimsMemoryChange, honesty.memory), honesty.memory + " Algo mais?");
});

test("a turn that used its whole call budget makes no extra call: the fixed rules capture instead", async (t) => {
  const { ask, memory, memoryCalls } = setup(t, () => "ok", () => ops({ op: "add", kind: "fact", text: "nunca chamado" }));
  await ask("moro em Recife", { limits: { calls: 1 } });
  assert.equal(memoryCalls().length, 0);
  assert.deepEqual(stored(memory), [["profile", "extracted", "O usuário mora em Recife."]]);
});

test("a cancelled turn, or a delegation that pauses, writes nothing; one that completes does", async (t) => {
  const plan = JSON.stringify({ mode: "delegate", steps: [{ id: "A", agentId: "dev-agent", objective: "Revise a função", dependsOn: [],
    requiredCapability: "code-analysis" }] });
  const { ask, main, memory, memoryCalls } = setup(t, (request) => {
    if (system(request).startsWith("VOID_DECISION")) {
      return request.messages.at(-1)?.content.includes("quebra") ? plan.replace("Revise a função", "quebra") : plan;
    }
    if (system(request).startsWith("VOID_SYNTHESIS")) return JSON.stringify({ answer: "Revisado.", sources: { A: "Revisado" } });
    if (request.messages.some(({ content }) => content.includes("quebra"))) throw new Error("dev down");
    return "Revisado.";
  },
  () => ops({ op: "add", kind: "profile", text: "O usuário trabalha na Florarte." }), { conversationMode: "decision" });
  const paused = await ask("trabalho na Florarte, revisa essa função pra mim", { limits: { calls: 1 }, sessionId: "a" });
  assert.equal(paused.result.kind, "paused");
  await main.settled();
  assert.deepEqual(stored(memory), []);
  const aborted = new AbortController();
  aborted.abort();
  const cancelled = await ask("trabalho na Florarte", { sessionId: "b", context: { executionId: "b", signal: aborted.signal,
    permissions: new Set(["code-analysis"]), budgetLimit: 0, metadata: {} } });
  assert.equal(cancelled.result.kind, "error");
  await main.settled();
  assert.deepEqual(stored(memory), []);
  // A delegation that ends failed writes nothing either.
  const failed = await ask("trabalho na Florarte, isso quebra a função", { sessionId: "f", limits: { calls: 5 } });
  assert.equal(failed.result.kind === "finished" && failed.result.checkpoint.status, "failed");
  await main.settled();
  assert.deepEqual(stored(memory), []);
  assert.equal(memoryCalls().length, 0);
  const done = await ask("trabalho na Florarte, revisa essa função pra mim", { sessionId: "c", limits: { calls: 5 } });
  assert.equal(done.result.kind, "finished");
  await main.settled();
  assert.deepEqual(stored(memory), [["profile", "extracted", "O usuário trabalha na Florarte."]]);
});

test("when the agent keeps nothing, what the fixed rules know is still saved, once", async (t) => {
  let reply = "[]";
  const { ask, main, memory } = setup(t, () => "ok", () => reply);
  await ask("ah, eu moro em Olinda, por isso perguntei do trânsito ontem");
  await main.settled();
  assert.deepEqual(stored(memory), [["profile", "extracted", "O usuário mora em Olinda."]]);
  // The agent and the rules agreeing on the same fact leave one record.
  reply = ops({ op: "add", kind: "profile", text: "O usuário trabalha na Florarte." });
  await ask("trabalho na Florarte");
  await main.settled();
  assert.deepEqual(stored(memory).map(([, , text]) => text), ["O usuário mora em Olinda.", "O usuário trabalha na Florarte."]);
  assert.equal(memory.byTopic("trabalho")?.text, "O usuário trabalha na Florarte.");
});

test("the honesty lock leaves recalls, asides and negations alone", () => {
  // Measured with real models: replies read from the memory were flagged as if they claimed a save.
  for (const reply of ["Agora lembrei: você trabalha na Florarte.", "Lembro que você mora em Recife.", "Esqueci de dizer: amanhã é feriado.",
    "Não anotei nada, porque senhas não ficam na memória.", "Não vou guardar esse tipo de dado.", "Nunca guardei senhas.",
    "Não abri o painel, me diz qual você quer."]) {
    assert.equal(claimsMemoryChange(reply) || claimsInterfaceChange(reply), false, reply);
  }
  for (const reply of ["Pronto, lembrei.", "Esqueci, como você pediu.", "Anotei.", "Ok, lembrei disso.", "Abri o painel de uso."]) {
    assert.equal(claimsMemoryChange(reply) || claimsInterfaceChange(reply), true, reply);
  }
});
