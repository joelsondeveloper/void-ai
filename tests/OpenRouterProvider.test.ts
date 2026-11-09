import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { DevAgent } from "../src/agents/DevAgent.js";
import { ResearchAgent } from "../src/agents/ResearchAgent.js";
import { ModelRouter } from "../src/models/ModelRouter.js";
import {
  OpenRouterError,
  OpenRouterProvider,
  type OpenRouterDiagnostic,
} from "../src/models/providers/OpenRouterProvider.js";
import { createRuntimeStepRunner } from "../src/orchestration/RuntimeStepRunner.js";
import { AgentRegistry } from "../src/runtime/AgentRegistry.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import { PlanExecutor } from "../src/runtime/PlanExecutor.js";
import type { ModelRequest } from "../src/types/model.js";

const key = "test-secret-key";
const request: ModelRequest = {
  model: "vendor/requested:free",
  messages: [{ role: "user", content: "Private prompt" }],
  maxOutputTokens: 123,
};
const model = "vendor/served:free";
const usage = { prompt_tokens: 14, completion_tokens: 8 };

function completion(message: object = { content: "Final answer" }, finishReason: unknown = "stop") {
  return { model, choices: [{ finish_reason: finishReason, message }], usage };
}

function mockResponse(t: TestContext, data: unknown, status = 200): void {
  t.mock.method(globalThis, "fetch", async () => Response.json(data, { status }));
}

function captureDiagnostics() {
  const events: OpenRouterDiagnostic[] = [];
  const provider = new OpenRouterProvider(key, (event) => { events.push(event); });
  return { provider, events };
}

function failure(category: OpenRouterError["category"], message: RegExp) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof OpenRouterError);
    assert.equal(error.category, category);
    assert.match(error.message, message);
    return true;
  };
}

test("OpenRouter sends the configured request and exposes only safe diagnostics", async (t) => {
  const { provider, events } = captureDiagnostics();
  const controller = new AbortController();
  const data = completion({ content: "Final answer", reasoning: "Private reasoning" });
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${key}`);
    assert.equal(init.redirect, "error");
    assert.ok(init.signal && !init.signal.aborted);
    assert.deepEqual(JSON.parse(String(init.body)), {
      model: request.model, messages: request.messages, max_tokens: 123,
    });
    return Response.json({
      ...data,
      usage: { ...usage, completion_tokens_details: { reasoning_tokens: 3 } },
    });
  });

  const metrics = { inputTokens: 14, outputTokens: 8, reasoningTokens: 3 };
  assert.deepEqual(await provider.generate({ ...request, signal: controller.signal }), {
    model, content: "Final answer", usage: metrics,
  });
  assert.deepEqual(events, [{
    provider: "openrouter",
    requestedModel: request.model,
    maxOutputTokens: 123,
    returnedModel: model,
    httpStatus: 200,
    finishReason: "stop",
    contentType: "string",
    contentLength: 12,
    hasReasoning: true,
    usageStatus: "available",
    usage: metrics,
  }]);
  assert.doesNotMatch(JSON.stringify(events), /test-secret-key|Private prompt|Private reasoning|Final answer/);
});

for (const [description, message] of [
  ["null", { content: null, reasoning: "Private reasoning" }],
  ["missing", {}],
  ["empty", { content: " \n " }],
] as const) {
  test(`OpenRouter rejects ${description} final text`, async (t) => {
    mockResponse(t, completion(message));
    const { provider, events } = captureDiagnostics();

    await assert.rejects(provider.generate(request),
      failure("missing_content", new RegExp(`content=${description}`)));
    assert.equal(events[0]?.failure, "missing_content");
    assert.equal(events[0]?.hasReasoning, description === "null");
    assert.doesNotMatch(JSON.stringify(events), /Private reasoning/);
  });
}

test("OpenRouter rejects an empty choices array", async (t) => {
  mockResponse(t, { model, choices: [] });
  await assert.rejects(new OpenRouterProvider(key).generate(request),
    failure("invalid_response", /no choices/));
});

for (const [description, data, expected] of [
  ["response envelope", [], /model and choices/],
  ["message", { model, choices: [{ message: [] }] }, /invalid message/],
  ["non-text content", completion({ content: [] }), /content must be text/],
  ["missing finish reason", completion({ content: "Text" }, null), /missing finish_reason/],
  ["unsupported finish reason", completion({ content: "Text" }, "provider-specific"), /unrecognized finish_reason/],
] as const) {
  test(`OpenRouter rejects invalid ${description}`, async (t) => {
    mockResponse(t, data);
    await assert.rejects(new OpenRouterProvider(key).generate(request),
      failure("invalid_response", expected));
  });
}

test("OpenRouter treats a non-JSON success body as invalid", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("not JSON"));
  await assert.rejects(new OpenRouterProvider(key).generate(request),
    failure("invalid_response", /not JSON/));
});

test("OpenRouter preserves HTTP and API codes without exposing the error payload", async (t) => {
  mockResponse(t, { error: {
    code: 429,
    message: "Private provider error and test-secret-key",
    metadata: { error_type: "rate_limit_exceeded", raw: "Private prompt" },
  } }, 429);
  const { provider, events } = captureDiagnostics();
  await assert.rejects(provider.generate(request), {
    name: "OpenRouterError",
    category: "http",
    message: "OpenRouter HTTP 429 (API code 429, rate_limit_exceeded).",
  });
  assert.equal(events[0]?.httpStatus, 429);
  assert.equal(events[0]?.apiCode, 429);
  assert.equal(events[0]?.apiErrorType, "rate_limit_exceeded");
  assert.doesNotMatch(JSON.stringify(events), /test-secret-key|Private/);
});

test("OpenRouter preserves HTTP status when the error body is unexpected", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("<html>Private upstream text</html>", { status: 503 }));
  await assert.rejects(new OpenRouterProvider(key).generate(request), {
    category: "http",
    message: "OpenRouter HTTP 503 (no structured API error).",
  });
});

for (const [location, body] of [
  ["envelope", { error: { code: 502, metadata: { error_type: "provider_unavailable" } } }],
  ["choice", { model, choices: [{
    finish_reason: "error",
    message: { content: "Partial text" },
    error: { code: 502, metadata: { error_type: "provider_unavailable" } },
  }] }],
] as const) {
  test(`OpenRouter rejects an API error in a 200 ${location}`, async (t) => {
    mockResponse(t, body);
    await assert.rejects(new OpenRouterProvider(key).generate(request),
      failure("api", /API code 502, provider_unavailable/));
  });
}

test("OpenRouter rejects partial text when the generation reaches the token limit", async (t) => {
  mockResponse(t, completion({ content: "Partial code" }, "length"));
  const { provider, events } = captureDiagnostics();
  await assert.rejects(provider.generate(request), failure("incomplete", /output token limit/));
  assert.equal(events[0]?.finishReason, "length");
  assert.equal(events[0]?.contentLength, 12);
  assert.equal(events[0]?.failure, "incomplete");
  assert.doesNotMatch(JSON.stringify(events), /Partial code/);
});

test("OpenRouter identifies a token limit when only reasoning was generated", async (t) => {
  mockResponse(t, {
    ...completion({ content: null, reasoning: "Private reasoning" }, "length"),
    usage: { ...usage, completion_tokens_details: { reasoning_tokens: 8 } },
  });
  const { provider, events } = captureDiagnostics();
  await assert.rejects(provider.generate(request), failure("incomplete", /output token limit/));
  assert.equal(events[0]?.finishReason, "length");
  assert.equal(events[0]?.contentType, "null");
  assert.equal(events[0]?.usage?.reasoningTokens, 8);
});

test("OpenRouter rejects non-text completion modes even if partial text exists", async (t) => {
  mockResponse(t, completion({ content: "Partial text" }, "tool_calls"));
  await assert.rejects(new OpenRouterProvider(key).generate(request),
    failure("incomplete", /finish_reason=tool_calls/));
});

for (const [description, metrics] of [["missing", undefined], ["null", null]] as const) {
  test(`OpenRouter leaves ${description} usage unavailable`, async (t) => {
    mockResponse(t, { ...completion(), usage: metrics });
    const { provider, events } = captureDiagnostics();
    assert.deepEqual(await provider.generate(request), { model, content: "Final answer" });
    assert.equal(events[0]?.usageStatus, "unavailable");
    assert.equal(events[0]?.usage, undefined);
  });
}

test("OpenRouter rejects invalid token metrics", async (t) => {
  mockResponse(t, { ...completion(), usage: { prompt_tokens: 1.5, completion_tokens: 8 } });
  const { provider, events } = captureDiagnostics();
  await assert.rejects(provider.generate(request), failure("invalid_response", /invalid usage/));
  assert.equal(events[0]?.usageStatus, "invalid");
  assert.equal(events[0]?.usage, undefined);
});

test("OpenRouter preserves complete text when the optional reasoning breakdown is inconsistent", async (t) => {
  mockResponse(t, {
    ...completion(),
    usage: { ...usage, completion_tokens_details: { reasoning_tokens: 11 } },
  });
  const { provider, events } = captureDiagnostics();
  assert.deepEqual(await provider.generate(request), { model, content: "Final answer" });
  assert.equal(events[0]?.usageStatus, "invalid");
  assert.equal(events[0]?.usageIssue, "invalid_reasoning_breakdown");
  assert.equal(events[0]?.usage, undefined);
});

test("OpenRouter distinguishes network failures from invalid responses", async (t) => {
  t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("Private connection detail", { cause: { code: "ECONNRESET" } });
  });
  const { provider, events } = captureDiagnostics();
  await assert.rejects(provider.generate(request), {
    category: "transport",
    message: "OpenRouter transport failure while sending the request (ECONNRESET).",
  });
  assert.equal(events[0]?.failure, "transport");
  assert.equal(events[0]?.transportCode, "ECONNRESET");
});

test("OpenRouter preserves a pre-aborted signal without dispatching a request", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json(completion()));
  const { provider, events } = captureDiagnostics();
  const controller = new AbortController();
  const reason = new Error("Cancelled");
  controller.abort(reason);
  await assert.rejects(provider.generate({ ...request, signal: controller.signal }), (error) => error === reason);
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(events[0]?.failure, "cancelled");
});

test("OpenRouter preserves cancellation during fetch", async (t) => {
  const controller = new AbortController();
  const reason = new Error("Cancelled during fetch");
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    assert.equal(init.redirect, "error");
    assert.ok(init.signal && !init.signal.aborted);
    return new Promise<Response>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
  });
  const { provider, events } = captureDiagnostics();
  const outcome = assert.rejects(provider.generate({ ...request, signal: controller.signal }), (error) => error === reason);
  controller.abort(reason);
  await outcome;
  assert.equal(events[0]?.failure, "cancelled");
});

test("OpenRouter preserves cancellation during response body consumption", async (t) => {
  const controller = new AbortController();
  const reason = new Error("Cancelled during response body");
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(stream) {
      controller.signal.addEventListener("abort", () => stream.error(controller.signal.reason), { once: true });
    },
  })));
  const { provider, events } = captureDiagnostics();
  const outcome = assert.rejects(provider.generate({ ...request, signal: controller.signal }), (error) => error === reason);
  await Promise.resolve();
  controller.abort(reason);
  await outcome;
  assert.equal(events[0]?.httpStatus, 200);
  assert.equal(events[0]?.failure, "cancelled");
});

test("OpenRouter ignores a failing diagnostic consumer", async (t) => {
  mockResponse(t, completion());
  const provider = new OpenRouterProvider(key, async () => { throw new Error("Consumer failed"); });
  assert.equal((await provider.generate(request)).content, "Final answer");
});

test("The runtime preserves the completed specialist when another OpenRouter generation is incomplete", async (t) => {
  const requests: Array<{ model: unknown; limit: unknown }> = [];
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body: unknown = JSON.parse(String(init.body));
    assert.ok(typeof body === "object" && body !== null && "model" in body && "max_tokens" in body);
    requests.push({ model: body.model, limit: body.max_tokens });
    const data = body.model === "vendor/dev:free" ? completion() : completion({ content: "Partial text" }, "length");
    return Response.json(data);
  });
  const router = new ModelRouter([new OpenRouterProvider(key)]);
  const registry = new AgentRegistry();
  registry.register(new DevAgent(router, { providerId: "openrouter", model: "vendor/dev:free", maxOutputTokens: 900 }));
  registry.register(new ResearchAgent(router, { providerId: "openrouter", model: "vendor/research:free", maxOutputTokens: 800 }));
  const runStep = createRuntimeStepRunner(new AgentRuntime(registry), {
    executionId: "openrouter-partial-plan",
    permissions: new Set(),
    budgetLimit: 0,
    signal: new AbortController().signal,
    metadata: {},
  });

  const result = await new PlanExecutor().executePlan([
    { id: "A", agentId: "dev-agent", objective: "Review this code", dependsOn: [] },
    { id: "B", agentId: "research-agent", objective: "Compare this evidence", dependsOn: [] },
  ], runStep, 2);

  assert.deepEqual(requests, [
    { model: "vendor/dev:free", limit: 900 },
    { model: "vendor/research:free", limit: 800 },
  ]);
  assert.equal(result.get("A")?.status, "completed");
  assert.equal(result.get("A")?.output, "Final answer");
  assert.equal(result.get("A")?.error, null);
  assert.equal(result.get("B")?.status, "failed");
  assert.equal(result.get("B")?.output, null);
  assert.match(result.get("B")?.error ?? "", /generation incomplete: output token limit/);
});
