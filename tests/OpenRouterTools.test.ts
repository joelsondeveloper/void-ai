import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { ExecutionError } from "../src/types/failure.js";
import { OpenRouterFreeCatalog } from "../src/models/providers/OpenRouterFreeCatalog.js";
import { OpenRouterError, OpenRouterProvider } from "../src/models/providers/OpenRouterProvider.js";
import type { ModelRequest, ModelToolSpec } from "../src/types/model.js";

const key = "test-secret-key";
const model = "vendor/served:free";
const usage = { prompt_tokens: 14, completion_tokens: 8 };
const askDev: ModelToolSpec = {
  name: "ask_dev", description: "Revisa código.",
  parameters: { type: "object", properties: { task: { type: "string" } }, required: ["task"] },
};
const request: ModelRequest = {
  model: "vendor/requested:free",
  messages: [{ role: "user", content: "Revise esta função" }],
  tools: [askDev],
};
const call = (extra: object = {}) => ({
  id: "call_1", type: "function", function: { name: "ask_dev", arguments: JSON.stringify({ task: "Revise" }) }, ...extra,
});
const toolCompletion = (calls: unknown[], reason: unknown = "tool_calls", content: unknown = null) =>
  ({ model, usage, choices: [{ finish_reason: reason, message: { content, tool_calls: calls } }] });

function mockResponse(t: TestContext, data: unknown): void {
  t.mock.method(globalThis, "fetch", async () => Response.json(data));
}

test("tools and tool_choice are sent in the OpenAI function format, and tool messages are mapped", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.deepEqual(body.tools, [{ type: "function", function: askDev }]);
    assert.equal(body.tool_choice, "none");
    assert.deepEqual(body.messages, [
      { role: "user", content: "Revise esta função" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function",
        function: { name: "ask_dev", arguments: "{\"task\":\"Revise\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "Cheque o caso limite." },
    ]);
    return Response.json({ model, usage, choices: [{ finish_reason: "stop", message: { content: "Pronto." } }] });
  });
  const response = await new OpenRouterProvider(key).generate({
    ...request, toolChoice: "none",
    messages: [...request.messages,
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "ask_dev", arguments: "{\"task\":\"Revise\"}" }] },
      { role: "tool", toolCallId: "call_1", content: "Cheque o caso limite." }],
  });
  assert.equal(response.content, "Pronto.");
  assert.equal(response.toolCalls, undefined);
});

test("a tool-call completion returns the parsed calls with no text and skips content validation", async (t) => {
  mockResponse(t, toolCompletion([call()]));
  let validated = false;
  const response = await new OpenRouterProvider(key).generate({ ...request, validateContent: () => { validated = true; } });
  assert.deepEqual(response.toolCalls, [{ id: "call_1", name: "ask_dev", arguments: "{\"task\":\"Revise\"}" }]);
  assert.equal(response.content, "");
  assert.deepEqual(response.usage, { inputTokens: 14, outputTokens: 8 });
  assert.equal(validated, false);
});

test("a provider that reports finish_reason stop together with tool calls is still honored", async (t) => {
  mockResponse(t, toolCompletion([call()], "stop", "Vou checar."));
  const response = await new OpenRouterProvider(key).generate(request);
  assert.equal(response.content, "Vou checar.");
  assert.equal(response.toolCalls?.length, 1);
});

for (const [description, calls] of [
  ["an invalid tool name", [call({ function: { name: "ask dev!", arguments: "{}" } })]],
  ["non-text arguments", [call({ function: { name: "ask_dev", arguments: { task: "x" } } })]],
  ["duplicate ids", [call(), call()]],
  ["too many calls", Array.from({ length: 9 }, (_, index) => call({ id: `call_${index}` }))],
] as const) {
  test(`OpenRouter rejects ${description} in a tool call`, async (t) => {
    mockResponse(t, toolCompletion([...calls]));
    await assert.rejects(new OpenRouterProvider(key).generate(request), (error: unknown) => {
      assert.ok(error instanceof OpenRouterError);
      assert.equal(error.category, "invalid_response");
      return true;
    });
  });
}

test("tool calls stay rejected when the request offered no tools", async (t) => {
  mockResponse(t, toolCompletion([call()]));
  const { tools: _tools, ...plain } = request;
  await assert.rejects(new OpenRouterProvider(key).generate(plain), /finish_reason=tool_calls/);
});

test("streamed tool call fragments are assembled by index", async (t) => {
  const event = (data: object) => `data: ${JSON.stringify(data)}\n\n`;
  const body = [
    event({ model, choices: [{ delta: { content: "Vou ver. " } }] }),
    event({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "ask_dev", arguments: "" } }] } }] }),
    event({ choices: [{ delta: { tool_calls: [{ index: 1, id: "call_2", function: { name: "ask_research", arguments: "{\"task\":\"b\"}" } }] } }] }),
    event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"task\":" } }] } }] }),
    event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"a\"}" } }] }, finish_reason: "tool_calls" }], usage }),
    "data: [DONE]\n\n",
  ].join("");
  t.mock.method(globalThis, "fetch", async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
  const texts: string[] = [];
  const response = await new OpenRouterProvider(key).generate({ ...request, onText: (text) => { texts.push(text); } });
  assert.deepEqual(response.toolCalls, [
    { id: "call_1", name: "ask_dev", arguments: "{\"task\":\"a\"}" },
    { id: "call_2", name: "ask_research", arguments: "{\"task\":\"b\"}" },
  ]);
  assert.equal(response.content, "Vou ver. ");
  assert.deepEqual(texts, ["Vou ver. "]);
});

function catalogFor(supported: string[]): OpenRouterFreeCatalog {
  return new OpenRouterFreeCatalog((async () => Response.json({ data: [{
    id: "vendor/requested:free", pricing: { prompt: "0", completion: "0" },
    context_length: 100_000, supported_parameters: supported,
  }] })) as typeof fetch);
}

test("a free model without catalog support for tools is refused before any request is sent", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  const provider = new OpenRouterProvider(key, undefined, catalogFor(["response_format"]));
  await assert.rejects(provider.generate(request), (error: unknown) => {
    assert.ok(error instanceof ExecutionError);
    assert.equal(error.failure.code, "tools_unsupported");
    return true;
  });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("a free model that supports tools is called with required parameters", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.provider.require_parameters, true);
    assert.equal(body.provider.allow_fallbacks, false);
    return Response.json(toolCompletion([call()]));
  });
  const provider = new OpenRouterProvider(key, undefined, catalogFor(["tools", "response_format"]));
  assert.equal((await provider.generate(request)).toolCalls?.length, 1);
});
