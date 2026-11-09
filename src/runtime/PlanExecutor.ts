import type {
  PlanStep,
  PlanStepExecution,
  PlanStepStatus,
  StepRunner,
} from "../types/plan.js";
import { describeFailure, type ExecutionFailure } from "../types/failure.js";

export interface PlanScheduling {
  executions: Map<string, PlanStepExecution>;
  reserve(step: PlanStep): Promise<(() => void) | null>;
  canStart(): boolean;
  changed(step: PlanStepExecution): void;
  defer?(step: PlanStep, failure: ExecutionFailure): boolean;
}

export class PlanExecutor {
  constructor() {}

  getReadySteps(
    steps: PlanStep[],
    executions: Map<string, PlanStepExecution>,
  ): PlanStep[] {
    return steps.filter(
      (step) =>
        executions.get(step.id)?.status === "pending" &&
        step.dependsOn.every(
          (dep) => executions.get(dep)?.status === "completed",
        ),
    );
  }

  validatePlan(steps: PlanStep[]): void {
    const seenIds = new Set<string>();
    const stepMap = new Map<string, PlanStep>();
    for (const step of steps) {
      stepMap.set(step.id, step);
      if (seenIds.has(step.id)) {
        throw new Error(`Duplicate step ID: ${step.id}`);
      }
      seenIds.add(step.id);
    }

    for (const step of steps) {
      const invalidDependency = step.dependsOn.find((dep) => !seenIds.has(dep));

      if (invalidDependency !== undefined) {
        throw new Error(
          `Step ${step.id} depends on non-existent step ${invalidDependency}`,
        );
      }
    }

    const visited = new Set<string>();
    const visiting = new Set<string>();

    function visit(stepId: string): void {
      if (visiting.has(stepId)) {
        throw new Error(`Cyclic dependency detected: ${stepId}`);
      }

      if (visited.has(stepId)) {
        return;
      }

      visiting.add(stepId);
      const step = stepMap.get(stepId);

      if (!step) {
        throw new Error(`Step ${stepId} not found`);
      }

      for (const dep of step.dependsOn) {
        visit(dep);
      }
      visiting.delete(stepId);
      visited.add(stepId);
    }

    for (const step of steps) {
      visit(step.id);
    }
  }

  initializeExecution(steps: PlanStep[]): Map<string, PlanStepExecution> {
    const execution = new Map<string, PlanStepExecution>();
    for (const step of steps) {
      execution.set(step.id, {
        stepId: step.id,
        status: "pending",
        startedAt: null,
        finishedAt: null,
        output: null,
        error: null,
      });
    }
    return execution;
  }

  updateStepStatus(
    execution: Map<string, PlanStepExecution>,
    stepId: string,
    status: PlanStepStatus,
  ): void {
    const stepExecution = execution.get(stepId);
    const allowedTransitions: Record<PlanStepStatus, PlanStepStatus[]> = {
      pending: ["running", "cancelled"],
      running: ["completed", "failed", "cancelled"],
      completed: [],
      failed: [],
      cancelled: [],
    };
    if (!stepExecution) {
      throw new Error(`Step ${stepId} not found in execution`);
    }

    if (!allowedTransitions[stepExecution.status].includes(status)) {
      throw new Error(
        `Invalid transition from ${stepExecution.status} to ${status}`,
      );
    }
    stepExecution.status = status;
    if (status === "running") {
      stepExecution.startedAt = new Date();
    }
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      stepExecution.finishedAt = new Date();
    }
  }

  async executePlan(
    steps: PlanStep[],
    runner: StepRunner,
    maxConcurrency = 3,
    scheduling?: PlanScheduling,
  ): Promise<Map<string, PlanStepExecution>> {
    if (maxConcurrency < 1 || !Number.isInteger(maxConcurrency)) {
      throw new Error("Max concurrency must be a positive integer.");
    }

    this.validatePlan(steps);

    const executions = scheduling?.executions ?? this.initializeExecution(steps);
    const running = new Set<Promise<void>>();
    let failure: { error: unknown } | undefined;

    const runStep = async (
      step: PlanStep,
      execution: PlanStepExecution,
    ): Promise<void> => {
      try {
        const dependencies = step.dependsOn.flatMap((stepId) => {
          const dependency = executions.get(stepId);
          return dependency?.status === "completed" && dependency.output !== null
            ? [{ stepId, output: dependency.output }] : [];
        });
        let output: string;
        try {
          output = await runner(step, dependencies);
        } catch (error) {
          const detail = describeFailure(error);
          if (scheduling?.defer?.(step, detail)) {
            execution.status = "pending";
            execution.startedAt = null;
            scheduling.changed(execution);
            return;
          }
          execution.error =
            error instanceof Error ? error.message : String(error);
          execution.failure = detail;
          this.updateStepStatus(executions, step.id, "failed");
          scheduling?.changed(execution);
          return;
        }

        execution.output = output;
        this.updateStepStatus(executions, step.id, "completed");
        scheduling?.changed(execution);
      } catch (error) {
        // Record the error before a concurrent completion can wake the scheduler.
        failure ??= { error };
      }
    };

    const startStep = (step: PlanStep, release?: () => void): void => {
      const execution = executions.get(step.id);
      if (!execution) {
        throw new Error(`Step ${step.id} not found in execution`);
      }
      this.updateStepStatus(executions, step.id, "running");
      scheduling?.changed(execution);

      const tracked = runStep(step, execution).then(() => {
        try { release?.(); }
        catch (error) { failure ??= { error }; }
        finally { running.delete(tracked); }
      });
      running.add(tracked);
    };

    try {
      schedule: while (!failure) {
        const ready = this.getReadySteps(steps, executions);

        for (const step of ready) {
          if (failure || running.size >= maxConcurrency) {
            break;
          }
          if (scheduling) {
            const release = await scheduling.reserve(step);
            if (release === null) {
              await Promise.all(running);
              break schedule;
            }
            try {
              if (!failure && scheduling.canStart()) {
                startStep(step, release);
                continue;
              }
            } catch (error) {
              release();
              throw error;
            }
            release();
            await Promise.all(running);
            break schedule;
          } else {
            startStep(step);
          }
        }

        if (failure || running.size === 0) {
          break;
        }

        await Promise.race(running);
      }
    } catch (error) {
      failure ??= { error };
    }

    if (failure) {
      await Promise.all(running);
      throw failure.error;
    }

    return executions;
  }
}
