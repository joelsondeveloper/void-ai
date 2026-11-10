import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { DevAgent } from "../src/agents/DevAgent.js";
import { MainAgent, type MainAgentOptions, type MainMessage } from "../src/agents/MainAgent.js";
import { ResearchAgent } from "../src/agents/ResearchAgent.js";
import { SQLiteConversationStore } from "../src/conversation/ConversationStore.js";
import { SQLiteCheckpointStore } from "../src/governance/CheckpointStore.js";
import { ExecutionGovernance } from "../src/governance/ExecutionGovernance.js";
import { ModelRouter } from "../src/models/ModelRouter.js";
import { AgentRegistry } from "../src/runtime/AgentRegistry.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import type { AgentContext } from "../src/types/context.js";
import type { ModelRequest } from "../src/types/model.js";

const providerId = "test-local";
const dev = { id: "A", agentId: "dev-agent", requiredCapability: "code-analysis", objective: "Analyze code", dependsOn: [] };
const research = { id: "B", agentId: "research-agent", requiredCapability: "comparative-analysis", objective: "Compare notes", dependsOn: [] };
const permissions = ["code-analysis", "comparative-analysis"];

function context(signal = new AbortController().signal, allowed = permissions): AgentContext {
  return { executionId: "session", signal, permissions: new Set(allowed), budgetLimit: 0, metadata: {} };
}

const plan = (...steps: object[]) => JSON.stringify({ mode: "delegate", steps });
const direct = (response: string) => JSON.stringify({ mode: "direct", response });
const isSynthesis = (request: ModelRequest) => request.messages[0]?.content.startsWith("VOID_SYNTHESIS") ?? false;
const completed = (message: MainMessage, stepId: string) =>
  message.type === "progress" && message.stepId === stepId && /concluiu/.test(message.text);

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function fixture(t: TestContext, generate: (request: ModelRequest) => string | Promise<string>,
  overrides: Partial<MainAgentOptions> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "void-conversation-"));
  const filename = join(directory, "chat.sqlite");
  const stores: Array<{ close(): void }> = [];
  const requests: ModelRequest[] = [];
  function open(options = overrides) {
    const store = new SQLiteCheckpointStore(filename);
    const conversations = new SQLiteConversationStore(filename);
    stores.push(store, conversations);
    const router = new ModelRouter([{ id: providerId, async generate(request) {
      requests.push(request);
      return { model: request.model, content: await generate(request), usage: { inputTokens: 2, outputTokens: 1 } };
    } }]);
    const registry = new AgentRegistry();
    registry.register(new DevAgent(router, { providerId, model: "dev" }));
    registry.register(new ResearchAgent(router, { providerId, model: "research" }));
    const governance = new ExecutionGovernance(new AgentRuntime(registry), store, { trustedLocalProviders: [providerId] });
    const main = new MainAgent(router, registry, governance, conversations, { providerId, model: "main", ...options });
    return { main, conversations };
  }
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(filename, { force: true });
    rmdirSync(directory);
  });
  return { ...open(), open, requests };
}

test("direct responses produce a single final message and no execution", async (t) => {
  const { main, conversations, requests } = fixture(t, () => direct("Uma resposta direta."), { temperature: 0.4 });
  const messages: MainMessage[] = [];
  const result = await main.run({ sessionId: "one", message: "Olá", context: context() },
    (message) => { messages.push(message); });
  assert.equal(result.kind, "direct");
  assert.deepEqual(messages, [{ type: "final", text: "Uma resposta direta." }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.temperature, 0.4);
  assert.deepEqual(main.pending("one"), []);
  assert.deepEqual(conversations.history("one", 1).map(({ content }) => content), ["Olá", "Uma resposta direta."]);
});

test("the MainAgent can ignore voice noise in one decision without emitting or remembering a reply", async (t) => {
  const { main, conversations, requests } = fixture(t, () => JSON.stringify({ mode: "ignore" }));
  const messages: MainMessage[] = [];
  const result = await main.run({ sessionId: "one", message: "fala ao fundo", source: "voice", context: context() },
    (message) => { messages.push(message); });
  assert.equal(result.kind, "ignored");
  assert.deepEqual(messages, []);
  assert.equal(requests.length, 1);
  assert.deepEqual(conversations.history("one", 1), []);
  const typed = await main.run({ sessionId: "one", message: "fala ao fundo", context: context() }, () => {});
  assert.equal(typed.kind, "error");
});

test("the versioned persona scopes its style to direct response text and can be disabled", async (t) => {
  const reply = "A premissa precisa de um teste. Sem os dados, ainda é hipótese.";
  const { main, open, requests } = fixture(t, () => direct(reply), { persona: "void-v1", historyTurns: 0 });
  const neutral = open({ persona: "off", historyTurns: 0 }).main;
  for (const agent of [main, neutral]) {
    const messages: MainMessage[] = [];
    const result = await agent.run({ sessionId: "persona", message: "Isso vai funcionar?", context: context() },
      (message) => { messages.push(message); });
    assert.equal(result.kind, "direct");
    assert.deepEqual(messages, [{ type: "final", text: reply }]);
  }
  assert.equal(requests.length, 2);
  const [styled, baseline] = requests;
  assert.ok(styled && baseline);
  const [contract, style] = (styled.messages[0]?.content ?? "").split("\n\nVOID_PERSONA_V1. ");
  assert.equal(contract, baseline.messages[0]?.content);
  assert.equal(styled.responseFormat, "json_object");
  assert.equal(baseline.responseFormat, "json_object");
  assert.deepEqual(styled.messages.slice(1), baseline.messages.slice(1));
  assert.ok(style);
  assert.match(style, /apenas ao texto do campo response quando mode for direct/);
  assert.match(style, /português brasileiro natural/);
  assert.match(style, /perguntas simples.*temas complexos/);
  assert.match(style, /premissas frágeis com evidências/);
  assert.match(style, /fatos confirmados, hipóteses e o que falta verificar/);
  assert.match(style, /ironia sutil.*temas sensíveis, dispense o humor/);
  assert.match(style, /imitação de personagens, teatralidade, hostilidade e superioridade/);
  assert.throws(() => open({ persona: "unknown" }), /VOID_PERSONA inválida/);
});

test("initial and progress messages arrive before the gated specialist finishes", { timeout: 3000 }, async (t) => {
  const wait = gate();
  const devDone = gate();
  const researchStarted = gate();
  const { main, requests } = fixture(t, async (request) => {
    if (isSynthesis(request)) return JSON.stringify({ answer: "Dev confirmed the issue. Research confirmed the comparison.",
      sources: { A: "Dev confirmed", B: "Research confirmed" } });
    if (request.model === "main") return plan(dev, research);
    if (request.model === "dev") return "Dev confirmed; other material";
    researchStarted.release();
    await wait.promise;
    return "Research confirmed";
  });
  const messages: MainMessage[] = [];
  let requestsWhenInitial: number | undefined;
  const result = main.run({ sessionId: "one", message: "Compare", context: context() }, (message) => {
    if (message.type === "initial") requestsWhenInitial = requests.length;
    messages.push(message);
    if (completed(message, "A")) devDone.release();
  });
  try {
    await Promise.all([devDone.promise, researchStarted.promise]);
    assert.equal(messages[0]?.type, "initial");
    assert.equal(requestsWhenInitial, 1);
    assert.equal(messages.some((message) => completed(message, "B")), false);
    assert.equal(messages.filter((message) => message.type === "progress" && message.chatText).length, 1);
    assert.equal(messages.some(({ type }) => type === "final"), false);
  } finally { wait.release(); }
  const done = await result;
  assert.equal(done.kind, "finished");
  assert.deepEqual(messages.map(({ type }) => type),
    ["initial", "progress", "progress", "progress", "progress", "final"]);
  assert.equal(requests.filter(isSynthesis).length, 1);
  assert.match(messages.at(-1)?.text ?? "", /Dev confirmed/);
  assert.doesNotMatch(messages.at(-1)?.text ?? "", /other material/);
  assert.match(messages.at(-1)?.text ?? "", /Research confirmed/);
  if (done.kind === "finished") assert.equal(done.checkpoint.usage.callsStarted, 4);
});

for (const [name, decision, category] of [
  ["malformed JSON", "{broken", "invalid_response"],
  ["unknown mode", '{"mode":"tool"}', "invalid_response"],
  ["invented agent", plan({ ...dev, agentId: "imaginary" }), "invalid_response"],
  ["incompatible capability", plan({ ...dev, requiredCapability: "comparative-analysis" }), "invalid_response"],
  ["forbidden capability", plan({ ...dev, requiredCapability: "debugging" }), "permission_denied"],
  ["missing dependency", plan({ ...dev, dependsOn: ["missing"] }), "invalid_response"],
  ["cycle", plan({ ...dev, dependsOn: ["B"] }, { ...research, dependsOn: ["A"] }), "invalid_response"],
  ["duplicate step IDs", plan(dev, { ...research, id: "A" }), "invalid_response"],
  ["tool request", plan({ ...dev, tools: ["shell"] }), "invalid_response"],
  ["unapproved limit override", JSON.stringify({ mode: "delegate", steps: [dev], limits: { calls: 99 } }), "invalid_response"],
  ["too many steps", plan(dev, research), "budget_exceeded"],
] as const) {
  test(`rejects ${name} before dispatch`, async (t) => {
    const { main, requests } = fixture(t, () => decision);
    const messages: MainMessage[] = [];
    const result = await main.run({ sessionId: "one", message: "Review", context: context(),
      limits: { steps: name === "too many steps" ? 1 : 2 } }, (message) => { messages.push(message); });
    assert.equal(result.kind, "error");
    assert.equal(requests.length, 1);
    const first = messages[0];
    assert.equal(messages.length, 1);
    assert.ok(first?.type === "error");
    assert.equal(first.failure.category, category);
    assert.deepEqual(main.pending("one"), []);
  });
}

test("passes only bounded direct dependency results to the receiving specialist", async (t) => {
  const large = "X".repeat(5_000);
  const { main, requests } = fixture(t, (request) => {
    if (request.model === "main") return plan(dev, { ...dev, id: "C", objective: "Unrelated evidence" },
      { ...research, dependsOn: ["A"] });
    if (request.model === "research") return "Comparison";
    return request.messages.at(-1)?.content === "Analyze code" ? large : "PRIVATE_UNRELATED";
  });
  const result = await main.run({ sessionId: "one", message: "Review", context: context(),
    limits: { calls: 4, concurrency: 1 } }, () => {});
  assert.equal(result.kind, "finished");
  const input = requests.find(({ model }) => model === "research")?.messages.at(-1)?.content ?? "";
  assert.match(input, /untrusted evidence/);
  assert.ok(input.includes("X".repeat(4_000)));
  assert.ok(!input.includes("X".repeat(4_001)));
  assert.ok(!input.includes("PRIVATE_UNRELATED"));
  assert.match(input, /"truncated":true/);
  assert.deepEqual(requests.map(({ model }) => model), ["main", "dev", "dev", "research"]);
});

test("failed formatting, subscribers and invalid synthesis preserve a partial final answer", async (t) => {
  const output = "Dev evidence. ".repeat(110) + "Conclusão preservada.";
  const issues: string[] = [];
  const messages: MainMessage[] = [];
  const { main, conversations } = fixture(t, (request) => {
    if (isSynthesis(request)) return JSON.stringify({ answer: "Made up result", sources: { invented: "Made up result" } });
    if (request.model === "main") return plan(dev, research);
    if (request.model === "research") throw new Error("Private raw failure");
    return output;
  }, {
    formatProgress(event, fallback) {
      if (event.type === "step_completed") throw new Error("Formatter failed");
      return fallback;
    },
    onCommunicationIssue(kind) { issues.push(kind); },
  });
  const result = await main.run({ sessionId: "one", message: "Review", context: context() }, (message) => {
    messages.push(message);
    if (message.type === "initial") throw new Error("Broken UI");
    if (message.type === "progress" && message.stepId === "B") return Promise.reject(new Error("Async broken UI"));
  });
  assert.equal(result.kind, "finished");
  if (result.kind === "finished") {
    assert.equal(result.checkpoint.status, "failed");
    assert.equal(result.checkpoint.steps[0]?.output, output);
  }
  assert.ok(messages.some((message) => completed(message, "A")));
  assert.ok(issues.includes("subscriber") && issues.includes("progress") && issues.includes("synthesis"));
  const final = messages.at(-1);
  assert.equal(final?.type, "final");
  assert.match(final?.text ?? "", /Resultados dos especialistas.*Dev evidence.*Conclusão preservada/s);
  assert.match(final?.text ?? "", /Falhas/);
  assert.match(conversations.history("one", 1).at(-1)?.content ?? "", /Não consegui concluir a síntese automática/);
  assert.doesNotMatch(final?.text ?? "", /Made up result|invented|Private raw failure/);
});

test("approval resumes a persisted session without repeating completed steps or planning", async (t) => {
  const messages: MainMessage[] = [];
  const { main, open, requests } = fixture(t, (request) => {
    if (isSynthesis(request)) return '{"answer":"Research evidence","sources":{"B":"Research evidence"}}';
    if (request.model === "main") return plan(dev, { ...research, dependsOn: ["A"] });
    return request.model === "dev" ? "Dev evidence" : "Research evidence";
  });
  const paused = await main.run({ sessionId: "one", message: "Review", context: context(),
    effort: "low", limits: { calls: 2, concurrency: 1 } }, (message) => { messages.push(message); });
  assert.equal(paused.kind, "paused");
  if (paused.kind !== "paused") return;
  const id = paused.checkpoint.id;
  const approval = messages.at(-1);
  assert.ok(approval?.type === "approval_required");
  assert.equal(approval.completed, 1);
  assert.deepEqual(approval.actions, ["partial", "cancel", "extend_calls"]);
  assert.equal(paused.checkpoint.usage.callsStarted, 2);

  const restarted = open();
  assert.deepEqual(restarted.main.pending("one"), [id]);
  assert.throws(() => restarted.main.partial("other", id), /indisponível/);
  const denied = await restarted.main.resume("one", id, context(undefined, ["code-analysis"]), { calls: 2 }, () => {});
  assert.equal(denied.kind, "error");
  assert.equal(restarted.main.partial("one", id).checkpoint.limits.calls, 2);

  const resumedMessages: MainMessage[] = [];
  const done = await restarted.main.resume("one", id, context(), { calls: 2 },
    (message) => { resumedMessages.push(message); });
  assert.equal(done.kind, "finished");
  if (done.kind === "finished") {
    assert.equal(done.checkpoint.status, "completed");
    assert.deepEqual(done.checkpoint.extensions.map(({ limits }) => limits), [{ calls: 2 }]);
  }
  assert.match(resumedMessages[0]?.text ?? "", /Retomei/);
  assert.deepEqual(requests.map(({ model }) => model), ["main", "dev", "research", "main"]);
  assert.match(requests[2]?.messages.at(-1)?.content ?? "", /Dev evidence/);
  assert.equal(restarted.conversations.history("one", 1).length, 2);
  assert.deepEqual(restarted.main.pending("one"), []);
});

test("can cancel a running delegation and preserve the partial result", { timeout: 3000 }, async (t) => {
  const messages: MainMessage[] = [];
  const started = gate();
  const { main } = fixture(t, async (request) => {
    if (request.model === "main") return plan(dev, { ...research, dependsOn: ["A"] });
    if (request.model === "dev") return "Dev retained";
    const signal = request.signal;
    assert.ok(signal);
    return new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      started.release();
    });
  });
  const running = main.run({ sessionId: "one", message: "Review", context: context() },
    (message) => { messages.push(message); });
  await started.promise;
  const initial = messages[0];
  assert.ok(initial?.type === "initial");
  assert.match(main.cancel("one", initial.executionId), /Cancelamento solicitado/);
  const result = await running;
  assert.equal(result.kind, "finished");
  if (result.kind === "finished") assert.equal(result.checkpoint.status, "cancelled");
  assert.match(messages.at(-1)?.text ?? "", /Dev retained/);
});

test("history is bounded, survives a new MainAgent, and is isolated by session", async (t) => {
  const { main, open, requests } = fixture(t, () => direct("Answer"), { historyTurns: 1 });
  for (const message of ["First", "Second"]) await main.run({ sessionId: "one", message, context: context() }, () => {});
  const restarted = open();
  await restarted.main.run({ sessionId: "one", message: "Third", context: context() }, () => {});
  await restarted.main.run({ sessionId: "two", message: "Separate", context: context() }, () => {});
  assert.deepEqual(requests[2]?.messages.slice(1).map(({ content }) => content), ["Second", "Answer", "Third"]);
  assert.deepEqual(requests[3]?.messages.slice(1).map(({ content }) => content), ["Separate"]);
});

test("blocks a paid planning model before contacting any provider", async (t) => {
  const { main, requests } = fixture(t, () => direct("Unexpected"),
    { providerId: "openrouter", model: "vendor/paid" });
  const messages: MainMessage[] = [];
  const result = await main.run({ sessionId: "one", message: "Review", context: context() },
    (message) => { messages.push(message); });
  assert.equal(result.kind, "error");
  assert.equal(requests.length, 0);
  assert.equal(messages[0]?.type, "error");
  if (messages[0]?.type === "error") assert.equal(messages[0].failure.category, "permission_denied");
});

test("manual pause leaves completed work intact and can be continued without a new plan", async (t) => {
  const wait = gate();
  const { main, requests } = fixture(t, async (request) => {
    if (isSynthesis(request)) return '{"answer":"Done","sources":{"A":"Done"}}';
    if (request.model === "main") return plan(dev, { ...research, dependsOn: ["A"] });
    if (request.model === "dev") await wait.promise;
    return "Done";
  });
  const messages: MainMessage[] = [];
  const running = main.run({ sessionId: "one", message: "Review", context: context() },
    (message) => { messages.push(message); });
  try {
    await setImmediate();
    const initial = messages[0];
    assert.ok(initial?.type === "initial");
    main.pause("one", initial.executionId);
  } finally { wait.release(); }
  const paused = await running;
  assert.equal(paused.kind, "paused");
  if (paused.kind !== "paused") return;
  const approval = messages.at(-1);
  assert.ok(approval?.type === "approval_required");
  assert.ok(approval.actions.includes("continue"));
  assert.deepEqual(paused.checkpoint.steps.map(({ status }) => status), ["completed", "pending"]);
  const done = await main.resume("one", paused.checkpoint.id, context(), {}, () => {});
  assert.equal(done.kind, "finished");
  assert.equal(requests.filter((request) => request.model === "main" && !isSynthesis(request)).length, 1);
});

test("the terminal can discover and approve a paused execution in a second process", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "void-chat-restart-"));
  const filename = join(directory, "restart.sqlite");
  t.after(() => {
    rmSync(filename, { force: true });
    rmdirSync(directory);
  });
  const env = { ...process.env, VOID_CHAT_DB: filename, VOID_CHAT_SESSION: "restart",
    VOID_CHAT_MAX_CALLS: "2", VOID_EFFORT: "low" };
  const args = [...process.execArgv, "src/examples/mainAgent.ts"];
  const before = spawnSync(process.execPath, args, {
    env, input: "Analise a função.\n", encoding: "utf8", timeout: 10_000,
  });
  assert.equal(before.status, 0, before.stderr);
  assert.match(before.stdout, /\[approval_required\].*1 de 2/);
  assert.doesNotMatch(before.stdout, /research-agent concluiu/);

  const after = spawnSync(process.execPath, args, {
    env, input: "/pending\n/approve calls=2\n", encoding: "utf8", timeout: 10_000,
  });
  assert.equal(after.status, 0, after.stderr);
  assert.match(after.stdout, /Retomei a execução/);
  assert.match(after.stdout, /research-agent iniciou/);
  assert.match(after.stdout, /\[final\] Execução concluída/);
  assert.doesNotMatch(after.stdout, /dev-agent iniciou/);
});

test("synthesis uses full evidence from both specialists and writes one answer in the configured voice", async (t) => {
  const messages: MainMessage[] = [];
  const { main, open, requests } = fixture(t, (request) => {
    if (isSynthesis(request)) {
      assert.match(request.messages.at(-1)?.content ?? "", /Resultado/);
      return JSON.stringify({ answer: "Resultado NaN. A comparação ficou em 90 % e 60 %.",
        sources: { A: "Resultado NaN.", B: "90 % e 60 %." } });
    }
    if (request.model === "main") return plan(dev, { ...research, dependsOn: ["A"] });
    return request.model === "dev" ? "Unselected paragraph. ".repeat(110) + "\n\nResultado\u202fNaN." : "90\u202f% e 60\u202f%.";
  }, { persona: "void-v1" });
  const result = await main.run({ sessionId: "indexed", message: "Compare", context: context() },
    (message) => { messages.push(message); });
  assert.equal(result.kind, "finished");
  if (result.kind === "finished") assert.equal(result.checkpoint.status, "completed");
  const final = messages.at(-1);
  assert.equal(final?.type, "final");
  assert.match(final?.text ?? "", /Resultado\u202fNaN.*90\u202f% e 60\u202f%/s);
  assert.doesNotMatch(final?.text ?? "", /Unselected paragraph/);

  const neutral = open({ persona: "off" }).main;
  const neutralMessages: MainMessage[] = [];
  await neutral.run({ sessionId: "neutral", message: "Compare", context: context() },
    (message) => { neutralMessages.push(message); });
  assert.equal(neutralMessages.at(-1)?.text, final?.text);
  assert.deepEqual(messages.map(({ type }) => type), neutralMessages.map(({ type }) => type));
  const [styledSynthesis, neutralSynthesis] = requests.filter(isSynthesis);
  assert.ok(styledSynthesis && neutralSynthesis);
  assert.match(styledSynthesis.messages[0]?.content ?? "", /VOID_PERSONA_V1/);
  assert.doesNotMatch(neutralSynthesis.messages[0]?.content ?? "", /VOID_PERSONA_V1/);
  assert.deepEqual(styledSynthesis.messages[1], neutralSynthesis.messages[1]);
  assert.equal(styledSynthesis.responseFormat, "json_object");
  assert.equal(requests.length, 8);
});

test("when DevAgent fails, the final answer uses only confirmed ResearchAgent evidence", async (t) => {
  const messages: MainMessage[] = [];
  const { main } = fixture(t, (request) => {
    if (isSynthesis(request)) {
      const prompt = request.messages.at(-1)?.content ?? "";
      assert.match(prompt, /Pesquisa concluída/);
      assert.doesNotMatch(prompt, /Private provider body/);
      return '{"answer":"Pesquisa concluída","sources":{"B":"Pesquisa concluída"}}';
    }
    if (request.model === "main") return plan(dev, research);
    if (request.model === "dev") throw new Error("Private provider body");
    return "Pesquisa concluída";
  });
  const result = await main.run({ sessionId: "partial-indexed", message: "Compare", context: context() },
    (message) => { messages.push(message); });
  assert.equal(result.kind, "finished");
  if (result.kind === "finished") {
    assert.equal(result.checkpoint.status, "failed");
    assert.deepEqual(result.checkpoint.steps.map(({ status }) => status), ["failed", "completed"]);
  }
  assert.match(messages.at(-1)?.text ?? "", /Pesquisa concluída.*Falhas/s);
  assert.doesNotMatch(messages.at(-1)?.text ?? "", /Private provider body/);
});
