import { createRuntimeStepRunner } from "../orchestration/RuntimeStepRunner.js";
import { currentGenerationTrace, withGenerationTrace } from "../models/generationTrace.js";
import { runWithModelGate, type ModelGate } from "../models/modelScope.js";
import type { AgentRuntime } from "../runtime/AgentRuntime.js";
import type { PlanExecutor } from "../runtime/PlanExecutor.js";
import type { AgentContext } from "../types/context.js";
import { ExecutionError, type ExecutionFailure } from "../types/failure.js";
import type { ModelUsage } from "../types/model.js";
import type { DependencyResult, PlanStep, PlanStepExecution } from "../types/plan.js";
import { Capacity } from "./Capacity.js";
import type { CheckpointLease } from "./CheckpointStore.js";
import { transition, type ExecutionCheckpoint, type PauseReason, type ResourceUsage } from "./checkpoint.js";
import { validUsage } from "./modelPolicy.js";
import type { CostAuthorizationPolicy } from "../models/costAuthorization.js";
import { isModelLabel } from "../models/modelSelection.js";

export type ProgressEvent = {
  type: "execution_started" | "step_started" | "step_completed" | "step_failed" |
    "checkpoint_saved" | "warning_threshold_reached" | "execution_paused" |
    "approval_required" | "execution_resumed" | "execution_completed" |
    "execution_failed" | "execution_cancelled";
  executionId: string;
  status: ExecutionCheckpoint["status"];
  usage: Readonly<ResourceUsage>;
  stepId?: string;
  reason?: PauseReason;
  actions?: readonly ("continue" | "extend_calls" | "extend_steps" | "extend_time" |
    "extend_output_tokens" | "partial" | "cancel")[];
};

export type ProgressSink = (event: ProgressEvent) => void | Promise<void>;

export interface ExecutionObserver {
  onProgress?: ProgressSink;
  finalize?: (checkpoint: ExecutionCheckpoint) => Promise<void>;
  includeDependencyResults?: boolean;
}

export function publish(sink: ProgressSink | undefined, event: ProgressEvent): void {
  try { void Promise.resolve(sink?.(event)).catch(() => {}); } catch { /* observer isolation */ }
}

function block(category: "budget_exceeded" | "permission_denied" | "internal_error", message: string, code?: string) {
  return new ExecutionError({ category, message, retryable: false, ...(code ? { code } : {}) });
}

export class ExecutionRun {
  private readonly checkpoint: ExecutionCheckpoint;
  private readonly pauseController = new AbortController();
  private readonly cancelController = new AbortController();
  private readonly executionSignal: AbortSignal;
  private readonly admissionSignal: AbortSignal;
  private readonly modelSlots: Capacity;
  private readonly callsByStep = new Map<string, number>();
  private readonly startedAt: number;
  private readonly priorElapsed: number;
  private storageError?: ExecutionError;
  private hardFailure = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly lease: CheckpointLease,
    private readonly runtime: AgentRuntime,
    private readonly executor: PlanExecutor,
    private readonly context: AgentContext,
    private readonly stepSlots: Capacity,
    private readonly callSlots: Capacity,
    private readonly authorization: CostAuthorizationPolicy,
    private readonly now: () => number,
    private readonly events?: ProgressSink,
    private readonly finalize?: ExecutionObserver["finalize"],
    private readonly includeDependencyResults = false,
  ) {
    this.checkpoint = lease.checkpoint;
    this.executionSignal = AbortSignal.any([context.signal, this.cancelController.signal]);
    this.admissionSignal = AbortSignal.any([this.executionSignal, this.pauseController.signal]);
    this.modelSlots = new Capacity(this.checkpoint.limits.concurrency);
    this.startedAt = now();
    this.priorElapsed = this.checkpoint.usage.elapsedMs;
  }

  pause(): void { this.requestPause("requested"); }

  cancel(): void { this.cancelController.abort(); }

  async execute(resumed: boolean): Promise<ExecutionCheckpoint> {
    try {
      transition(this.checkpoint, "running");
      delete this.checkpoint.pauseReason;
      this.save();
      this.emit(resumed ? "execution_resumed" : "execution_started");
      this.armTimer();

      const states = new Map(this.checkpoint.steps.map((state): [string, PlanStepExecution] => [
        state.stepId,
        {
          ...state,
          startedAt: state.startedAt ? new Date(state.startedAt) : null,
          finishedAt: state.finishedAt ? new Date(state.finishedAt) : null,
        },
      ]));
      await this.executor.executePlan(
        this.checkpoint.plan,
        (step, dependencies) => this.runStep(step, dependencies),
        this.checkpoint.limits.concurrency,
        {
          executions: states,
          reserve: () => this.reserveStep(),
          canStart: () => this.canStart(),
          changed: (step) => this.stepChanged(step),
          defer: (step, failure) => this.canDefer(step, failure),
        },
      );

      if (this.storageError) throw this.storageError;
      const unfinished = this.checkpoint.steps.some(({ status }) => status === "pending");
      const failed = this.checkpoint.steps.some(({ status }) => status === "failed");
      const finalize = this.finalize;
      if (finalize && !this.executionSignal.aborted && !this.hardFailure &&
          this.checkpoint.status === "running") {
        try {
          await runWithModelGate((provider, request, dispatch) => this.runModel(undefined, provider, request, dispatch),
            () => finalize(structuredClone(this.checkpoint)));
        } catch { /* Communication failure cannot invalidate specialist results. */ }
      }
      if (this.storageError) throw this.storageError;
      if (this.executionSignal.aborted) transition(this.checkpoint, "cancelled");
      else if (this.hardFailure) transition(this.checkpoint, "failed");
      else if (unfinished && this.checkpoint.status === "pausing") {
        transition(this.checkpoint, this.checkpoint.pauseReason === "requested" ? "paused" : "awaiting_approval");
      } else {
        transition(this.checkpoint, failed || unfinished ? "failed" : "completed");
      }
      if (["completed", "failed", "cancelled"].includes(this.checkpoint.status)) delete this.checkpoint.pauseReason;
      this.save();
      return structuredClone(this.checkpoint);
    } finally {
      clearTimeout(this.timer);
    }
  }

  private async runStep(step: PlanStep, dependencies?: readonly DependencyResult[]): Promise<string> {
    const inFlight = new Set<Promise<unknown>>();
    let open = true;
    const gate: ModelGate = (provider, request, dispatch) => {
      if (!open) return Promise.reject(block("permission_denied", "The step is no longer active."));
      const call = this.runModel(step, provider, request, dispatch);
      inFlight.add(call);
      void call.then(() => inFlight.delete(call), () => inFlight.delete(call));
      return call;
    };
    try {
      const modelRoute = step.agentId === "dev-agent" || step.agentId === "research-agent"
        ? this.checkpoint.modelRoutes?.[step.agentId] : undefined;
      const run = createRuntimeStepRunner(this.runtime, {
        ...this.context, executionId: this.checkpoint.id, signal: this.executionSignal,
        ...(modelRoute ? { modelRoute } : {}),
      }, this.includeDependencyResults);
      return await runWithModelGate(gate, () => run(step, dependencies));
    } finally {
      open = false;
      await Promise.allSettled(inFlight);
    }
  }

  private async runModel(
    step: PlanStep | undefined,
    provider: Parameters<ModelGate>[0],
    request: Parameters<ModelGate>[1],
    dispatch: Parameters<ModelGate>[2],
  ) {
    const stepId = step?.id;
    request = { ...request };
    const signal = request.signal ? AbortSignal.any([this.executionSignal, request.signal]) : this.executionSignal;
    const waitSignal = AbortSignal.any([this.admissionSignal, signal]);
    this.assertModelAdmission(signal);
    if (!this.authorization.permits(provider, request.model)) {
      if (stepId !== undefined) {
        this.hardFailure = true;
        this.pauseController.abort();
      }
      throw block("permission_denied", "The financial policy allows only approved free or local models.");
    }

    let releaseLocal: (() => void) | undefined;
    let releaseGlobal: (() => void) | undefined;
    try {
      try {
        releaseLocal = await this.modelSlots.acquire(waitSignal);
        releaseGlobal = await this.callSlots.acquire(waitSignal);
      } catch (error) {
        this.assertModelAdmission(signal);
        throw error;
      }
      this.assertModelAdmission(signal);
      const { usage, limits } = this.checkpoint;
      const reserve = request.maxOutputTokens ?? 0;
      if (limits.outputTokens !== undefined &&
          (!Number.isSafeInteger(reserve) || reserve <= 0 || reserve > limits.outputTokens - usage.outputTokens - usage.outputTokensReserved)) {
        this.requestPause("tokens");
        throw block("budget_exceeded", "Insufficient authorized output tokens for the request.", "tokens");
      }

      usage.callsStarted++;
      usage.callsActive++;
      const reserved = limits.outputTokens === undefined ? 0 : reserve;
      usage.outputTokensReserved += reserved;
      if (stepId !== undefined) this.callsByStep.set(stepId, (this.callsByStep.get(stepId) ?? 0) + 1);
      this.save();

      let metrics: ModelUsage | undefined;
      try {
        const trace = currentGenerationTrace();
        const response = await (trace && step
          ? withGenerationTrace({ ...trace, role: "specialist", stepId: step.id, agentId: step.agentId },
            () => dispatch({ ...request, signal }))
          : dispatch({ ...request, signal }));
        metrics = response.usage;
        signal.throwIfAborted();
        if (limits.outputTokens !== undefined && validUsage(metrics) && metrics.outputTokens > reserved) {
          throw block("budget_exceeded", "Reported output exceeded the authorized reservation.", "token_overrun");
        }
        if (this.checkpoint.servedModels && isModelLabel(provider) && isModelLabel(request.model) &&
            isModelLabel(response.model)) {
          const role = step === undefined ? "synthesis"
            : step.agentId === "dev-agent" || step.agentId === "research-agent" ? step.agentId : "specialist";
          this.checkpoint.servedModels.push({ role, providerId: provider, requested: request.model,
            returned: response.model, ...(stepId === undefined ? {} : { stepId }) });
        }
        usage.callsCompleted++;
        return response;
      } catch (error) {
        if (error instanceof ExecutionError && error.usage !== undefined) metrics = error.usage;
        usage.callsFailed++;
        throw error;
      } finally {
        usage.callsActive--;
        usage.outputTokensReserved -= reserved;
        if (validUsage(metrics)) {
          if (stepId !== undefined && limits.outputTokens !== undefined && metrics.outputTokens > reserved) {
            this.hardFailure = true;
            this.pauseController.abort();
          }
          usage.inputTokens += metrics.inputTokens;
          usage.outputTokens += metrics.outputTokens;
          usage.reasoningTokens += metrics.reasoningTokens ?? 0;
        } else {
          usage.unknownUsageCalls++;
        }
        this.save();
      }
    } finally {
      releaseGlobal?.();
      releaseLocal?.();
    }
  }

  private assertModelAdmission(signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.storageError) throw this.storageError;
    if (this.hardFailure) throw block("permission_denied", "A safety violation stopped new operations.");
    this.checkTime();
    const reason = this.checkpoint.pauseReason ?? this.modelLimit();
    if (reason) {
      this.requestPause(reason);
      throw block("budget_exceeded", "Execution paused before model dispatch.", reason);
    }
  }

  private modelLimit(): PauseReason | undefined {
    const { limits, usage } = this.checkpoint;
    if (usage.callsStarted >= limits.calls) return "calls";
    if (limits.outputTokens !== undefined) {
      if (usage.unknownUsageCalls > 0) return "usage_unknown";
      if (usage.outputTokens >= limits.outputTokens) return "tokens";
    }
    return undefined;
  }

  private canStart(): boolean {
    if (this.storageError) throw this.storageError;
    if (this.executionSignal.aborted || this.hardFailure || this.checkpoint.status !== "running") return false;
    this.checkTime();
    if (this.executionSignal.aborted || this.hardFailure || this.checkpoint.status !== "running") return false;
    const reason = this.checkpoint.usage.stepsStarted >= this.checkpoint.limits.steps ? "steps" : this.modelLimit();
    if (reason) this.requestPause(reason);
    return !reason;
  }

  private async reserveStep(): Promise<(() => void) | null> {
    if (!this.canStart()) return null;
    try { return await this.stepSlots.acquire(this.admissionSignal); }
    catch (error) {
      if (this.canStart()) throw error;
      return null;
    }
  }

  private canDefer(step: PlanStep, failure: ExecutionFailure): boolean {
    return failure.category === "budget_exceeded" && this.checkpoint.status === "pausing" &&
      failure.code === this.checkpoint.pauseReason && !this.callsByStep.has(step.id);
  }

  private stepChanged(state: PlanStepExecution): void {
    const index = this.checkpoint.steps.findIndex(({ stepId }) => stepId === state.stepId);
    if (index < 0) throw block("internal_error", "Unknown step in checkpoint.");
    const { usage } = this.checkpoint;
    if (state.status === "running") {
      usage.stepsStarted++;
      usage.stepsActive++;
      this.callsByStep.delete(state.stepId);
    } else {
      usage.stepsActive--;
    }
    this.checkpoint.steps[index] = {
      ...state,
      error: state.failure?.message ?? null,
      startedAt: state.startedAt?.toISOString() ?? null,
      finishedAt: state.finishedAt?.toISOString() ?? null,
    };
    this.checkTime();
    this.save();
    if (state.status === "running") this.emit("step_started", state.stepId);
    if (state.status === "completed") this.emit("step_completed", state.stepId);
    if (state.status === "failed") this.emit("step_failed", state.stepId);
  }

  private requestPause(reason: PauseReason): void {
    if (this.checkpoint.status !== "running") return;
    transition(this.checkpoint, "pausing");
    this.checkpoint.pauseReason = reason;
    this.pauseController.abort();
    this.save();
  }

  private syncTime(): void {
    this.checkpoint.usage.elapsedMs = this.priorElapsed + Math.max(0, Math.floor(this.now() - this.startedAt));
  }

  private checkTime(): void {
    this.syncTime();
    const { limits, usage } = this.checkpoint;
    if (!this.checkpoint.warned && usage.elapsedMs >= limits.warnAfterMs) {
      this.checkpoint.warned = true;
      this.save();
      this.emit("warning_threshold_reached");
    }
    if (limits.pauseAfterMs !== undefined && usage.elapsedMs >= limits.pauseAfterMs) this.requestPause("time");
  }

  private armTimer(): void {
    this.checkTime();
    const { limits, usage } = this.checkpoint;
    if (this.checkpoint.status !== "running") return;
    const next = Math.min(this.checkpoint.warned ? Infinity : limits.warnAfterMs, limits.pauseAfterMs ?? Infinity);
    if (!Number.isFinite(next)) return;
    this.timer = setTimeout(() => {
      try { this.armTimer(); } catch { /* save latched the failure and stopped admission */ }
    }, Math.max(1, next - usage.elapsedMs)).unref();
  }

  private save(): void {
    if (this.storageError) throw this.storageError;
    this.syncTime();
    this.checkpoint.updatedAt = new Date().toISOString();
    try { this.lease.save(this.checkpoint); }
    catch {
      this.storageError = block("internal_error", "Could not persist execution checkpoint.");
      this.pauseController.abort();
      throw this.storageError;
    }
    this.emit("checkpoint_saved");
  }

  private emit(type: ProgressEvent["type"], stepId?: string): void {
    publish(this.events, {
      type, executionId: this.checkpoint.id, status: this.checkpoint.status, usage: { ...this.checkpoint.usage },
      ...(stepId === undefined ? {} : { stepId }),
      ...(this.checkpoint.pauseReason === undefined ? {} : { reason: this.checkpoint.pauseReason }),
    });
  }
}
