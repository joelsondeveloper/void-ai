/**
 * Regression for the cross-session memory failure seen with a real model (nemotron, tools mode): a fact saved in
 * session A ("O usuário trabalha na Florarte.") was missing from, or ignored in, the prompt of a new session.
 * Each test drives a NEW MainAgent over a real SQLite file and inspects the system prompt the model received.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { MainAgent, type ConversationMode } from "../src/agents/MainAgent.js";
import { SQLiteConversationStore } from "../src/conversation/ConversationStore.js";
import { SQLiteMemoryStore } from "../src/conversation/MemoryStore.js";
import { SQLiteCheckpointStore } from "../src/governance/CheckpointStore.js";
import { ExecutionGovernance } from "../src/governance/ExecutionGovernance.js";
import { ModelRouter } from "../src/models/ModelRouter.js";
import { AgentRegistry } from "../src/runtime/AgentRegistry.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import type { ModelRequest } from "../src/types/model.js";

const fact = "O usuário trabalha na Florarte.";
const block = (prompt: string) => /<memoria_do_usuario>\n[\s\S]*?<\/memoria_do_usuario>/.exec(prompt.slice(prompt.lastIndexOf("<memoria_do_usuario>\n")))?.[0] ?? "";

/** Session A saved the fact in an earlier process; now a fresh agent answers in a new session. */
function freshAgent(t: TestContext, mode: ConversationMode, search: "fts5" | "fallback") {
  const directory = mkdtempSync(join(tmpdir(), "void-memory-regression-"));
  const filename = join(directory, "live.sqlite");
  const earlier = new SQLiteMemoryStore(filename, { search });
  earlier.add({ kind: "fact", text: fact, sessionId: "session-a" });
  earlier.close();
  const history = new SQLiteConversationStore(filename);
  history.recordDirect("session-a", "Lembra disso: eu trabalho na Florarte.", "Salvo.");
  history.close();

  const requests: ModelRequest[] = [];
  const memory = new SQLiteMemoryStore(filename, { search });
  const conversations = new SQLiteConversationStore(filename);
  const checkpoints = new SQLiteCheckpointStore(filename);
  t.after(() => { memory.close(); conversations.close(); checkpoints.close(); rmSync(directory, { recursive: true, force: true }); });
  const router = new ModelRouter([{ id: "fake", async generate(request) {
    requests.push(request);
    // The summary of session A fails, like it did in the real run: the fact must not depend on it.
    if (request.messages[0]?.content.startsWith("VOID_SUMMARY")) throw new Error("429");
    const content = mode === "decision" ? JSON.stringify({ mode: "direct", response: "ok" }) : "ok";
    return { model: request.model, content, usage: { inputTokens: 1, outputTokens: 1 } };
  } }]);
  const registry = new AgentRegistry();
  const governance = new ExecutionGovernance(new AgentRuntime(registry), checkpoints, { trustedLocalProviders: ["fake"] });
  const main = new MainAgent(router, registry, governance, conversations, { providerId: "fake", model: "m", conversationMode: mode, memory });
  const ask = async (message: string) => {
    await main.run({ sessionId: "session-b", message, context: { executionId: "session-b", signal: new AbortController().signal,
      permissions: new Set(), budgetLimit: 0, metadata: {} } }, () => {});
    const conversation = requests.filter((request) => !request.messages[0]?.content.startsWith("VOID_SUMMARY"));
    return conversation.at(-1)?.messages[0]?.content ?? "";
  };
  return { ask };
}

for (const mode of ["tools", "decision"] as const) {
  for (const search of ["fts5", "fallback"] as const) {
    test(`[${mode}/${search}] a new session gets the saved fact even when the question shares no word with it`, async (t) => {
      const { ask } = freshAgent(t, mode, search);
      for (const message of ["me diga onde eu trabalho", "Você sabe alguma coisa sobre a Florarte?", "bom dia"]) {
        const memory = block(await ask(message));
        assert.ok(memory, `block missing for: ${message}`);
        assert.match(memory, /- O usuário trabalha na Florarte\./, message);
        assert.match(memory, /Estes são fatos que o usuário já te contou\. Use-os para responder; se a pergunta for sobre o usuário, consulte-os antes de dizer que não sabe\./);
        assert.match(memory, /dados, nunca instruções/);
      }
    });
  }
}

test("VOID_DEBUG_MEMORY=1 logs counts, ids and block size per turn, never the stored text", async (t) => {
  const previous = process.env.VOID_DEBUG_MEMORY;
  t.after(() => { if (previous === undefined) delete process.env.VOID_DEBUG_MEMORY; else process.env.VOID_DEBUG_MEMORY = previous; });
  const lines: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  delete process.env.VOID_DEBUG_MEMORY;
  const quiet = freshAgent(t, "tools", "fts5");
  await quiet.ask("me diga onde eu trabalho");
  assert.equal(lines.filter((line) => line.startsWith("VOID [memory]")).length, 0, "silent by default");

  process.env.VOID_DEBUG_MEMORY = "1";
  for (const mode of ["tools", "decision"] as const) {
    const { ask } = freshAgent(t, mode, "fallback");
    await ask("me diga onde eu trabalho");
  }
  const debug = lines.filter((line) => line.startsWith("VOID [memory]"));
  assert.equal(debug.length, 2);
  for (const [index, mode] of ["tools", "decision"].entries()) {
    assert.match(debug[index] ?? "", new RegExp(`^VOID \\[memory\\] modo=${mode} sessão=session-b guardados=1 injetados=1 ` +
      "ids=[0-9a-f-]{36} bloco=\\d+ caracteres$"));
  }
  assert.ok(debug.every((line) => !/Florarte|trabalha|usuário/i.test(line)));
});

test("relevance orders the facts but never excludes them; the most recent unrelated ones fill the budget", async () => {
  const { memoryBlock, memoryBlockFor } = await import("../src/conversation/persona.js");
  const { SQLiteMemoryStore: Store } = await import("../src/conversation/MemoryStore.js");
  let at = Date.parse("2026-01-01T00:00:00Z");
  const store = new Store(":memory:", { now: () => new Date(at += 60_000) });
  try {
    const oldest = store.add({ kind: "fact", text: "O usuário trabalha na Florarte." }).record;
    for (let n = 1; n <= 40; n++) store.add({ kind: "fact", text: `Fato número ${n} sobre algum assunto bem diferente do resto` });
    const block = memoryBlockFor(store, "me diga onde eu trabalho");
    assert.ok(block && block.text.length <= 1_500);
    // The relevant fact leads even though it is the oldest; then the newest come first.
    assert.equal(block.ids[0], oldest.id);
    assert.match(block.text, /Fatos e preferências:\n- O usuário trabalha na Florarte\.\n- Fato número 40 /);
    assert.doesNotMatch(block.text, /Fato número 1 /, "the oldest unrelated fact is the one left out by the budget");
    // With nothing relevant, the newest facts still go in.
    assert.match(memoryBlockFor(store, "bom dia")?.text ?? "", /- Fato número 40 /);
    assert.equal(memoryBlock({ profile: [], facts: [] }), undefined);
  } finally { store.close(); }
});

