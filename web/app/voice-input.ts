type Pack = "available" | "downloadable" | "downloading" | "unavailable";
const permissionGesture = "Clique para retomar a escuta e confirme o acesso ao microfone se o navegador pedir.";
const micDenied = "O acesso ao microfone foi recusado. Confira a permissão deste site no navegador e tente novamente.";

type PackOptions = { langs: string[]; processLocally: true };
type Recognition = {
  lang: string;
  processLocally: boolean;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onstart: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(track?: MediaStreamTrack): void;
  stop(): void;
  abort(): void;
};
type Speech = {
  new(): Recognition;
  available?(options: PackOptions): Promise<Pack>;
  install?(options: PackOptions): Promise<boolean>;
};

const packOptions: PackOptions = { langs: ["pt-BR"], processLocally: true };
const wakeWord = /^[\s\p{P}]*void(?![\p{L}\p{N}_])[\s\p{P}]*/iu;
const speechText = /[\p{L}\p{N}]/u;
const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase("pt-BR")
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export type InputStatus = "checking" | "unavailable" | Pack;
export type InputPhase = "off" | "starting" | "wake" | "listening" | "transcribing" | "paused";
export type InputState = {
  status: InputStatus; packError: string; phase: InputPhase; mode: "manual" | "hands-free" | null;
  engine: "local" | "browser" | null; browserSupported: boolean; captureIssue: string;
  permission: PermissionState | "unknown"; error: string; code: string;
};
type PolicyDocument = Document & {
  permissionsPolicy?: { allowsFeature(feature: string): boolean; features?(): string[] };
  featurePolicy?: { allowsFeature(feature: string): boolean; features?(): string[] };
};
function policyBlocks(feature: string) {
  const doc = document as PolicyDocument;
  const policy = doc.permissionsPolicy ?? doc.featurePolicy;
  return policy?.features?.().includes(feature) && !policy.allowsFeature(feature);
}
async function microphonePermission() {
  return (await navigator.permissions?.query({ name: "microphone" as PermissionName }).catch(() => undefined))?.state ?? "unknown";
}
export type InputSettings = { pauseMs: number; idleMs: number };

type Capture = {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  meter: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  recognition?: Recognition;
  timer?: ReturnType<typeof setInterval>;
  readyTimer?: ReturnType<typeof setTimeout>;
  endTimer?: ReturnType<typeof setTimeout>;
  restartTimer?: ReturnType<typeof setTimeout>;
  text: string[];
  startedAt: number;
  lastSound: number;
  soundFrames: number;
  closing: boolean;
  shortEnds: number;
};

export class VoiceInput {
  private state: InputState = {
    status: "checking", packError: "", phase: "off", mode: null, engine: null, browserSupported: false,
    captureIssue: "", permission: "unknown", error: "", code: "",
  };
  private settings: InputSettings = { pauseMs: 1_000, idleMs: 300_000 };
  private capture: Capture | undefined;
  private audio: { context: AudioContext; ready: Promise<boolean> } | undefined;
  private browserFallback = false;
  private generation = 0;
  private disposed = false;
  private awakeUntil = 0;
  private processing = false;
  private playback = false;
  private resumeTimer: ReturnType<typeof setTimeout> | undefined;
  private previous: { text: string; at: number } | undefined;

  constructor(
    private readonly speech: Speech | undefined,
    private readonly update: (state: InputState) => void,
    private readonly submit: (text: string) => void,
    private readonly authorizeHandsFree: () => void,
  ) {
    this.set({
      browserSupported: !!speech,
      captureIssue: !window.isSecureContext ? "Abra o VOID em localhost ou por HTTPS para usar o microfone."
        : policyBlocks("microphone") ? "A política desta página bloqueia o microfone. Abra o VOID diretamente em uma aba."
          : !navigator.mediaDevices?.getUserMedia || !window.AudioContext ? "Este navegador não oferece captura de áudio compatível." : "",
    });
    void this.checkPack();
  }

  private set(change: Partial<InputState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...change };
    this.update(this.state);
  }

  private async checkPack(install = false) {
    this.set({ status: "checking", packError: "" });
    try {
      if (policyBlocks("on-device-speech-recognition")) {
        this.set({ status: "unavailable", packError: "A política desta página bloqueia o reconhecimento local. Abra o VOID diretamente em uma aba." });
        return;
      }
      if (!this.speech?.available || !("processLocally" in new this.speech())) {
        this.set({ status: "unavailable", packError: "Este navegador não oferece reconhecimento local de fala compatível." });
        return;
      }
      const installed = !install || await this.speech.install?.(packOptions).catch(() => false);
      const status = await this.speech.available(packOptions);
      this.set({
        status: ["available", "downloadable", "downloading"].includes(status) ? status : "unavailable",
        packError: !installed && status !== "available" && status !== "downloading"
          ? "Não foi possível instalar o pacote pt-BR. Tente novamente ou use o teclado." : "",
      });
    } catch {
      this.set({ status: "unavailable", packError: "Não foi possível consultar o pacote local pt-BR. Verifique a política do navegador ou tente novamente." });
    }
  }

  install() {
    if (this.state.status !== "checking" && !this.state.mode) {
      void this.checkPack(this.state.status === "downloadable");
    }
  }

  configure(settings: InputSettings) {
    if (this.awakeUntil && this.state.mode === "hands-free") this.awakeUntil += settings.idleMs - this.settings.idleMs;
    this.settings = settings;
  }

  configureFallback(enabled: boolean) {
    this.browserFallback = enabled;
    if (!enabled && this.state.engine === "browser") this.stop();
  }

  private canStart() {
    return !this.state.captureIssue && !this.state.mode && !this.processing && !this.playback &&
      !document.hidden && !this.disposed && this.state.status !== "checking" && !!this.speech;
  }

  private get engine() {
    return this.state.status === "available" ? "local" : this.browserFallback ? "browser" : null;
  }

  async startAutomatically() {
    if (!this.canStart() || !this.engine) return;
    const generation = this.generation;
    const permission = await microphonePermission();
    if (generation !== this.generation || !this.canStart() || !this.engine) return;
    this.set({ permission });
    if (permission === "granted") this.start("hands-free");
    else this.stop(permission === "denied" ? micDenied : permissionGesture, "permissão automática");
  }

  start(mode: NonNullable<InputState["mode"]>) {
    if (!this.canStart()) return;
    const engine = this.engine;
    if (!engine && mode === "manual") return;
    try {
      if (engine) {
        // Unlock Web Audio in the click, before waiting for the permission prompt.
        const context = new AudioContext();
        const ready = context.resume().then(() => context.state === "running", () => false);
        this.audio = { context, ready };
      }
      this.set({ mode, phase: "starting", engine, error: "", code: "" });
      void this.open();
    } catch {
      this.stop("O navegador não conseguiu ativar o áudio. Clique para tentar novamente.", "Web Audio · inicialização");
    }
  }

  setProcessing(processing: boolean) {
    if (processing === this.processing) return;
    this.processing = processing;
    if (!processing && this.awakeUntil && this.state.mode === "hands-free") this.awakeUntil = performance.now() + this.settings.idleMs;
    this.reconcile();
  }

  setPlayback(playback: boolean) {
    if (playback === this.playback) return;
    this.playback = playback;
    if (!playback && this.awakeUntil && this.state.mode === "hands-free") this.awakeUntil = performance.now() + this.settings.idleMs;
    this.reconcile(playback ? 0 : 350);
  }

  private reconcile(delay = 0) {
    if (!this.state.mode) return;
    clearTimeout(this.resumeTimer);
    if (this.processing || this.playback) {
      this.release();
      this.set({ phase: "paused" });
    } else if (!this.capture && this.state.phase === "paused") {
      // Keep a short guard interval after stopping output so speaker tails are not transcribed.
      this.resumeTimer = setTimeout(() => void this.resume(), delay || 350);
    }
  }

  private async resume() {
    if (!this.canOpen()) return;
    const generation = this.generation;
    const permission = await microphonePermission();
    if (generation !== this.generation || !this.canOpen()) return;
    this.set({ permission });
    if (permission === "granted") void this.open();
    else this.stop(permission === "denied" ? micDenied : permissionGesture, "permissão na retomada");
  }

  private canOpen() {
    return !!this.state.mode && !this.disposed && !document.hidden &&
      !this.capture && !this.processing && !this.playback;
  }

  stopActive() {
    if (this.state.mode) this.stop();
    else this.generation++;
  }

  stop(error = "", code = "") {
    clearTimeout(this.resumeTimer);
    this.release();
    void this.audio?.context.close().catch(() => {});
    this.audio = undefined;
    this.awakeUntil = 0;
    this.previous = undefined;
    this.set({ phase: "off", mode: null, engine: null, error, code });
  }

  dispose() {
    this.disposed = true;
    this.stop();
  }

  private release() {
    this.generation++;
    const capture = this.capture;
    this.capture = undefined;
    if (!capture) return;
    clearInterval(capture.timer);
    clearTimeout(capture.readyTimer);
    clearTimeout(capture.endTimer);
    clearTimeout(capture.restartTimer);
    capture.stream.getTracks().forEach((track) => track.stop());
    this.detach(capture);
    capture.source.disconnect();
  }

  private detach(capture: Capture) {
    const recognition = capture.recognition;
    if (!recognition) return;
    delete capture.recognition;
    recognition.onstart = recognition.onresult = recognition.onerror = recognition.onend = null;
    try { recognition.abort(); } catch { /* Already ended. */ }
  }

  private async open() {
    if (!this.canOpen()) return;
    const generation = this.generation;
    this.set({ phase: "starting" });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (error) {
      if (generation !== this.generation || !this.canOpen()) return;
      const name = error instanceof Error ? error.name : "erro desconhecido";
      const denied = name === "NotAllowedError" || name === "SecurityError";
      if (denied) this.set({ permission: "denied" });
      this.stop(denied ? micDenied
        : name === "NotFoundError" ? "Nenhum microfone foi encontrado. Conecte um dispositivo e tente novamente."
          : name === "NotReadableError" ? "Não foi possível acessar o dispositivo. Verifique o microfone nas configurações do sistema."
            : "Não foi possível abrir o microfone. Clique para tentar novamente.", "captura · " + name);
      return;
    }

    const audio = this.audio;
    if (generation !== this.generation || !this.canOpen()) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.set({ permission: "granted" });
    if (this.state.mode === "hands-free") this.authorizeHandsFree();
    if (!audio) {
      // First-run permission can be saved while the language pack still needs setup.
      stream.getTracks().forEach((track) => track.stop());
      this.stop();
      return;
    }
    try {
      const meter = audio.context.createAnalyser();
      meter.fftSize = 1024;
      const source = audio.context.createMediaStreamSource(stream);
      source.connect(meter);
      const capture: Capture = { stream, source, meter, samples: new Float32Array(meter.fftSize), text: [],
        startedAt: 0, lastSound: 0, soundFrames: 0, closing: false, shortEnds: 0 };
      this.capture = capture;
      for (const track of stream.getTracks()) {
        track.addEventListener("ended", () => {
          if (this.capture === capture) this.stop("O microfone foi interrompido. Verifique o dispositivo e tente novamente.", "captura · faixa encerrada");
        });
      }
      capture.readyTimer = setTimeout(() => {
        if (this.capture === capture) this.stop("O navegador não ativou o áudio automaticamente. Clique para retomar.", "Web Audio · tempo limite");
      }, 4_000);
      const ready = await audio.ready;
      if (this.capture !== capture) return;
      clearTimeout(capture.readyTimer);
      if (!ready || audio.context.state !== "running") {
        this.stop("O navegador não conseguiu preparar o áudio. Clique para retomar.", "Web Audio · contexto suspenso");
        return;
      }
      if (this.state.mode === "manual") this.awakeUntil = performance.now() + 12_000;
      capture.timer = setInterval(() => this.sample(capture), 40);
      this.recognize(capture);
    } catch {
      if (!this.capture) stream.getTracks().forEach((track) => track.stop());
      this.stop("O navegador não conseguiu conectar o microfone ao áudio. Verifique o dispositivo e tente novamente.", "Web Audio · conexão da captura");
    }
  }

  private recognize(capture: Capture) {
    if (this.capture !== capture || capture.closing || !this.speech) return;
    const local = this.state.engine === "local";
    try {
      const track = capture.stream.getAudioTracks()[0];
      if (!track || track.readyState !== "live") throw new Error("audio-track");
      const recognition = new this.speech();
      capture.recognition = recognition;
      recognition.lang = "pt-BR";
      if ("processLocally" in recognition) recognition.processLocally = local;
      recognition.continuous = true;
      recognition.interimResults = false;
      const seen = new Set<number>();
      const openedAt = performance.now();
      capture.readyTimer = setTimeout(() => {
        if (capture.recognition === recognition) this.recognitionFailed(capture, "tempo limite", "O reconhecimento demorou para iniciar. Clique para retomar.");
      }, 8_000);
      recognition.onstart = () => {
        if (capture.recognition !== recognition) return;
        clearTimeout(capture.readyTimer);
        if (!capture.closing) this.set({ phase: this.awakeUntil ? "listening" : "wake" });
      };
      recognition.onresult = ({ resultIndex, results }) => {
        if (capture.recognition !== recognition || !capture.startedAt) return;
        for (let i = resultIndex; i < results.length; i++) {
          const result = results[i];
          if (!result?.isFinal || seen.has(i)) continue;
          seen.add(i);
          const text = result[0].transcript.trim();
          if (speechText.test(text)) capture.text.push(text);
        }
        this.detectWake(capture);
      };
      const ended = (reason: string) => {
        if (capture.recognition !== recognition) return;
        clearTimeout(capture.readyTimer);
        this.detach(capture);
        if (capture.closing) {
          this.finish(capture);
          return;
        }
        capture.shortEnds = performance.now() - openedAt < 300 ? capture.shortEnds + 1 : 0;
        if (capture.shortEnds >= 3) {
          this.recognitionFailed(capture, reason, "O reconhecimento encerrou repetidamente. Clique para retomar.");
        } else capture.restartTimer = setTimeout(() => this.recognize(capture), 250);
      };
      recognition.onerror = ({ error }) => {
        if (capture.recognition !== recognition) return;
        if (error === "no-speech" || error === "aborted") {
          ended(error);
          return;
        }
        const engine = local ? "local" : "do navegador";
        this.recognitionFailed(capture, error, error === "language-not-supported" && local
          ? "O pacote local pt-BR deixou de estar disponível. Verifique o pacote em Configurações."
          : error === "not-allowed" || error === "service-not-allowed"
            ? "O navegador bloqueou o reconhecimento de fala " + engine + " após abrir o microfone. Verifique as permissões e políticas do navegador."
            : error === "audio-capture" ? "O reconhecimento perdeu a entrada de áudio. Verifique o dispositivo e tente novamente."
              : error === "network" ? "O serviço de reconhecimento do navegador não respondeu. Verifique a conexão e tente novamente."
                : "O reconhecimento de fala foi interrompido. Clique para retomar.");
        if (error === "language-not-supported" && local) void this.checkPack();
      };
      recognition.onend = () => ended("onend");
      // Older browser-service implementations only support recognition from the default microphone.
      if (local) recognition.start(track);
      else recognition.start();
    } catch (error) {
      const name = error instanceof Error ? error.name : "erro desconhecido";
      this.recognitionFailed(capture, "start · " + name, name === "NotAllowedError"
        ? "O navegador bloqueou o reconhecimento de fala após abrir o microfone. Clique para retomar."
        : "Este navegador não conseguiu iniciar o reconhecimento. Confira as opções em Configurações.");
    }
  }

  private recognitionFailed(capture: Capture, reason: string, message: string) {
    const local = this.state.engine === "local";
    const code = (local ? "reconhecimento local" : "serviço do navegador") + " · " + reason;
    if (local && this.browserFallback) {
      clearTimeout(capture.readyTimer);
      clearTimeout(capture.endTimer);
      this.detach(capture);
      capture.text = [];
      capture.startedAt = capture.lastSound = capture.soundFrames = capture.shortEnds = 0;
      capture.closing = false;
      if (this.state.mode === "hands-free") this.awakeUntil = 0;
      this.set({ engine: "browser", phase: "starting", code });
      this.recognize(capture);
    } else this.stop(message, code);
  }

  private detectWake(capture: Capture) {
    if (this.awakeUntil) return;
    const text = capture.text.join(" ");
    const match = wakeWord.exec(text);
    if (!match) return;
    this.awakeUntil = performance.now() + this.settings.idleMs;
    capture.text = [text.slice(match[0].length)];
    this.set({ phase: capture.closing ? "transcribing" : "listening" });
  }

  private sample(capture: Capture) {
    if (capture.closing) return;
    capture.meter.getFloatTimeDomainData(capture.samples);
    let sum = 0;
    for (const value of capture.samples) sum += value * value;
    const now = performance.now();
    const loud = Math.sqrt(sum / capture.samples.length) >= 0.015;
    capture.soundFrames = loud ? capture.soundFrames + 1 : 0;
    if (loud && (capture.startedAt || capture.soundFrames >= 3)) {
      capture.startedAt ||= now;
      capture.lastSound = now;
    }
    if (capture.startedAt && (now - capture.lastSound >= this.settings.pauseMs || now - capture.startedAt >= 45_000)) {
      this.endUtterance(capture);
    } else if (!capture.startedAt && this.awakeUntil && now >= this.awakeUntil) {
      if (this.state.mode === "hands-free") {
        this.awakeUntil = 0;
        capture.text = [];
        this.set({ phase: "wake" });
      } else this.stop("Nenhuma fala detectada. Clique para falar e tente novamente.");
    }
  }

  private endUtterance(capture: Capture) {
    capture.closing = true;
    if (this.awakeUntil) this.set({ phase: "transcribing" });
    if (!capture.recognition) { this.finish(capture); return; }
    capture.endTimer = setTimeout(() => this.finish(capture), 1_500);
    try { capture.recognition.stop(); } catch { this.finish(capture); }
  }

  private finish(capture: Capture) {
    if (this.capture !== capture) return;
    clearTimeout(capture.endTimer);
    clearTimeout(capture.restartTimer);
    clearTimeout(capture.readyTimer);
    this.detach(capture);
    const text = capture.text.join(" ").trim().slice(0, 16_000);
    const key = normalize(text);
    const now = performance.now();
    const duplicate = this.previous?.text === key && now - this.previous.at < 2_000;
    if (this.awakeUntil && key && !duplicate) {
      this.previous = { text: key, at: now };
      this.awakeUntil = now + this.settings.idleMs;
      if (this.state.mode === "manual") this.stop();
      this.submit(text);
      if (this.capture !== capture) return;
    } else if (this.state.mode === "manual") {
      this.stop("Nenhuma fala reconhecida. Clique para falar e tente novamente.");
      return;
    }
    capture.text = [];
    capture.startedAt = capture.lastSound = capture.soundFrames = 0;
    capture.closing = false;
    this.recognize(capture);
  }
}

export function browserVoiceInput(update: (state: InputState) => void, submit: (text: string) => void, authorizeHandsFree: () => void) {
  const browser = window as Window & { SpeechRecognition?: Speech; webkitSpeechRecognition?: Speech };
  return new VoiceInput(browser.SpeechRecognition ?? browser.webkitSpeechRecognition, update, submit, authorizeHandsFree);
}
