import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { Execution, Snapshot, Turn } from "../src/web/contracts.js";
import { finalReply, speakableText, VoiceController, type VoiceState } from "../web/app/voice-controller.js";

const voice = (name: string, lang = "pt-BR", localService = true): SpeechSynthesisVoice =>
  ({ name, lang, localService, voiceURI: name, default: false });
class SpeechMock extends EventTarget {
  voices: SpeechSynthesisVoice[] = [];
  spoken: SpeechSynthesisUtterance[] = [];
  cancelled = 0;
  getVoices() { return this.voices; }
  speak(utterance: SpeechSynthesisUtterance) { this.spoken.push(utterance); }
  cancel() { this.cancelled++; }
}

type Remote = NonNullable<ConstructorParameters<typeof VoiceController>[3]>;

function setup(remote?: Remote) {
  const engine = new SpeechMock();
  let state!: VoiceState;
  const controller = new VoiceController(engine, (text) => ({ text }) as SpeechSynthesisUtterance,
    (next) => { state = next; }, remote);
  return { controller, engine, state: () => state };
}

function audioMock(play = async () => {}) {
  const audio = {
    volume: 1, playbackRate: 1,
    onplaying: null as HTMLAudioElement["onplaying"],
    onended: null as HTMLAudioElement["onended"],
    onerror: null as HTMLAudioElement["onerror"],
    play,
  };
  let disposals = 0;
  return { audio, dispose() { disposals++; }, disposals: () => disposals };
}

test("ElevenLabs plays a final reply once across SSE snapshots with the selected controls", async () => {
  const remote = audioMock();
  let requests = 0;
  const { controller, engine, state } = setup(async (sessionId, turnId) => {
    assert.deepEqual([sessionId, turnId], ["a", "new"]);
    requests++;
    return remote;
  });
  assert.equal(state().provider, "elevenlabs");
  controller.configure({ enabled: true, rate: 1.25, volume: 0.4 });
  controller.selectSession("a");
  controller.observe(snapshot([turn("old", "Histórico.")]));
  const final = snapshot([turn("new", "Final.")]);
  controller.observe(final);
  controller.observe(final);
  assert.equal(state().playback, "pending");
  await setImmediate();
  assert.equal(remote.audio.playbackRate, 1.25);
  assert.equal(remote.audio.volume, 0.4);
  remote.audio.onplaying?.call(remote.audio as unknown as GlobalEventHandlers, new Event("playing"));
  assert.equal(state().playingProvider, "elevenlabs");
  assert.equal(state().playback, "speaking");
  remote.audio.onended?.call(remote.audio as unknown as GlobalEventHandlers, new Event("ended"));
  assert.equal(state().playback, "idle");
  assert.equal(remote.disposals(), 1);
  assert.equal(engine.spoken.length, 0);
  assert.equal(requests, 1);
});

test("remote failures fall back once and selecting local skips remote entirely", async () => {
  let requests = 0;
  const { controller, engine, state } = setup(async () => {
    requests++;
    throw new Error("429 quota");
  });
  engine.voices = [voice("Daniel")];
  controller.configure({ enabled: true });
  controller.selectSession("a");
  controller.play("quota", "Cota esgotada.");
  await setImmediate();
  assert.deepEqual(engine.spoken.map(({ text }) => text), ["Cota esgotada."]);
  emit(engine.spoken[0]!, "onstart");
  assert.equal(state().playingProvider, "local");
  controller.configure({ provider: "local" });
  assert.equal(engine.cancelled, 1);
  controller.play("local", "Voz do sistema.");
  assert.equal(engine.spoken[1]?.text, "Voz do sistema.");
  assert.equal(requests, 1);
});

test("stop aborts pending ElevenLabs and discards late audio without local fallback", async () => {
  const remote = audioMock();
  let finish!: (value: typeof remote) => void;
  let captured!: AbortSignal;
  const { controller, engine, state } = setup((_session, _turn, signal) => {
    captured = signal;
    return new Promise((resolve) => { finish = resolve; });
  });
  engine.voices = [voice("Daniel")];
  controller.configure({ enabled: true });
  controller.selectSession("a");
  controller.play("turn", "Pare.");
  controller.stop();
  assert.equal(captured.aborted, true);
  assert.equal(state().playback, "idle");
  finish(remote);
  await setImmediate();
  assert.equal(remote.disposals(), 1);
  assert.equal(engine.spoken.length, 0);
});

test("playback denial uses the local voice, and provider changes stop active remote audio", async () => {
  const denied = audioMock(async () => { throw new Error("not allowed"); });
  const playing = audioMock();
  const { controller, engine, state } = setup(async (_session, key) => key === "blocked" ? denied : playing);
  engine.voices = [voice("Daniel")];
  controller.configure({ enabled: true });
  controller.selectSession("a");
  controller.play("blocked", "Reprodução bloqueada.");
  await setImmediate();
  assert.equal(denied.disposals(), 1);
  assert.equal(engine.spoken.length, 1);
  controller.play("playing", "Reproduzindo.");
  await setImmediate();
  playing.audio.onplaying?.call(playing.audio as unknown as GlobalEventHandlers, new Event("playing"));
  assert.equal(state().playingProvider, "elevenlabs");
  controller.configure({ provider: "local" });
  assert.equal(playing.disposals(), 1);
  assert.equal(state().playback, "idle");
  assert.equal(engine.spoken.length, 1);
});

function turn(id: string, response: string | null, extra: Partial<Turn> = {}): Turn {
  return { id, response, request: "Pergunta", executionId: null, failure: null, model: null, ...extra };
}
function snapshot(turns: Turn[], extra: Partial<Snapshot> = {}): Snapshot {
  return { sessionId: "a", turns, active: null, executions: [], notices: [], ...extra };
}
function emit(utterance: SpeechSynthesisUtterance, name: "onstart" | "onend") {
  utterance[name]?.(new Event(name) as SpeechSynthesisEvent);
}

test("prepares spoken prose while preserving the original Markdown", () => {
  const source = [
    "## **Resumo**", "", "- Leia [a referência](https://exemplo.com/a(b)).",
    "Use " + String.fromCharCode(96) + "x = y" + String.fromCharCode(96) + " com cuidado.", "",
    "~~~ts", "throw new Error('não ler');", "~~~", "",
    "| Um | Dois |", "| --- | --- |", "| A | B |", "",
    "> Concluído. https://exemplo.com", "", "    código indentado",
  ].join("\n");
  assert.equal(speakableText(source), "Resumo\nLeia a referência.\nUse com cuidado.\nConcluído.");
  assert.ok(source.includes("throw new Error"));
  assert.equal(speakableText("~~~ts\nconst x = 1;"), "");
});

test("filters local pt-BR voices, prefers a name hint, and honors explicit controls", () => {
  const { controller, engine, state } = setup();
  engine.voices = [voice("Maria"), voice("Daniel"), voice("Online", "pt-BR", false), voice("Portugal", "pt-PT")];
  engine.dispatchEvent(new Event("voiceschanged"));
  assert.deepEqual(state().voices.map(({ name }) => name), ["Daniel", "Maria"]);
  controller.play("a", "Silêncio");
  assert.equal(engine.spoken.length, 0);
  controller.configure({ enabled: true, volume: 0.4, rate: 1.25 });
  controller.play("a", "Resposta.");
  assert.equal(engine.spoken[0]?.voice?.name, "Daniel");
  controller.configure({ voiceURI: "Maria" });
  controller.play("b", "Outra.");
  assert.equal(engine.cancelled, 1);
  assert.equal(engine.spoken[1]?.voice?.name, "Maria");
  assert.equal(engine.spoken[1]?.rate, 1.25);
  assert.equal(engine.spoken[1]?.volume, 0.4);
  controller.configure({ volume: 0 });
  assert.equal(engine.cancelled, 2);
  assert.equal(state().playback, "idle");
});

test("reads only new final replies once across repeated snapshots and supports explicit replay", () => {
  const { controller, engine } = setup();
  engine.voices = [voice("Daniel")];
  controller.configure({ enabled: true });
  controller.selectSession("a");
  const history = turn("old", "Histórico.");
  const answer = turn("new", "Final.");
  controller.observe(snapshot([history]));
  controller.observe(snapshot([history, turn("new", null)], { active: { turnId: "new", executionId: null, draft: "Rascunho" } }));
  controller.observe(snapshot([history, answer], { active: { turnId: "new", executionId: null } }));
  assert.equal(engine.spoken.length, 0);
  controller.observe(snapshot([history, answer]));
  emit(engine.spoken[0]!, "onend");
  controller.observe(snapshot([history, answer]));
  assert.deepEqual(engine.spoken.map(({ text }) => text), ["Final."]);
  controller.play(answer.id, answer.response!);
  assert.equal(engine.spoken.length, 2);
  controller.selectSession("b");
  controller.observe(snapshot([turn("late", "Sessão anterior.")]));
  assert.equal(engine.cancelled, 1);
  assert.equal(engine.spoken.length, 2);
});

test("skips unvalidated delegated fallbacks, cancelled runs and a stopped turn", () => {
  const { controller, engine } = setup();
  engine.voices = [voice("Daniel")];
  controller.configure({ enabled: true });
  controller.selectSession("a");
  controller.expectReply("a", "first");
  controller.observe(snapshot([turn("first", "Resposta enviada antes do primeiro snapshot.")]));
  controller.stop("late");
  controller.observe(snapshot([turn("late", "Resposta que chegou após Parar.")]));
  assert.equal(engine.spoken.length, 1);
  const run = { id: "job", status: "completed" } as Execution;
  for (const response of [
    "Execução concluída.\n\n## Resultados dos especialistas\n\nResultados brutos.",
    "Execução concluída.\n\nNão consegui concluir a síntese automática. Seguem os resultados disponíveis.",
  ]) {
    const result = turn("delegated", response, { executionId: run.id });
    assert.equal(finalReply(snapshot([result], { executions: [run] }), result), undefined);
  }
  const result = turn("delegated", "Execução concluída.\n\nSíntese validada.", { executionId: run.id });
  assert.equal(finalReply(snapshot([result], { executions: [run] }), result), result.response);
  assert.equal(finalReply(snapshot([result], { executions: [{ ...run, status: "cancelled" }] }), result), undefined);
});

test("queues one chunk at a time and ignores old callbacks after stop, mute or replacement", () => {
  const { controller, engine, state } = setup();
  engine.voices = [voice("Daniel")];
  controller.configure({ enabled: true });
  controller.play("long", "Uma frase longa para sintetizar. ".repeat(20));
  const first = engine.spoken[0]!;
  assert.equal(state().playback, "pending");
  emit(first, "onstart");
  assert.equal(state().playback, "speaking");
  assert.equal(engine.spoken.length, 1);
  emit(first, "onend");
  assert.equal(engine.spoken.length, 2);
  const second = engine.spoken[1]!;
  controller.play("replacement", "Nova resposta.");
  emit(second, "onstart");
  emit(second, "onend");
  assert.equal(state().playback, "pending");
  assert.equal(engine.spoken.length, 3);
  controller.configure({ enabled: false });
  emit(engine.spoken[2]!, "onend");
  assert.equal(state().playback, "idle");
  assert.equal(engine.cancelled, 2);
  controller.dispose();
});

test("waits for a gesture before requesting synthesis and honors mute on server refresh", async () => {
  const engine = new SpeechMock();
  let activated = false, requests = 0;
  let state!: VoiceState;
  const controller = new VoiceController(engine, (text) => ({ text }) as SpeechSynthesisUtterance,
    (next) => { state = next; }, async () => { requests++; return audioMock(); },
    { enabled: true, waitForServer: true, canPlay: () => activated });
  controller.selectSession("a");
  controller.setRemoteStatus({ enabled: true, issue: null });
  controller.play("new", "Resposta.");
  assert.match(state.error, /bloqueou/);
  assert.equal(requests, 0);
  activated = true;
  controller.play("new", "Resposta.");
  assert.equal(requests, 1);
  controller.configure({ enabled: false });
  controller.setRemoteStatus({ enabled: true, issue: null });
  controller.play("new", "Resposta.");
  assert.equal(state.enabled, false);
  assert.equal(requests, 1);
  await setImmediate();
});

test("reports autoplay blocking and permits a manual retry", () => {
  const { controller, engine, state } = setup();
  controller.configure({ enabled: true });
  assert.match(state().error, /Nenhuma voz local/);
  engine.voices = [voice("Daniel")];
  engine.dispatchEvent(new Event("voiceschanged"));
  controller.play("a", "Resposta.");
  engine.spoken[0]!.onerror?.({ error: "not-allowed" } as SpeechSynthesisErrorEvent);
  assert.match(state().error, /bloqueou/);
  assert.equal(state().playback, "idle");
  controller.play("a", "Resposta.");
  assert.equal(engine.spoken.length, 2);
});
