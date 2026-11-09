import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OpenRouterFreeCatalog } from "../src/models/providers/OpenRouterFreeCatalog.js";
import { OpenRouterProvider } from "../src/models/providers/OpenRouterProvider.js";
import { ExecutionError } from "../src/types/failure.js";
import { ProviderUsage } from "../src/web/provider-usage.js";
import { createVoiceService } from "../src/web/voice.js";

test("voice records real generation credits and persists separate local limits across restarts", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "void-provider-"));
  const path = join(directory, "usage.sqlite");
  const env = { ELEVENLABS_API_KEY: "fake-key", ELEVENLABS_VOICE_ID: "TestVoice" };
  const signal = new AbortController().signal;
  let at = 86_400_000 + 1_000;
  let calls = 0;
  const send: typeof fetch = async () => {
    calls++;
    return new Response(new Uint8Array([0xff]), { headers: { "content-type": "audio/mpeg", "character-cost": "1000" } });
  };
  const first = new ProviderUsage(path, () => at);
  try {
    const voice = createVoiceService(env, send, () => at, first);
    await voice("a".repeat(2000), signal);
    await voice("b".repeat(2000), signal);
    await voice("c".repeat(2000), signal);
  } finally { first.close(); }
  const second = new ProviderUsage(path, () => at);
  t.after(() => { second.close(); rmSync(directory, { recursive: true, force: true }); });
  const voice = createVoiceService(env, send, () => at, second);
  await assert.rejects(voice("local limit", signal), { code: "voice_usage_limit" });
  const row = second.report("elevenlabs", []).models[0];
  assert.equal(row?.characters, 6000);
  assert.equal(row?.credits, 3000);
  assert.equal(row?.costUsd, null);
  assert.equal(row?.limitEvent, null);
  assert.equal(second.voiceLimits().daily.status, "exhausted");
  assert.equal(second.voiceLimits().daily.resetsAt, 2 * 86_400_000);
  assert.equal(calls, 3);
  at = 2 * 86_400_000;
  await voice("after UTC reset", signal);
  assert.equal(second.voiceLimits().daily.used, 15);
});

test("generic ElevenLabs 429 records throttling separately from explicit quota exhaustion", async (t) => {
  let at = 1_000, calls = 0;
  const usage = new ProviderUsage(":memory:", () => at);
  t.after(() => usage.close());
  const voice = createVoiceService({ ELEVENLABS_API_KEY: "mock-key", ELEVENLABS_VOICE_ID: "TestVoice" },
    async () => ++calls === 1
      ? Response.json({ detail: { status: "too_many_concurrent_requests", message: "private message" } },
        { status: 429, headers: { "Retry-After": "8" } })
      : Response.json({ detail: { status: "quota_exceeded" } }, { status: 401 }),
    () => at, usage);
  const signal = new AbortController().signal;
  await assert.rejects(voice("test", signal), { code: "voice_rate_limit" });
  assert.deepEqual(usage.report("elevenlabs", []).models[0]?.limitEvent,
    { kind: "rate", at: 1000, retryAt: 9000, httpStatus: 429, apiCode: null });
  assert.equal(usage.voiceLimits().retryAt, 9000);
  await assert.rejects(voice("test", signal), { code: "voice_cooldown" });
  at = 9000;
  await assert.rejects(voice("test", signal), { code: "voice_quota" });
  assert.equal(usage.report("elevenlabs", []).models[0]?.limitEvent?.kind, "quota");
  assert.equal(calls, 2);
});

test("OpenRouter stream error 429 honors Retry-After and avoids fallback and repeat calls", async (t) => {
  const usage = new ProviderUsage(":memory:");
  t.after(() => usage.close());
  const models = ["vendor/primary:free", "vendor/other:free"];
  const catalog = new OpenRouterFreeCatalog(async () => Response.json({ data: models.map((id) =>
    ({ id, pricing: { prompt: "0", completion: "0", request: "0" } })) }));
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(
    'data: {"error":{"code":429,"message":"private"},"usage":{"prompt_tokens":1,"completion_tokens":0,"cost":0}}\n\n',
    { headers: { "Content-Type": "text/event-stream", "Retry-After": "8" } }));
  const router = new OpenRouterProvider("fake-key", (event) => usage.openRouter(event), catalog, models);
  const request = { model: models[0]!, messages: [], onText: () => {} };
  const rateLimited = (error: unknown) => error instanceof ExecutionError && error.failure.category === "rate_limited";
  await assert.rejects(router.generate(request), rateLimited);
  await assert.rejects(router.generate(request), rateLimited);
  assert.equal(fetch.mock.callCount(), 1);
  const row = usage.report("openrouter", models).models[0];
  assert.equal(row?.limitEvent?.kind, "rate");
  assert.equal(row?.limitEvent?.httpStatus, 200);
  assert.equal(row?.limitEvent?.apiCode, 429);
  assert.ok(row?.limitEvent?.retryAt && row.limitEvent.retryAt >= row.limitEvent.at + 7_900);
  assert.equal(row?.costUsd, 0);
  assert.equal(row?.costReports, 1);
});
