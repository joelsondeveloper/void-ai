import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import type { MainMessageSink } from "../agents/MainAgent.js";
import type { ExecutionCheckpoint } from "../governance/checkpoint.js";
import { positiveInteger, safetyCaps, validateLimits } from "../governance/effort.js";
import { failureCategories, type ExecutionFailure, type FailureCategory } from "../types/failure.js";
import { efforts, isFailureDetail, type FailureDetail, type ActionName, type Effort, type Execution, type Extension, type Notice, type Snapshot } from "./contracts.js";
import type { WebRuntime } from "./runtime.js";
import { VoiceError, type createVoiceService } from "./voice.js";
import { finalReply, speakableText } from "./voice-text.js";

type Request = Pick<IncomingMessage, "url" | "method" | "headers"> & Pick<Readable, "iterator" | "resume">;
interface Response {
  readonly headersSent: boolean;
  readonly destroyed: boolean;
  readonly writableLength: number;
  setHeader(name: string, value: string): unknown;
  writeHead(status: number, headers: Record<string, string>): unknown;
  write(chunk: string): unknown;
  end(chunk?: string | Uint8Array): unknown;
  once(event: "close", listener: () => void): unknown;
  destroy(): unknown;
}
const sessionPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const activeStates = ["running", "pausing"];
const terminal = ["completed", "failed", "cancelled"];
const extensionKeys = { calls: "calls", steps: "steps", time: "timeMs", tokens: "outputTokens" } as const;
const actionNames = ["pause", "cancel", "resume", "approve"] as const;

function allowedExtension(reason: ExecutionCheckpoint["pauseReason"]): keyof Extension | null {
  switch (reason) {
    case "calls": case "steps": case "time": case "tokens": return extensionKeys[reason];
    default: return null;
  }
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function invalid(message = "Dados da solicitação inválidos."): never { throw new HttpError(400, "invalid_input", message); }
function missing(): never { throw new HttpError(404, "not_found", "Sessão ou execução não encontrada."); }
function conflict(message: string): never { throw new HttpError(409, "conflict", message); }

function json(response: Response, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function effort(value: unknown): Effort {
  return efforts.find((level) => level === value) ?? invalid("Nível de esforço inválido.");
}
function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function body(request: Request, limit = 128_000) {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") invalid("Envie JSON.");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) {
      request.resume();
      throw new HttpError(413, "too_large", "Solicitação muito grande.");
    }
    chunks.push(bytes);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { invalid("JSON inválido."); }
  if (!isRecord(value)) invalid();
  return value;
}

function publicDetail(failure: ExecutionFailure | undefined): FailureDetail | undefined {
  if (failure?.code === "context_length_exceeded") return "context_limit";
  if (failure?.category === "invalid_response" && isFailureDetail(failure.code) &&
      (failure.code.startsWith("decision_") || failure.code === "plan_invalid")) return failure.code;
  if (failure?.category === "incomplete") {
    if (failure.finishReason === "length" || failure.code === "max_tokens_exceeded") return "output_limit";
    if (failure.finishReason === "content_filter" || failure.finishReason === "tool_calls") return failure.finishReason;
  }
  if (failure && (failure.category === "http" || failure.category === "api") &&
      (failure.httpStatus === 404 || failure.code === "provider_unavailable" || failure.code === "not_found")) {
    return "model_unavailable";
  }
}
function project(checkpoint: ExecutionCheckpoint, active: boolean): Execution {
  const recovered = !active && activeStates.includes(checkpoint.status);
  const status = recovered ? "paused" : checkpoint.status;
  const reason = recovered ? "recovery" : checkpoint.pauseReason ?? null;
  const extension = status === "awaiting_approval" ? allowedExtension(checkpoint.pauseReason) : null;
  const actions: ActionName[] = [];
  if (!terminal.includes(status)) {
    actions.push("cancel");
    if (active && status === "running") actions.push("pause");
    if (!active && (status === "paused" || status === "pending")) actions.push("resume");
    if (!active && extension) actions.push("approve");
  }
  const states = new Map(checkpoint.steps.map((step) => [step.stepId, step]));
  return {
    id: checkpoint.id, createdAt: checkpoint.createdAt, updatedAt: checkpoint.updatedAt,
    revision: createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex"),
    status, effort: checkpoint.effort, reason, extension, actions, limits: checkpoint.limits,
    usage: { calls: checkpoint.usage.callsStarted, steps: checkpoint.usage.stepsStarted,
      elapsedMs: checkpoint.usage.elapsedMs, outputTokens: checkpoint.usage.outputTokens },
    steps: checkpoint.plan.map(({ id, agentId, objective, dependsOn }) => {
      const step = states.get(id);
      const interrupted = recovered && step?.status === "running";
      const detail = publicDetail(step?.failure);
      return { id, agentId, objective, dependsOn, status: interrupted ? "failed" : step?.status ?? "pending",
        output: step?.output ?? null, failure: interrupted ? "interrupted" : step?.failure?.category ?? null,
        ...(detail ? { failureDetail: detail } : {}),
        startedAt: step?.startedAt ?? null, finishedAt: step?.finishedAt ?? null };
    }),
    routes: checkpoint.modelRoutes ?? null, served: checkpoint.servedModels ?? [],
  };
}

type Job = { turnId: string; executionId: string | null; controller: AbortController; draft?: string };

export function createWebApi(runtime: WebRuntime, port: () => number, voice: ReturnType<typeof createVoiceService> | undefined = runtime.voice) {
  const { main, conversations } = runtime;
  const jobs = new Map<string, Job>();
  const subscribers = new Map<string, Set<Response>>();
  const notices = new Map<string, Notice[]>();
  let sequence = 0;
  const epoch = randomUUID();
  const eventId = () => epoch + ":" + ++sequence;

  function execution(sessionId: string, id: string): Execution | undefined {
    if (!conversations.find(sessionId, id)) return;
    try {
      const { checkpoint } = main.partial(sessionId, id);
      return project(checkpoint, jobs.get(sessionId)?.executionId === id);
    } catch { return undefined; }
  }

  function snapshot(sessionId: string): Snapshot {
    const active = jobs.get(sessionId);
    const executions: Execution[] = [];
    const turns = conversations.turns(sessionId).flatMap((row) => {
      const id = asString(row.id), request = asString(row.request);
      if (!id || request === null) return [];
      const executionId = asString(row.execution_id), response = asString(row.response);
      const run = executionId ? execution(sessionId, executionId) : undefined;
      if (run) executions.push(run);
      const interrupted = !run && response === null && active?.turnId !== id;
      const [savedCategory, detail] = asString(row.failure)?.split(":") ?? [];
      const failure = failureCategories.find((category) => category === savedCategory) ?? (interrupted ? "interrupted" : null);
      const introduction = asString(row.introduction);
      return [{ id, request, response, executionId, failure, model: asString(row.model),
        ...(introduction ? { introduction } : {}),
        ...(isFailureDetail(detail) ? { failureDetail: detail } : {}) }];
    });
    return { sessionId, turns, executions, notices: notices.get(sessionId) ?? [],
      active: active ? { turnId: active.turnId, executionId: active.executionId, ...(active.draft ? { draft: active.draft } : {}) } : null };
  }

  function writeEvent(response: Response, id: string, current: Snapshot) {
    if (response.destroyed) return;
    if (response.writableLength > 512_000) { response.destroy(); return; }
    response.write("id: " + id + "\nevent: snapshot\ndata: " + JSON.stringify(current) + "\n\n");
  }

  function notify(sessionId: string) {
    const listeners = subscribers.get(sessionId);
    if (!listeners?.size) return;
    const current = snapshot(sessionId), id = eventId();
    for (const response of listeners) writeEvent(response, id, current);
  }

  function append(sessionId: string, entry: Omit<Notice, "id" | "at">) {
    notices.set(sessionId, [...(notices.get(sessionId) ?? []).slice(-79),
      { id: eventId(), at: new Date().toISOString(), ...entry }]);
  }

  function stream(sessionId: string, response: Response) {
    const current = snapshot(sessionId);
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
    });
    const listeners = subscribers.get(sessionId) ?? new Set<Response>();
    subscribers.set(sessionId, listeners);
    listeners.add(response);
    const heartbeat = setInterval(() => {
      if (response.writableLength > 512_000) response.destroy();
      else response.write(": heartbeat\n\n");
    }, 15_000);
    heartbeat.unref();
    response.once("close", () => {
      clearInterval(heartbeat);
      listeners.delete(response);
      if (!listeners.size) subscribers.delete(sessionId);
    });
    writeEvent(response, eventId(), current);
  }

  function start(sessionId: string, turnId: string, executionId: string | null,
    run: (signal: AbortSignal, sink: MainMessageSink) => Promise<{ kind: string }>) {
    const job: Job = { turnId, executionId, controller: new AbortController() };
    jobs.set(sessionId, job);
    const fail = (category: FailureCategory, detail?: FailureDetail) =>
      conversations.failTurn(sessionId, turnId, detail ? category + ":" + detail : category);
    let reported = false;
    const sink: MainMessageSink = (message) => {
      if (message.executionId) job.executionId = message.executionId;
      if (message.type === "draft") {
        job.draft = message.text;
      } else if (message.type === "error") {
        delete job.draft;
        fail(message.failure.category, publicDetail(message.failure));
        reported = true;
      } else if (message.type !== "final") {
        append(sessionId, { turnId, type: message.type, text: message.text,
          ...(message.executionId ? { executionId: message.executionId } : {}),
          ...(message.type === "progress" && message.stepId ? { stepId: message.stepId } : {}),
          ...(message.type === "progress" && message.chatText ? { chatText: message.chatText } : {}) });
      }
      notify(sessionId);
    };
    void (async () => {
      try {
        notify(sessionId);
        const result = await run(job.controller.signal, sink);
        if (result.kind === "error" && !reported) fail("internal_error");
      } catch {
        try { fail("internal_error"); } catch { console.error("VOID web: falha ao registrar o estado da conversa."); }
      } finally {
        jobs.delete(sessionId);
        try { notify(sessionId); } catch { console.error("VOID web: falha ao atualizar a sessão."); }
      }
    })();
  }

  const context = (sessionId: string, signal: AbortSignal) =>
    ({ executionId: sessionId, permissions: runtime.permissions, budgetLimit: 0, signal, metadata: {} });

  function checkAvailable(level: Effort) {
    const system = runtime.system(level);
    if (!system.available) throw new HttpError(503, "backend_unavailable", system.issue ?? "Backend indisponível.");
  }

  function action(sessionId: string, id: string, payload: Record<string, unknown>) {
    const requested = actionNames.find((name) => name === payload.action) ?? invalid();
    if (typeof payload.revision !== "string" || !/^[0-9a-f]{64}$/.test(payload.revision) ||
        Object.keys(payload).some((key) => !["action", "revision", "extension"].includes(key))) invalid();
    const current = execution(sessionId, id) ?? missing();
    if (current.revision !== payload.revision || !current.actions.includes(requested)) {
      conflict("O estado da execução mudou ou a ação está indisponível. Consulte o estado atual.");
    }
    const turn = conversations.turns(sessionId).find((row) => row.execution_id === id);
    const turnId = asString(turn?.id) ?? missing();
    const extension: Extension = {};
    if (requested === "approve") {
      const key = current.extension, proposed = payload.extension;
      if (!key || !isRecord(proposed) || Object.keys(proposed).length !== 1) invalid("Autorize apenas o recurso solicitado.");
      const extra = proposed[key];
      if (!positiveInteger(extra, safetyCaps.outputTokens)) invalid("Informe uma quantidade adicional válida.");
      extension[key] = extra;
      const next = { ...current.limits };
      if (key === "timeMs") next.pauseAfterMs = (next.pauseAfterMs ?? Math.max(current.usage.elapsedMs, next.warnAfterMs)) + extra;
      else next[key] = (next[key] ?? 0) + extra;
      try { validateLimits(next); } catch { invalid("A extensão ultrapassa os limites de segurança."); }
    } else if (payload.extension !== undefined) invalid();
    if (requested === "pause" || requested === "cancel") {
      try {
        if (requested === "pause") main.pause(sessionId, id);
        else main.cancel(sessionId, id);
      } catch { conflict("A execução mudou de estado. Atualize os detalhes antes de tentar novamente."); }
      append(sessionId, { turnId, executionId: id, type: "action",
        text: requested === "pause" ? "Pausa solicitada pelo usuário." : "Cancelamento solicitado pelo usuário." });
      notify(sessionId);
      return;
    }
    if (jobs.has(sessionId)) conflict("A sessão já está em processamento.");
    if (!runtime.available) checkAvailable(current.effort);
    append(sessionId, { turnId, executionId: id, type: "action",
      text: requested === "approve" ? "Extensão autorizada pelo usuário." : "Retomada solicitada pelo usuário." });
    start(sessionId, turnId, id, (signal, sink) => main.resume(sessionId, id, context(sessionId, signal), extension, sink));
  }

  return async (request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    try {
      const host = request.headers.host;
      const method = request.method;
      if (host !== "127.0.0.1:" + port() && host !== "localhost:" + port()) {
        throw new HttpError(403, "invalid_host", "Acesso permitido apenas pelo endereço local.");
      }
      if (method !== "GET" && method !== "POST") throw new HttpError(405, "method_not_allowed", "Método indisponível.");
      if (method === "POST" && request.headers.origin !== "http://" + host) {
        throw new HttpError(403, "invalid_origin", "Origem da solicitação não autorizada.");
      }
      const url = new URL(request.url ?? "/", "http://" + host);
      const [, api, resource, sessionId, subresource, id, operation, ...extra] = url.pathname.split("/");
      if (api !== "api" || extra.length) missing();
      if (resource === "system" && sessionId === undefined && method === "GET") {
        json(response, 200, runtime.system(effort(url.searchParams.get("effort") ?? "auto")));
      } else if (resource === "usage" && sessionId === undefined && method === "GET") {
        json(response, 200, runtime.usage());
      } else if (resource === "provider-usage" && sessionId === undefined && method === "POST") {
        if (Object.keys(await body(request, 1024)).length) invalid();
        json(response, 200, await runtime.providerDashboard());
      } else if (resource === "sessions" && sessionId === undefined) {
        if (method === "POST") {
          if (Object.keys(await body(request)).length) invalid();
          const id = randomUUID();
          conversations.createSession(id);
          json(response, 201, { id, title: "Nova sessão" });
        } else json(response, 200, conversations.sessions().flatMap((row) =>
          typeof row.id === "string" ? [{ id: row.id, title: asString(row.title)?.replace(/\s+/g, " ").slice(0, 72) || "Nova sessão" }] : []));
      } else {
        if (resource !== "sessions" || !sessionId || !sessionPattern.test(sessionId) || !conversations.hasSession(sessionId)) missing();
        if (method === "GET" && subresource === undefined) json(response, 200, snapshot(sessionId));
        else if (method === "GET" && subresource === "events" && id === undefined) stream(sessionId, response);
        else if (method === "POST" && subresource === "messages" && id === undefined) {
          const data = await body(request);
          const { id, message } = data;
          const level = effort(data.effort);
          if (typeof id !== "string" || !uuid.test(id) || typeof message !== "string" ||
              !message.trim() || message.length > 16_000 ||
              Object.keys(data).some((key) => !["id", "message", "effort"].includes(key))) invalid();
          const text = message.trim();
          const existing = conversations.turns(sessionId).find((turn) => turn.id === id);
          if (existing) {
            if (existing.request !== text) conflict("Identificador já utilizado nesta sessão.");
          } else {
            checkAvailable(level);
            if (jobs.has(sessionId)) conflict("A sessão já está em processamento.");
            if (!conversations.beginTurn(sessionId, id, text)) conflict("Identificador já utilizado.");
            start(sessionId, id, null, (signal, sink) => main.run({
              sessionId, message: text, turnId: id, context: context(sessionId, signal), effort: level, limits: runtime.limits, stream: runtime.live,
            }, sink));
          }
          json(response, 202, { id });
        } else if (method === "POST" && subresource === "messages" && id && uuid.test(id) && operation === "cancel") {
          if (Object.keys(await body(request)).length) invalid();
          const job = jobs.get(sessionId);
          if (!job || job.turnId !== id) conflict("A geração já foi encerrada ou mudou.");
          job.controller.abort();
          json(response, 202, { id });
        } else if (method === "POST" && subresource === "messages" && id && uuid.test(id) && operation === "voice") {
          const fetchSite = request.headers["sec-fetch-site"];
          if (fetchSite && fetchSite !== "same-origin") {
            throw new HttpError(403, "invalid_origin", "Origem da solicitação não autorizada.");
          }
          if (Object.keys(await body(request, 1024)).length) invalid();
          if (!voice) throw new VoiceError(503, "voice_not_configured", "ElevenLabs sem configuração válida.");
          const current = snapshot(sessionId);
          const turn = current.turns.find((item) => item.id === id);
          const reply = turn && finalReply(current, turn);
          if (!reply) missing();
          const abort = new AbortController();
          if (response.destroyed) return;
          response.once("close", () => abort.abort());
          const audio = await voice(speakableText(reply), abort.signal);
          if (abort.signal.aborted) return;
          response.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": String(audio.byteLength) });
          response.end(audio);
        } else if (subresource === "executions" && id && uuid.test(id)) {
          if (method === "GET" && operation === undefined) json(response, 200, execution(sessionId, id) ?? missing());
          else if (method === "POST" && operation === "action") {
            action(sessionId, id, await body(request));
            json(response, 202, { id });
          } else missing();
        } else missing();
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      if (error instanceof HttpError || error instanceof VoiceError) {
        json(response, error.status, { error: { code: error.code, message: error.message } });
      }
      else {
        console.error("VOID web: erro interno na API local.");
        json(response, 500, { error: { code: "internal_error", message: "O servidor não conseguiu atender à solicitação." } });
      }
    }
  };
}
