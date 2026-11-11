import type { ExplicitEffort, ExecutionLimits } from "./effort.js";
import { validateLimits } from "./effort.js";
import type { PlanStep, PlanStepExecution } from "../types/plan.js";
import { failureCategories } from "../types/failure.js";
import type { ModelRoutes, ServedModel } from "../types/model.js";
import { isUiAction } from "../web/ui-contracts.js";
import { isModelLabel, isModelRoutes } from "../models/modelSelection.js";

export type RunStatus = "pending" | "running" | "pausing" | "paused" | "awaiting_approval"
  | "completed" | "failed" | "cancelled";
export type PauseReason = "requested" | "time" | "calls" | "steps" | "tokens" | "usage_unknown" | "recovery";

export interface ResourceUsage {
  callsStarted: number;
  callsCompleted: number;
  callsFailed: number;
  callsInterrupted: number;
  callsActive: number;
  stepsStarted: number;
  stepsActive: number;
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  outputTokensReserved: number;
  reasoningTokens: number;
  unknownUsageCalls: number;
  financialCostUsd: null;
}

export interface Extension {
  calls?: number;
  steps?: number;
  timeMs?: number;
  outputTokens?: number;
}

export interface ExecutionCheckpoint {
  version: 1;
  id: string;
  plan: PlanStep[];
  steps: Array<Omit<PlanStepExecution, "startedAt" | "finishedAt"> & {
    startedAt: string | null;
    finishedAt: string | null;
  }>;
  effort: ExplicitEffort;
  limits: ExecutionLimits;
  financial: { mode: "free_only"; maxCostUsd: 0 };
  usage: ResourceUsage;
  modelRoutes?: ModelRoutes;
  servedModels?: ServedModel[];
  status: RunStatus;
  pauseReason?: PauseReason;
  warned: boolean;
  extensions: Array<{ at: string; limits: Extension }>;
  createdAt: string;
  updatedAt: string;
}

const transitions: Record<RunStatus, readonly RunStatus[]> = {
  pending: ["running", "cancelled"],
  running: ["pausing", "completed", "failed", "cancelled", "paused"],
  pausing: ["paused", "awaiting_approval", "completed", "failed", "cancelled"],
  paused: ["running", "cancelled"],
  awaiting_approval: ["running", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function transition(checkpoint: ExecutionCheckpoint, status: RunStatus): void {
  if (!transitions[checkpoint.status].includes(status)) {
    throw new Error(`Invalid execution transition ${checkpoint.status} -> ${status}.`);
  }
  checkpoint.status = status;
}

export function emptyUsage(): ResourceUsage {
  return {
    callsStarted: 0, callsCompleted: 0, callsFailed: 0, callsInterrupted: 0,
    callsActive: 0, stepsStarted: 0, stepsActive: 0, elapsedMs: 0,
    inputTokens: 0, outputTokens: 0, outputTokensReserved: 0, reasoningTokens: 0,
    unknownUsageCalls: 0, financialCostUsd: null,
  };
}

function requireValid(valid: unknown): asserts valid {
  if (!valid) throw new Error("Invalid execution checkpoint.");
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const date = (value: unknown): boolean => typeof value === "string" && Number.isFinite(Date.parse(value));

export function decodeCheckpoint(json: string): ExecutionCheckpoint {
  const raw: unknown = JSON.parse(json);
  requireValid(record(raw));
  if (raw.version !== 1) throw new Error("Unsupported execution checkpoint version.");
  requireValid(typeof raw.id === "string" && raw.id.length > 0 && typeof raw.status === "string" &&
    Object.hasOwn(transitions, raw.status) && typeof raw.effort === "string" &&
    ["low", "medium", "high", "max"].includes(raw.effort) &&
    date(raw.createdAt) && date(raw.updatedAt) && typeof raw.warned === "boolean" &&
    record(raw.financial) && raw.financial.mode === "free_only" && raw.financial.maxCostUsd === 0 &&
    record(raw.limits) && record(raw.usage) && Array.isArray(raw.plan) && Array.isArray(raw.steps) &&
    raw.plan.length === raw.steps.length && Array.isArray(raw.extensions));
  // Validate the persisted limits before the checkpoint can authorize any work.
  validateLimits(raw.limits as unknown as ExecutionLimits);
  if (raw.modelRoutes !== undefined) requireValid(isModelRoutes(raw.modelRoutes));
  if (raw.servedModels !== undefined) {
    requireValid(Array.isArray(raw.servedModels) && raw.servedModels.length <= Number(raw.usage.callsStarted) &&
      raw.servedModels.every((model: unknown) => record(model) &&
        Object.keys(model).every((key) => ["providerId", "requested", "returned", "role", "stepId"].includes(key)) &&
        isModelLabel(model.providerId) && isModelLabel(model.requested) && isModelLabel(model.returned) &&
        isModelLabel(model.role) &&
        (model.stepId === undefined || typeof model.stepId === "string")));
  }
  const usage = raw.usage;
  for (const key of Object.keys(emptyUsage())) {
    requireValid(key === "financialCostUsd" ? usage[key] === null : count(usage[key]));
  }
  requireValid(usage.callsStarted === Number(usage.callsCompleted) + Number(usage.callsFailed) +
    Number(usage.callsInterrupted) + Number(usage.callsActive) &&
    Number(usage.unknownUsageCalls) <= Number(usage.callsStarted) &&
    (usage.callsActive !== 0 || usage.outputTokensReserved === 0) &&
    Number(usage.callsStarted) <= Number(raw.limits.calls) &&
    Number(usage.stepsStarted) <= Number(raw.limits.steps) &&
    Number(usage.stepsActive) <= Number(raw.limits.concurrency) &&
    Number(usage.callsActive) <= Number(raw.limits.concurrency));

  const ids = new Set<string>();
  for (const step of raw.plan as unknown[]) {
    requireValid(record(step) && typeof step.id === "string" && !ids.has(step.id) &&
      typeof step.agentId === "string" && typeof step.objective === "string" &&
      (step.requiredCapability === undefined || typeof step.requiredCapability === "string") &&
      Array.isArray(step.dependsOn) && step.dependsOn.every((id) => typeof id === "string"));
    ids.add(step.id);
  }
  let active = 0;
  for (const state of raw.steps as unknown[]) {
    requireValid(record(state) && typeof state.stepId === "string" && ids.delete(state.stepId) &&
      typeof state.status === "string" && ["pending", "running", "completed", "failed", "cancelled"].includes(state.status) &&
      (state.output === null || typeof state.output === "string") &&
      (state.error === null || typeof state.error === "string") &&
      (state.startedAt === null || date(state.startedAt)) &&
      (state.finishedAt === null || date(state.finishedAt)));
    requireValid(state.action === undefined || (state.status === "completed" && isUiAction(state.action)));
    if (state.status === "running") active++;
    if (state.status === "pending" || state.status === "running") {
      requireValid(state.finishedAt === null && state.output === null && state.error === null &&
        state.failure === undefined && (state.status === "pending" ? state.startedAt === null : date(state.startedAt)));
    }
    if (state.status === "completed") {
      requireValid(typeof state.output === "string" && date(state.startedAt) && date(state.finishedAt) &&
        state.error === null && state.failure === undefined);
    }
    if (state.status === "failed") {
      requireValid(state.output === null && date(state.startedAt) && date(state.finishedAt) && record(state.failure));
    }
    const failure = state.failure;
    if (failure !== undefined) {
      requireValid(record(failure) && typeof failure.category === "string" &&
        failureCategories.some((category) => category === failure.category) &&
        typeof failure.message === "string" && state.error === failure.message &&
        typeof failure.retryable === "boolean");
    }
  }
  requireValid(ids.size === 0 && usage.stepsActive === active &&
    (["running", "pausing"].includes(raw.status) || (active === 0 && usage.callsActive === 0)));
  if (raw.pauseReason !== undefined) {
    requireValid(typeof raw.pauseReason === "string" &&
      ["requested", "time", "calls", "steps", "tokens", "usage_unknown", "recovery"].includes(raw.pauseReason));
  }
  for (const extension of raw.extensions as unknown[]) {
    requireValid(record(extension) && date(extension.at) && record(extension.limits) &&
      Object.entries(extension.limits).every(([key, value]) =>
        ["calls", "steps", "timeMs", "outputTokens"].includes(key) && count(value) && value > 0));
  }
  return raw as unknown as ExecutionCheckpoint;
}

export function encodeCheckpoint(checkpoint: ExecutionCheckpoint): string {
  const json = JSON.stringify(checkpoint, (_key, value: unknown) => {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" ||
        (record(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
      throw new Error("Non-serializable execution checkpoint value.");
    }
    return value;
  });
  decodeCheckpoint(json);
  return json;
}
