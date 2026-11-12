/**
 * Memory that does not depend on the model calling a tool. With a real free model (nemotron, tools mode) a passing
 * mention was never saved, and the model answered "Anotei." without having written anything. These tests drive the
 * host-side capture: a deterministic extractor that runs at the end of every turn, in every mode.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { MainAgent, type MainAgentOptions, type MainMessage, type MainRequest } from "../src/agents/MainAgent.js";
import { SQLiteConversationStore } from "../src/conversation/ConversationStore.js";
import { applyExtracted, claimsSaved, extractionWindow, extractMemories } from "../src/conversation/memoryExtractor.js";
import { MemoryError, type MemoryStore, SQLiteMemoryStore } from "../src/conversation/MemoryStore.js";
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
const usedTool = (request: ModelRequest | undefined) => !!request?.messages.some(({ role }) => role === "tool");
const blockOf = (prompt: string) => /<memoria_do_usuario>\nEstes são fatos[\s\S]*?<\/memoria_do_usuario>/.exec(prompt)?.[0] ?? "";
const file = () => join(tempDirectory("void-extraction-"), "chat.sqlite");
/** Everything but session summaries, as [kind, origin, topic, text]. */
const stored = (memory: MemoryStore) => memory.list().filter(({ kind }) => kind !== "summary")
  .map(({ kind, origin, topic, text }) => [kind, origin, topic ?? null, text]);

/** A MainAgent over a real SQLite file, with a scripted model. A second agent on the same file simulates a restart. */
function agent(t: TestContext, filename: string, handle: (request: ModelRequest) => Reply, overrides: Partial<MainAgentOptions> = {}) {
  const memory = new SQLiteMemoryStore(filename);
  const checkpoints = new SQLiteCheckpointStore(filename);
  const conversations = new SQLiteConversationStore(filename);
  t.after(() => { checkpoints.close(); conversations.close(); memory.close(); });
  const requests: ModelRequest[] = [];
  const router = new ModelRouter([{ id: providerId, async generate(request) {
    requests.push(request);
    const reply = isSummary(request) ? "Resumo da sessão." : handle(request);
    const { content = "", toolCalls } = typeof reply === "string" ? { content: reply } : reply;
    return { model: request.model, content, ...(toolCalls ? { toolCalls } : {}), usage: { inputTokens: 2, outputTokens: 1 } };
  } }]);
  const registry = new AgentRegistry();
  const governance = new ExecutionGovernance(new AgentRuntime(registry), checkpoints, { trustedLocalProviders: [providerId] });
  const main = new MainAgent(router, registry, governance, conversations,
    { providerId, model: "main", conversationMode: "tools", memory, ...overrides });
  const ask = async (message: string, extra: Partial<MainRequest> = {}) => {
    const messages: MainMessage[] = [];
    const result = await main.run({ sessionId: "s", message, context: { executionId: "s", signal: new AbortController().signal,
      permissions: new Set(), budgetLimit: 0, metadata: {} }, ...extra }, (m) => { messages.push(m); });
    return { result, messages, request: requests.filter((request) => !isSummary(request)).at(-1) };
  };
  return { ask, memory };
}

test("durable first-person statements become short third-person facts with a topic", () => {
  const cases: [string, [string, string, string][]][] = [
    ["trabalho na Florarte, mas hoje tô cansado", [["profile", "trabalho", "O usuário trabalha na Florarte."]]],
    ["VOID, eu tô trabalhando na Acme agora", [["profile", "trabalho", "O usuário trabalha na Acme."]]],
    ["trabalho com logística", [["profile", "ocupacao", "O usuário trabalha com logística."]]],
    ["sou desenvolvedor de software", [["profile", "profissao", "O usuário é desenvolvedor de software."]]],
    ["meu nome é joelson", [["profile", "nome", "O usuário se chama Joelson."]]],
    ["me chamo Joelson Vicente e moro em Recife", [["profile", "nome", "O usuário se chama Joelson Vicente."],
      ["profile", "moradia", "O usuário mora em Recife."]]],
    ["moro no Cabo de Santo Agostinho", [["profile", "moradia", "O usuário mora no Cabo de Santo Agostinho."]]],
    ["Sou de Recife", [["profile", "origem", "O usuário é de Recife."]]],
    ["prefiro TypeScript a JavaScript", [["fact", "prefere:typescript-a-javascript", "O usuário prefere TypeScript a JavaScript."]]],
    ["gosto de café coado", [["fact", "gosta:cafe-coado", "O usuário gosta de café coado."]]],
    ["adoro o Rust", [["fact", "gosta:rust", "O usuário gosta de Rust."]]],
    ["não gosto de reunião de manhã", [["fact", "naogosta:reuniao-de-manha", "O usuário não gosta de reunião de manhã."]]],
    ["eu uso Linux", [["fact", "usa:linux", "O usuário usa Linux."]]],
    ["minha esposa se chama Ana", [["fact", "pessoa:esposa", "A esposa do usuário se chama Ana."]]],
    ["meu cachorro chama thor", [["fact", "pessoa:cachorro", "O cachorro do usuário se chama Thor."]]],
    ["meu projeto se chama Void", [["fact", "projeto:void", "O usuário tem um projeto chamado Void."]]],
  ];
  for (const [message, expected] of cases) {
    const found = extractMemories(message);
    assert.deepEqual(found.map(({ kind, topic, text }) => [kind, topic, text]), expected, message);
    assert.ok(found.every(({ origin }) => origin === "extracted"), message);
  }
});

test("questions, negations, plans, doubts, moods and vague objects are left alone", () => {
  for (const message of ["onde eu trabalho?", "você sabe onde eu moro", "não trabalho na Florarte", "já não moro em Recife",
    "se eu trabalho na Florarte, por que estou aqui", "queria morar em Lisboa", "acho que prefiro Rust",
    "vou morar em Olinda ano que vem", "hoje acordei de mau humor kkk", "gosto disso", "adoro quando você responde rápido",
    "sou de boa", "o uso de memória está alto", "bom dia", "trabalho em casa", "explica concorrência e paralelismo"]) {
    assert.deepEqual(extractMemories(message), [], message);
  }
});

test("a request to remember is explicit, a request to forget saves nothing, and a paste is not the user talking", () => {
  assert.deepEqual(extractMemories("lembra que eu trabalho na Florarte"),
    [{ kind: "profile", topic: "trabalho", text: "O usuário trabalha na Florarte.", origin: "explicit" }]);
  // No rule knows the shape, but the user asked: their own words are kept, quoted.
  assert.deepEqual(extractMemories("anota aí que a reunião com o cliente é toda segunda"),
    [{ kind: "fact", topic: "lembrete:a-reuniao-com-o-cliente-e-toda-segunda", origin: "explicit",
      text: 'O usuário pediu para lembrar: "a reunião com o cliente é toda segunda".' }]);
  assert.deepEqual(extractMemories("esquece que eu trabalho na Florarte"), []);
  assert.deepEqual(extractMemories("apaga da memória: moro em Recife"), []);
  assert.deepEqual(extractMemories("lembra onde eu trabalho?"), []);
  // At most three per turn, one per topic, and only from the opening of the message.
  assert.deepEqual(extractMemories("moro em Recife. trabalho na Florarte. prefiro TypeScript. gosto de café. uso Linux.")
    .map(({ topic }) => topic), ["moradia", "trabalho", "prefere:typescript"]);
  assert.deepEqual(extractMemories("x".repeat(extractionWindow) + ". Eu trabalho na Florarte."), []);
});

test("a reply that claims a save is recognized, an ordinary one is not", () => {
  for (const reply of ["Anotei.", "Fechado, vou lembrar.", "Anotado, fica salvo.", "Pronto, salvei.", "Tá registrado."]) assert.ok(claimsSaved(reply), reply);
  for (const reply of ["Na Florarte.", "Não rodei nada, então não sei.", "Bom dia. O que a gente resolve hoje?"]) assert.ok(!claimsSaved(reply), reply);
});

test("a topic holds one record: a new statement replaces the text, keeps the id and reports what happened", (t) => {
  const store = new SQLiteMemoryStore(file());
  t.after(() => store.close());
  const first = store.remember({ kind: "profile", topic: "moradia", text: "O usuário mora em Recife.", origin: "extracted", sessionId: "a" });
  assert.equal(first.outcome, "created");
  assert.deepEqual([first.record.origin, first.record.topic, first.record.sessionId], ["extracted", "moradia", "a"]);
  assert.equal(store.remember({ kind: "profile", topic: "moradia", text: "o usuário mora em RECIFE" }).outcome, "unchanged");
  const moved = store.remember({ kind: "profile", topic: "moradia", text: "O usuário mora em Olinda." });
  assert.equal(moved.outcome, "updated");
  assert.equal(moved.record.id, first.record.id);
  assert.deepEqual(store.list().map(({ text }) => text), ["O usuário mora em Olinda."]);
  assert.deepEqual(store.search("olinda").map(({ id }) => id), [first.record.id]);
  assert.deepEqual(store.search("recife"), []);
  assert.equal(store.byTopic("moradia")?.text, "O usuário mora em Olinda.");
  assert.equal(store.byTopic("trabalho"), undefined);
  // A record saved without topic takes the topic when the same sentence arrives with one.
  const loose = store.add({ kind: "fact", text: "O usuário gosta de café." }).record;
  assert.equal(loose.origin, "explicit");
  const taken = store.remember({ kind: "fact", topic: "gosta:cafe", text: "O usuário gosta de café.", origin: "extracted" });
  assert.deepEqual([taken.outcome, taken.record.id, store.get(loose.id)?.topic], ["unchanged", loose.id, "gosta:cafe"]);
  assert.equal(store.adoptTopic(loose.id, "gosta:cha"), false, "already has a topic");
  // Same validation as add: secrets, sizes, and the shape of the topic.
  const refused = (action: () => unknown, code: MemoryError["code"]) =>
    assert.throws(action, (error) => error instanceof MemoryError && error.code === code);
  refused(() => store.remember({ kind: "fact", topic: "lembrete:x", text: "a senha do wifi é batata123" }), "secret");
  refused(() => store.remember({ kind: "fact", topic: "Tema Inválido", text: "ok" }), "invalid");
  refused(() => store.remember({ kind: "summary", topic: "resumo", text: "ok" }), "invalid");
  refused(() => store.add({ kind: "fact", text: "ok", origin: "summary" }), "invalid");
  assert.equal(store.count(), 2);
});

test("a database created before origin and topic existed is migrated on open, keeping its records", (t) => {
  const filename = file();
  const old = new DatabaseSync(filename);
  old.exec(`CREATE TABLE memory_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('profile', 'fact', 'summary')),
    text TEXT NOT NULL, normalized TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    source_turn_id TEXT, session_id TEXT) STRICT;`);
  const insert = old.prepare("INSERT INTO memory_records VALUES (?, ?, ?, ?, '2026-11-12T03:06:04.746Z', '2026-11-12T03:06:04.746Z', NULL, 'a')");
  insert.run("00000000-0000-4000-8000-000000000001", "fact", "O usuário trabalha na Florarte.", "o usuário trabalha na florarte");
  insert.run("00000000-0000-4000-8000-000000000002", "summary", "Resumo antigo.", "resumo antigo");
  old.close();
  for (let reopen = 0; reopen < 2; reopen++) {
    const store = new SQLiteMemoryStore(filename);
    assert.deepEqual(store.list().map(({ kind, origin, topic, text }) => [kind, origin, topic, text]),
      [["fact", "explicit", undefined, "O usuário trabalha na Florarte."], ["summary", "summary", undefined, "Resumo antigo."]]);
    store.close();
  }
  const store = new SQLiteMemoryStore(filename);
  t.after(() => store.close());
  // The old record takes the topic instead of being duplicated, and can then be updated in place.
  assert.deepEqual(applyExtracted(store, extractMemories("eu trabalho na Florarte"), { sessionId: "b" }),
    { added: [], updated: [], known: 1, failed: 0 });
  assert.equal(store.byTopic("trabalho")?.id, "00000000-0000-4000-8000-000000000001");
  assert.equal(applyExtracted(store, extractMemories("agora trabalho na Acme"), { sessionId: "b" }).updated[0]?.text, "O usuário trabalha na Acme.");
  assert.equal(store.count(), 2);
});

test("a passing mention is saved even when the model calls no tool and only says \"Anotei.\"; a new session after a restart knows it", async (t) => {
  const filename = file();
  const first = agent(t, filename, () => "Anotei. Dia puxado aí?");
  const turn = await first.ask("trabalho na Florarte, mas hoje tô cansado", { sessionId: "a" });
  assert.equal(usedTool(turn.request), false, "the model called nothing");
  assert.deepEqual(turn.messages, [{ type: "memory", text: "Memória: salvei “O usuário trabalha na Florarte.”." },
    { type: "final", text: "Anotei. Dia puxado aí?" }]);
  assert.deepEqual(stored(first.memory), [["profile", "extracted", "trabalho", "O usuário trabalha na Florarte."]]);
  assert.equal(first.memory.list()[0]?.sessionId, "a");

  const second = agent(t, filename, () => "Na Florarte.");
  const later = await second.ask("me diga onde eu trabalho", { sessionId: "b" });
  assert.match(blockOf(system(later.request)), /Perfil:\n- O usuário trabalha na Florarte\./);
  assert.deepEqual(later.messages, [{ type: "final", text: "Na Florarte." }]);
});

test("the strict-JSON coordinator, which has no memory tools, saves the same mention", async (t) => {
  const { ask, memory } = agent(t, file(), () => JSON.stringify({ mode: "direct", response: "Entendi." }), { conversationMode: "decision" });
  const { messages } = await ask("moro em Recife e trabalho com logística");
  assert.deepEqual(stored(memory), [["profile", "extracted", "ocupacao", "O usuário trabalha com logística."],
    ["profile", "extracted", "moradia", "O usuário mora em Recife."]]);
  assert.deepEqual(messages.map(({ type }) => type), ["memory", "final"]);
});

test("a changed fact updates the record of its topic instead of piling up a contradiction", async (t) => {
  const { ask, memory } = agent(t, file(), () => "Certo.");
  await ask("moro em Recife");
  const { messages } = await ask("me mudei, agora moro em Olinda");
  assert.deepEqual(stored(memory), [["profile", "extracted", "moradia", "O usuário mora em Olinda."]]);
  assert.deepEqual(messages[0], { type: "memory", text: "Memória: atualizei para “O usuário mora em Olinda.”." });
});

test("a turn dismissed as voice noise, or one that fails, saves nothing", async (t) => {
  const noise = agent(t, file(), () => "<ignore/>");
  assert.equal((await noise.ask("eu trabalho na Globo", { source: "voice" })).result.kind, "ignored");
  assert.deepEqual(stored(noise.memory), []);
  const broken = agent(t, file(), () => { throw new Error("provider down"); });
  assert.equal((await broken.ask("eu trabalho na Globo")).result.kind, "error");
  assert.deepEqual(stored(broken.memory), []);
});

test("\"Anotei.\" with nothing saved is contradicted; with the fact already stored it stands", async (t) => {
  const { ask, memory } = agent(t, file(), () => "Anotei.");
  // Nothing durable in the message and no tool call: the claim is false.
  assert.deepEqual((await ask("hoje acordei de mau humor kkk")).messages,
    [{ type: "memory", text: "Memória: nada foi salvo nesta resposta." }, { type: "final", text: "Anotei." }]);
  assert.deepEqual(stored(memory), []);
  await ask("trabalho na Florarte");
  // Said again: nothing new is written, and the claim is true because the fact is there.
  assert.deepEqual((await ask("já te falei, trabalho na Florarte")).messages, [{ type: "final", text: "Anotei." }]);
  assert.equal(stored(memory).length, 1);
});

test("an explicit request is kept in the user's words when the model ignores it, and a secret still never gets in", async (t) => {
  const issues: string[] = [];
  const { ask, memory } = agent(t, file(), () => "Anotado.", { onCommunicationIssue: (kind) => { issues.push(kind); } });
  await ask("anota aí que a reunião com o cliente é toda segunda");
  assert.deepEqual(stored(memory), [["fact", "explicit", "lembrete:a-reuniao-com-o-cliente-e-toda-segunda",
    'O usuário pediu para lembrar: "a reunião com o cliente é toda segunda".']]);
  const { messages } = await ask("não esquece que a senha do wifi é batata123");
  assert.equal(stored(memory).length, 1);
  assert.deepEqual(issues, ["memory"]);
  assert.deepEqual(messages[0], { type: "memory", text: "Memória: nada foi salvo nesta resposta." });
});

test("when the model does call remember, the extractor marks that record instead of saving a second one", async (t) => {
  const { ask, memory } = agent(t, file(), (request) => usedTool(request) ? "Fechado."
    : { toolCalls: [{ id: "c1", name: "remember", arguments: JSON.stringify({ text: "Prefere respostas curtas e diretas" }) }] });
  const { messages } = await ask("lembra que eu prefiro respostas curtas e diretas");
  assert.deepEqual(stored(memory), [["fact", "explicit", "prefere:respostas-curtas-e-diretas", "Prefere respostas curtas e diretas"]]);
  assert.deepEqual(messages, [{ type: "memory", text: "Memória: salvei “Prefere respostas curtas e diretas”." },
    { type: "final", text: "Fechado." }]);
});

test("asking to forget removes the record and the extractor does not put it back", async (t) => {
  const filename = file();
  let id = "";
  const { ask, memory } = agent(t, filename, (request) => usedTool(request) ? "Pronto, esqueci."
    : id ? { toolCalls: [{ id: "c1", name: "forget", arguments: JSON.stringify({ id }) }] } : "Certo.");
  await ask("trabalho na Florarte");
  id = memory.list()[0]?.id ?? "";
  assert.ok(id);
  const { messages } = await ask("esquece que eu trabalho na Florarte");
  assert.deepEqual(stored(memory), []);
  assert.deepEqual(messages[0], { type: "memory", text: "Memória: apaguei 1 registro." });
});
