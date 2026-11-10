import { randomUUID } from "node:crypto";
import { PlanExecutor } from "../runtime/PlanExecutor.js";
import type { AgentRuntime } from "../runtime/AgentRuntime.js";
import type { AgentContext } from "../types/context.js";
import type { PlanStep } from "../types/plan.js";
import { Capacity } from "./Capacity.js";
import type { CheckpointLease, CheckpointStore } from "./CheckpointStore.js";
import { ExecutionRun, publish, type ExecutionObserver, type ProgressEvent } from "./ExecutionRun.js";
import { ExecutionError } from "../types/failure.js";
import type { ModelRequest, ModelResponse, ModelRoutes, ModelUsage, ServedModel } from "../types/model.js";
import type { ModelRouter } from "../models/ModelRouter.js";
import { validUsage } from "./modelPolicy.js";
import { freeOnlyAuthorization, type CostAuthorizationPolicy } from "../models/costAuthorization.js";
import { isModelLabel } from "../models/modelSelection.js";
import { emptyUsage, transition, type ExecutionCheckpoint, type Extension } from "./checkpoint.js";
import { positiveInteger, resolveEffort, safetyCaps, validateLimits,
  type Effort, type ExecutionLimits, type ExplicitEffort } from "./effort.js";

export interface GovernanceOptions {
  globalConcurrency?: number;
  autoEffort?: ExplicitEffort;
  trustedLocalProviders?: readonly string[];
  onProgress?: (event: ProgressEvent) => void | Promise<void>;
  now?: () => number;
}

export interface PlanningUsage {
  elapsedMs: number;
  usage?: ModelUsage;
  servedModel?: ServedModel;
}

export interface StartExecution extends ExecutionObserver {
  id?: string;
  plan: readonly PlanStep[];
  context: AgentContext;
  effort?: Effort;
  limits?: Partial<ExecutionLimits>;
  planning?: PlanningUsage;
  modelRoutes?: ModelRoutes;
}

export class ExecutionGovernance {
  private readonly executor = new PlanExecutor();
  private readonly active = new Map<string, ExecutionRun>();
  private readonly steps: Capacity;
  private readonly calls: Capacity;
  private readonly authorization: CostAuthorizationPolicy;
  private readonly now: () => number;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly store: CheckpointStore,
    private readonly options: GovernanceOptions = {},
  ) {
    const concurrency = options.globalConcurrency ?? 4;
    if (!positiveInteger(concurrency, safetyCaps.concurrency)) throw new Error("Invalid global concurrency.");
    this.steps = new Capacity(concurrency);
    this.calls = new Capacity(concurrency);
    this.authorization = freeOnlyAuthorization(options.trustedLocalProviders);
    this.now = options.now ?? (() => performance.now());
  }

  effortLimits(effort?: Effort, limits?: Partial<ExecutionLimits>) {
    return resolveEffort(effort, limits, this.options.autoEffort);
  }

  validatePlan(plan: PlanStep[]): void {
    this.executor.validatePlan(plan);
  }

  permitsModel(providerId: string, model: string): boolean {
    return this.authorization.permits(providerId, model);
  }

  // A single host-controlled planning request before a plan (or any checkpoint) exists.
  async planRequest(router: ModelRouter, providerId: string, request: ModelRequest,
    limits: ExecutionLimits, signal: AbortSignal): Promise<{ response: ModelResponse; planning: PlanningUsage }> {
    const startedAt = this.now();
    const bounded = { ...request, signal };
    validateLimits(limits);
    signal.throwIfAborted();
    if (!this.permitsModel(providerId, bounded.model)) {
      throw new ExecutionError({ category: "permission_denied", message: "Planning requires a free or trusted local model.", retryable: false });
    }
    if ((bounded.maxOutputTokens !== undefined || limits.outputTokens !== undefined) &&
        !positiveInteger(bounded.maxOutputTokens, limits.outputTokens ?? Number.MAX_SAFE_INTEGER)) {
      throw new ExecutionError({ category: "budget_exceeded", message: "Planning exceeds the authorized output limit.", retryable: false });
    }
    const release = await this.calls.acquire(signal);
    try {
      signal.throwIfAborted();
      const response = await router.generate(providerId, bounded);
      signal.throwIfAborted();
      if (limits.outputTokens !== undefined && bounded.maxOutputTokens !== undefined && validUsage(response.usage) &&
          response.usage.outputTokens > bounded.maxOutputTokens) {
        throw new ExecutionError({ category: "budget_exceeded", message: "Planning exceeded its reserved output.", retryable: false });
      }
      return {
        response,
        planning: {
          elapsedMs: Math.max(0, Math.floor(this.now() - startedAt)),
          ...(validUsage(response.usage) ? { usage: { ...response.usage } } : {}),
          ...(isModelLabel(providerId) && isModelLabel(bounded.model) && isModelLabel(response.model)
            ? { servedModel: { role: "decision", providerId, requested: bounded.model, returned: response.model } } : {}),
        },
      };
    } finally { release(); }
  }

  start(input: StartExecution): Promise<ExecutionCheckpoint> {
    const id = input.id ?? randomUUID();
    if (input.plan.length > safetyCaps.steps) throw new Error("The plan exceeds the hard step limit.");
    const plan = input.plan.map(({ id, agentId, objective, dependsOn, requiredCapability }) => ({
      id, agentId, objective, dependsOn: [...dependsOn],
      ...(requiredCapability === undefined ? {} : { requiredCapability }),
    }));
    this.executor.validatePlan(plan);
    const { effort, limits } = this.effortLimits(input.effort, input.limits);
    const usage = emptyUsage();
    if (input.planning) {
      usage.callsStarted = 1;
      usage.callsCompleted = 1;
      usage.elapsedMs = input.planning.elapsedMs;
      const metrics = input.planning.usage;
      if (validUsage(metrics)) {
        usage.inputTokens = metrics.inputTokens;
        usage.outputTokens = metrics.outputTokens;
        usage.reasoningTokens = metrics.reasoningTokens ?? 0;
      } else usage.unknownUsageCalls = 1;
    }
    const at = new Date().toISOString();
    const checkpoint: ExecutionCheckpoint = {
      version: 1, id, plan, effort, limits, status: "pending", warned: false,
      financial: { mode: "free_only", maxCostUsd: 0 },
      usage, extensions: [], createdAt: at, updatedAt: at,
      ...(input.modelRoutes ? {
        modelRoutes: structuredClone(input.modelRoutes),
        servedModels: input.planning?.servedModel ? [input.planning.servedModel] : [],
      } : {}),
      steps: [...this.executor.initializeExecution(plan).values()].map((step) => ({
        ...step, startedAt: null, finishedAt: null,
      })),
    };
    return this.run(this.store.claim(id, checkpoint), input.context, false, input);
  }

  resume(id: string, context: AgentContext, extension: Extension = {},
    observer: ExecutionObserver = {}): Promise<ExecutionCheckpoint> {
    const lease = this.store.claim(id);
    try {
      this.recoverLease(lease);
      const checkpoint = lease.checkpoint;
      if (!["pending", "paused", "awaiting_approval"].includes(checkpoint.status)) {
        throw new Error(`Execution in state ${checkpoint.status} cannot be resumed.`);
      }
      this.extend(lease, extension);
      this.executor.validatePlan(checkpoint.plan);
    } catch (error) {
      lease.release();
      throw error;
    }
    return this.run(lease, context, true, observer);
  }

  pause(id: string): void {
    const active = this.active.get(id);
    if (!active) throw new Error("Execution is not active in this process.");
    active.pause();
  }

  cancel(id: string): void {
    const active = this.active.get(id);
    if (active) {
      active.cancel();
      return;
    }
    const lease = this.store.claim(id);
    try {
      this.recoverLease(lease);
      transition(lease.checkpoint, "cancelled");
      delete lease.checkpoint.pauseReason;
      this.save(lease);
    } finally { lease.release(); }
    this.emit(lease.checkpoint, "execution_cancelled");
  }

  partial(id: string): ExecutionCheckpoint | undefined {
    return this.store.load(id);
  }

  recover(id: string): ExecutionCheckpoint {
    const lease = this.store.claim(id);
    let recovered: boolean;
    try {
      recovered = this.recoverLease(lease);
    } finally { lease.release(); }
    if (recovered) this.emit(lease.checkpoint, "execution_paused");
    return lease.checkpoint;
  }

  private async run(lease: CheckpointLease, context: AgentContext, resumed: boolean,
    observer: ExecutionObserver): Promise<ExecutionCheckpoint> {
    const id = lease.checkpoint.id;
    let result: ExecutionCheckpoint;
    try {
      const run = new ExecutionRun(lease, this.runtime, this.executor, context, this.steps, this.calls,
        this.authorization, this.now, (event) => {
          publish(this.options.onProgress, event);
          publish(observer.onProgress, event);
        }, observer.finalize, observer.includeDependencyResults);
      this.active.set(id, run);
      result = await run.execute(resumed);
    } finally {
      this.active.delete(id);
      lease.release();
    }
    switch (result.status) {
      case "awaiting_approval": this.emit(result, "approval_required", observer.onProgress); break;
      case "paused": this.emit(result, "execution_paused", observer.onProgress); break;
      case "completed": this.emit(result, "execution_completed", observer.onProgress); break;
      case "failed": this.emit(result, "execution_failed", observer.onProgress); break;
      case "cancelled": this.emit(result, "execution_cancelled", observer.onProgress); break;
    }
    return result;
  }

  private recoverLease(lease: CheckpointLease): boolean {
    const checkpoint = lease.checkpoint;
    if (checkpoint.status !== "running" && checkpoint.status !== "pausing") return false;
    const now = new Date().toISOString();
    for (const step of checkpoint.steps) {
      if (step.status !== "running") continue;
      step.status = "failed";
      step.finishedAt = now;
      step.error = "Step interrupted before a final checkpoint.";
      step.failure = { category: "interrupted", message: step.error, retryable: false };
    }
    const { usage } = checkpoint;
    usage.callsInterrupted += usage.callsActive;
    usage.unknownUsageCalls += usage.callsActive;
    usage.callsActive = 0;
    usage.stepsActive = 0;
    usage.outputTokensReserved = 0;
    transition(checkpoint, "paused");
    checkpoint.pauseReason = "recovery";
    this.save(lease);
    return true;
  }

  private extend(lease: CheckpointLease, extension: Extension): void {
    const requested = Object.entries(extension);
    if (requested.length === 0) return;
    for (const [key, value] of requested) {
      if (!["calls", "steps", "timeMs", "outputTokens"].includes(key) || !positiveInteger(value, Number.MAX_SAFE_INTEGER)) {
        throw new Error("Invalid execution extension.");
      }
    }

    const checkpoint = lease.checkpoint;
    const limits = { ...checkpoint.limits };
    limits.calls += extension.calls ?? 0;
    limits.steps += extension.steps ?? 0;
    if (extension.timeMs !== undefined) {
      limits.pauseAfterMs = (limits.pauseAfterMs ?? Math.max(checkpoint.usage.elapsedMs, limits.warnAfterMs))
        + extension.timeMs;
    }
    if (extension.outputTokens !== undefined) {
      if (limits.outputTokens === undefined) throw new Error("No output token limit to extend.");
      limits.outputTokens += extension.outputTokens;
    }
    validateLimits(limits);
    checkpoint.limits = limits;
    checkpoint.extensions.push({ at: new Date().toISOString(), limits: { ...extension } });
    this.save(lease);
  }

  private save(lease: CheckpointLease): void {
    lease.checkpoint.updatedAt = new Date().toISOString();
    lease.save(lease.checkpoint);
    this.emit(lease.checkpoint, "checkpoint_saved");
  }

  private emit(checkpoint: ExecutionCheckpoint, type: ProgressEvent["type"], observer?: ExecutionObserver["onProgress"]): void {
    const actions: NonNullable<ProgressEvent["actions"]>[number][] = [];
    if (type === "approval_required" || type === "execution_paused") {
      actions.push("partial", "cancel");
      if (type === "execution_paused") actions.push("continue");
      else {
        switch (checkpoint.pauseReason) {
          case "calls": actions.push("extend_calls"); break;
          case "steps": actions.push("extend_steps"); break;
          case "time": actions.push("extend_time"); break;
          case "tokens": actions.push("extend_output_tokens"); break;
        }
      }
    }
    const event: ProgressEvent = {
      type, executionId: checkpoint.id, status: checkpoint.status, usage: { ...checkpoint.usage },
      ...(checkpoint.pauseReason === undefined ? {} : { reason: checkpoint.pauseReason }),
      ...(actions.length === 0 ? {} : { actions }),
    };
    publish(this.options.onProgress, event);
    publish(observer, event);
  }
}
