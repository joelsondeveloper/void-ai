import assert from "node:assert/strict";
import test from "node:test";

import { runToolLoop, ToolInputError, type LoopTool, type ToolLoopTurn } from "../src/conversation/toolLoop.js";
import { ExecutionError } from "../src/types/failure.js";
import type { ModelMessage, ModelResponse, ModelToolCall } from "../src/types/model.js";

const model = "test/model";
const ask = (id: string, name: string, args: unknown = {}): ModelToolCall =>
  ({ id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
const calls = (...toolCalls: ModelToolCall[]): ModelResponse => ({ model, content: "", toolCalls });
const text = (content: string): ModelResponse => ({ model, content });
const start: ModelMessage[] = [{ role: "system", content: "sistema" }, { role: "user", content: "oi" }];

function tool(name: string, run: LoopTool["run"]): LoopTool {
  return { label: name, spec: { name, description: name, parameters: { type: "object", properties: {} } }, run };
}

function scripted(...replies: ModelResponse[]) {
  const turns: ToolLoopTurn[] = [];
  return { turns, generate: async (turn: ToolLoopTurn): Promise<ModelResponse> => {
    turns.push(turn);
    const reply = replies[turns.length - 1];
    assert.ok(reply, "unexpected extra model call");
    return reply;
  } };
}

const base = { messages: start, maxIterations: 5, signal: new AbortController().signal };

test("a plain answer takes one call and offers no tool choice when there are no tools", async () => {
  const { turns, generate } = scripted({ ...text("  Bom dia.  "), usage: { inputTokens: 3, outputTokens: 2 } });
  const result = await runToolLoop({ ...base, tools: [], generate });
  assert.equal(result.content, "Bom dia.");
  assert.equal(result.iterations, 1);
  assert.equal(result.toolCalls, 0);
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2 });
  assert.equal(turns[0]?.toolChoice, "none");
  assert.deepEqual(turns[0]?.tools, []);
});

test("tool calls run in parallel, results return in call order with their ids, and usage accumulates", async () => {
  const order: string[] = [];
  const release: Array<() => void> = [];
  const slow = tool("slow", () => new Promise((resolve) => { order.push("slow:start"); release.push(() => { order.push("slow:end"); resolve("lento"); }); }));
  const fast = tool("fast", async () => { order.push("fast"); release[0]?.(); return "rápido"; });
  const { turns, generate } = scripted(
    { ...calls(ask("a", "slow"), ask("b", "fast")), usage: { inputTokens: 5, outputTokens: 1 } },
    { ...text("Feito."), usage: { inputTokens: 9, outputTokens: 2, reasoningTokens: 1 } });
  const result = await runToolLoop({ ...base, tools: [slow, fast], generate });
  // fast ran while slow was still pending, which only happens with parallel execution.
  assert.deepEqual(order, ["slow:start", "fast", "slow:end"]);
  assert.equal(result.content, "Feito.");
  assert.equal(result.toolCalls, 2);
  assert.deepEqual(result.usage, { inputTokens: 14, outputTokens: 3, reasoningTokens: 1 });
  const second = turns[1]?.messages ?? [];
  assert.deepEqual(second.slice(-3).map(({ role, toolCallId, content }) => ({ role, toolCallId, content })), [
    { role: "assistant", toolCallId: undefined, content: "" },
    { role: "tool", toolCallId: "a", content: "lento" },
    { role: "tool", toolCallId: "b", content: "rápido" },
  ]);
  assert.equal(second.at(-3)?.toolCalls?.length, 2);
  assert.equal(turns[0]?.toolChoice, "auto");
});

test("the initial messages are never mutated", async () => {
  const snapshot = structuredClone(start);
  const { generate } = scripted(calls(ask("a", "t")), text("ok"));
  await runToolLoop({ ...base, tools: [tool("t", async () => "r")], generate });
  assert.deepEqual(start, snapshot);
});

test("bad arguments, unknown tools and tool failures become results the model can recover from", async () => {
  const failing = tool("failing", async () => { throw new Error("segredo interno: /etc/passwd"); });
  const strict = tool("strict", async () => { throw new ToolInputError("task precisa ser texto."); });
  const specialist = tool("specialist", async () => { throw new ExecutionError({ category: "timeout", message: "Tempo esgotado.", retryable: false }); });
  const never = tool("never", async () => { throw new Error("não deveria rodar"); });
  const { turns, generate } = scripted(
    calls(ask("1", "never", "{não é json"), ask("2", "ghost"), ask("3", "failing"), ask("4", "strict"), ask("5", "specialist")),
    text("Resolvi sem elas."));
  const result = await runToolLoop({ ...base, maxToolCallsPerTurn: 5, tools: [never, failing, strict, specialist], generate });
  assert.equal(result.content, "Resolvi sem elas.");
  const results = (turns[1]?.messages ?? []).filter(({ role }) => role === "tool").map(({ content }) => content);
  assert.match(results[0] ?? "", /^Erro: os argumentos não são JSON válido/);
  assert.match(results[1] ?? "", /^Erro: a ferramenta ghost não existe\. Disponíveis: never, failing, strict, specialist/);
  assert.equal(results[2], "Erro: Execution failed.");
  assert.equal(results[3], "Erro: task precisa ser texto.");
  assert.equal(results[4], "Erro: Tempo esgotado.");
  assert.ok(results.every((value) => !value.includes("/etc/passwd")));
});

test("empty arguments are treated as an empty object", async () => {
  let received: unknown;
  const { generate } = scripted(calls(ask("a", "t", "")), text("ok"));
  await runToolLoop({ ...base, tools: [tool("t", async (args) => { received = args; return "r"; })], generate });
  assert.deepEqual(received, {});
});

test("calls beyond the per-turn limit are answered with an error instead of left dangling", async () => {
  let runs = 0;
  const counted = tool("t", async () => { runs++; return "ok"; });
  const { turns, generate } = scripted(
    calls(ask("1", "t"), ask("2", "t"), ask("3", "t")), text("pronto"));
  const result = await runToolLoop({ ...base, maxToolCallsPerTurn: 2, tools: [counted], generate });
  assert.equal(runs, 2);
  assert.equal(result.toolCalls, 2);
  const tools = (turns[1]?.messages ?? []).filter(({ role }) => role === "tool");
  assert.deepEqual(tools.map(({ toolCallId }) => toolCallId), ["1", "2", "3"]);
  assert.match(tools[2]?.content ?? "", /^Erro: limite de 2 chamadas por vez/);
});

test("long tool results are truncated", async () => {
  const { turns, generate } = scripted(calls(ask("a", "t")), text("ok"));
  await runToolLoop({ ...base, maxResultChars: 10, tools: [tool("t", async () => "x".repeat(50))], generate });
  assert.equal(turns[1]?.messages.at(-1)?.content, "xxxxxxxxxx\n[resultado truncado]");
});

test("the last allowed call is made with tools disabled so the loop always ends in text", async () => {
  const { turns, generate } = scripted(calls(ask("a", "t")), calls(ask("b", "t")), text("fim"));
  const result = await runToolLoop({ ...base, maxIterations: 3, tools: [tool("t", async () => "r")], generate });
  assert.equal(result.content, "fim");
  assert.deepEqual(turns.map(({ toolChoice }) => toolChoice), ["auto", "auto", "none"]);
});

test("the caller can force the final answer earlier", async () => {
  const { turns, generate } = scripted(calls(ask("a", "t")), text("fim"));
  await runToolLoop({ ...base, forceFinal: (iteration) => iteration >= 1, tools: [tool("t", async () => "r")], generate });
  assert.deepEqual(turns.map(({ toolChoice }) => toolChoice), ["auto", "none"]);
});

test("a model that keeps asking for tools after they are disabled fails with a clear error", async () => {
  const { generate } = scripted(calls(ask("a", "t")), calls(ask("b", "t")));
  await assert.rejects(runToolLoop({ ...base, maxIterations: 2, tools: [tool("t", async () => "r")], generate }),
    (error: unknown) => {
      assert.ok(error instanceof ExecutionError);
      assert.equal(error.failure.code, "tool_loop_exhausted");
      return true;
    });
});

test("an empty final answer is an error, not a silent blank reply", async () => {
  const { generate } = scripted(text("   "));
  await assert.rejects(runToolLoop({ ...base, tools: [], generate }), (error: unknown) => {
    assert.ok(error instanceof ExecutionError);
    assert.equal(error.failure.code, "empty_reply");
    return true;
  });
});

test("cancellation during a tool propagates instead of becoming a tool result", async () => {
  const controller = new AbortController();
  const aborting = tool("t", async () => { controller.abort(); throw new Error("ignored"); });
  const { generate } = scripted(calls(ask("a", "t")), text("não deveria chegar aqui"));
  await assert.rejects(runToolLoop({ ...base, signal: controller.signal, tools: [aborting], generate }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError");
});

test("onToolStart reports each tool that actually runs", async () => {
  const started: string[] = [];
  const { generate } = scripted(calls(ask("a", "one"), ask("b", "ghost")), text("ok"));
  await runToolLoop({ ...base, tools: [tool("one", async () => "r")], generate,
    onToolStart: (started_, call) => { started.push(`${started_.label}:${call.id}`); } });
  assert.deepEqual(started, ["one:a"]);
});

test("an invalid iteration limit is rejected", async () => {
  await assert.rejects(runToolLoop({ ...base, maxIterations: 0, tools: [], generate: async () => text("x") }), /Invalid tool loop/);
});
