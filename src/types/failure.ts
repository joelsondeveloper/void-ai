import type { ModelUsage } from "./model.js";

export const failureCategories = [
  "transport", "http", "api", "rate_limited", "invalid_response",
  "missing_content", "incomplete", "timeout", "cancelled",
  "budget_exceeded", "permission_denied", "agent_not_found",
  "interrupted", "internal_error",
] as const;
export type FailureCategory = typeof failureCategories[number];

export interface ExecutionFailure {
  category: FailureCategory;
  message: string;
  retryable: boolean;
  provider?: string;
  model?: string;
  httpStatus?: number;
  finishReason?: string;
  code?: string;
}

export class ExecutionError extends Error {
  usage?: ModelUsage;

  constructor(readonly failure: ExecutionFailure, legacyMessage = failure.message) {
    super(legacyMessage);
    this.name = "ExecutionError";
  }
}

export function isOutputLimit(failure: ExecutionFailure): boolean {
  return failure.category === "incomplete" &&
    (failure.finishReason === "length" || failure.code === "max_tokens_exceeded");
}

export function describeFailure(error: unknown, signal?: AbortSignal): ExecutionFailure {
  if (signal?.aborted || (error instanceof DOMException && ["AbortError", "TimeoutError"].includes(error.name))) {
    const reason: unknown = signal?.aborted ? signal.reason : error;
    if (reason instanceof DOMException && reason.name === "TimeoutError") {
      return { category: "timeout", message: "Execution timed out.", retryable: false };
    }
    return { category: "cancelled", message: "Execution was cancelled.", retryable: false };
  }
  if (error instanceof ExecutionError) return error.failure;
  return { category: "internal_error", message: "Execution failed.", retryable: false };
}
