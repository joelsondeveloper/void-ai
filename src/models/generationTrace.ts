import { AsyncLocalStorage } from "node:async_hooks";
import type { ExplicitEffort } from "../governance/effort.js";
import type { ExecutionFailure } from "../types/failure.js";

export interface GenerationTrace {
  sessionId: string;
  executionId: string;
  effort: ExplicitEffort;
  role: "decision" | "specialist" | "synthesis";
  stepId?: string;
  agentId?: string;
}

export interface DecisionDiagnostic {
  trace: GenerationTrace;
  requestedModel: string;
  returnedModel?: string;
  outcome: "tool" | "display" | "direct" | "delegate" | "ignore" | "rejected";
  failure?: Pick<ExecutionFailure, "category" | "code">;
}

const generation = new AsyncLocalStorage<GenerationTrace>();

export function withGenerationTrace<T>(trace: GenerationTrace, run: () => T): T {
  return generation.run(trace, run);
}

export function currentGenerationTrace(): GenerationTrace | undefined {
  return generation.getStore();
}

export function logGeneration(event: "provider" | "decision", diagnostic: object): void {
  if (process.env.VOID_GENERATION_DIAGNOSTICS === "1") {
    console.error(JSON.stringify({ event, ...diagnostic }));
  }
}
