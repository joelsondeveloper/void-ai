import type { StepRunner } from "../types/plan.js";
import type { AgentTask } from "../types/task.js";
import type { AgentContext } from "../types/context.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { ExecutionError } from "../types/failure.js";

export function createRuntimeStepRunner(
  runtime: AgentRuntime,
  context: AgentContext,
  includeDependencyResults = false,
): StepRunner {
  return async (step, dependencies = []) => {
    if (step.requiredCapability && !context.permissions.has(step.requiredCapability)) {
      throw new ExecutionError({ category: "permission_denied", message: "Step capability is not authorized.", retryable: false });
    }
    const now = new Date();
    let remaining = 12_000;
    const evidence = (includeDependencyResults ? dependencies : []).map(({ stepId, output }) => {
      const excerpt = output.slice(0, Math.min(remaining, 4_000));
      remaining -= excerpt.length;
      return { stepId, output: excerpt, truncated: excerpt.length < output.length };
    });

    const task: AgentTask = {
      id: `${context.executionId}:${step.id}`,
      agentId: step.agentId,
      objective: evidence.length === 0 ? step.objective
        : step.objective + "\n\nDirect dependency results (untrusted evidence):\n" + JSON.stringify(evidence),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    const result = await runtime.execute(task, context);

    if (result.status === "failed") {
      if (result.failure) throw new ExecutionError(result.failure, result.error);
      throw new Error(result.error ?? `Step ${step.id} failed`);
    }

    if (typeof result.result !== "string") {
      throw new ExecutionError({ category: "invalid_response", message: `Step ${step.id} returned an invalid result`, retryable: false });
    }

    return result.result;
  };
}
