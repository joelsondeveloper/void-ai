import { addAbortListener } from "node:events";
import { isFreeOpenRouterRoute } from "../costAuthorization.js";
import { ExecutionError } from "../../types/failure.js";
import type { ModelReasoning } from "../../types/model.js";

function unverified(): ExecutionError {
  return new ExecutionError({
    category: "permission_denied", code: "free_price_unverified", retryable: false,
    message: "O catálogo do OpenRouter não confirmou uma rota gratuita para o modelo solicitado.",
  });
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const zero = (value: unknown) => value === 0 || (typeof value === "string" && /^0(?:\.0+)?$/.test(value));

interface CatalogEntry {
  contextLength: number | undefined;
  maxCompletionTokens: number | undefined;
  supported: boolean;
  efforts: unknown;
  maxTokens: boolean;
  mandatory: boolean;
  canDisable: boolean;
  jsonObject: boolean;
  tools: boolean;
}

export class OpenRouterFreeCatalog {
  private verified: ReadonlyMap<string, CatalogEntry> = new Map();
  private expiresAt = 0;
  private refresh: Promise<void> | undefined;

  constructor(private readonly fetchCatalog: typeof fetch = fetch, private readonly now = Date.now) {}

  async assertFree(model: string, signal?: AbortSignal, reasoning?: ModelReasoning): Promise<CatalogEntry> {
    signal?.throwIfAborted();
    if (!isFreeOpenRouterRoute(model)) throw unverified();
    if (this.now() >= this.expiresAt) {
      this.refresh ??= this.load().finally(() => { this.refresh = undefined; });
      let subscription: ReturnType<typeof addAbortListener> | undefined;
      try {
        if (signal) {
          const aborted = new Promise<never>((_, reject) => {
            subscription = addAbortListener(signal, () => reject(signal.reason));
          });
          await Promise.race([this.refresh, aborted]);
        } else await this.refresh;
      } catch {
        signal?.throwIfAborted();
        throw unverified();
      } finally {
        subscription?.[Symbol.dispose]();
      }
    }
    signal?.throwIfAborted();
    const support = this.verified.get(model);
    if (!support) throw unverified();
    if (reasoning && (!support.supported ||
        (reasoning.enabled === false && !support.canDisable) ||
        (reasoning.effort !== undefined &&
          ((reasoning.effort === "none" && support.mandatory) ||
           (support.efforts !== null && (!Array.isArray(support.efforts) || !support.efforts.includes(reasoning.effort))))) ||
        (reasoning.maxTokens !== undefined && !support.maxTokens))) {
      throw new ExecutionError({
        category: "permission_denied", code: "reasoning_unsupported", retryable: false,
        message: "O catálogo não confirmou o controle de raciocínio solicitado para este modelo.",
        provider: "openrouter",
      });
    }
    return support;
  }

  private async load(): Promise<void> {
    const response = await this.fetchCatalog("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw unverified();
    const data: unknown = await response.json();
    if (!record(data) || !Array.isArray(data.data)) throw unverified();
    const verified = new Map<string, CatalogEntry>();
    for (const entry of data.data as unknown[]) {
      if (!record(entry) || typeof entry.id !== "string" || !record(entry.pricing)) continue;
      if (typeof entry.expiration_date === "string" && !(Date.parse(entry.expiration_date) > this.now())) continue;
      if (zero(entry.pricing.prompt) && zero(entry.pricing.completion) &&
          Object.values(entry.pricing).every(zero)) {
        const reasoning = record(entry.reasoning) ? entry.reasoning : undefined;
        const top = record(entry.top_provider) ? entry.top_provider : undefined;
        verified.set(entry.id, {
          contextLength: positive(top?.context_length) ?? positive(entry.context_length),
          maxCompletionTokens: positive(top?.max_completion_tokens),
          supported: !!reasoning && Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes("reasoning"),
          efforts: reasoning?.supported_efforts,
          maxTokens: reasoning?.supports_max_tokens === true,
          mandatory: reasoning?.mandatory === true,
          canDisable: reasoning?.mandatory === false,
          jsonObject: Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes("response_format"),
          tools: Array.isArray(entry.supported_parameters) && entry.supported_parameters.includes("tools"),
        });
      }
    }
    this.verified = verified;
    this.expiresAt = this.now() + 300_000;
  }
}
