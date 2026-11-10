import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { VoiceInput, type InputState } from "../web/app/voice-input.js";

test("quiet final transcripts wake VOID without VAD, deduplicate and stop without remote fallback", async (t) => {
  let state!: InputState;
  let recognition!: RecognitionMock;
  const sent: string[] = [];
  let tracksStopped = 0;
  const track = Object.assign(new EventTarget(), { readyState: "live", stop() { tracksStopped++; } });
  class RecognitionMock {
    lang = ""; processLocally = false; continuous = false; interimResults = false;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null;
    static async available() { return "available" as const; }
    start(input?: MediaStreamTrack) {
      recognition = this;
      assert.equal(this.lang, "pt-BR");
      assert.equal(this.processLocally, true);
      assert.equal(input, track);
      this.onstart?.();
    }
    stop() { this.onend?.(); }
    abort() {}
  }
  class AudioMock {
    state = "running";
    async resume() {} async close() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(0) }; }
  }
  const values = {
    window: { isSecureContext: true, AudioContext: AudioMock }, document: { hidden: false },
    navigator: { permissions: { query: async () => ({ state: "granted" }) },
      mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) } },
    AudioContext: AudioMock,
  };
  for (const [key, value] of Object.entries(values)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (original) Object.defineProperty(globalThis, key, original); else Reflect.deleteProperty(globalThis, key); });
  }
  const input = new VoiceInput(RecognitionMock, next => { state = next; }, text => { sent.push(text); }, () => {});
  t.after(() => input.dispose());
  await setImmediate();
  await input.startAutomatically();
  await setImmediate();
  assert.equal(state.phase, "wake");
  const event = { resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "VOID, abra configurações" } }] };
  recognition.onresult?.(event);
  recognition.onresult?.(event);
  assert.equal(state.phase, "listening", "quiet wake word must not be discarded");
  // A real recognition end finalizes the current captured utterance on silence.
  input.configure({ pauseMs: 0, idleMs: 300_000 });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(sent, ["abra configurações"]);
  recognition.onerror?.({ error: "network" });
  assert.equal(state.mode, null);
  assert.equal(tracksStopped, 1);
  assert.equal(state.engine, null, "no remote fallback without consent");
});
