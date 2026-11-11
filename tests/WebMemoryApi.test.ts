import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import type { MemoryRecord } from "../src/conversation/MemoryStore.js";
import { createWebApi } from "../src/web/api.js";
import { createWebRuntime } from "../src/web/runtime.js";

const port = 3031;
const origin = "http://127.0.0.1:" + port;

/** Minimal response double: the API only needs these members. */
function capture() {
  const state = { status: 0, body: "", headersSent: false, destroyed: false, writableLength: 0 };
  return Object.assign(state, {
    setHeader() {},
    writeHead(status: number) { state.status = status; state.headersSent = true; },
    write(chunk: string) { state.body += chunk; },
    end(chunk?: string | Uint8Array) { if (typeof chunk === "string") state.body += chunk; },
    once() {},
    destroy() { state.destroyed = true; },
  });
}

function serve(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "void-memory-api-"));
  const runtime = createWebRuntime({ filename: join(directory, "web.sqlite"), mockDelay: 0 });
  t.after(() => { runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  const api = createWebApi(runtime, () => port);
  async function send(method: string, path: string, payload?: object, headers: Record<string, string> = {}) {
    const request = Object.assign(Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : []), {
      url: path, method, headers: { host: "127.0.0.1:" + port, ...(method === "GET" ? {} : { origin }),
        ...(payload ? { "content-type": "application/json" } : {}), ...headers },
    });
    const response = capture();
    await api(request, response);
    return { status: response.status, json: response.body ? JSON.parse(response.body) : undefined };
  }
  return { runtime, send };
}

test("GET /api/memory lists every record, oldest first, with the limit", async (t) => {
  const { runtime, send } = serve(t);
  const empty = await send("GET", "/api/memory");
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.json, { records: [], limits: { records: 500 } });
  const a = runtime.memory.add({ kind: "profile", text: "Se chama Joelson" }).record;
  const b = runtime.memory.add({ kind: "fact", text: "Prefere TypeScript", sessionId: "s1" }).record;
  const { status, json } = await send("GET", "/api/memory");
  assert.equal(status, 200);
  assert.deepEqual(json.records as MemoryRecord[], [a, b]);
  // A cross-site page cannot read it.
  assert.equal((await send("GET", "/api/memory", undefined, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await send("GET", "/api/memory", undefined, { "sec-fetch-site": "same-origin" })).status, 200);
});

test("DELETE /api/memory/:id removes one record for real", async (t) => {
  const { runtime, send } = serve(t);
  const keep = runtime.memory.add({ kind: "fact", text: "Mora em Recife" }).record;
  const drop = runtime.memory.add({ kind: "fact", text: "Mora em Olinda" }).record;
  assert.deepEqual(await send("DELETE", "/api/memory/" + drop.id), { status: 200, json: { id: drop.id } });
  assert.deepEqual(runtime.memory.list(), [keep]);
  const again = await send("DELETE", "/api/memory/" + drop.id);
  assert.equal(again.status, 404);
  assert.equal(again.json.error.code, "not_found");
  assert.equal((await send("DELETE", "/api/memory/not-a-uuid")).status, 404);
  assert.equal((await send("DELETE", "/api/memory/" + keep.id + "/extra")).status, 404);
  assert.equal((await send("GET", "/api/memory/" + keep.id)).status, 405);
  assert.equal((await send("POST", "/api/memory", {})).status, 405);
});

test("DELETE /api/memory erases everything only with the confirmation field", async (t) => {
  const { runtime, send } = serve(t);
  runtime.memory.add({ kind: "fact", text: "Mora em Recife" });
  runtime.memory.add({ kind: "profile", text: "Se chama Joelson" });
  for (const payload of [undefined, {}, { confirm: true }, { confirm: "sim" }, { confirm: "apagar-tudo", extra: 1 }]) {
    const result = await send("DELETE", "/api/memory", payload);
    assert.equal(result.status, 400, JSON.stringify(payload));
    assert.equal(runtime.memory.count(), 2);
  }
  assert.match((await send("DELETE", "/api/memory", {})).json.error.message, /"confirm":"apagar-tudo"/);
  assert.deepEqual(await send("DELETE", "/api/memory", { confirm: "apagar-tudo" }), { status: 200, json: { deleted: 2 } });
  assert.deepEqual(runtime.memory.list(), []);
});

test("writes need the local origin and host, like every other endpoint", async (t) => {
  const { runtime, send } = serve(t);
  const record = runtime.memory.add({ kind: "fact", text: "Mora em Recife" }).record;
  for (const headers of [{ origin: "http://evil.example" }, { origin: "null" }]) {
    const one = await send("DELETE", "/api/memory/" + record.id, undefined, headers);
    assert.equal(one.status, 403);
    assert.equal(one.json.error.code, "invalid_origin");
    assert.equal((await send("DELETE", "/api/memory", { confirm: "apagar-tudo" }, headers)).status, 403);
  }
  assert.equal((await send("GET", "/api/memory", undefined, { host: "evil.example:" + port })).status, 403);
  assert.equal((await send("DELETE", "/api/memory/" + record.id, undefined, { host: "evil.example:" + port, origin: "http://evil.example:" + port })).status, 403);
  assert.equal(runtime.memory.count(), 1);
});

test("DELETE is only accepted on memory routes", async (t) => {
  const { send } = serve(t);
  assert.equal((await send("DELETE", "/api/sessions")).status, 405);
  assert.equal((await send("DELETE", "/api/provider-usage")).status, 405);
  assert.equal((await send("PUT", "/api/memory")).status, 405);
});

test("the web runtime hands the same store to the conversation, so what the API lists is what the model sees", async (t) => {
  const previous = process.env.VOID_CONVERSATION_MODE;
  process.env.VOID_CONVERSATION_MODE = "tools";
  t.after(() => { if (previous === undefined) delete process.env.VOID_CONVERSATION_MODE; else process.env.VOID_CONVERSATION_MODE = previous; });
  const directory = mkdtempSync(join(tmpdir(), "void-memory-runtime-"));
  const prompts: string[] = [];
  const runtime = createWebRuntime({ filename: join(directory, "web.sqlite"), mock: { id: "web-demo", async generate(request) {
    prompts.push(request.messages[0]?.content ?? "");
    return { model: request.model, content: "ok", usage: { inputTokens: 1, outputTokens: 1 } };
  } } });
  t.after(() => { runtime.close(); rmSync(directory, { recursive: true, force: true }); });
  runtime.memory.add({ kind: "profile", text: "Se chama Joelson" });
  const result = await runtime.main.run({ sessionId: "s1", message: "oi", context: { executionId: "s1", permissions: runtime.permissions,
    budgetLimit: 0, signal: new AbortController().signal, metadata: {} } }, () => {});
  assert.equal(result.kind, "direct");
  assert.match(prompts[0] ?? "", /Perfil:\n- Se chama Joelson/);
});
