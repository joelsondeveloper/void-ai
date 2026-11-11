import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DevAgent } from "../src/agents/DevAgent.js";
import { MainAgent } from "../src/agents/MainAgent.js";
import { ResearchAgent } from "../src/agents/ResearchAgent.js";
import { SQLiteConversationStore } from "../src/conversation/ConversationStore.js";
import { parseDecision } from "../src/conversation/mainDecision.js";
import { parseSynthesis } from "../src/conversation/synthesis.js";
import { limitBenchmarkProvider } from "../src/examples/benchmarkModels.js";
import { SQLiteCheckpointStore } from "../src/governance/CheckpointStore.js";
import { ExecutionGovernance } from "../src/governance/ExecutionGovernance.js";
import { resolveEffort } from "../src/governance/effort.js";
import { ModelRouter } from "../src/models/ModelRouter.js";
import { freeModelIds, liveModelRoutes, selectOpenRouterRoutes } from "../src/models/modelSelection.js";
import { freeOnlyAuthorization } from "../src/models/costAuthorization.js";
import { OpenRouterFreeCatalog } from "../src/models/providers/OpenRouterFreeCatalog.js";
import { OpenRouterProvider } from "../src/models/providers/OpenRouterProvider.js";
import { AgentRegistry } from "../src/runtime/AgentRegistry.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import type { AgentContext } from "../src/types/context.js";
import type { ModelRequest, ModelRoutes } from "../src/types/model.js";
import { ExecutionError } from "../src/types/failure.js";

const chatRequest: ModelRequest = {
  model: freeModelIds.lightning,
  messages: [{ role: "user", content: "Synthetic text" }],
  maxOutputTokens: 10,
};

const pricing = { prompt: "0", completion: "0" };
const catalogBody = (...ids: string[]) => ({ data: ids.map((id) => ({ id, pricing })) });

test("free routing follows each effort and auto resolves conservatively", () => {
  const expected = [
    ["low", freeModelIds.superVl, 5],
    ["medium", freeModelIds.superVl, 15],
    ["high", freeModelIds.superVl, 30],
    ["max", freeModelIds.superVl, 60],
  ] as const;
  for (const [level, general, calls] of expected) {
    const routes = liveModelRoutes(level, {});
    assert.equal(routes.decision.model, general);
    assert.equal(routes.synthesis.model, freeModelIds.superVl);
    assert.equal(routes["research-agent"]?.model, freeModelIds.ultra);
    assert.deepEqual(routes["research-agent"]?.reasoning, { effort: "none" });
    assert.equal(routes["dev-agent"]?.model, freeModelIds.north);
    assert.equal(resolveEffort(level).limits.calls, calls);
  }
  const auto = liveModelRoutes(resolveEffort("auto").effort, {}).decision;
  assert.equal(auto.model, freeModelIds.superVl);
  assert.deepEqual(auto.reasoning, { enabled: false });
  assert.equal(liveModelRoutes("low", { VOID_MAIN_REASONING_EFFORT_LOW: "default" }).decision.reasoning, undefined);
  assert.equal(liveModelRoutes("high", {}).decision.maxOutputTokens, undefined);
});

test("per-role, per-effort overrides stay isolated and reject unsafe configuration", () => {
  const env = { VOID_DEV_MODEL: "vendor/general:free", VOID_DEV_MODEL_HIGH: "vendor/high:free",
    VOID_DEV_MAX_OUTPUT_TOKENS_HIGH: "2345", VOID_SYNTHESIS_MODEL_HIGH: "openrouter/free" };
  const high = liveModelRoutes("high", env);
  assert.equal(high["dev-agent"]?.model, "vendor/high:free");
  assert.equal(high["dev-agent"]?.maxOutputTokens, 2345);
  assert.equal(high.decision.model, freeModelIds.superVl);
  assert.equal(high.synthesis.model, "openrouter/free");
  assert.equal(high["research-agent"]?.model, freeModelIds.ultra);
  assert.equal(liveModelRoutes("low", env)["dev-agent"]?.model, "vendor/general:free");
  assert.equal(liveModelRoutes("low", { VOID_RESEARCH_MODEL: freeModelIds.dots })["research-agent"]?.reasoning, undefined);
  assert.equal(liveModelRoutes("medium", { VOID_RESEARCH_REASONING_EFFORT: "default" })["research-agent"]?.reasoning, undefined);
  assert.throws(() => liveModelRoutes("high", { VOID_MAIN_MODEL: "vendor/paid" }), /modelo :free/);
  assert.throws(() => liveModelRoutes("low", { VOID_DEV_MAX_OUTPUT_TOKENS: "1.5" }), /inteiro/);
});

test("selection can describe a paid model while the active cost policy rejects it", () => {
  const selected = selectOpenRouterRoutes("low", { VOID_DEV_MODEL: "vendor/paid" });
  assert.equal(selected["dev-agent"]?.model, "vendor/paid");
  const policy = freeOnlyAuthorization(["trusted-local", "openrouter"]);
  assert.equal(policy.permits("openrouter", selected["dev-agent"]?.model ?? ""), false);
  assert.equal(policy.permits("trusted-local", "local-model"), true);
  assert.equal(policy.permits("untrusted-provider", "model:free"), false);
  assert.throws(() => liveModelRoutes("low", { VOID_DEV_MODEL: "vendor/paid" }), /modelo :free/);
});

test("verified reasoning settings are sent explicitly and remain distinct from generation limits", async (t) => {
  const catalog = new OpenRouterFreeCatalog(async () => Response.json({ data: [{
    id: freeModelIds.ultra, pricing, supported_parameters: ["reasoning"],
    reasoning: { mandatory: false, supported_efforts: ["none", "medium"], supports_max_tokens: true },
  }] }));
  const requests: Array<{ reasoning: unknown; max_tokens: number; provider: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (_input: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return Response.json({ model: freeModelIds.ultra,
      choices: [{ finish_reason: "stop", message: { content: "Final text" } }] });
  });
  const provider = new OpenRouterProvider("test-key", undefined, catalog);
  const request = { ...chatRequest, model: freeModelIds.ultra, maxOutputTokens: 300 };
  await provider.generate({ ...request, reasoning: { effort: "none" } });
  await provider.generate({ ...request, reasoning: { maxTokens: 100, exclude: true } });
  assert.deepEqual(requests.map(({ reasoning }) => reasoning), [{ effort: "none" }, { max_tokens: 100, exclude: true }]);
  assert.ok(requests.every(({ max_tokens }) => max_tokens === 300));
  assert.deepEqual(requests[0]?.provider, {
    allow_fallbacks: false, require_parameters: true, max_price: { prompt: 0, completion: 0, request: 0 },
  });
});

test("unsupported, ambiguous and invalid reasoning configurations never dispatch", async (t) => {
  const catalog = new OpenRouterFreeCatalog(async () => Response.json({ data: [
    { id: freeModelIds.north, pricing },
    { id: freeModelIds.dots, pricing, supported_parameters: ["reasoning"], reasoning: { mandatory: false } },
    { id: freeModelIds.ultra, pricing, supported_parameters: ["reasoning"], reasoning: { mandatory: true, supported_efforts: null } },
  ] }));
  const api = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  const provider = new OpenRouterProvider("test-key", undefined, catalog);
  const request = { ...chatRequest, maxOutputTokens: 300 };
  for (const model of [freeModelIds.north, freeModelIds.dots, freeModelIds.ultra]) {
    await assert.rejects(provider.generate({ ...request, model, reasoning: { effort: "none" } }),
      (error) => error instanceof ExecutionError && error.failure.code === "reasoning_unsupported" &&
        error.failure.category === "permission_denied");
  }
  await assert.rejects(provider.generate({ ...request, reasoning: { effort: "none", maxTokens: 100 } }),
    (error) => error instanceof ExecutionError && error.failure.code === "reasoning_unverified" &&
      error.failure.category === "permission_denied");
  await assert.rejects(provider.generate({ ...request, reasoning: { maxTokens: 300 } }), /configuração válida/);
  assert.equal(api.mock.callCount(), 0);
});

test("reasoning without usable final text remains a failure with reported usage", async (t) => {
  const catalog = new OpenRouterFreeCatalog(async () => Response.json({ data: [{
    id: freeModelIds.ultra, pricing, supported_parameters: ["reasoning"],
    reasoning: { supported_efforts: ["medium"] },
  }] }));
  let finishReason = "stop";
  t.mock.method(globalThis, "fetch", async () => Response.json({
    model: freeModelIds.ultra, choices: [{ finish_reason: finishReason,
      message: { content: null, reasoning: "Private reasoning text" } }],
    usage: { prompt_tokens: 10, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 50 } },
  }));
  const provider = new OpenRouterProvider("test-key", undefined, catalog);
  const request = { ...chatRequest, model: freeModelIds.ultra, maxOutputTokens: 50, reasoning: { effort: "medium" as const } };
  await assert.rejects(provider.generate(request), (error) => {
    assert.ok(error instanceof ExecutionError);
    assert.equal(error.failure.category, "missing_content");
    assert.deepEqual(error.usage, { inputTokens: 10, outputTokens: 50, reasoningTokens: 50 });
    return true;
  });
  finishReason = "length";
  await assert.rejects(provider.generate(request),
    (error) => error instanceof ExecutionError && error.failure.category === "incomplete" && error.failure.finishReason === "length");
});

test("catalog verifies exact IDs and prices, coalesces refreshes and rejects stale evidence", async () => {
  let now = 0;
  let reads = 0;
  let unavailable = false;
  const catalog = new OpenRouterFreeCatalog(async (_input, init) => {
    reads++;
    assert.equal(init?.headers, undefined);
    return unavailable ? new Response(null, { status: 503 }) : Response.json({
      data: [
        ...catalogBody(freeModelIds.lightning, freeModelIds.north).data,
        { id: "vendor/paid:free", pricing: { prompt: "0", completion: "0.001" } },
        { id: "vendor/unknown:free", pricing: { prompt: "0" } },
        { id: "vendor/request-fee:free", pricing: { ...pricing, request: "0.01" } },
        { id: "vendor/zero-without-variant", pricing },
        { id: "vendor/expired:free", pricing, expiration_date: "1970-01-01" },
      ],
    });
  }, () => now);
  await Promise.all([catalog.assertFree(freeModelIds.lightning), catalog.assertFree(freeModelIds.north)]);
  assert.equal(reads, 1);
  for (const id of ["vendor/paid:free", "vendor/unknown:free", "vendor/request-fee:free", "vendor/missing:free",
    "vendor/zero-without-variant", "vendor/expired:free"]) {
    await assert.rejects(catalog.assertFree(id), /não confirmou/);
  }
  assert.equal(reads, 1);
  now = 300_001;
  unavailable = true;
  await assert.rejects(catalog.assertFree(freeModelIds.lightning), /não confirmou/);
  assert.equal(reads, 2);
});

test("verified provider sends zero price ceilings, disables fallback and preserves 429", async (t) => {
  const catalog = new OpenRouterFreeCatalog(async () => Response.json(catalogBody(freeModelIds.lightning)));
  const api = t.mock.method(globalThis, "fetch", async (_input: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, freeModelIds.lightning);
    assert.deepEqual(body.provider, { allow_fallbacks: false, max_price: { prompt: 0, completion: 0, request: 0 } });
    assert.equal("models" in body, false);
    return Response.json({ error: { code: 429, message: "quota" } }, { status: 429 });
  });
  const provider = new OpenRouterProvider("test-key", undefined, catalog);
  await assert.rejects(provider.generate({ ...chatRequest, model: "vendor/missing:free" }), /não confirmou/);
  assert.equal(api.mock.callCount(), 0);
  await assert.rejects(provider.generate(chatRequest), (error: unknown) => {
    assert.ok(error && typeof error === "object" && "failure" in error);
    assert.deepEqual(error.failure, {
      category: "rate_limited", message: "OpenRouter HTTP 429 (API code 429).", retryable: true,
      provider: "openrouter", model: freeModelIds.lightning, httpStatus: 429,
    });
    return true;
  });
  assert.equal(api.mock.callCount(), 1);
});

test("verified provider keeps length termination as an incomplete generation", async (t) => {
  const catalog = new OpenRouterFreeCatalog(async () => Response.json(catalogBody(freeModelIds.lightning)));
  const api = t.mock.method(globalThis, "fetch", async () => Response.json({
    model: freeModelIds.lightning,
    choices: [{ finish_reason: "length", message: { content: "partial JSON" } }],
  }));
  const provider = new OpenRouterProvider("test-key", undefined, catalog);
  await assert.rejects(provider.generate(chatRequest), /output token limit/);
  assert.equal(api.mock.callCount(), 1);
});

test("the benchmark caps requests across turns and stops when quota is reported", async () => {
  let calls = 0;
  let quota = false;
  const base = { id: "local", async generate({ model }: ModelRequest) {
    calls++;
    return { model, content: "done" };
  } };
  const bounded = limitBenchmarkProvider(base, 2, () => quota);
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => bounded.generate(chatRequest)));
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 2);
  assert.equal(calls, 2);
  const stopped = limitBenchmarkProvider(base, 3, () => quota);
  quota = true;
  await assert.rejects(stopped.generate(chatRequest), /interrompido pela cota/);
  assert.equal(calls, 2);
});

test("accepts exactly one JSON fence and rejects surrounding prose or incomplete decisions", () => {
  const json = '{"mode":"direct","response":"Uma resposta."}';
  const fence = "```json\n" + json + "\n```";
  assert.deepEqual(parseDecision(fence, 4), { mode: "direct", response: "Uma resposta." });
  for (const input of ["Texto extra\n" + fence, fence + "\nOutro texto", fence + "\n" + fence, '{"mode":"direct"}', json.slice(0, -1)]) {
    assert.throws(() => parseDecision(input, 4), /decisão|JSON/);
  }
});

test("synthesis rejects missing steps, unknown IDs and invented quotes", () => {
  const evidence = new Map([["A", "Full first evidence"], ["B", "Second source"]]);
  for (const sources of [{ A: "first", C: "source" }, { A: "first" }, { A: "first", B: "invented" }]) {
    assert.throws(() => parseSynthesis(JSON.stringify({ answer: "A reply", sources }), evidence), /synthesis/);
  }
  assert.equal(parseSynthesis(JSON.stringify({ answer: "A reply", sources: { A: "first", B: "source" } }), evidence), "A reply");
});

test("a resumed checkpoint pins requested routes and records actual models", async () => {
  const checkpoints = new SQLiteCheckpointStore(":memory:");
  const conversations = new SQLiteConversationStore(":memory:");
  try {
    const requests: ModelRequest[] = [];
    const providerId = "local-routing";
    const router = new ModelRouter([{ id: providerId, async generate(request) {
      requests.push(request);
      const content = request.model === "decision-v1" ? JSON.stringify({
        mode: "delegate",
        steps: [
          { id: "A", agentId: "dev-agent", requiredCapability: "code-analysis", objective: "Review", dependsOn: [] },
          { id: "B", agentId: "research-agent", requiredCapability: "comparative-analysis", objective: "Compare", dependsOn: ["A"] },
        ],
      }) : request.model === "synthesis-v1"
        ? '{"answer":"Dev evidence and Research evidence","sources":{"A":"Dev evidence","B":"Research evidence"}}'
        : request.model === "dev-v1" ? "Dev evidence" : "Research evidence";
      return { model: "served/" + request.model, content, usage: { inputTokens: 2, outputTokens: 1 } };
    } }]);
    const registry = new AgentRegistry();
    registry.register(new DevAgent(router));
    registry.register(new ResearchAgent(router));
    const gov = new ExecutionGovernance(new AgentRuntime(registry), checkpoints, { trustedLocalProviders: [providerId] });
    const routeSet = (version: number): ModelRoutes => {
      const route = (role: string, maxOutputTokens: number) => ({ providerId, model: role + "-v" + version, maxOutputTokens });
      return { decision: route("decision", 120), synthesis: route("synthesis", 90),
        "dev-agent": route("dev", 60), "research-agent": { ...route("research", 80),
          reasoning: { effort: version === 1 ? "none" : "medium" } } };
    };
    const options = { providerId, model: "legacy" };
    const main = new MainAgent(router, registry, gov, conversations, { ...options, routesForEffort: (effort) => {
      assert.equal(effort, "high");
      return routeSet(1);
    } });
    const context: AgentContext = { executionId: "session", permissions: new Set(["code-analysis", "comparative-analysis"]),
      budgetLimit: 0, signal: new AbortController().signal, metadata: {} };
    const paused = await main.run({ sessionId: "session", message: "Review", context,
      effort: "high", limits: { calls: 2, concurrency: 1 } }, () => {});
    assert.equal(paused.kind, "paused");
    if (paused.kind !== "paused") return;
    assert.deepEqual(paused.checkpoint.modelRoutes, routeSet(1));

    const after = new MainAgent(router, registry, gov, conversations, { ...options, routesForEffort: () => routeSet(2) });
    const done = await after.resume("session", paused.checkpoint.id, context, { calls: 2 }, () => {});
    assert.equal(done.kind, "finished");
    if (done.kind !== "finished") return;
    assert.equal(done.checkpoint.status, "completed");
    assert.deepEqual(requests[2]?.reasoning, { effort: "none" });
    assert.match(requests[3]?.messages.at(-1)?.content ?? "", /Dev evidence.*Research evidence/);
    assert.deepEqual(requests.map(({ model, maxOutputTokens }) => [model, maxOutputTokens]),
      [["decision-v1", 120], ["dev-v1", 60], ["research-v1", 80], ["synthesis-v1", 90]]);
    assert.deepEqual(done.checkpoint.servedModels?.map(({ role, returned }) => [role, returned]),
      [["decision", "served/decision-v1"], ["dev-agent", "served/dev-v1"],
        ["research-agent", "served/research-v1"], ["synthesis", "served/synthesis-v1"]]);
  } finally {
    conversations.close();
    checkpoints.close();
  }
});

test("the terminal labels mock answers and requires credentials for explicit live mode", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "void-routing-cli-"));
  const db = join(directory, "chat.sqlite");
  t.after(() => { rmSync(db, { force: true }); rmdirSync(directory); });
  const env: NodeJS.ProcessEnv = { ...process.env, VOID_CHAT_DB: db, VOID_CHAT_SESSION: "routing-test",
    VOID_EFFORT: "auto", VOID_CHAT_MAX_CALLS: "4" };
  delete env.OPENROUTER_API_KEY;
  const command = [...process.execArgv, "src/examples/mainAgent.ts"];
  const local = spawnSync(process.execPath, [...command, "--mock"], { env, encoding: "utf8", timeout: 10_000,
    input: "/mode\n/effort high\n/models\nExplique a diferença entre concorrência e paralelismo em programação.\n" });
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /VOID MOCK/);
  assert.match(local.stdout, /"selected":"high"/);
  assert.match(local.stdout, /\[mock\] \[final\].*alternando.*simultaneamente/);
  const live = spawnSync(process.execPath, [...command, "--live"], { env, encoding: "utf8", timeout: 10_000 });
  assert.notEqual(live.status, 0);
  assert.match(live.stderr, /OPENROUTER_API_KEY é obrigatória/);
});


test("free catalog requires explicitly optional reasoning before disabling it", async () => {
  for (const mandatory of [false, true, undefined]) {
    const catalog = new OpenRouterFreeCatalog(async () => Response.json({ data: [{
      id: freeModelIds.lightning, pricing: { prompt: "0", completion: "0", request: "0" },
      supported_parameters: ["reasoning"], reasoning: { mandatory },
    }] }));
    const check = catalog.assertFree(freeModelIds.lightning, undefined, { enabled: false });
    if (mandatory === false) await check;
    else await assert.rejects(check, /não confirmou o controle/);
  }
});
