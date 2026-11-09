import type { Snapshot } from "../../src/web/contracts.js";
import { finalReply, speakableText } from "../../src/web/voice-text.ts";
export { finalReply, speakableText } from "../../src/web/voice-text.ts";

type SpeechEngine = Pick<SpeechSynthesis, "getVoices" | "addEventListener" | "removeEventListener" | "speak" | "cancel">;
type VoiceProvider = "elevenlabs" | "local";
type RemotePlayback = {
  audio: Pick<HTMLAudioElement, "volume" | "playbackRate" | "onplaying" | "onended" | "onerror" | "play">;
  dispose(): void;
};
type LoadRemoteVoice = (sessionId: string, turnId: string, signal: AbortSignal) => Promise<RemotePlayback>;
type VoiceJob = { key: string; utterance?: SpeechSynthesisUtterance; abort?: AbortController; remote?: RemotePlayback };
export type VoiceState = {
  enabled: boolean;
  provider: VoiceProvider;
  playingProvider: VoiceProvider | null;
  localSupported: boolean;
  remoteSupported: boolean;
  voices: readonly SpeechSynthesisVoice[];
  voiceURI: string;
  volume: number;
  rate: number;
  playback: "idle" | "pending" | "speaking";
  error: string;
};

const unavailable = "Nenhuma voz local pt-BR disponível neste dispositivo.";
// Voice names are only an ordering hint. The API exposes no gender metadata.
const preferredVoice = /\b(?:male|masculin[oa]|daniel|ricardo|felipe|antonio|antônio|thiago)\b/i;

function* speechChunks(text: string) {
  const limit = 200;
  while (text.length > limit) {
    const prefix = text.slice(0, limit + 1);
    const sentenceEnd = [...prefix.matchAll(/[.!?](?=\s)|\n/g)].at(-1)?.index;
    const wordEnd = Math.max(prefix.lastIndexOf(" "), prefix.lastIndexOf("\n"));
    const end = sentenceEnd && sentenceEnd > limit / 3 ? sentenceEnd + 1 : wordEnd > 0 ? wordEnd : limit;
    yield text.slice(0, end).trim();
    text = text.slice(end).trimStart();
  }
  if (text) yield text;
}

export class VoiceController {
  private state: VoiceState;
  private active: VoiceJob | undefined;
  private sessionId = "";
  private hasSnapshot = false;
  private handled = new Set<string>();
  private expected = new Set<string>();

  constructor(private readonly engine: SpeechEngine | undefined,
    private readonly utterance: (text: string) => SpeechSynthesisUtterance,
    private readonly update: (state: VoiceState) => void,
    private readonly loadRemote?: LoadRemoteVoice) {
    this.state = {
      enabled: false, provider: loadRemote ? "elevenlabs" : "local", playingProvider: null,
      localSupported: !!engine, remoteSupported: !!loadRemote,
      voices: [], voiceURI: "", volume: 1, rate: 1, playback: "idle", error: "",
    };
    engine?.addEventListener("voiceschanged", this.refreshVoices);
    this.refreshVoices();
  }

  private set(change: Partial<VoiceState>) {
    this.state = { ...this.state, ...change };
    this.update(this.state);
  }

  private refreshVoices = () => {
    const voices = (this.engine?.getVoices() ?? [])
      .filter((voice) => voice.localService && /^pt[-_]br$/i.test(voice.lang))
      .sort((a, b) => Number(preferredVoice.test(b.name)) - Number(preferredVoice.test(a.name)) ||
        Number(b.default) - Number(a.default));
    const error = !voices.length && this.state.enabled && this.state.provider === "local" ? unavailable :
      this.state.error === unavailable ? "" : this.state.error;
    this.set({ voices, error });
  };

  configure(change: Partial<Pick<VoiceState, "enabled" | "provider" | "voiceURI" | "volume" | "rate">>) {
    if (change.enabled === false || change.volume === 0 || (change.provider && change.provider !== this.state.provider)) this.stop();
    this.set({ ...change, error: "" });
    if (this.state.enabled) this.refreshVoices();
  }

  selectSession(id: string) {
    if (id === this.sessionId) return;
    this.stop();
    this.sessionId = id;
    this.hasSnapshot = false;
    this.handled.clear();
    this.expected.clear();
  }

  expectReply(sessionId: string, turnId: string) {
    if (sessionId === this.sessionId && !this.hasSnapshot) this.expected.add(turnId);
  }

  observe(snapshot: Snapshot) {
    if (snapshot.sessionId !== this.sessionId) return;
    let latest: { id: string; text: string } | undefined;
    for (const turn of snapshot.turns) {
      const text = finalReply(snapshot, turn);
      if (!text || this.handled.has(turn.id)) continue;
      const expected = this.expected.delete(turn.id);
      this.handled.add(turn.id);
      if (this.hasSnapshot || expected) latest = { id: turn.id, text };
    }
    this.expected.clear();
    this.hasSnapshot = true;
    if (latest) this.play(latest.id, latest.text);
  }

  play(key: string, source: string) {
    if (!this.state.enabled || this.state.volume === 0 || this.active?.key === key) return;
    const text = speakableText(source);
    if (!text) return;
    this.stop();
    const job: VoiceJob = { key };
    this.active = job;
    this.set({ playback: "pending", playingProvider: null, error: "" });
    if (this.state.provider === "elevenlabs" && this.loadRemote && this.sessionId) {
      void this.playRemote(job, text, this.loadRemote);
    } else this.playLocal(job, text);
  }

  private finish(job: VoiceJob, error = "") {
    if (this.active !== job) return;
    this.active = undefined;
    job.remote?.dispose();
    this.set({ playback: "idle", playingProvider: null, error });
  }

  private async playRemote(job: VoiceJob, text: string, load: LoadRemoteVoice) {
    const abort = new AbortController();
    job.abort = abort;
    let started = false;
    const fallback = () => {
      if (this.active !== job || abort.signal.aborted || job.utterance) return;
      // Once audio has started, a replay would repeat already spoken text.
      if (started) {
        this.finish(job, "A reprodução da ElevenLabs foi interrompida. Use Reproduzir resposta.");
        return;
      }
      job.remote?.dispose();
      delete job.remote;
      this.playLocal(job, text, true);
    };
    try {
      const playback = await load(this.sessionId, job.key, AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]));
      if (this.active !== job) { playback.dispose(); return; }
      job.remote = playback;
      const { audio } = playback;
      audio.volume = this.state.volume;
      audio.playbackRate = this.state.rate;
      audio.onplaying = () => {
        if (this.active !== job || job.remote !== playback) return;
        started = true;
        this.set({ playback: "speaking", playingProvider: "elevenlabs" });
      };
      audio.onended = () => { if (job.remote === playback) this.finish(job); };
      audio.onerror = () => { if (job.remote === playback) fallback(); };
      await audio.play();
    } catch { fallback(); }
  }

  private playLocal(job: VoiceJob, text: string, fallback = false) {
    const { engine } = this;
    const { voices, voiceURI, volume, rate } = this.state;
    const voice = voices.find((item) => item.voiceURI === voiceURI) ?? voices[0];
    if (!engine || !voice) {
      this.finish(job, fallback ? "ElevenLabs indisponível. " + unavailable : unavailable);
      return;
    }
    const chunks = speechChunks(text);
    const next = () => {
      const chunk = chunks.next();
      if (chunk.done) { this.finish(job); return; }
      try {
        const utterance = this.utterance(chunk.value);
        job.utterance = utterance;
        utterance.voice = voice;
        utterance.lang = "pt-BR";
        utterance.volume = volume;
        utterance.rate = rate;
        const current = () => this.active === job && job.utterance === utterance;
        utterance.onstart = () => { if (current()) this.set({ playback: "speaking", playingProvider: "local" }); };
        utterance.onend = () => { if (current()) next(); };
        utterance.onerror = (event) => {
          if (!current()) return;
          this.finish(job, event.error === "not-allowed" ? "O navegador bloqueou a leitura automática. Use Reproduzir resposta."
            : "O navegador não conseguiu reproduzir esta resposta.");
        };
        engine.speak(utterance);
      } catch {
        this.finish(job, "O navegador não conseguiu reproduzir esta resposta.");
      }
    };
    next();
  }

  stop(turnId?: string) {
    if (turnId) {
      this.expected.delete(turnId);
      this.handled.add(turnId);
    }
    const job = this.active;
    if (!job) return;
    this.active = undefined;
    job.abort?.abort();
    job.remote?.dispose();
    if (job.utterance) this.engine?.cancel();
    this.set({ playback: "idle", playingProvider: null });
  }

  dispose() {
    this.engine?.removeEventListener("voiceschanged", this.refreshVoices);
    this.stop();
  }
}

export function browserVoice(update: (state: VoiceState) => void) {
  if (typeof window === "undefined") return;
  const engine = window.speechSynthesis;
  const local = typeof window.SpeechSynthesisUtterance === "function" && engine &&
    typeof engine.getVoices === "function" && typeof engine.speak === "function" && typeof engine.cancel === "function";
  const remote = typeof window.Audio === "function" && typeof window.fetch === "function" &&
    typeof URL.createObjectURL === "function" && typeof AbortSignal.any === "function" && typeof AbortSignal.timeout === "function";
  if (!local && !remote) return;
  return new VoiceController(local ? engine : undefined, (text) => new window.SpeechSynthesisUtterance(text), update,
    remote ? loadElevenLabs : undefined);
}

async function loadElevenLabs(sessionId: string, turnId: string, signal: AbortSignal): Promise<RemotePlayback> {
  const path = "/api/sessions/" + encodeURIComponent(sessionId) + "/messages/" + encodeURIComponent(turnId) + "/voice";
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal });
  if (!response.ok || response.headers.get("content-type") !== "audio/mpeg") throw new Error("Áudio indisponível.");
  const blob = await response.blob();
  if (!blob.size) throw new Error("Áudio vazio.");
  const audio = new Audio();
  const url = URL.createObjectURL(blob);
  audio.src = url;
  return {
    audio,
    dispose() {
      audio.onplaying = audio.onended = audio.onerror = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
    },
  };
}
