import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createWebApi } from "../src/web/api.js";
import { createVoiceService } from "../src/web/voice.js";
import type { Execution, Session, Snapshot } from "../src/web/contracts.js";
import { createWebRuntime, type WebRuntime } from "../src/web/runtime.js";
import { freeModelIds, liveModelRoutes } from "../src/models/modelSelection.js";
import { ExecutionError } from "../src/types/failure.js";
import type { ModelProvider } from "../src/types/model.js";

class Capture extends EventEmitter {
  statusCode = 0;
  headersSent = false;
  destroyed = false;
  writableLength = 0;
  private readonly headers = new Headers();
  private readonly channel = new TransformStream<Uint8Array, Uint8Array>();
  private readonly writer = this.channel.writable.getWriter();
  private readonly encoder = new TextEncoder();

  setHeader(name: string, value: string) { this.headers.set(name, value); }
  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headersSent = true;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
  }
  write(chunk: string) { void this.writer.write(this.encoder.encode(chunk)).catch(() => {}); }
  end(chunk?: string | Uint8Array) {
    if (typeof chunk === "string") this.write(chunk);
    else if (chunk) void this.writer.write(chunk).catch(() => {});
    void this.writer.close().catch(() => {});
    this.emit("close");
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    void this.writer.abort().catch(() => {});
    this.emit("close");
  }
  response() { return new Response(this.channel.readable, { status: this.statusCode, headers: this.headers }); }
}

async function serve(runtime: WebRuntime, voice?: ReturnType<typeof createVoiceService>) {
  const port = 3030;
  const api = createWebApi(runtime, () => port, voice);
  const origin = "http://127.0.0.1:" + port;
  async function dispatch(path: string, method: "GET" | "POST", payload?: object, from?: string, signal?: AbortSignal,
    headers: Record<string, string> = {}) {
    const request = Object.assign(Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : []), {
      url: path, method, headers: { host: "127.0.0.1:" + port,
        ...(from === undefined ? {} : { origin: from, "content-type": "application/json" }), ...headers },
    });
    const capture = new Capture();
    signal?.addEventListener("abort", () => capture.destroy(), { once: true });
    await api(request, capture);
    return capture.response();
  }
  const get = (path: string, signal?: AbortSignal) => dispatch(path, "GET", undefined, undefined, signal);
  const post = (path: string, payload: object, from = origin) => dispatch(path, "POST", payload, from);
  async function session(): Promise<string> {
    const response = await post("/api/sessions", {});
    assert.equal(response.status, 201);
    const data: Session = await response.json();
    return "/api/sessions/" + data.id;
  }
  async function close() { runtime.close(); }
  async function waitFor(path: string, ready: (snapshot: Snapshot) => boolean) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await get(path);
      assert.equal(response.status, 200);
      const snapshot: Snapshot = await response.json();
      if (ready(snapshot)) return snapshot;
      await setImmediate();
    }
    throw new Error("Expected session state did not arrive");
  }
  return { get, post, session, waitFor, close, dispatch };
}

async function subscribe(base: Awaited<ReturnType<typeof serve>>, path: string) {
  const controller = new AbortController();
  const response = await base.get(path + "/events", controller.signal);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  async function until(predicate: (snapshot: Snapshot) => boolean) {
    while (true) {
      const delimiter = pending.indexOf("\n\n");
      if (delimiter < 0) {
        const { value, done } = await reader.read();
        assert.equal(done, false, "The event stream ended prematurely");
        pending += decoder.decode(value, { stream: true });
        continue;
      }
      const event = pending.slice(0, delimiter);
      pending = pending.slice(delimiter + 2);
      const id = event.match(/^id: (.+)$/m)?.[1];
      const data = event.match(/^data: (.+)$/m)?.[1];
      if (!id || !data) continue;
      const state: Snapshot = JSON.parse(data);
      if (predicate(state)) return { id, state };
    }
  }
  return { until, close: () => controller.abort() };
}

const direct = "Explique concorrência e paralelismo.";
const delegated = "Analise esta função e compare alternativas.";
const demoRuntime = (filename = ":memory:", maxCalls?: number) =>
  createWebRuntime({ filename, mockDelay: 0, ...(maxCalls === undefined ? {} : { maxCalls }) });
const message = (text: string) => ({ id: randomUUID(), message: text, effort: "auto" });

test("ignored voice turns finish quietly, stay idempotent and are omitted from model history", async (t) => {
  let calls = 0;
  const runtime = createWebRuntime({ filename: ":memory:", mock: { id: "web-demo", async generate({ model }) {
    calls++;
    return { model, content: '{"mode":"ignore"}', usage: { inputTokens: 2, outputTokens: 1 } };
  } } });
  const api = await serve(runtime, async () => assert.fail("Ignored turns must not be synthesized"));
  t.after(api.close);
  const path = await api.session();
  const input = { ...message("fala ao fundo"), source: "voice" };
  assert.equal((await api.post(path + "/messages", input)).status, 202);
  const result = await api.waitFor(path, ({ active, turns }) => !active && turns.length === 1);
  assert.equal(result.turns[0]?.response, "");
  assert.equal(result.turns[0]?.failure, null);
  assert.deepEqual(runtime.conversations.history(result.sessionId, 1), []);
  assert.equal((await api.post(path + "/messages", input)).status, 202);
  assert.equal((await api.post(path + "/messages/" + input.id + "/voice", {})).status, 404);
  assert.equal((await api.post(path + "/messages", { ...input, source: "other" })).status, 400);
  assert.equal(calls, 1);
});

test("voice API accepts only final replies from the same local session and returns audio without secrets", async (t) => {
  const runtime = demoRuntime();
  let calls = 0;
  const audio = new Uint8Array([0x49, 0x44, 0x33, 0xff]);
  const service = createVoiceService({ ELEVENLABS_API_KEY: "test-secret", ELEVENLABS_VOICE_ID: "BrazilVoice" },
    async (url, init) => {
      calls++;
      assert.equal(url, "https://api.elevenlabs.io/v1/text-to-speech/BrazilVoice?output_format=mp3_44100_128");
      assert.equal(new Headers(init?.headers).get("xi-api-key"), "test-secret");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        text: "Resposta final.", model_id: "eleven_flash_v2_5", language_code: "pt",
      });
      return new Response(audio, { headers: { "Content-Type": "audio/mpeg", "xi-api-key": "test-secret" } });
    });
  const api = await serve(runtime, service);
  t.after(api.close);
  const path = await api.session(), other = await api.session();
  const session = path.split("/").at(-1)!;
  const id = randomUUID(), draft = randomUUID();
  const route = "/messages/" + id + "/voice";
  runtime.conversations.beginTurn(session, id, "Pergunta");
  runtime.conversations.recordDirect(session, "Pergunta", "**Resposta final.** https://example.invalid", id);
  runtime.conversations.beginTurn(session, draft, "Pendente");
  assert.equal((await api.post(path + route, {}, "https://other.invalid")).status, 403);
  assert.equal((await api.dispatch(path + route, "POST", {}, undefined)).status, 403);
  const origin = "http://127.0.0.1:3030";
  assert.equal((await api.dispatch(path + route, "POST", {}, origin, undefined, { host: "other.invalid:3030" })).status, 403);
  assert.equal((await api.dispatch(path + route, "POST", {}, origin, undefined, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await api.get(path + route)).status, 404);
  assert.equal((await api.post(path + route, { text: "Texto arbitrário", voice_id: "other" })).status, 400);
  assert.equal((await api.post(path + route, { text: "x".repeat(1024) })).status, 413);
  assert.equal((await api.post(other + route, {})).status, 404);
  assert.equal((await api.post(path + "/messages/" + draft + "/voice", {})).status, 404);
  assert.equal(calls, 0);
  const response = await api.post(path + route, {});
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("xi-api-key"), null);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), audio);
  assert.equal(calls, 1);
});

test("voice API sends a safe fallback error without a key and aborts on disconnect", async (t) => {
  for (const configured of [false, true]) {
    const runtime = demoRuntime();
    t.after(() => runtime.close());
    let notifyStarted!: (signal: AbortSignal) => void;
    const started = new Promise<AbortSignal>((resolve) => { notifyStarted = resolve; });
    let calls = 0;
    const service = createVoiceService(configured ? { ELEVENLABS_API_KEY: "test", ELEVENLABS_VOICE_ID: "Voice" } : {},
      async (_url, init) => {
        calls++;
        const signal = init?.signal!;
        notifyStarted(signal);
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      });
    const api = await serve(runtime, service);
    const path = await api.session();
    const session = path.split("/").at(-1)!;
    const id = randomUUID();
    runtime.conversations.beginTurn(session, id, "Pergunta");
    runtime.conversations.recordDirect(session, "Pergunta", "Resposta.", id);
    const route = path + "/messages/" + id + "/voice";
    if (configured) {
      const controller = new AbortController();
      const request = api.dispatch(route, "POST", {}, "http://127.0.0.1:3030", controller.signal);
      const provider = await started;
      controller.abort();
      await assert.rejects(request);
      assert.equal(provider.aborted, true);
      assert.equal(calls, 1);
    } else {
      const response = await api.post(route, {});
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, "voice_not_configured");
      assert.equal(calls, 0);
    }
  }
});

test("provider dashboard exposes allowlisted read-only metrics, coalesces reads and rejects other origins", async (t) => {
  const reads: string[] = [];
  const api = await serve(createWebRuntime({ filename: ":memory:", live: true, key: "test-router-secret",
    voiceEnv: { VOID_ELEVENLABS_TTS: "1", ELEVENLABS_API_KEY: "test-voice-secret", ELEVENLABS_VOICE_ID: "PrivateVoiceId" },
    accountFetch: async (input, init) => {
      const url = String(input);
      reads.push(url);
      assert.equal(init?.method, "GET");
      assert.equal(init?.redirect, "error");
      if (url.endsWith("/key")) {
        assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-router-secret");
        return Response.json({ data: { usage: 0, usage_daily: 0, limit: null, limit_remaining: null,
          is_free_tier: true, free_model_daily_requests: { used: 52, limit: 50, remaining: 0 },
          label: "private-label", rate_limit: { requests: 999 } } });
      }
      assert.equal(new Headers(init.headers).get("xi-api-key"), "test-voice-secret");
      return Response.json({ detail: { status: "missing_permissions", message: "private-label" } }, { status: 401 });
    } }));
  t.after(api.close);
  assert.equal((await api.post("/api/provider-usage", {}, "https://example.invalid")).status, 403);
  assert.equal((await api.post("/api/provider-usage", { url: "https://example.invalid" })).status, 400);
  const system = await (await api.get("/api/system")).json();
  assert.deepEqual(system.voice, { enabled: true, issue: null });
  assert.doesNotMatch(JSON.stringify(system), /test-voice-secret|PrivateVoiceId/);
  const local = await api.get("/api/provider-usage");
  assert.equal(local.status, 200);
  const snapshot = await local.json();
  assert.equal(snapshot.providers[0].account.issue, "not_checked");
  assert.equal(snapshot.voiceLimits.daily.limit, 6000);
  assert.deepEqual(reads, []);
  const replies = await Promise.all([api.post("/api/provider-usage", {}), api.post("/api/provider-usage", {})]);
  const [first, second] = await Promise.all(replies.map((r) => r.json()));
  assert.deepEqual(first.providers, second.providers);
  assert.equal(replies[0]?.headers.get("cache-control"), "no-store");
  assert.equal(first.providers[0].account.spend.amount, 0);
  assert.equal(first.providers[0].account.quota.status, "unknown");
  assert.equal(first.providers[0].totals.costUsd, null);
  const free = first.providers[0].account.freeRequests;
  assert.deepEqual({ ...free, resetsAt: null }, { used: 52, limit: 50, remaining: 0, window: "daily",
    resetsAt: null, status: "exhausted" });
  assert.equal(new Date(free.resetsAt).getUTCHours(), 0);
  assert.equal(first.providers[1].account.issue, "permission");
  assert.equal(first.providers[1].account.errorCode, "missing_permissions");
  assert.equal(first.providers[1].account.quota, null);
  assert.equal(first.providers[1].enabled, true);
  assert.deepEqual((await (await api.get("/api/system")).json()).voice, system.voice);
  assert.equal(first.voiceLimits.daily.limit, 6000);
  assert.doesNotMatch(JSON.stringify(first), /test-router-secret|test-voice-secret|private-label|PrivateVoiceId|999/);
  assert.equal(reads.length, 2);
});

test("local provider telemetry remains available while quota calls are pending or fail", async (t) => {
  let rejectRemote!: (reason: Error) => void;
  let markStarted!: () => void;
  const remote = new Promise<Response>((_, reject) => { rejectRemote = reject; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const api = await serve(createWebRuntime({ filename: ":memory:", key: "mock-router",
    voiceEnv: { ELEVENLABS_API_KEY: "mock-voice" },
    accountFetch: async (input) => {
      if (String(input).endsWith("/key")) { markStarted(); return remote; }
      return Response.json({ character_count: 25, character_limit: 100 });
    } }));
  t.after(api.close);
  const refresh = api.post("/api/provider-usage", {});
  await started;
  const local = await api.get("/api/provider-usage");
  assert.equal(local.status, 200);
  assert.equal((await local.json()).voiceLimits.daily.limit, 6000);
  rejectRemote(new Error("sensitive transport detail"));
  const response = await refresh;
  assert.equal(response.status, 200);
  const dashboard = await response.json();
  assert.equal(dashboard.providers[0].account.issue, "network");
  assert.equal(dashboard.providers[1].account.quota.used, 25);
  assert.equal(dashboard.voiceLimits.daily.limit, 6000);
  assert.doesNotMatch(JSON.stringify(dashboard), /sensitive transport detail/);
});

test("provider dashboard keeps key budgets and ElevenLabs subscription units separate", async (t) => {
  const api = await serve(createWebRuntime({ filename: ":memory:", key: "mock-router",
    voiceEnv: { ELEVENLABS_API_KEY: "mock-voice" },
    accountFetch: async (input) => String(input).endsWith("/key")
      ? Response.json({ data: { usage: 10, limit: 10, limit_remaining: 0, limit_reset: "daily" } })
      : Response.json({ character_count: 85, character_limit: 100, next_character_count_reset_unix: 2_000_000_000,
        character_refresh_period: "monthly_period", current_overage: { amount: "1.15", currency: "usd" } }) }));
  t.after(api.close);
  const response = await api.post("/api/provider-usage", {});
  assert.equal(response.status, 200);
  const { providers: [openRouter, elevenLabs] } = await response.json();
  assert.equal(openRouter.account.quota.status, "exhausted");
  assert.deepEqual(openRouter.account.spend, { amount: 10, currency: "USD", scope: "key" });
  assert.equal(new Date(openRouter.account.quota.resetsAt).getUTCHours(), 0);
  assert.deepEqual(elevenLabs.account.quota, {
    status: "near", used: 85, limit: 100, remaining: 15, window: "monthly_period", resetsAt: 2_000_000_000_000,
  });
  assert.deepEqual(elevenLabs.account.spend, { amount: 1.15, currency: "USD", scope: "overage" });
});

test("web validates input and origin, persists sessions and keeps direct sends idempotent", { timeout: 10_000 }, async (t) => {
  const api = await serve(demoRuntime());
  t.after(api.close);
  assert.equal((await api.post("/api/sessions", {}, "https://other.invalid")).status, 403);
  assert.equal((await api.post("/api/sessions", { key: "unexpected" })).status, 400);
  assert.equal((await api.get("/api/system?effort=extra")).status, 400);
  const path = await api.session();
  assert.equal((await api.post(path + "/messages", { ...message(direct), message: " " })).status, 400);
  const payload = message(direct);
  assert.equal((await api.post(path + "/messages", payload)).status, 202);
  const history = await api.waitFor(path, (state) => !state.active && !!state.turns[0]?.response);
  assert.match(history.turns[0]?.response ?? "", /Paralelismo/);
  assert.equal(history.turns[0]?.model, "main-local");
  assert.equal(history.executions.length, 0);
  assert.equal((await api.post(path + "/messages", payload)).status, 202);
  assert.equal((await api.post(path + "/messages", { ...payload, message: "new" })).status, 409);
  assert.equal((await api.waitFor(path, () => true)).turns.length, 1);
  const response = await api.get("/api/sessions");
  const list: Session[] = await response.json();
  assert.equal(list[0]?.title, direct);
});

test("web streams the initial reply and progress before completion, then survives disconnect", { timeout: 10_000 }, async (t) => {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const mock: ModelProvider = {
    id: "test-web",
    async generate({ model, messages }) {
      const system = messages[0]?.content ?? "";
      if (system.startsWith("VOID_DECISION")) return {
        model, content: JSON.stringify({ mode: "delegate", steps: [
          { id: "A", agentId: "dev-agent", requiredCapability: "code-analysis", objective: "Analyze", dependsOn: [] },
        ] }),
      };
      if (system.startsWith("VOID_SYNTHESIS")) return { model, content: '{"answer":"Verified output","sources":{"A":"Verified output"}}' };
      await waiting;
      return { model, content: "Verified output" };
    },
  };
  const api = await serve(createWebRuntime({ filename: ":memory:", mock }));
  t.after(api.close);
  const path = await api.session();
  const stream = await subscribe(api, path);
  t.after(stream.close);
  const first = await stream.until((state) => state.turns.length === 0);
  assert.equal((await api.post(path + "/messages", message(delegated))).status, 202);
  try {
    const progress = await stream.until((state) => state.notices.some(({ type }) => type === "progress"));
    assert.notEqual(first.id, progress.id);
    assert.equal(progress.state.notices[0]?.type, "initial");
    assert.ok(progress.state.active?.executionId);
    assert.equal(progress.state.turns[0]?.response, null);
    stream.close();
  } finally { release(); }
  const final = await api.waitFor(path, (state) => !state.active && !!state.turns[0]?.response);
  assert.equal(final.executions[0]?.steps[0]?.output, "Verified output");
  const reconnect = await subscribe(api, path);
  t.after(reconnect.close);
  const restored = await reconnect.until((state) => !!state.turns[0]?.response);
  assert.equal(restored.state.turns.length, 1);
  assert.match(restored.state.turns[0]?.introduction ?? "", /^Vou revisar/);
  assert.match(restored.state.turns[0]?.response ?? "", /Verified output/);
  assert.equal(restored.state.executions[0]?.status, "completed");
});

test("web restores approval from SQLite and rejects cross-session or duplicate actions", { timeout: 10_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "void-web-test-"));
  const database = join(directory, "sessions.sqlite");
  let api = await serve(demoRuntime(database, 2));
  t.after(async () => { await api.close(); rmSync(directory, { recursive: true, force: true }); });
  const path = await api.session();
  await api.post(path + "/messages", message(delegated));
  const stopped = await api.waitFor(path, (state) => !state.active && state.executions[0]?.status === "awaiting_approval");
  const before = stopped.executions[0]!;
  assert.equal(before.extension, "calls");
  assert.equal(before.steps[0]?.status, "completed");
  assert.equal(before.steps[1]?.status, "pending");
  await api.close();
  api = await serve(demoRuntime(database, 2));
  const restored = await api.waitFor(path, () => true);
  assert.equal(restored.notices.length, 0);
  assert.deepEqual(restored.executions[0], before);
  const runPath = path + "/executions/" + before.id;
  const other = await api.session();
  const approval = { action: "approve", revision: before.revision, extension: { calls: 2 } };
  assert.equal((await api.post(other + "/executions/" + before.id + "/action", approval)).status, 404);
  assert.equal((await api.post(runPath + "/action", { ...approval, extension: { steps: 2 } })).status, 400);
  assert.equal((await api.post(runPath + "/action", approval)).status, 202);
  assert.equal((await api.post(runPath + "/action", approval)).status, 409);
  const result = await api.waitFor(path, (state) => !state.active && !!state.turns[0]?.response);
  assert.equal(result.executions[0]?.status, "completed");
  assert.equal(result.executions[0]?.steps[1]?.status, "completed");
  assert.equal(result.executions[0]?.limits.calls, 4);
  assert.equal((await api.get(runPath)).status, 200);
});

test("web cancels a paused execution and preserves the completed specialist output", { timeout: 10_000 }, async (t) => {
  const api = await serve(demoRuntime(":memory:", 2));
  t.after(api.close);
  const path = await api.session();
  await api.post(path + "/messages", message(delegated));
  const stopped = await api.waitFor(path, (state) => !state.active && state.executions[0]?.status === "awaiting_approval");
  const run = stopped.executions[0]!;
  const runPath = path + "/executions/" + run.id;
  assert.equal((await api.post(runPath + "/action", { action: "cancel", revision: run.revision })).status, 202);
  const cancelled: Execution = await (await api.get(runPath)).json();
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.steps[0]?.output, run.steps[0]?.output);
  assert.ok((await api.waitFor(path, () => true)).turns[0]?.response);
});

test("web exposes safe provider errors and does not fall back when LIVE credentials are missing", { timeout: 10_000 }, async (t) => {
  const live = await serve(createWebRuntime({ live: true, filename: ":memory:" }));
  t.after(live.close);
  const status = await (await live.get("/api/system")).json();
  assert.equal(status.mode, "LIVE");
  assert.equal(status.available, false);
  const path = await live.session();
  assert.equal((await live.post(path + "/messages", message(direct))).status, 503);

  const secret = "secret-provider-body";
  const mock: ModelProvider = { id: "failing-web", async generate() {
    throw new ExecutionError({ category: "rate_limited", message: secret, retryable: true });
  } };
  const failing = await serve(createWebRuntime({ filename: ":memory:", mock }));
  t.after(failing.close);
  const failingPath = await failing.session();
  await failing.post(failingPath + "/messages", message(direct));
  const history = await failing.waitFor(failingPath, (state) => !state.active && !!state.turns[0]?.failure);
  assert.equal(history.turns[0]?.failure, "rate_limited");
  assert.ok(!JSON.stringify(history).includes(secret));
});

test("web pauses cooperatively and resumes without extending a limit", { timeout: 10_000 }, async (t) => {
  let release = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const mock: ModelProvider = { id: "pause-web", async generate({ model, messages }) {
    const system = messages[0]?.content ?? "";
    if (system.startsWith("VOID_DECISION")) return { model, content: JSON.stringify({
      mode: "delegate", steps: [
        { id: "A", agentId: "dev-agent", requiredCapability: "code-analysis", objective: "First", dependsOn: [] },
        { id: "B", agentId: "dev-agent", requiredCapability: "code-analysis", objective: "Second", dependsOn: ["A"] },
      ],
    }) };
    if (system.startsWith("VOID_SYNTHESIS")) return { model, content: JSON.stringify({ answer: "Consolidated result",
      sources: JSON.parse(messages.at(-1)?.content ?? "{}").evidence }) };
    await waiting;
    return { model, content: "Specialist result" };
  } };
  const api = await serve(createWebRuntime({ filename: ":memory:", mock }));
  t.after(api.close);
  const path = await api.session();
  await api.post(path + "/messages", message(delegated));
  const running = await api.waitFor(path, (state) => state.executions[0]?.steps[0]?.status === "running");
  const active = running.executions[0]!;
  const actionPath = path + "/executions/" + active.id + "/action";
  try {
    assert.ok(active.actions.includes("pause"));
    assert.equal((await api.post(actionPath, { action: "pause", revision: active.revision })).status, 202);
  } finally { release(); }
  const snapshot = await api.waitFor(path, (state) => !state.active && state.executions[0]?.status === "paused");
  const paused = snapshot.executions[0]!;
  assert.equal(paused.steps[0]?.output, "Specialist result");
  assert.equal(paused.steps[1]?.status, "pending");
  assert.equal((await api.post(actionPath, { action: "resume", revision: paused.revision })).status, 202);
  const final = await api.waitFor(path, (state) => !state.active && state.executions[0]?.status === "completed");
  assert.equal(final.executions[0]?.steps[1]?.output, "Specialist result");
  assert.deepEqual(final.executions[0]?.limits, paused.limits);
});

test("web LIVE preserves safe failure details and accepts a later send after transport failure", { timeout: 10_000 }, async (t) => {
  const model = liveModelRoutes("medium").decision.model;
  const pricing = { prompt: "0", completion: "0", request: "0" };
  const requests: Array<{ messages: Array<{ role: string; content: string }>; response_format: unknown }> = [];
  const payload = (content: unknown, reason = "stop", reasoning?: string) =>
    Response.json({ model, choices: [{ finish_reason: reason, message: { content, reasoning } }] });
  const results = [
    () => payload("not-json"),
    () => payload('{"mode":"direct"}'),
    () => payload('{"mode":"delegate","steps":[{"id":"A","agentId":"dev-agent","objective":"Test","dependsOn":["A"],"requiredCapability":"code-analysis"}]}'),
    () => payload('{"mode":"direct","response":"partial', "length"),
    () => payload(" "),
    () => payload(null, "stop", "reasoning-private"),
    () => Response.json({ error: { message: "private-unavailable" } }, { status: 404 }),
    () => { throw new TypeError("private-network-error"); },
    () => payload('{"mode":"direct","response":"valid answer"}'),
    () => Response.json({ error: { message: "private-rate-limit" } }, { status: 429 }),
  ];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/models")) return Response.json({ data: [{ id: model, pricing, supported_parameters: ["response_format", "reasoning"], reasoning: { mandatory: false } }] });
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    requests.push(JSON.parse(String(init.body)));
    const next = results.shift();
    assert.ok(next);
    return next();
  });
  const api = await serve(createWebRuntime({ filename: ":memory:", live: true, key: "test-key", maxCalls: 2 }));
  t.after(api.close);
  const path = await api.session();
  const expectations = [
    ["invalid_response", "decision_json"], ["invalid_response", "decision_schema"], ["invalid_response", "plan_invalid"],
    ["incomplete", "output_limit"], ["missing_content", undefined], ["missing_content", undefined],
    ["http", "model_unavailable"], ["transport", undefined], [null, undefined], ["rate_limited", undefined],
  ] as const;
  for (const [index, [category, detail]] of expectations.entries()) {
    const body = { ...message("Question " + index), effort: "medium" };
    assert.equal((await api.post(path + "/messages", body)).status, 202);
    const state = await api.waitFor(path, ({ active, turns }) => !active && turns.length === index + 1);
    const turn = state.turns.at(-1);
    assert.equal(turn?.failure, category);
    assert.equal(turn?.failureDetail, detail);
    assert.equal(turn?.response, category ? null : "valid answer");
    assert.equal(state.executions.length, 0);
    assert.doesNotMatch(JSON.stringify(state), /private-|reasoning-private|test-key/);
    assert.deepEqual(requests[index]?.response_format, { type: "json_object" });
    assert.deepEqual(requests[index]?.messages.at(-1), { role: "user", content: body.message });
    assert.equal((await api.post(path + "/messages", body)).status, 202);
  }
  assert.equal(requests.length, expectations.length);
});


test("LIVE streams direct text, falls back only to a verified JSON model and cancels the upstream", { timeout: 10_000 }, async (t) => {
  const primary = liveModelRoutes("low", {}).decision.model;
  const fallback = freeModelIds.dots;
  const attempts: string[] = [];
  const pricing = { prompt: "0", completion: "0" };
  let finish = () => {};
  let upstreamAborted = false;
  const encoder = new TextEncoder();
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    if (url.endsWith("/models")) return Response.json({ data: [primary, fallback].map((id) => ({
      id, pricing, supported_parameters: ["response_format", "reasoning"], reasoning: { mandatory: false },
      context_length: 100_000, top_provider: { max_completion_tokens: 90_000 },
    })) });
    const request = JSON.parse(String(init.body));
    attempts.push(request.model);
    assert.equal(request.max_tokens, undefined);
    assert.equal(request.stream, true);
    assert.deepEqual(request.response_format, { type: "json_object" });
    assert.deepEqual(request.provider.max_price, { prompt: 0, completion: 0, request: 0 });
    if (request.model === primary) return Response.json({ error: { code: 503 } }, { status: 503 });
    return new Response(new ReadableStream({
      start(controller) {
        const frame = (body: object) => "data: " + JSON.stringify(body) + "\r\n\r\n";
        const first = frame({ model: fallback, choices: [{ delta: {
          content: '{"mode":"direct","response":"Início',
          reasoning: "must never appear",
        } }] });
        const bytes = encoder.encode(": waiting\r\n\r\n" + first);
        const split = bytes.indexOf(195) + 1;
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        finish = () => {
          controller.enqueue(encoder.encode(frame({ choices: [{ delta: { content: ' e fim"}' }, finish_reason: "stop" }] })
            + frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 12 } }) + "data: [DONE]\r\n\r\n"));
          controller.close();
        };
        init.signal?.addEventListener("abort", () => {
          upstreamAborted = true;
          controller.error(init.signal?.reason);
        }, { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } });
  });

  const api = await serve(createWebRuntime({ filename: ":memory:", live: true, key: "test-key" }));
  t.after(api.close);
  const path = await api.session();
  const events = await subscribe(api, path);
  t.after(events.close);

  const first = message("Primeira");
  assert.equal((await api.post(path + "/messages", first)).status, 202);
  const preview = await events.until(({ active, turns }) => !!active?.draft || (!active && turns.length === 1));
  assert.equal(preview.state.active?.draft, "Início");
  assert.equal(preview.state.turns[0]?.response, null);
  assert.doesNotMatch(JSON.stringify(preview.state), /must never appear/);
  finish();
  const completed = await events.until(({ active, turns }) => !active && !!turns[0]?.response);
  assert.equal(completed.state.turns[0]?.response, "Início e fim");
  assert.equal(completed.state.turns[0]?.model, fallback);

  const second = message("Segunda");
  assert.equal((await api.post(path + "/messages", second)).status, 202);
  const secondPreview = await events.until(({ active, turns }) =>
    (active?.turnId === second.id && !!active.draft) || (!active && turns.length === 2));
  assert.equal(secondPreview.state.active?.draft, "Início");
  assert.equal((await api.post(path + "/messages/" + first.id + "/cancel", {})).status, 409);
  assert.equal((await api.post(path + "/messages/" + second.id + "/cancel", {})).status, 202);
  const cancelled = await events.until(({ active, turns }) => !active && turns.length === 2);
  assert.equal(upstreamAborted, true);
  assert.equal(cancelled.state.turns[1]?.failure, "cancelled");
  assert.equal(cancelled.state.turns[1]?.response, null);
  assert.deepEqual(attempts, [primary, fallback, primary, fallback]);
  const usage = await (await api.get("/api/usage")).json();
  assert.equal(usage.mode, "observe");
  assert.deepEqual(usage.windows.map(({ hours, attempts, failed, unknownUsage, outputTokens }: import("../src/web/contracts.js").UsageWindow) =>
    [hours, attempts, failed, unknownUsage, outputTokens]), [[5, 4, 3, 3, 12], [168, 4, 3, 3, 12]]);
});

for (const effort of ["auto", "medium"] as const) {
  test("web and terminal share OpenRouter configuration and use their registered agents for " + effort, { timeout: 20_000 }, async (t) => {
    const model = liveModelRoutes(effort === "auto" ? "low" : effort).decision.model;
    const catalog = { data: [{ id: model, pricing: { prompt: "0", completion: "0", request: "0" },
      supported_parameters: ["response_format", "reasoning"], reasoning: { mandatory: false } }] };
    const completion = { model, choices: [{ finish_reason: "stop",
      message: { content: '{"mode":"direct","response":"Verified"}' } }] };
    const input = "Analyze this function:\n\nfunction media(nums) { return nums.length; }";
    const directory = mkdtempSync(join(tmpdir(), "void-parity-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "prompt.txt");
    writeFileSync(file, input);
    const preload = `
      globalThis.fetch = async (url, init) => {
        if (url === "https://openrouter.ai/api/v1/models") return Response.json(${JSON.stringify(catalog)});
        if (url !== "https://openrouter.ai/api/v1/chat/completions") throw new Error("Unexpected request");
        console.log("PARITY_REQUEST:" + init.body);
        return Response.json(${JSON.stringify(completion)});
      };
    `;
    const terminal = spawnSync(process.execPath, ["--import", "tsx", "--import",
      "data:text/javascript," + encodeURIComponent(preload), "src/examples/mainAgent.ts", "--live", "--prompt-file", file], {
      env: { ...process.env, OPENROUTER_API_KEY: "test-key", VOID_EFFORT: effort, VOID_CHAT_MAX_CALLS: "1",
        VOID_GENERATION_DIAGNOSTICS: "1" }, encoding: "utf8", timeout: 12_000, windowsHide: true,
    });
    assert.equal(terminal.status, 0, terminal.error?.message ?? terminal.stderr);
    assert.match(terminal.stdout, /\[final\] Verified/);
    const serialized = terminal.stdout.match(/^PARITY_REQUEST:(.+)$/m)?.[1];
    assert.ok(serialized);
    const terminalRequest = JSON.parse(serialized);
    assert.equal(terminalRequest.messages.at(-1)?.content, input);
    assert.deepEqual(terminalRequest.response_format, { type: "json_object" });
    assert.deepEqual(terminalRequest.reasoning, { enabled: false });
    assert.equal(terminalRequest.provider.max_price.completion, 0);
    assert.equal(terminalRequest.provider.allow_fallbacks, false);
    assert.equal(terminalRequest.provider.require_parameters, true);

    let webRequest: { messages: { role: string; content: string }[] } | undefined;
    t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      if (url === "https://openrouter.ai/api/v1/models") return Response.json(catalog);
      assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
      webRequest = JSON.parse(String(init.body));
      return Response.json(completion);
    });
    const api = await serve(createWebRuntime({ filename: ":memory:", live: true, key: "test-key", maxCalls: 1 }));
    t.after(api.close);
    const path = await api.session();
    assert.equal((await api.post(path + "/messages", { ...message(input), effort })).status, 202);
    await api.waitFor(path, ({ turns }) => turns[0]?.response === "Verified");
    assert.ok(webRequest);
    const { messages: webMessages, ...webConfig } = webRequest;
    const { messages: terminalMessages, ...terminalConfig } = terminalRequest;
    assert.deepEqual(webConfig, { ...terminalConfig, stream: true, stream_options: { include_usage: true } });
    assert.deepEqual(webMessages.at(-1), terminalMessages.at(-1));
    assert.match(webMessages[0]?.content ?? "", /AgentRenderer/);
    assert.match(webMessages[0]?.content ?? "", /"name":"ui.render"/);
    assert.doesNotMatch(terminalMessages[0]?.content ?? "", /"name":"ui.render"/);
    for (const id of ["dev-agent", "research-agent"]) {
      assert.ok(webMessages[0]?.content.includes(id));
      assert.ok(terminalMessages[0]?.content.includes(id));
    }
  });
}

test("UI commands use the existing message route without an available model and keep events session-scoped", async (t) => {
  const api = await serve(createWebRuntime({ filename: ":memory:", live: true }));
  t.after(api.close);
  const path = await api.session();
  const other = await api.session();
  const stream = await subscribe(api, path);
  t.after(stream.close);
  const input = { ...message("VOID, mostre o painel de uso, por favor."), source: "voice" };
  assert.equal((await api.post(path + "/messages", input, "http://example.com")).status, 403);
  assert.equal((await api.post(path + "/messages", input)).status, 202);
  const { state } = await stream.until(({ active, ui }) => !active && ui?.turnId === input.id);
  assert.deepEqual(state.ui?.action, { type: "open_panel", panel: "usage" });
  assert.equal(state.turns[0]?.model, null);
  assert.equal((await api.post(path + "/messages", input)).status, 202);
  const replay = await api.waitFor(path, ({ active }) => !active);
  assert.equal(replay.turns.length, 1);
  assert.deepEqual(replay.ui, state.ui);
  const otherState: Snapshot = await (await api.get(other)).json();
  assert.equal(otherState.ui, undefined);
  assert.equal((await api.post(path + "/messages", message("O que é workspace?"))).status, 503);
});

test("MainAgent validates display schemas and routes them through the registered renderer", async (t) => {
  const schema = { title: "Custos", blocks: [{ kind: "card", title: "Total", value: 12 }] };
  let calls = 0;
  const api = await serve(createWebRuntime({ filename: ":memory:", mock: { id: "web-demo",
    async generate({ model }) {
      calls++;
      return { model, content: JSON.stringify({ mode: "display", schema }) };
    },
  } }));
  t.after(api.close);
  const path = await api.session();
  const invalid = message("Exibir " + JSON.stringify({ ...schema, html: "<script>alert(1)</script>" }));
  assert.equal((await api.post(path + "/messages", invalid)).status, 202);
  const rejectedSchema = await api.waitFor(path, ({ active, turns }) => !active && turns.length === 1);
  assert.equal(rejectedSchema.ui, undefined);
  assert.equal(calls, 0);
  const valid = message("Crie um cartão com o total de 12.");
  assert.equal((await api.post(path + "/messages", valid)).status, 202);
  const accepted = await api.waitFor(path, ({ active, turns }) => !active && turns.length === 2);
  assert.deepEqual(accepted.ui, { turnId: valid.id, action: { type: "update_panel", panel: "display", schema } });
  assert.equal(calls, 1);
  const ordinary = message("Organize esses dados visualmente para mim.");
  assert.equal((await api.post(path + "/messages", ordinary)).status, 202);
  const rejectedDecision = await api.waitFor(path, ({ active, turns }) => !active && turns.length === 3);
  assert.equal(rejectedDecision.turns[2]?.failure, null);
  assert.deepEqual(rejectedDecision.ui?.action, accepted.ui?.action);
});

test("MainAgent executes registered window tools and rejects unknown components or extra arguments", async (t) => {
  let call: unknown = { name: "ui.openWindow", arguments: { component: "settings" } };
  const api = await serve(createWebRuntime({ filename: ":memory:", mock: { id: "web-demo",
    async generate({ model }) { return { model, content: JSON.stringify({ mode: "tool", call }) }; },
  } }));
  t.after(api.close);
  const path = await api.session();
  const request = "Se estiver disponível, pode abrir a janela de configurações para que eu ajuste a voz?";
  const valid = message(request);
  assert.equal((await api.post(path + "/messages", valid)).status, 202);
  const accepted = await api.waitFor(path, ({ active, turns }) => !active && turns.length === 1);
  assert.deepEqual(accepted.ui, { turnId: valid.id, action: { type: "open_panel", panel: "settings" } });
  assert.equal(accepted.turns[0]?.ui, true);

  const rejected = [
    { text: request, args: { component: "settings", url: "https://example.invalid" } },
    { text: request, args: { component: "secrets" } },
    { text: request, args: {} },
  ];
  for (const [index, { text, args }] of rejected.entries()) {
    call = { name: "ui.openWindow", arguments: args };
    assert.equal((await api.post(path + "/messages", message(text))).status, 202);
    const state = await api.waitFor(path, ({ active, turns }) => !active && turns.length === index + 2);
    assert.equal(state.turns.at(-1)?.failure, "invalid_response");
    assert.deepEqual(state.ui, accepted.ui);
  }
});
