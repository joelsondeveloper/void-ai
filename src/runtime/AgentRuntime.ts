import { AgentRegistry } from "./AgentRegistry.js";
import type { AgentTask, AgentResult } from "../types/task.js";
import type { AgentContext } from "../types/context.js";
import { describeFailure } from "../types/failure.js";

export class AgentRuntime {
  private readonly agents: AgentRegistry;
  private readonly runningTasks = new Set<string>();

  constructor(agents: AgentRegistry) {
    this.agents = agents;
  }

  async execute(task: AgentTask, context: AgentContext): Promise<AgentResult> {
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

    this.runningTasks.add(task.id);

    try {
      task.status = "running";
      task.updatedAt = new Date();

      context.signal.throwIfAborted();

      const output = await agent.execute(task, context);

      context.signal.throwIfAborted();

      task.status = "completed";
      task.updatedAt = new Date();

      const agentResult: AgentResult = {
        id: crypto.randomUUID(),
        taskId: task.id,
        agentId: task.agentId,
        result: output.content,
        status: "completed",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      return agentResult;
    } catch (error) {
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
      this.runningTasks.delete(task.id);
    }
  }
}
