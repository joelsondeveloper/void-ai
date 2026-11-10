import assert from "node:assert/strict";
import { test } from "node:test";
import { createVoiceService, VoiceError } from "../src/web/voice.js";

const env = { ELEVENLABS_API_KEY: "mock-key", ELEVENLABS_VOICE_ID: "BrazilVoice" };
const signal = new AbortController().signal;
const mp3 = () => new Response(new Uint8Array([0xff]), { headers: { "Content-Type": "audio/mpeg" } });

test("ElevenLabs quota responses cool down without retry and recover after the window", async () => {
  for (const status of [429, 401]) {
    let calls = 0, clock = 1_000;
    const voice = createVoiceService(env, async () => ++calls === 1
      ? Response.json({ detail: { status: "quota_exceeded", message: "mock-key" } }, { status })
      : mp3(), () => clock);
    await assert.rejects(voice("Olá.", signal), { status: 429, code: "voice_quota" });
    await assert.rejects(voice("Olá novamente.", signal), { status: 429, code: "voice_cooldown" });
    assert.equal(calls, 1);
    clock += 300_000;
    await voice("Voltei.", signal);
    assert.equal(calls, 2);
  }
});

test("ElevenLabs transport, HTTP and invalid-audio errors never expose provider details", async () => {
  for (const send of [
    async () => { throw new Error("mock-key"); },
    async () => Response.json({ detail: "mock-key" }, { status: 500 }),
    async () => new Response("mock-key"),
    async () => new Response(null, { headers: { "Content-Type": "audio/mpeg" } }),
    async () => new Response(new Uint8Array(4 * 1024 * 1024 + 1), { headers: { "Content-Type": "audio/mpeg" } }),
  ]) {
    await assert.rejects(createVoiceService(env, send)("Olá.", signal),
      { status: 502, code: "voice_provider_error", message: "ElevenLabs indisponível." });
  }
});

test("TTS permissions and voice access expose only fixed diagnostics", async () => {
  for (const [status, providerCode, code, message] of [
    [401, "missing_permissions", "voice_tts_permission", /Text to Speech/],
    [404, "voice_not_found", "voice_unavailable", /voz configurada/],
    [403, "model_access_denied", "voice_access_denied", /acesso à voz e ao modelo/],
  ] as const) {
    const service = createVoiceService(env, async () => Response.json({
      detail: { status: providerCode, message: "mock-key BrazilVoice" },
    }, { status }));
    await assert.rejects(service("Oi.", signal), (error: unknown) => {
      assert.ok(error instanceof VoiceError);
      assert.equal(error.status, 502);
      assert.equal(error.code, code);
      assert.match(error.message, message);
      assert.doesNotMatch(error.message, /mock-key|BrazilVoice/);
      return true;
    });
  }
});

test("voice enforces configuration, text length, concurrency and character and request budgets", async () => {
  let calls = 0, clock = 0;
  const send = async () => { calls++; return mp3(); };
  const voice = createVoiceService(env, send, () => clock);
  await assert.rejects(createVoiceService({ ...env, ELEVENLABS_VOICE_ID: "../voices" }, send)("Oi", signal),
    { status: 503, code: "voice_not_configured" });
  await assert.rejects(voice("a".repeat(2001), signal), { status: 422, code: "voice_text_limit" });
  assert.equal(calls, 0);
  const pending = voice("a".repeat(2000), signal);
  await assert.rejects(voice("concorrente", signal), { status: 429, code: "voice_usage_limit" });
  await pending;
  await voice("b".repeat(2000), signal);
  await voice("c".repeat(2000), signal);
  await assert.rejects(voice("acima do total diário", signal), { status: 429, code: "voice_usage_limit" });
  assert.equal(calls, 3);
  clock = 86_400_000;
  for (let i = 0; i < 6; i++) await voice("Oi", signal);
  await assert.rejects(voice("acima do total por minuto", signal), { status: 429, code: "voice_usage_limit" });
  clock += 60_000;
  await voice("Oi", signal);
  assert.equal(calls, 10);
});
