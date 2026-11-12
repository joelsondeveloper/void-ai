"use client";

import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from "react";
import { efforts, failureText, type ActionName, type ApiError, type Effort, type Execution, type Extension,
  type SendMessage, type Session, type Snapshot, type SystemInfo } from "../../src/web/contracts";
import { applyUiAction, initialLayout, isUiEvent, type PanelId, type UiAction } from "../../src/web/ui-contracts";
import { DynamicDisplay } from "./runtime-panels";
import { FloatingWindow } from "./window-manager";
import { Icon, ringLabels, SingularityRing, type RingState } from "./singularity";
import { Workspace } from "./workspace";
import { ProviderPanel } from "./provider-panel";
import { browserVoice, finalReply, type VoiceController, type VoiceState } from "./voice-controller";
import { browserVoiceInput, type InputState, type VoiceInput } from "./voice-input";

const handsFreeKey = "void:voice-hands-free";
const microphoneSetupKey = "void:voice-hands-free-mic";
const browserRecognitionKey = "void:voice-browser-recognition";

const micLabels = {
  off: "Microfone desligado", starting: "Abrindo microfone…", wake: "Escuta local · diga “VOID”",
  listening: "Escutando · fale agora", transcribing: "Finalizando transcrição…",
  paused: "Microfone pausado",
};

function voiceNumber(key: string, fallback: number, min: number, max: number) {
  const raw = voicePreference(key);
  const value = Number(raw);
  return raw && value >= min && value <= max ? value : fallback;
}

const prompts = [
  { label: "Resposta direta", text: "Explique a diferença entre concorrência e paralelismo em programação." },
  { label: "Trabalho em equipe", text: "Analise a função TypeScript const first = (items: string[]) => items[0] e compare duas formas de tratar listas vazias." },
];
function voicePreference(key: string, value?: string) {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    else return localStorage.getItem(key);
  } catch { /* The current page can still use voice if storage is unavailable. */ }
}

const sessionPath = (id: string) => "/api/sessions/" + encodeURIComponent(id);

function DelegatedReply({ text }: { text: string }) {
  return text.split(/(\x60{3}[^\n]*\n[\s\S]*?\x60{3})/).map((part, index) => {
    if (part.startsWith("\x60\x60\x60") && part.endsWith("\x60\x60\x60")) {
      return <pre className="prewrap" key={index}><code>{part.slice(part.indexOf("\n") + 1, -3)}</code></pre>;
    }
    return part.trim().split(/\n{2,}/).filter(Boolean).map((block, blockIndex) => {
      const key = index + ":" + blockIndex;
      if (/^#{1,3} [^\n]+$/.test(block)) return <h3 key={key}>{block.replace(/^#+ /, "")}</h3>;
      return <p className="prewrap" key={key}>{block}</p>;
    });
  });
}

async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) } : { cache: "no-store" });
  const data = await response.json() as T | ApiError;
  if (!response.ok) {
    const failure = data as ApiError;
    throw new Error(failure.error?.message ?? "O servidor recusou a solicitação.");
  }
  return data as T;
}

function report(error: unknown) {
  return error instanceof Error && error.name !== "TypeError"
    ? error.message : "Não foi possível conectar ao servidor local. Tente novamente.";
}

function ringState(snapshot: Snapshot | null): RingState {
  if (!snapshot?.turns.length) return "idle";
  const turn = snapshot.turns.at(-1);
  const run = snapshot.executions.find((item) => item.id === turn?.executionId);
  if (snapshot.active) return snapshot.active.executionId ? "delegating" : "processing";
  if (run?.status === "paused" || run?.status === "awaiting_approval") return "approval";
  if (turn?.failure || run?.status === "failed" || run?.status === "cancelled") return "failed";
  return turn?.response ? "completed" : "idle";
}

export function Console() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [connection, setConnection] = useState<"connecting" | "online" | "reconnecting">("connecting");
  const [effort, setEffort] = useState<Effort>("auto");
  const [layout, setLayout] = useState(initialLayout);
  const { mode, panel } = layout;
  const [windowActivation, setWindowActivation] = useState(0);
  const [minimized, setMinimized] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const settingsOpen = panel === "settings" && !minimized;
  const [mobilePane, setMobilePane] = useState<"chat" | "details">("chat");
  const [showSessions, setShowSessions] = useState(false);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState("");
  const [optimistic, setOptimistic] = useState<{ sessionId: string; id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [booting, setBooting] = useState(true);
  const [reload, setReload] = useState(0);
  const [voiceState, setVoiceState] = useState<VoiceState>();
  const [inputState, setInputState] = useState<InputState>();
  const [handsFree, setHandsFree] = useState(true);
  const [microphoneSetup, setMicrophoneSetup] = useState(false);
  const [browserRecognition, setBrowserRecognition] = useState(false);
  const [pageReturn, setPageReturn] = useState(0);
  const [voicePause, setVoicePause] = useState(1);
  const [voiceIdle, setVoiceIdle] = useState(5);
  const pendingUi = useRef<{ sessionId: string; turnId: string } | null>(null);
  const voice = useRef<VoiceController>(undefined);
  const input = useRef<VoiceInput>(undefined);
  const dispatching = useRef(false);
  const retry = useRef<(SendMessage & { sessionId: string; source: "text" | "voice" }) | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const focusTrigger = useRef<HTMLButtonElement>(null);
  const previewFrame = useRef<HTMLIFrameElement>(null);
  const scrollRegion = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const current = snapshot?.sessionId === sessionId ? snapshot : null;
  const activeTurnId = current?.active?.turnId;
  const turns = current?.turns ?? [];
  const chatTurns = turns.filter((turn) => !turn.ui);
  const execution = current?.executions.find((item) => item.id === selected) ?? current?.executions.at(-1);
  const suggestion = current?.executions.slice().reverse().find((item) => item.status === "paused" || item.status === "awaiting_approval");
  const optimisticTurn = optimistic?.sessionId === sessionId && !turns.some((turn) => turn.id === optimistic.id) ? optimistic : null;
  const state = optimisticTurn ? "processing" : ringState(current);
  const speaking = voiceState?.playback === "speaking";
  const playing = speaking || voiceState?.playback === "pending";
  const audioBlocked = voiceState?.playback === "blocked";
  const waiting = connection === "reconnecting" && !!sessionId;
  const hasConversation = !!(chatTurns.length || optimisticTurn || sessionId && current === null);
  const textBlocked = busy || booting || !!activeTurnId || !!optimisticTurn || waiting;
  const micBlocked = textBlocked || !system;

  const micMode = inputState?.mode;
  const micPhase = inputState?.phase ?? "off";
  const localReady = inputState?.status === "available";
  const captureIssue = inputState?.captureIssue;
  const micReady = !!inputState && !captureIssue && inputState.status !== "checking" &&
    (localReady || (browserRecognition && inputState.browserSupported));
  const packLabel = inputState?.status === "checking" || !inputState ? "Verificando reconhecimento local…"
    : inputState.status === "downloadable" || inputState.status === "downloading"
      ? "Pacote de voz pt-BR pendente" : "Reconhecimento local pt-BR indisponível";
  const firstSetup = !microphoneSetup && !inputState?.error;
  const micStatus = micPhase === "off" ? inputState?.error || captureIssue || (!micReady ? packLabel
    : handsFree && firstSetup ? "Mãos livres · permita o microfone para começar" : micLabels.off)
    : micPhase === "wake" && inputState?.engine === "browser" ? "Serviço do navegador · diga “VOID”" : micLabels[micPhase];
  const engineStatus = micPhase !== "wake" && inputState?.engine === "browser" ? "Serviço do navegador" : "";
  const audioStatus = speaking ? "Falando" : playing ? "Preparando áudio"
    : audioBlocked ? "Reproduza a resposta para ouvir" : "";
  const voiceIssue = inputState?.error || voiceState?.error;
  const micIdle = !micBlocked && !playing && (!sessionId || !!current);
  const canListen = micReady && micIdle;
  const canRequestMic = !!inputState?.browserSupported && !captureIssue && inputState.status !== "checking";

  const submitSpeech = useEffectEvent((text: string) => { void sendMessage(text, "voice"); });
  const resumeHandsFree = useEffectEvent(() => {
    if (handsFree && microphoneSetup && canListen && !settingsOpen && !inputState?.error) {
      void input.current?.startAutomatically();
    }
  });

  useEffect(() => {
    const controller = browserVoiceInput(setInputState, (text) => submitSpeech(text), () => {
      voicePreference(microphoneSetupKey, "granted");
      setMicrophoneSetup(true);
    });
    input.current = controller;
    const pause = voiceNumber("void:voice-pause", 1, 0.5, 4);
    const idle = voiceNumber("void:voice-idle", 5, 1, 30);
    const preference = voicePreference(handsFreeKey);
    setHandsFree(preference !== "off");
    if (preference == null) voicePreference(handsFreeKey, "on");
    setMicrophoneSetup(voicePreference(microphoneSetupKey) === "granted");
    const fallback = voicePreference(browserRecognitionKey) === "on";
    setBrowserRecognition(fallback);
    controller.configureFallback(fallback);
    const savedEffort = efforts.find((level) => level === voicePreference("void:effort"));
    if (savedEffort) setEffort(savedEffort);
    setVoicePause(pause); setVoiceIdle(idle);
    controller.configure({ pauseMs: pause * 1_000, idleMs: idle * 60_000 });
    const stop = () => controller.stopActive();
    const returned = () => setPageReturn((value) => value + 1);
    const visibility = () => { if (document.hidden) stop(); else returned(); };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", returned);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("pageshow", returned);
      controller.dispose(); input.current = undefined;
    };
  }, []);

  useEffect(() => { input.current?.setProcessing(micBlocked); }, [micBlocked]);

  useEffect(() => { if (settingsOpen) input.current?.stopActive(); }, [settingsOpen]);
  useEffect(() => { resumeHandsFree(); }, [handsFree, microphoneSetup, canListen, settingsOpen, sessionId, pageReturn]);

  useEffect(() => {
    const controller = browserVoice((next) => {
      input.current?.setPlayback(next.playback === "speaking" || next.playback === "pending");
      setVoiceState(next);
    }, voicePreference("void:voice-enabled") !== "off",
      voicePreference("void:voice-provider") === "local");
    controller?.configure({
      voiceURI: voicePreference("void:voice-uri") ?? "",
      volume: voiceNumber("void:voice-volume", 1, 0, 1),
      rate: voiceNumber("void:voice-rate", 1, 0.75, 1.5),
    });
    voice.current = controller;
    return () => { controller?.dispose(); voice.current = undefined; };
  }, []);

  useEffect(() => {
    let ignore = false;
    void request<Session[]>("/api/sessions").then((list) => {
      if (ignore) return;
      setSessions(list);
      const previous = localStorage.getItem("void:session");
      if (previous && list.some(({ id }) => id === previous)) setSessionId(previous);
      setError("");
    }).catch((failure) => { if (!ignore) setError(report(failure)); }).finally(() => { if (!ignore) setBooting(false); });
    return () => { ignore = true; };
  }, [reload]);

  useEffect(() => {
    let ignore = false;
    void request<SystemInfo>("/api/system?effort=" + effort).then((info) => {
      if (!ignore) {
        setSystem(info);
        voice.current?.setRemoteStatus(info.voice);
      }
    }).catch((failure) => {
      if (!ignore) { setSystem(null); setError(report(failure)); }
    });
    return () => { ignore = true; };
  }, [effort, reload]);

  useEffect(() => {
    if (!sessionId) return;
    voice.current?.selectSession(sessionId);
    localStorage.setItem("void:session", sessionId);
    const events = new EventSource(sessionPath(sessionId) + "/events");
    let open = true;
    let lastId = "";
    events.addEventListener("snapshot", (event: MessageEvent<string>) => {
      if (!open || lastId === event.lastEventId) return;
      const next = JSON.parse(event.data) as Snapshot;
      if (next.sessionId !== sessionId) return;
      lastId = event.lastEventId;
      const pending = pendingUi.current;
      if (pending?.sessionId === sessionId && isUiEvent(next.ui) && next.ui.turnId === pending.turnId) {
        pendingUi.current = null;
        receiveUiAction(next.ui.action);
      }
      setSnapshot(next);
      voice.current?.observe(next);
      setConnection("online");
      const first = next.turns.find((turn) => !turn.ui);
      if (first) setSessions((previous) => previous.map((session) => session.id === sessionId
        ? { ...session, title: first.request.replace(/\s+/g, " ").slice(0, 72) } : session));
    });
    events.onerror = () => { if (open) setConnection("reconnecting"); };
    return () => { open = false; events.close(); };
  }, [sessionId, reload]);

  useEffect(() => {
    if (follow.current && scrollRegion.current) scrollRegion.current.scrollTop = scrollRegion.current.scrollHeight;
  }, [current, optimisticTurn, mode, mobilePane]);

  const receiveUiAction = useEffectEvent((action: UiAction) => { applyLayout(action); });

  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    if (mode === "focus" && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      setCommandOpen(true);
      composer.current?.focus();
    } else if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) {
      if (commandOpen) {
        setCommandOpen(false);
        focusTrigger.current?.focus();
      } else if (panel) closePanel(panel);
      else return;
      event.preventDefault();
    }
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => handleShortcut(event);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handlePreviewEscape = useEffectEvent((event: MessageEvent) => {
    if (panel === "generated" && event.origin === "null" && event.source === previewFrame.current?.contentWindow &&
        event.data === "void-preview-escape") closePanel("generated");
  });

  useEffect(() => {
    const receive = (event: MessageEvent) => handlePreviewEscape(event);
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  useEffect(() => {
    if (commandOpen) composer.current?.focus();
  }, [commandOpen]);

  function selectSession(id: string, preserveMic = false) {
    if (id === sessionId) {
      applyLayout({ type: "close_panel", panel: "sessions" });
      setShowSessions(false);
      return;
    }
    if (!preserveMic) input.current?.stopActive();
    voice.current?.selectSession(id);
    setSessionId(id); setSnapshot(null); setSelected(""); setConnection("connecting");
    pendingUi.current = null;
    setMinimized(false);
    setLayout((currentLayout) => ({ ...initialLayout, mode: currentLayout.mode }));
    setShowSessions(false); setMobilePane("chat"); setError(""); setDraft(""); follow.current = true;
  }

  async function createSession(preserveMic = false) {
    const result = await request<Session>("/api/sessions", {});
    setSessions((list) => [result, ...list]); selectSession(result.id, preserveMic);
    return result.id;
  }

  async function newSession() {
    if (dispatching.current) return;
    dispatching.current = true; setBusy(true);
    try { await createSession(); composer.current?.focus(); }
    catch (failure) { setError(report(failure)); }
    finally { dispatching.current = false; setBusy(false); }
  }

  function send(event: FormEvent) {
    event.preventDefault();
    void sendMessage(draft.trim(), "text");
  }

  async function sendMessage(message: string, source: "text" | "voice") {
    if (!message || dispatching.current || (source === "voice" ? micBlocked : textBlocked)) return;
    input.current?.setProcessing(true);
    dispatching.current = true; setBusy(true); setError("");
    try {
      const target = sessionId || await createSession(source === "voice");
      const prior = retry.current;
      const payload = prior?.sessionId === target && prior.message === message && prior.effort === effort
        ? prior : { sessionId: target, id: crypto.randomUUID(), message, effort, source };
      retry.current = payload;
      pendingUi.current = { sessionId: target, turnId: payload.id };
      voice.current?.expectReply(target, payload.id);
      setOptimistic({ sessionId: target, id: payload.id, text: message });
      follow.current = true;
      await request(sessionPath(target) + "/messages", { id: payload.id, message, effort,
        ...(payload.source === "voice" ? { source: "voice" } : {}) });
      if (source === "text") {
        setDraft("");
        if (mode === "focus") setCommandOpen(false);
      }
      retry.current = null;
    } catch (failure) {
      setOptimistic(null);
      setDraft((currentDraft) => source === "text" || !currentDraft.trim() ? message : currentDraft);
      setError(report(failure));
      input.current?.setProcessing(false);
    } finally { dispatching.current = false; setBusy(false); }
  }

  async function act(action: ActionName, run: Execution, extension?: Extension) {
    if (dispatching.current || waiting) return;
    if (action === "cancel" && !window.confirm("Encerrar esta execução? A conversa e os resultados disponíveis serão preservados.")) return;
    dispatching.current = true; setBusy(true); setError("");
    try { await request(sessionPath(sessionId) + "/executions/" + run.id + "/action", { action, revision: run.revision, extension }); }
    catch (failure) { setError(report(failure)); }
    finally { dispatching.current = false; setBusy(false); }
  }

  async function stop(turnId?: string) {
    voice.current?.stop(turnId);
    if (!turnId || dispatching.current) return;
    dispatching.current = true; setBusy(true); setError("");
    try { await request(sessionPath(sessionId) + "/messages/" + turnId + "/cancel", {}); }
    catch (failure) { setError(report(failure)); }
    finally { dispatching.current = false; setBusy(false); }
  }

  function applyLayout(action: UiAction) {
    setLayout((previous) => applyUiAction(previous, action));
    if (action.type !== "close_panel") setMinimized(false);
    if (action.type === "open_panel" || action.type === "update_panel" || action.type === "open_component") {
      setCommandOpen(false);
      setWindowActivation((value) => value + 1);
    }
    if (action.type === "switch_mode" || action.type === "reset_layout") {
      setCommandOpen(false);
      setMobilePane("chat");
      setShowSessions(false);
    }
  }

  const openPanel = (panel: PanelId) => applyLayout({ type: "open_panel", panel });
  function closePanel(panel: PanelId) {
    applyLayout({ type: "close_panel", panel });
    (focusTrigger.current ?? composer.current)?.focus({ preventScroll: true });
  }

  const sessionList = <>
      <button className="new-session button" onClick={() => void newSession()} disabled={busy || booting}><Icon name="plus"/> Nova sessão</button>
      <div className="session-section"><p className="kicker"><span>Arquivo de sessões</span><span>{String(sessions.length).padStart(2, "0")}</span></p>
        <nav>{sessions.map((item) => <button key={item.id} className="session" aria-current={sessionId === item.id ? "page" : undefined}
          onClick={() => selectSession(item.id)} disabled={busy} title={item.title}><Icon name="message"/><span>{item.title}</span></button>)}</nav>
        {!sessions.length && <p className="muted session-empty">{booting ? "Carregando sessões…" : "Sua próxima conversa começa aqui."}</p>}
      </div>
      <div className="side-footer"><span className="signal"/><div><b>Instância local</b><small>Singularity OS · 4.1</small></div></div>
  </>;

  const operations = <Workspace snapshot={current} execution={execution} select={setSelected}
    system={system} busy={busy || waiting} act={act}/>;

  const settings = <div className="settings-pane">
    <fieldset>
      <legend>Microfone</legend>
      <label><input type="checkbox" checked={handsFree} onChange={(event) => {
    const enabled = event.target.checked;
    setHandsFree(enabled);
    voicePreference(handsFreeKey, enabled ? "on" : "off");
    if (!enabled) input.current?.stop();
      }}/> Modo mãos livres</label>
      <p>Na primeira vez, toque no anel e permita o microfone. Depois, o VOID tenta retomar a escuta quando a aba está visível e o navegador já concedeu acesso. Diga “VOID” para começar.</p>
      <p>O reconhecimento dá preferência ao pacote pt-BR do dispositivo. A transcrição enviada segue a mesma rota das mensagens digitadas.</p>
      <label><input type="checkbox" checked={browserRecognition} disabled={!inputState?.browserSupported || !!captureIssue}
    onChange={(event) => {
      const enabled = event.target.checked;
      setBrowserRecognition(enabled);
      voicePreference(browserRecognitionKey, enabled ? "on" : "off");
      input.current?.configureFallback(enabled);
    }}/> Usar o serviço do navegador quando o reconhecimento local falhar</label>
      <p>Com essa opção, o navegador pode enviar o áudio, inclusive durante a espera pela palavra “VOID”, ao serviço de reconhecimento dele.</p>
      <label>Pausa entre falas <input type="range" min="0.5" max="4" step="0.5" value={voicePause}
    onChange={(event) => {
      const value = event.target.valueAsNumber;
      setVoicePause(value); voicePreference("void:voice-pause", String(value));
      input.current?.configure({ pauseMs: value * 1_000, idleMs: voiceIdle * 60_000 });
    }}/><span>{voicePause.toLocaleString("pt-BR")} s</span></label>
      <label>Inatividade <input type="range" min="1" max="30" step="1" value={voiceIdle}
    onChange={(event) => {
      const value = event.target.valueAsNumber;
      setVoiceIdle(value); voicePreference("void:voice-idle", String(value));
      input.current?.configure({ pauseMs: voicePause * 1_000, idleMs: value * 60_000 });
    }}/><span>{voiceIdle} min</span></label>
      {captureIssue && <p role="status">{captureIssue}</p>}
      {!localReady && <p role="status">{packLabel}</p>}
      {!localReady && inputState?.status !== "checking" && !captureIssue &&
    <button type="button" className="button" onClick={() => input.current?.install()}>
      {inputState?.status === "downloadable" ? "Instalar reconhecimento pt-BR" : "Verificar reconhecimento pt-BR"}
    </button>}
      {inputState?.packError && <p role="status">{inputState.packError}</p>}
      {inputState?.error && <p role="status">{inputState.error}</p>}
      {inputState && <p>Último estado da permissão do microfone · {({ granted: "permitido", denied: "recusado", prompt: "aguarda confirmação", unknown: "desconhecido" })[inputState.permission]}.
    {inputState.code && <> Diagnóstico · {inputState.code}.</>}</p>}
    </fieldset>
    <fieldset>
      <legend>Voz de saída</legend>
    {voiceState ? <>
      <label><input type="checkbox" checked={voiceState.enabled}
        onChange={(event) => {
          const enabled = event.target.checked;
          voice.current?.configure({ enabled });
          voicePreference("void:voice-enabled", enabled ? "on" : "off");
        }}/> Ativar voz</label>
      {voiceState.enabled && <>
        <label>Provedor de voz <select value={voiceState.provider}
          onChange={(event) => {
            const provider = event.target.value === "local" ? "local" : "elevenlabs";
            voice.current?.configure({ provider });
            voicePreference("void:voice-provider", provider);
          }}>
          <option value="elevenlabs" disabled={!voiceState.remoteSupported}>ElevenLabs (pode consumir créditos)</option>
          <option value="local" disabled={!voiceState.localSupported}>Voz do sistema</option>
        </select></label>
        <label>Voz do sistema <select value={voiceState.voiceURI} disabled={!voiceState.voices.length}
          onChange={(event) => {
            const voiceURI = event.target.value;
            voice.current?.configure({ voiceURI });
            voicePreference("void:voice-uri", voiceURI);
          }}>
          <option value="">Automática (pt-BR)</option>
          {voiceState.voices.map((item) => <option key={item.voiceURI} value={item.voiceURI}>{item.name}</option>)}
        </select></label>
        <label>Volume <input type="range" min="0" max="1" step="0.1" value={voiceState.volume}
          onChange={(event) => {
            const volume = event.target.valueAsNumber;
            voice.current?.configure({ volume });
            voicePreference("void:voice-volume", String(volume));
          }}/></label>
        <label>Velocidade <input type="range" min="0.75" max="1.5" step="0.05" value={voiceState.rate}
          onChange={(event) => {
            const rate = event.target.valueAsNumber;
            voice.current?.configure({ rate });
            voicePreference("void:voice-rate", String(rate));
          }}/></label>
        {(voiceState.error || voiceState.remoteIssue) && <span role="status">
          {[voiceState.error, voiceState.remoteIssue].filter(Boolean).join(" ")}
        </span>}
      </>}
    </> : <span>Voz indisponível</span>}
    </fieldset>
    <fieldset>
      <legend>Respostas</legend>
      <label>Esforço <select value={effort} onChange={(event) => {
    const next = efforts.find((level) => level === event.target.value);
    if (next) { setEffort(next); voicePreference("void:effort", next); }
      }}>{efforts.map((level) => <option key={level} value={level}>{level === "auto" ? "Auto" : level}</option>)}</select></label>
    </fieldset>
    </div>;
  const feedback = (error || system?.issue || waiting) && <div className="feedback" role={error || system?.issue ? "alert" : "status"}>
    <span>{error || system?.issue || "Conexão interrompida. O servidor pode continuar a execução."}</span>
    {(error || waiting) && <button className="button" onClick={() => { setError(""); setReload((value) => value + 1); }}>Reconectar</button>}
      </div>;
  const commandForm = <>
    <form className="composer" onSubmit={send}>
      <label htmlFor="composer" className="sr-only">Mensagem para o VOID</label>
      <textarea ref={composer} id="composer" maxLength={16_000} rows={2} value={draft} placeholder="Envie uma instrução ao VOID…"
        onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault(); event.currentTarget.form?.requestSubmit();
          }
        }}/>
      <div className="composer-actions">
        <button type="button" className="button" disabled={micMode === "hands-free" ||
          (!micMode && !canListen)}
          onClick={() => micMode === "manual" ? input.current?.stop() : input.current?.start("manual")}>
          {micMode === "manual" ? "Cancelar gravação" : "Clique para falar"}
        </button>
        {(activeTurnId || playing || audioBlocked) && <button type="button" className="button" disabled={busy && !playing && !audioBlocked}
          onClick={() => void stop(activeTurnId)}>Parar</button>}
        <button className="send" aria-label="Enviar mensagem" disabled={!draft.trim() || textBlocked}><Icon name="arrow" size={21}/></button>
      </div>
    </form>
    <div className="voice-indicator">
      <span role="status">{[micStatus, engineStatus, audioStatus].filter(Boolean).join(" · ")}</span>
      {handsFree && !micMode && canRequestMic && (!microphoneSetup || (micReady && inputState?.error)) &&
        <button type="button" className="button" disabled={!micIdle} onClick={() => input.current?.start("hands-free")}>
          {firstSetup ? "Permitir microfone" : "Retomar escuta"}
        </button>}
      {(voiceIssue || !micReady) && <button type="button" className="button" onClick={() => openPanel("settings")}>
        {voiceIssue || captureIssue ? "Detalhes de áudio" : "Configurar microfone"}
      </button>}
    </div>
  </>;

  const generated = panel === "generated" ? layout.generated : null;
  const component = generated?.component;
  const windows = panel && <FloatingWindow key={panel} panel={panel} activation={windowActivation} minimized={minimized}
    {...(generated ? { title: generated.title } : {})}
    minimize={() => setMinimized(true)} restore={() => setMinimized(false)} close={() => closePanel(panel)}>
    {panel === "settings" && settings}
    {panel === "usage" && <ProviderPanel/>}
    {panel === "sessions" && <div className="session-panel">{sessionList}</div>}
    {panel === "operations" && operations}
    {panel === "display" && <DynamicDisplay schema={layout.display}/>}
    {generated && component && sessionId && <iframe
      key={component.id + ":" + component.version + ":" + windowActivation}
      ref={previewFrame} title={"Prévia · " + generated.title} className="component-preview"
      sandbox="allow-scripts" referrerPolicy="no-referrer"
      src={`/api/sessions/${sessionId}/components/${component.id}/${component.version}`}/>}
  </FloatingWindow>;

  if (mode === "focus") {
    const latest = chatTurns.at(-1);
    const reply = latest && current ? finalReply(current, latest) : null;
    return <main className="focus-shell">
      <span className="sr-only" aria-label="Estado do sistema">{system?.mode ?? "Inicializando"}</span>
      <div className="focus-orbit">
        <button ref={focusTrigger} className="focus-trigger" type="button" aria-label="Abrir comando de texto e voz"
          aria-keyshortcuts="Control+K Meta+K" aria-expanded={commandOpen}
          title="Texto e voz · Ctrl+K" onClick={() => setCommandOpen((value) => !value)}>
          <SingularityRing state={state} speaking={speaking}/>
        </button>
      </div>
      <span className="sr-only" role="status">{ringLabels[state]} · {micStatus}</span>
      {commandOpen && <section className="command-overlay" aria-label="Comando de texto e voz">
        <div className="command-heading">
          <h1>Comando</h1>
          <div className="command-tools">
            {/* The way into the full interface that does not depend on a model understanding the request. */}
            <button className="button" type="button" onClick={() => applyLayout({ type: "switch_mode", mode: "workspace" })}>
              <Icon name="workspace"/> Abrir workspace
            </button>
            <button className="icon-button" type="button" aria-label="Fechar comando" onClick={() => {
              setCommandOpen(false); focusTrigger.current?.focus();
            }}><Icon name="close"/></button>
          </div>
        </div>
        {feedback}
        {commandForm}
        {suggestion && <button className="button" type="button" onClick={() => {
          setSelected(suggestion.id); openPanel("operations");
        }}>Ver execução pendente</button>}
        {latest?.failure && <p role="status">{failureText(latest.failure, latest.failureDetail)}</p>}
        {latest && reply && !activeTurnId && <details className="focus-reply"><summary>Última resposta</summary>
          <p className="prewrap">{reply}</p>
          {voiceState?.enabled && <button className="button" type="button" onClick={() => voice.current?.play(latest.id, reply)}>
            Reproduzir resposta
          </button>}
        </details>}
      </section>}
      {windows}
    </main>;
  }

  return <div className="shell wide" data-mobile-pane={mobilePane}>
    <aside className={"sidebar" + (showSessions ? " drawer-open" : "")} aria-label="Sessões">
      <div className="brand"><div className="brand-mark" aria-hidden="true"/><div><strong>V<span>O</span>ID</strong><small>SINGULARITY OS</small></div>
        <button className="icon-button close-drawer" aria-label="Fechar sessões" onClick={() => setShowSessions(false)}><Icon name="close"/></button></div>
      {sessionList}
    </aside>
    <div className="deck">
      <header className="topbar">
        <div className="top-location"><button className="icon-button menu" aria-label="Abrir sessões" aria-expanded={showSessions} onClick={() => setShowSessions(!showSessions)}><Icon name="menu"/></button>
          <span className="kicker desktop-location">Estação pessoal <span className="slash">/</span> <b>VOID</b></span><strong className="mobile-brand">VOID</strong></div>
        <div className="top-controls">
          <span className="system-pill" aria-label="Estado do sistema"><span className={"signal " + (waiting || !system?.available ? "amber" : "")}/>{waiting ? "Reconectando" : system ? system.mode : "Inicializando"}</span>
          <div className="view-toggle" aria-label="Modo de visualização">
            <button aria-pressed={false} onClick={() => applyLayout({ type: "switch_mode", mode: "focus" })}><Icon name="focus"/> Focus</button>
            <span className="workspace-mode"><Icon name="workspace"/> Workspace</span>
            <button type="button" aria-haspopup="dialog" onClick={() => openPanel("settings")}>Configurações</button>
            <button type="button" aria-haspopup="dialog" onClick={() => openPanel("usage")}>Uso</button>
          </div>
        </div>
      </header>
      {feedback}
      <div className="mobile-tabs" aria-label="Área do Workspace">
        <button aria-pressed={mobilePane === "chat"} onClick={() => setMobilePane("chat")}>Conversa</button>
        <button aria-pressed={mobilePane === "details"} onClick={() => setMobilePane("details")}>Operações</button>
      </div>
      <main className="deck-main">
        <section className={"focus-pane" + (hasConversation ? " has-conversation" : "")} aria-label="Conversa">
          {hasConversation ? <div className="conversation-top">
            <SingularityRing state={state} speaking={speaking} compact/><div><strong>Singularity</strong><p role="status">{ringLabels[state]}</p></div>
          </div> : null}
          <div className="scroll-area" ref={scrollRegion} onScroll={(event) => {
            const node = event.currentTarget;
            follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          }}>
            {!hasConversation ? <div className="welcome">
              <div className="field"><span className="field-index">S / 01</span><SingularityRing state={state} speaking={speaking}/><span className="field-coords">+ 00.00</span></div>
              <p className="kicker welcome-status" role="status"><span className="signal"/>{ringLabels[state]}</p>
              <h1>O que vamos explorar?</h1>
              <p className="welcome-copy">Converse com o VOID ou reúna especialistas para investigar uma questão.</p>
            </div> : <div className="messages" aria-live="polite" aria-relevant="additions text">
              {!current && !optimisticTurn && <p className="muted">Recuperando conversa…</p>}
              {current && !chatTurns.length && !optimisticTurn && <p className="muted">Esta sessão está vazia. Envie uma mensagem para começar.</p>}
              {current && chatTurns.map((turn) => {
                const reply = finalReply(current, turn);
                return <article className="turn" key={turn.id}>
                  <div className="user-message"><span className="kicker">Você</span><p className="prewrap">{turn.request}</p></div>
                  {turn.introduction && <div className="assistant-message"><span className="kicker">VOID</span><p>{turn.introduction}</p></div>}
                  {turn.response === null && !turn.failure &&
                    current?.notices.filter((notice) => notice.turnId === turn.id &&
                      (notice.chatText || (notice.type === "generation_warning" && current.active?.turnId === turn.id))).map((notice) =>
                      <div className="notice progress" key={notice.id}><span className="signal"/><p>{notice.chatText ?? notice.text}</p></div>)}
                  {turn.response && <div className="assistant-message"><span className="kicker">VOID{turn.model ? " · " + turn.model : ""}</span>
                    {turn.executionId ? <DelegatedReply text={turn.response}/> : <p className="prewrap">{turn.response}</p>}
                    {voiceState && reply && <button type="button" className="button reply-play"
                      disabled={!voiceState.enabled || voiceState.volume === 0 ||
                        (voiceState.provider === "local" && !voiceState.voices.length)}
                      onClick={() => voice.current?.play(turn.id, reply)}>Reproduzir resposta</button>}
                  </div>}
                  {turn.response === "" && <p className="kicker">Fala ignorada</p>}
                  {!turn.response && !turn.failure && current?.active?.turnId === turn.id && current.active.draft &&
                    <div className="assistant-message"><span className="kicker">VOID · Gerando</span><p className="prewrap">{current.active.draft}</p></div>}
                  {turn.failure && <p className="step-failure">{failureText(turn.failure, turn.failureDetail)}</p>}
                </article>;
              })}
              {optimisticTurn && <article className="turn"><div className="user-message"><span className="kicker">Você</span><p className="prewrap">{optimisticTurn.text}</p></div></article>}
            </div>}
          </div>
          <div className="composer-wrap">
            {!hasConversation && <div className="prompt-grid">{prompts.map((prompt) => <button className="prompt" key={prompt.label}
              onClick={() => { setDraft(prompt.text); composer.current?.focus(); }}><div><span className="kicker">{prompt.label}</span><span>{prompt.text}</span></div><Icon name="arrow"/></button>)}</div>}
            {commandForm}
            <div className="composer-footer"><span>{system?.mode === "MOCK" ? "Chat em simulação local" : system?.mode === "LIVE" ? "OpenRouter · apenas modelos gratuitos" : "Conectando ao VOID"}</span>
              <span>Enter para enviar</span></div>
          </div>
        </section>
        {operations}
      </main>
    </div>
    {windows}
  </div>;
}
