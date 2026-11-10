"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { efforts, failureText, type ActionName, type ApiError, type Effort, type Execution, type Extension,
  type SendMessage, type Session, type Snapshot, type SystemInfo } from "../../src/web/contracts";
import { Icon, ringLabels, SingularityRing, type RingState } from "./singularity";
import { ApprovalPanel, Workspace } from "./workspace";
import { ProviderPanel } from "./provider-panel";
import { browserVoice, finalReply, type VoiceController, type VoiceState } from "./voice-controller";

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
  const [mode, setMode] = useState<"focus" | "workspace">("focus");
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
  const [showProviders, setShowProviders] = useState(false);
  const voice = useRef<VoiceController>(undefined);
  const dispatching = useRef(false);
  const retry = useRef<(SendMessage & { sessionId: string }) | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const scrollRegion = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const current = snapshot?.sessionId === sessionId ? snapshot : null;
  const activeTurnId = current?.active?.turnId;
  const turns = current?.turns ?? [];
  const execution = current?.executions.find((item) => item.id === selected) ?? current?.executions.at(-1);
  const suggestion = current?.executions.slice().reverse().find((item) => item.status === "paused" || item.status === "awaiting_approval");
  const optimisticTurn = optimistic?.sessionId === sessionId && !turns.some((turn) => turn.id === optimistic.id) ? optimistic : null;
  const state = optimisticTurn ? "processing" : ringState(current);
  const speaking = voiceState?.playback === "speaking";
  const playing = speaking || voiceState?.playback === "pending";
  const audioBlocked = voiceState?.playback === "blocked";
  const waiting = connection === "reconnecting" && !!sessionId;
  const hasConversation = !!(turns.length || optimisticTurn || sessionId && current === null);

  useEffect(() => {
    const controller = browserVoice(setVoiceState, voicePreference("void:voice-enabled") !== "off",
      voicePreference("void:voice-provider") === "local");
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
      setSnapshot(next);
      voice.current?.observe(next);
      setConnection("online");
      const first = next.turns[0];
      if (first) setSessions((previous) => previous.map((session) => session.id === sessionId
        ? { ...session, title: first.request.replace(/\s+/g, " ").slice(0, 72) } : session));
    });
    events.onerror = () => { if (open) setConnection("reconnecting"); };
    return () => { open = false; events.close(); };
  }, [sessionId, reload]);

  useEffect(() => {
    if (follow.current && scrollRegion.current) scrollRegion.current.scrollTop = scrollRegion.current.scrollHeight;
  }, [current, optimisticTurn, mode, mobilePane]);

  function selectSession(id: string) {
    if (id === sessionId) return;
    voice.current?.selectSession(id);
    setSessionId(id); setSnapshot(null); setSelected(""); setConnection("connecting");
    setShowSessions(false); setMobilePane("chat"); setError(""); setDraft(""); follow.current = true;
  }

  async function createSession() {
    const result = await request<Session>("/api/sessions", {});
    setSessions((list) => [result, ...list]); selectSession(result.id);
    return result.id;
  }

  async function newSession() {
    if (dispatching.current) return;
    dispatching.current = true; setBusy(true);
    try { await createSession(); composer.current?.focus(); }
    catch (failure) { setError(report(failure)); }
    finally { dispatching.current = false; setBusy(false); }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || dispatching.current || current?.active || !system?.available || waiting) return;
    dispatching.current = true; setBusy(true); setError("");
    try {
      const target = sessionId || await createSession();
      const prior = retry.current;
      const payload = prior?.sessionId === target && prior.message === message && prior.effort === effort
        ? prior : { sessionId: target, id: crypto.randomUUID(), message, effort };
      retry.current = payload;
      voice.current?.expectReply(target, payload.id);
      setOptimistic({ sessionId: target, id: payload.id, text: message });
      follow.current = true;
      await request(sessionPath(target) + "/messages", { id: payload.id, message, effort });
      setDraft(""); retry.current = null;
    } catch (failure) {
      setOptimistic(null); setDraft(message); setError(report(failure));
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

  function openWorkspace(id?: string) {
    if (id) setSelected(id);
    setMode("workspace"); setMobilePane("details");
  }

  return <div className={"shell " + (mode === "workspace" ? "wide" : "")} data-mobile-pane={mobilePane}>
    <aside className={"sidebar" + (showSessions ? " drawer-open" : "")} aria-label="Sessões">
      <div className="brand"><div className="brand-mark" aria-hidden="true"/><div><strong>V<span>O</span>ID</strong><small>SINGULARITY OS</small></div>
        <button className="icon-button close-drawer" aria-label="Fechar sessões" onClick={() => setShowSessions(false)}><Icon name="close"/></button></div>
      <button className="new-session button" onClick={() => void newSession()} disabled={busy || booting}><Icon name="plus"/> Nova sessão</button>
      <div className="session-section"><p className="kicker"><span>Arquivo de sessões</span><span>{String(sessions.length).padStart(2, "0")}</span></p>
        <nav>{sessions.map((item) => <button key={item.id} className="session" aria-current={sessionId === item.id ? "page" : undefined}
          onClick={() => selectSession(item.id)} disabled={busy} title={item.title}><Icon name="message"/><span>{item.title}</span></button>)}</nav>
        {!sessions.length && <p className="muted session-empty">{booting ? "Carregando sessões…" : "Sua próxima conversa começa aqui."}</p>}
      </div>
      <div className="side-footer"><span className="signal"/><div><b>Instância local</b><small>Singularity OS · 4.1</small></div></div>
    </aside>
    <div className="deck">
      <header className="topbar">
        <div className="top-location"><button className="icon-button menu" aria-label="Abrir sessões" aria-expanded={showSessions} onClick={() => setShowSessions(!showSessions)}><Icon name="menu"/></button>
          <span className="kicker desktop-location">Estação pessoal <span className="slash">/</span> <b>VOID</b></span><strong className="mobile-brand">VOID</strong></div>
        <div className="top-controls">
          <span className="system-pill" aria-label="Estado do sistema"><span className={"signal " + (waiting || !system?.available ? "amber" : "")}/>{waiting ? "Reconectando" : system ? system.mode : "Inicializando"}</span>
          <div className="view-toggle" aria-label="Modo de visualização">
            <button aria-pressed={mode === "focus"} onClick={() => { setMode("focus"); setMobilePane("chat"); }}><Icon name="focus"/> Focus</button>
            <button aria-pressed={mode === "workspace"} onClick={() => openWorkspace()}><Icon name="workspace"/> Workspace</button>
            <button type="button" aria-haspopup="dialog" onClick={() => setShowProviders(true)}>Uso</button>
          </div>
        </div>
      </header>
      {showProviders && <ProviderPanel close={() => setShowProviders(false)}/>}
      {(error || system?.issue || waiting) && <div className="feedback" role={error || system?.issue ? "alert" : "status"}>
        <span>{error || system?.issue || "Conexão interrompida. O servidor pode continuar a execução."}</span>
        {(error || waiting) && <button className="button" onClick={() => { setError(""); setReload((value) => value + 1); }}>Reconectar</button>}
      </div>}
      {mode === "workspace" && <div className="mobile-tabs" aria-label="Área do Workspace">
        <button aria-pressed={mobilePane === "chat"} onClick={() => setMobilePane("chat")}>Conversa</button>
        <button aria-pressed={mobilePane === "details"} onClick={() => setMobilePane("details")}>Operações</button>
      </div>}
      <main className="deck-main">
        <section className={"focus-pane" + (hasConversation ? " has-conversation" : "")} aria-label="Conversa">
          {hasConversation ? <div className="conversation-top">
            <SingularityRing state={state} speaking={speaking} compact/><div><strong>Singularity</strong><p role="status">{ringLabels[state]}</p></div>
            {execution && mode === "focus" && <button className="button inspect" onClick={() => openWorkspace(execution.id)}><Icon name="activity"/> Ver execução</button>}
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
              {current && !turns.length && !optimisticTurn && <p className="muted">Esta sessão está vazia. Envie uma mensagem para começar.</p>}
              {current && turns.map((turn) => {
                const reply = finalReply(current, turn);
                return <article className="turn" key={turn.id}>
                  <div className="user-message"><span className="kicker">Você</span><p className="prewrap">{turn.request}</p></div>
                  {turn.introduction && <div className="assistant-message"><span className="kicker">VOID</span><p>{turn.introduction}</p></div>}
                  {!turn.response && !turn.failure &&
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
                  {!turn.response && !turn.failure && current?.active?.turnId === turn.id && current.active.draft &&
                    <div className="assistant-message"><span className="kicker">VOID · Gerando</span><p className="prewrap">{current.active.draft}</p></div>}
                  {turn.failure && <p className="step-failure">{failureText(turn.failure, turn.failureDetail)}</p>}
                </article>;
              })}
              {optimisticTurn && <article className="turn"><div className="user-message"><span className="kicker">Você</span><p className="prewrap">{optimisticTurn.text}</p></div></article>}
              {suggestion && mode === "focus" && <ApprovalPanel key={suggestion.revision} execution={suggestion} busy={busy || waiting} act={act}/>}
            </div>}
          </div>
          <div className="composer-wrap">
            {!hasConversation && <div className="prompt-grid">{prompts.map((prompt) => <button className="prompt" key={prompt.label}
              onClick={() => { setDraft(prompt.text); composer.current?.focus(); }}><div><span className="kicker">{prompt.label}</span><span>{prompt.text}</span></div><Icon name="arrow"/></button>)}</div>}
            <form className="composer" onSubmit={(event) => void send(event)}>
              <label htmlFor="composer" className="sr-only">Mensagem para o VOID</label>
              <textarea ref={composer} id="composer" maxLength={16_000} rows={2} value={draft} placeholder="Envie uma instrução ao VOID…"
                onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault(); event.currentTarget.form?.requestSubmit();
                  }
                }}/>
              <div className="composer-actions">
                <label className="effort"><span>Esforço</span><select value={effort} onChange={(event) => {
                  const next = efforts.find((level) => level === event.target.value); if (next) setEffort(next);
                }}>{efforts.map((level) => <option key={level} value={level}>{level === "auto" ? "Auto" : level}</option>)}</select></label>
                {(activeTurnId || playing || audioBlocked) && <button type="button" className="button" disabled={busy && !playing && !audioBlocked}
                  onClick={() => void stop(activeTurnId)}>Parar</button>}
                <button className="send" aria-label="Enviar mensagem" disabled={!draft.trim() || busy || booting || !!current?.active || !!optimisticTurn || !system?.available || waiting}><Icon name="arrow" size={21}/></button>
              </div>
            </form>
            <div className="voice-controls" role="group" aria-label="Voz de saída">
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
                    onChange={(event) => voice.current?.configure({ voiceURI: event.target.value })}>
                    <option value="">Automática (pt-BR)</option>
                    {voiceState.voices.map((item) => <option key={item.voiceURI} value={item.voiceURI}>{item.name}</option>)}
                  </select></label>
                  <label>Volume <input type="range" min="0" max="1" step="0.1" value={voiceState.volume}
                    onChange={(event) => voice.current?.configure({ volume: event.target.valueAsNumber })}/></label>
                  <label>Velocidade <input type="range" min="0.75" max="1.5" step="0.05" value={voiceState.rate}
                    onChange={(event) => voice.current?.configure({ rate: event.target.valueAsNumber })}/></label>
                  <span role="status">{speaking
                    ? "Falando · " + (voiceState.playingProvider === "elevenlabs" ? "ElevenLabs" : "Voz do sistema")
                    : playing ? "Preparando áudio" : ""}</span>
                  {(voiceState.error || voiceState.remoteIssue) && <span role="status">
                    {[voiceState.error, voiceState.remoteIssue].filter(Boolean).join(" ")}
                  </span>}
                </>}
              </> : <span>Voz indisponível</span>}
            </div>
            <div className="composer-footer"><span>{system?.mode === "MOCK" ? "Chat em simulação local" : system?.mode === "LIVE" ? "OpenRouter · apenas modelos gratuitos" : "Conectando ao VOID"}</span>
              <span>Enter para enviar</span></div>
          </div>
        </section>
        {mode === "workspace" && <Workspace snapshot={current} execution={execution} select={setSelected} system={system} busy={busy || waiting} act={act}/>}
      </main>
    </div>
  </div>;
}
