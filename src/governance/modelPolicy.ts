import type { ModelUsage } from "../types/model.js";

export function validUsage(usage: ModelUsage | undefined): usage is ModelUsage {
  return !!usage && [usage.inputTokens, usage.outputTokens, usage.reasoningTokens ?? 0]
    .every((n) => Number.isSafeInteger(n) && n >= 0) &&
    (usage.reasoningTokens ?? 0) <= usage.outputTokens;
}
