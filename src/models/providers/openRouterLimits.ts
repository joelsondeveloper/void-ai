import { retryAfter } from "./retryAfter.js";

export interface OpenRouterLimitEvidence {
  origin: "account" | "model" | "upstream" | "platform" | "unknown";
  upstream: string | null;
  requestedModel: string | null;
  returnedModel: string | null;
  limit: number | null;
  remaining: number | null;
  resetsAt: number | null;
  retryAfterAt: number | null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function integer(value: unknown) {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

export function openRouterLimitEvidence(error: unknown, headers: Headers, now: number,
  requestedModel?: string, returnedModel?: string, streamProvider?: unknown): OpenRouterLimitEvidence {
  const { message, metadata: details } = object(error);
  const metadata = object(details);
  const nested = new Map(Object.entries(object(metadata.headers)).map(([name, value]) => [name.toLowerCase(), value]));
  const header = (name: string) => headers.get(name) ?? nested.get(name);
  const limit = integer(header("x-ratelimit-limit"));
  const remaining = integer(header("x-ratelimit-remaining"));
  const reset = integer(header("x-ratelimit-reset"));
  // OpenRouter documents this header as Unix epoch milliseconds.
  const resetsAt = reset !== null && reset >= 1e12 && reset <= 8.64e15 ? reset : null;
  const nestedRetry = nested.get("retry-after");
  const retryAfterAt = retryAfter(headers, now) ?? (typeof nestedRetry === "string" && /^[\x20-\x7e]{1,80}$/.test(nestedRetry)
    ? retryAfter(new Headers({ "retry-after": nestedRetry }), now) : null);

  const provider = metadata.provider_name ?? streamProvider;
  const upstream = typeof provider === "string" && /^[a-z][a-z0-9 ._()/&-]{0,63}$/i.test(provider) &&
    !/^(?:sk-|bearer |openrouter$)/i.test(provider) ? provider : null;
  const providerCode = metadata.provider_code;
  const source = metadata.limit_source;
  let origin: OpenRouterLimitEvidence["origin"] = "unknown";
  if (typeof message === "string" && /^Rate limit exceeded:\s*free-models-per-(?:day|min(?:ute)?)\b/i.test(message)) {
    origin = "account";
  } else if (source === "upstream_provider_shared_pool" ||
    (typeof providerCode === "string" && providerCode.trim().length > 0) || typeof providerCode === "number" ||
    (upstream !== null && message === "Provider returned error")) {
    origin = "upstream";
  } else if (metadata.scope === "model") {
    origin = "model";
  } else if (limit !== null && remaining === 0 && resetsAt !== null) {
    origin = "platform";
  }
  return { origin, upstream: origin === "upstream" ? upstream : null, requestedModel: requestedModel ?? null,
    returnedModel: returnedModel ?? null, limit, remaining, resetsAt, retryAfterAt };
}
