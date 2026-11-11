import { currentGenerationTrace, withGenerationTrace } from "../models/generationTrace.js";
import { isUiAction } from "../web/ui-contracts.js";
import { AgentRegistry } from "./AgentRegistry.js";
import type { AgentTask, AgentResult } from "../types/task.js";
import type { AgentContext } from "../types/context.js";
import { describeFailure, ExecutionError } from "../types/failure.js";
import type { AgentOperation, AgentTaskEvent, InvocationPolicy, ModelToolResources } from "./AgentOperation.js";

export class AgentRuntime {
  private readonly agents: AgentRegistry;
  private readonly runningTasks = new Set<string>();

  constructor(agents: AgentRegistry, private readonly trace?: InvocationPolicy["trace"]) {
    this.agents = agents;
  }

  async invokeTool(caller: string, call: { name: string; arguments: unknown }, resources: ModelToolResources,
    context: AgentContext, policy: InvocationPolicy): Promise<unknown> {
    const binding = this.agents.modelToolFor(call.name, caller, context.permissions);
    if (!binding || !binding.tool.accepts(call)) throw new ExecutionError({ category: "permission_denied",
      message: "Ferramenta indisponível ou argumentos inválidos.", retryable: false });
    return this.invoke(caller, binding.operation, binding.tool.prepare(call, resources), context, policy);
  }

  invoke<Input, Output>(caller: string, operation: AgentOperation<Input, Output>, input: Input,
    context: AgentContext, policy: InvocationPolicy): Promise<Output> {
    return this.dispatcher(context, policy)(operation, input, [caller], null, context.signal);
  }

  private dispatcher(context: AgentContext, policy: InvocationPolicy) {
    if (!Number.isSafeInteger(policy.maxTasks) || policy.maxTasks < 1) throw new Error("Invalid task budget.");
    const permissions = new Set(context.permissions);
    let remaining = policy.maxTasks;

    const dispatch = async <I, O>(target: AgentOperation<I, O>, payload: I, chain: readonly string[],
      parentTaskId: string | null, parentSignal: AbortSignal): Promise<O> => {
      parentSignal.throwIfAborted();
      const from = chain[chain.length - 1];
      const handler = from ? this.agents.operationFor(target, from) : undefined;
      if (!from || !handler || !permissions.has(target.capability) || chain.includes(target.agentId)) {
        throw new ExecutionError({ category: "permission_denied", retryable: false,
          message: "Delegação recusada por permissão ou ciclo." });
      }
      if (remaining <= 0) {
        throw new ExecutionError({ category: "budget_exceeded", retryable: false,
          message: "O limite de tarefas delegadas foi atingido." });
      }
      remaining--;
      const taskId = crypto.randomUUID();
      const lifetime = new AbortController();
      const signal = AbortSignal.any([parentSignal, lifetime.signal]);
      const trace = (status: AgentTaskEvent["status"], failureCategory?: AgentTaskEvent["failureCategory"]) => (policy.trace ?? this.trace)?.({
        executionId: context.executionId, taskId, parentTaskId, caller: from,
        agentId: target.agentId, capability: target.capability, status,
        ...(failureCategory ? { failureCategory } : {}), at: new Date().toISOString(),
      });
      try {
        trace("running");
        const result = await this.runAs(target.agentId, () => handler(payload, {
          ...this.forAgent(context, target.agentId, false), permissions: new Set(permissions), signal, taskId,
          invoke: (child, childInput) => dispatch(child, childInput, [...chain, target.agentId], taskId, signal),
        }));
        signal.throwIfAborted();
        trace("completed");
        return result;
      } catch (error) {
        trace(signal.aborted ? "cancelled" : "failed", describeFailure(error, signal).category);
        throw error;
      } finally {
        lifetime.abort();
      }
    };

    return dispatch;
  }

  private forAgent(context: AgentContext, agentId: string, root: boolean): AgentContext {
    const { modelRoute, ...rest } = context;
    const route = context.modelRoutes?.[agentId] ?? (root ? modelRoute : undefined);
    return { ...rest, permissions: new Set(context.permissions), metadata: { ...context.metadata },
      ...(route ? { modelRoute: route } : {}) };
  }

  private runAs<T>(agentId: string, run: () => Promise<T>): Promise<T> {
    const trace = currentGenerationTrace();
    return trace ? withGenerationTrace({ ...trace, agentId, role: "specialist" }, run) : run();
  }

  async execute(task: AgentTask, context: AgentContext, maxDelegations = 0): Promise<AgentResult> {
    if (task.status !== "pending") {
      throw new Error(`Task with ID ${task.id} is not pending`);
    }

    if (this.runningTasks.has(task.id)) {
      throw new Error(`Task with ID ${task.id} is already running`);
    }

    const agent = this.agents.get(task.agentId);

    if (!agent) {
      const error = `Agent with ID ${task.agentId} not found`;

      task.status = "failed";
      task.updatedAt = new Date();

      const agentResult: AgentResult = {
        id: crypto.randomUUID(),
        taskId: task.id,
        agentId: task.agentId,
        result: null,
        status: "failed",
        error,
        failure: { category: "agent_not_found", message: "The requested agent is not registered.", retryable: false },
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return agentResult;
    }

    const lifetime = new AbortController();
    const signal = AbortSignal.any([context.signal, lifetime.signal]);
    const dispatch = this.dispatcher(context, { maxTasks: Math.max(1, maxDelegations) });
    const trace = (status: AgentTaskEvent["status"], failureCategory?: AgentTaskEvent["failureCategory"]) => {
      if (task.requiredCapability) this.trace?.({ executionId: context.executionId, taskId: task.id,
        parentTaskId: null, caller: "main-agent", agentId: task.agentId, capability: task.requiredCapability,
        status, at: new Date().toISOString(), ...(failureCategory ? { failureCategory } : {}) });
    };
    this.runningTasks.add(task.id);

    try {
      task.status = "running";
      task.updatedAt = new Date();

      context.signal.throwIfAborted();

      if (task.requiredCapability && (!context.permissions.has(task.requiredCapability) ||
          !agent.definition.capabilities.includes(task.requiredCapability))) {
        throw new ExecutionError({ category: "permission_denied", message: "Step capability is not authorized.", retryable: false });
      }
      trace("running");
      const output = await this.runAs(task.agentId, () => agent.execute(task, {
        ...this.forAgent(context, task.agentId, true), signal, taskId: task.id,
        invoke: (operation, input) => {
          if (maxDelegations <= 0) throw new ExecutionError({ category: "budget_exceeded",
            message: "O limite de tarefas delegadas foi atingido.", retryable: false });
          return dispatch(operation, input, ["main-agent", task.agentId], task.id, signal);
        },
      }));
      if (output.action && !isUiAction(output.action)) throw new ExecutionError({ category: "invalid_response",
        message: "A ação retornada pelo agente é inválida.", retryable: false });

      context.signal.throwIfAborted();

      trace("completed");
      task.status = "completed";
      task.updatedAt = new Date();

      const agentResult: AgentResult = {
        id: crypto.randomUUID(),
        taskId: task.id,
        agentId: task.agentId,
        result: output.content,
        ...(output.action ? { action: output.action } : {}),
        status: "completed",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return agentResult;
    } catch (error) {
      trace(signal.aborted ? "cancelled" : "failed", describeFailure(error, signal).category);
      const errorString =
        error instanceof Error ? error.message : String(error);
      task.status = "failed";
      task.updatedAt = new Date();

      const agentResult: AgentResult = {
        id: crypto.randomUUID(),
        taskId: task.id,
        agentId: task.agentId,
        result: null,
        status: "failed",
        error: errorString,
        failure: describeFailure(error, context.signal),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return agentResult;
    } finally {
      lifetime.abort();
      this.runningTasks.delete(task.id);
    }
  }
}
