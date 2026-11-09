import type { ModelReasoning, ReasoningEffort } from "../types/model.js";

const efforts: readonly ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export function isModelReasoning(value: unknown, maxOutputTokens?: number): value is ModelReasoning {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = Object.keys(value);
  if (!fields.length || fields.some((key) => !["enabled", "effort", "maxTokens", "exclude"].includes(key))) return false;
  const { enabled, effort, maxTokens, exclude } = value as Record<string, unknown>;
  return (enabled !== undefined || effort !== undefined || maxTokens !== undefined || exclude !== undefined) &&
    (enabled === undefined || (enabled === false && effort === undefined && maxTokens === undefined)) &&
    (effort === undefined || efforts.some((allowed) => effort === allowed)) &&
    (maxTokens === undefined || (effort === undefined && typeof maxTokens === "number" &&
      Number.isSafeInteger(maxTokens) && maxTokens > 0 && (maxOutputTokens === undefined || maxTokens < maxOutputTokens))) &&
    (exclude === undefined || typeof exclude === "boolean");
}
