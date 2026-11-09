import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelUsage,
} from "../../types/model.js";
import { describeFailure, ExecutionError, type FailureCategory } from "../../types/failure.js";
import type { OpenRouterFreeCatalog } from "./OpenRouterFreeCatalog.js";
import { isModelReasoning } from "../reasoning.js";
import type { ModelReasoning } from "../../types/model.js";

import { currentGenerationTrace, type GenerationTrace } from "../generationTrace.js";
import { isFreeOpenRouterRoute } from "../costAuthorization.js";
import { readOpenRouterStream } from "./readOpenRouterStream.js";
import { retryAfter } from "./retryAfter.js";

type Failure = "transport" | "http" | "api" | "invalid_response" | "missing_content" | "incomplete";
const finishReasons = new Set(["stop", "length", "content_filter", "tool_calls", "error"]);
const apiErrorTypes = new Set([
  "authentication", "permission_denied", "payment_required",
  "rate_limit_exceeded", "provider_overloaded", "provider_unavailable",
  "context_length_exceeded", "max_tokens_exceeded", "token_limit_exceeded",
  "invalid_request", "invalid_prompt", "not_found", "content_policy_violation",
  "refusal", "timeout", "server", "unmapped",
]);
const transportCodes = new Set([
  "EAI_AGAIN", "ENOTFOUND", "ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

export class OpenRouterError extends ExecutionError {
  override readonly name = "OpenRouterError";

  constructor(readonly category: Failure, message: string) {
    super({ category, message, retryable: category === "transport" });
  }
}

export interface OpenRouterDiagnostic {
  provider: "openrouter";
  requestedModel?: string;
  maxOutputTokens?: number;
  elapsedMs?: number;
  reasoningConfig?: ModelReasoning;
  returnedModel?: string;
  httpStatus?: number;
  retryAt?: number;
  costUsd?: number;
  finishReason?: string;
  contentType?: string;
  contentLength?: number;
  hasReasoning?: boolean;
  usageStatus: "available" | "unavailable" | "invalid";
  usageIssue?: "invalid_totals" | "invalid_reasoning_breakdown";
  usage?: ModelUsage;
  apiCode?: number;
  apiErrorType?: string;
  transportCode?: string;
  failure?: FailureCategory;
  failureCode?: string;
  trace?: GenerationTrace;
  responseFormat?: "json_object";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isModelId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 160 &&
    /^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i.test(value);
}

function collectUsage(value: unknown, diagnostic: OpenRouterDiagnostic): void {
  if (value == null) {
    return;
  }
  if (isRecord(value) && typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0) {
    diagnostic.costUsd = value.cost;
  }
  diagnostic.usageStatus = "invalid";
  if (!isRecord(value) || !isTokenCount(value.prompt_tokens) || !isTokenCount(value.completion_tokens)) {
    diagnostic.usageIssue = "invalid_totals";
    return;
  }

  const details = value.completion_tokens_details;
  if (details != null && !isRecord(details)) {
    diagnostic.usageIssue = "invalid_reasoning_breakdown";
    return;
  }
  const reasoning = details?.reasoning_tokens;
  if (reasoning != null && (!isTokenCount(reasoning) || reasoning > value.completion_tokens)) {
    diagnostic.usageIssue = "invalid_reasoning_breakdown";
    return;
  }

  diagnostic.usage = {
    inputTokens: value.prompt_tokens,
    outputTokens: value.completion_tokens,
    ...(reasoning == null ? {} : { reasoningTokens: reasoning }),
  };
  diagnostic.usageStatus = "available";
}

function collectApiError(value: unknown, diagnostic: OpenRouterDiagnostic): string {
  if (!isRecord(value)) {
    return "no structured API error";
  }
  if (isTokenCount(value.code) && value.code >= 100 && value.code <= 599) {
    diagnostic.apiCode = value.code;
  }
  const metadataType = isRecord(value.metadata) ? value.metadata.error_type : undefined;
  const type = metadataType ?? value.code;
  if (typeof type === "string" && apiErrorTypes.has(type)) {
    diagnostic.apiErrorType = type;
  }
  const details = [
    diagnostic.apiCode === undefined ? undefined : `API code ${diagnostic.apiCode}`,
    diagnostic.apiErrorType,
  ].filter(Boolean);
  return details.join(", ") || "API error without a recognized code";
}

function parseCompletion(data: unknown, response: Response, diagnostic: OpenRouterDiagnostic): ModelResponse {
  const body = isRecord(data) ? data : undefined;
  const choice: unknown = Array.isArray(body?.choices) ? body.choices[0] : undefined;
  const first = isRecord(choice) ? choice : undefined;
  const message = isRecord(first?.message) ? first.message : undefined;
  const content = message?.content;
  const reason = first?.finish_reason;

  if (isModelId(body?.model)) {
    diagnostic.returnedModel = body.model;
  }
  if (reason != null) {
    diagnostic.finishReason = typeof reason === "string" && finishReasons.has(reason) ? reason : "unknown";
  }
  if (message) {
    diagnostic.contentType = content === undefined ? "missing" : content === null ? "null" : typeof content;
    if (typeof content === "string") {
      diagnostic.contentLength = content.length;
    }
    diagnostic.hasReasoning = (typeof message.reasoning === "string" && message.reasoning.length > 0) ||
      (Array.isArray(message.reasoning_details) && message.reasoning_details.length > 0);
  }
  collectUsage(body?.usage, diagnostic);

  const apiError = body?.error ?? first?.error;
  const errorDetail = apiError == null ? undefined : collectApiError(apiError, diagnostic);
  if (!response.ok) {
    throw new OpenRouterError("http", `OpenRouter HTTP ${response.status} (${errorDetail ?? "no structured API error"}).`);
  }
  if (reason === "length" || diagnostic.apiErrorType === "max_tokens_exceeded") {
    throw new OpenRouterError("incomplete", "OpenRouter generation incomplete: output token limit reached.");
  }
  if (errorDetail !== undefined || reason === "error") {
    throw new OpenRouterError("api", `OpenRouter generation failed (${errorDetail ?? "finish_reason=error"}).`);
  }
  if (!body || typeof body.model !== "string" || !body.model.trim() || !Array.isArray(body.choices)) {
    throw new OpenRouterError("invalid_response", "Invalid OpenRouter response: expected a model and choices array.");
  }
  if (body.choices.length === 0) {
    throw new OpenRouterError("invalid_response", "Invalid OpenRouter response: no choices.");
  }
  if (reason === "content_filter" || reason === "tool_calls") {
    throw new OpenRouterError("incomplete", `OpenRouter generation incomplete: finish_reason=${reason}.`);
  }
  if (!message) {
    throw new OpenRouterError("invalid_response", "Invalid OpenRouter response: missing or invalid message.");
  }
  if (content == null || (typeof content === "string" && !content.trim())) {
    const source = content === undefined ? "missing" : content === null ? "null" : "empty";
    const reasoning = diagnostic.hasReasoning ? "; reasoning was returned separately" : "";
    throw new OpenRouterError("missing_content", `OpenRouter returned no final text (content=${source}${reasoning}).`);
  }
  if (typeof content !== "string") {
    throw new OpenRouterError("invalid_response", "Invalid OpenRouter response: content must be text.");
  }
  if (reason !== "stop") {
    const detail = reason == null ? "missing" : "unrecognized";
    throw new OpenRouterError("invalid_response", `Invalid OpenRouter response: ${detail} finish_reason.`);
  }
  // An inconsistent optional reasoning breakdown makes usage untrusted, like missing usage.
  // The caller still validates the final text and the model gate handles unknown token usage.
  if (diagnostic.usageIssue === "invalid_totals") {
    throw new OpenRouterError("invalid_response", "Invalid OpenRouter response: invalid usage metrics.");
  }

  return {
    content,
    model: body.model,
    ...(diagnostic.usage === undefined ? {} : { usage: { ...diagnostic.usage } }),
  };
}

export class OpenRouterProvider implements ModelProvider {
  readonly id = "openrouter";
  private readonly cooldowns = new Map<string, number>();

  constructor(
    private readonly apiKey: string,
    private readonly onDiagnostic?: (event: Readonly<OpenRouterDiagnostic>) => void | Promise<void>,
    private readonly freeCatalog?: OpenRouterFreeCatalog,
    private readonly fallbackModels: readonly string[] = [],
  ) {
    if (!apiKey.trim()) {
      throw new Error("OpenRouter API key is required.");
    }
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    try {
      return await this.attempt(request);
    } catch (error) {
      request.signal?.throwIfAborted();
      const failure = describeFailure(error);
      const eligible = ["transport", "missing_content", "timeout"].includes(failure.category) ||
        ["free_price_unverified", "reasoning_unsupported", "context_length_exceeded", "decision_json", "decision_schema"].includes(failure.code ?? "") ||
        failure.httpStatus === 404 || (failure.httpStatus !== undefined && failure.httpStatus >= 500);
      if (!eligible || !this.freeCatalog || !isFreeOpenRouterRoute(request.model) ||
          request.maxOutputTokens !== undefined) throw error;
      for (const model of this.fallbackModels) {
        if (model === request.model) continue;
        request.onText?.("");
        try {
          return await this.attempt({ ...request, model }, true);
        } catch (fallbackError) {
          request.signal?.throwIfAborted();
          const failure = describeFailure(fallbackError);
          const preflight = ["free_price_unverified", "fallback_incompatible", "reasoning_unsupported", "context_length_exceeded"];
          if (failure.httpStatus !== undefined || !preflight.includes(failure.code ?? "")) throw fallbackError;
        }
      }
      throw error;
    }
  }

  private async attempt(request: ModelRequest, fallback = false): Promise<ModelResponse> {
    const cooldown = this.cooldowns.get(request.model);
    if (cooldown !== undefined) {
      request.signal?.throwIfAborted();
      if (Date.now() < cooldown) throw new ExecutionError({ category: "rate_limited", retryable: true,
        message: "Rota OpenRouter em pausa após um limite de requisições.", provider: this.id, model: request.model });
      this.cooldowns.delete(request.model);
    }
    request = { ...request, ...(request.reasoning ? { reasoning: { ...request.reasoning } } : {}) };
    const reasoning = request.reasoning;
    let startedAt: number | undefined;
    const idle = new AbortController();
    const signal = request.onText && request.signal ? AbortSignal.any([idle.signal, request.signal])
      : request.onText ? idle.signal : request.signal
        ? AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let headers: Headers | undefined;
    const refreshTimeout = () => {
      if (!request.onText) return;
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new DOMException("OpenRouter stream stalled", "TimeoutError")), 60_000);
      timer.unref();
    };
    const diagnostic: OpenRouterDiagnostic = { provider: this.id, usageStatus: "unavailable" };
    const trace = currentGenerationTrace();
    if (trace) diagnostic.trace = trace;
    if (isModelId(request.model)) {
      diagnostic.requestedModel = request.model;
    }
    if (isTokenCount(request.maxOutputTokens)) {
      diagnostic.maxOutputTokens = request.maxOutputTokens;
    }

    try {
      request.signal?.throwIfAborted();
      if (reasoning !== undefined && (!this.freeCatalog || !isModelReasoning(reasoning, request.maxOutputTokens))) {
        throw new ExecutionError({
          category: "permission_denied", code: "reasoning_unverified", retryable: false,
          message: "O controle de raciocínio exige configuração válida e confirmação no catálogo.", provider: this.id,
        });
      }
      if (reasoning) diagnostic.reasoningConfig = { ...reasoning };
      const support = this.freeCatalog ? await this.freeCatalog.assertFree(request.model, request.signal, reasoning) : undefined;
      const responseFormat = support?.jsonObject ? request.responseFormat : undefined;
      if (fallback && request.responseFormat && !responseFormat) {
        throw new ExecutionError({ category: "permission_denied", code: "fallback_incompatible",
          retryable: false, message: "A rota gratuita de reserva não suporta o formato solicitado." });
      }
      // UTF-8 bytes conservatively estimate text input and message framing.
      const input = request.messages.reduce((total, message) => total + Buffer.byteLength(message.content) + 16, 16);
      const available = support?.contextLength === undefined ? Infinity : support.contextLength - input;
      const limit = Math.min(request.maxOutputTokens ?? Infinity, support?.maxCompletionTokens ?? Infinity, available);
      if (limit <= 0 || (reasoning?.maxTokens !== undefined && reasoning.maxTokens >= limit)) {
        throw new ExecutionError({ category: "invalid_response", code: "context_length_exceeded",
          retryable: false, message: "O contexto disponível é insuficiente para esta solicitação." });
      }
      // Omit the optional parameter by default so the actual serving endpoint applies its limits.
      // Catalog maxima can differ from the endpoint's accepted max_tokens parameter.
      const maxOutputTokens = request.maxOutputTokens === undefined ? undefined : limit;
      if (maxOutputTokens !== undefined) diagnostic.maxOutputTokens = maxOutputTokens;
      if (responseFormat) diagnostic.responseFormat = responseFormat;
      refreshTimeout();
      startedAt = performance.now();
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", redirect: "error",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          max_tokens: maxOutputTokens,
          ...(request.onText ? { stream: true, stream_options: { include_usage: true } } : {}),
          temperature: request.temperature,
          ...(responseFormat ? { response_format: { type: responseFormat } } : {}),
          ...(reasoning ? { reasoning: {
            enabled: reasoning.enabled, effort: reasoning.effort, max_tokens: reasoning.maxTokens, exclude: reasoning.exclude,
          } } : {}),
          ...(this.freeCatalog ? { provider: { allow_fallbacks: false,
            ...(reasoning || responseFormat ? { require_parameters: true } : {}),
            max_price: { prompt: 0, completion: 0, request: 0 } } } : {}),
        }),
        signal: signal ?? null,
      });
      diagnostic.httpStatus = response.status;
      headers = response.headers;
      let data: unknown;
      try {
        data = response.ok && response.headers.get("content-type")?.includes("text/event-stream")
          ? await readOpenRouterStream(response, (content) => {
            signal?.throwIfAborted();
            request.onText?.(content);
          }, refreshTimeout)
          : await response.json();
      } catch (error) {
        request.signal?.throwIfAborted();
        if (response.ok) {
          if (error instanceof SyntaxError) {
            throw new OpenRouterError("invalid_response", "Invalid OpenRouter response: body is not JSON.");
          }
          throw error;
        }
      }
      request.signal?.throwIfAborted();
      const completion = parseCompletion(data, response, diagnostic);
      request.validateContent?.(completion.content);
      return completion;
    } catch (error) {
      if (request.signal?.aborted) {
        diagnostic.failure = describeFailure(error, request.signal).category;
        request.signal.throwIfAborted();
      }
      if (error instanceof OpenRouterError) {
        const status = diagnostic.httpStatus;
        Object.assign(error.failure, {
          provider: this.id,
          ...(diagnostic.returnedModel || diagnostic.requestedModel
            ? { model: diagnostic.returnedModel ?? diagnostic.requestedModel } : {}),
          ...(status === undefined ? {} : { httpStatus: status }),
          ...(diagnostic.finishReason === undefined ? {} : { finishReason: diagnostic.finishReason }),
          ...(diagnostic.apiErrorType === undefined ? {} : { code: diagnostic.apiErrorType }),
          category: status === 429 || diagnostic.apiCode === 429 || diagnostic.apiErrorType === "rate_limit_exceeded" ? "rate_limited"
            : diagnostic.apiErrorType === "timeout" ? "timeout"
            : diagnostic.apiErrorType === "max_tokens_exceeded" ? "incomplete" : error.category,
          retryable: status === 429 || diagnostic.apiCode === 429 || (status !== undefined && status >= 500) ||
            diagnostic.apiErrorType === "rate_limit_exceeded" ||
            diagnostic.apiErrorType === "provider_unavailable" ||
            diagnostic.apiErrorType === "provider_overloaded" || diagnostic.apiErrorType === "timeout",
        });
        diagnostic.failure = error.failure.category;
        if (diagnostic.failure === "rate_limited" && this.freeCatalog && headers) {
          const now = Date.now();
          diagnostic.retryAt = retryAfter(headers, now) ?? now + 60_000;
          this.cooldowns.set(request.model, diagnostic.retryAt);
        }
        if (error.failure.code) diagnostic.failureCode = error.failure.code;
        if (diagnostic.usage) error.usage = { ...diagnostic.usage };
        throw error;
      }
      if (idle.signal.aborted || signal?.reason?.name === "TimeoutError") {
        diagnostic.failure = "timeout";
        throw new ExecutionError({ category: "timeout", retryable: true, provider: this.id,
          message: "O OpenRouter deixou de enviar dados." });
      }
      if (error instanceof ExecutionError) {
        diagnostic.failure = error.failure.category;
        if (diagnostic.usage) error.usage = { ...diagnostic.usage };
        if (diagnostic.httpStatus !== undefined) error.failure.httpStatus = diagnostic.httpStatus;
        if (error.failure.code) diagnostic.failureCode = error.failure.code;
        throw error;
      }
      const code = isRecord(error) && isRecord(error.cause) ? error.cause.code : undefined;
      if (typeof code === "string" && transportCodes.has(code)) {
        diagnostic.transportCode = code;
      }
      diagnostic.failure = "transport";
      const action = diagnostic.httpStatus === undefined ? "sending the request" : "reading the response";
      const detail = diagnostic.transportCode ? ` (${diagnostic.transportCode})` : "";
      const failure = new OpenRouterError("transport", `OpenRouter transport failure while ${action}${detail}.`);
      Object.assign(failure.failure, {
        provider: this.id,
        ...(diagnostic.requestedModel === undefined ? {} : { model: diagnostic.requestedModel }),
        ...(diagnostic.transportCode === undefined ? {} : { code: diagnostic.transportCode }),
        ...(diagnostic.httpStatus === undefined ? {} : { httpStatus: diagnostic.httpStatus }),
      });
      throw failure;
    } finally {
      clearTimeout(timer);
      if ((this.freeCatalog || trace) && startedAt !== undefined) diagnostic.elapsedMs = Math.round(performance.now() - startedAt);
      // Observability must not change the result or create an unhandled rejection.
      try {
        void Promise.resolve(this.onDiagnostic?.(diagnostic)).catch(() => {});
      } catch {
        // Diagnostic consumers are optional and isolated from generation.
      }
    }
  }
}
