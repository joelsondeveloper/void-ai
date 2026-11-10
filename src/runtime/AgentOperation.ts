import type { AgentContext } from "../types/context.js";

export class AgentOperation<Input, Output> {
  // Keep both ends of the contract tied to the operation token.
  declare readonly contract: (input: Input) => Output;

  constructor(readonly agentId: string, readonly capability: string) {}
}

export interface AgentInvocation extends AgentContext {
  readonly taskId: string;
  invoke<Input, Output>(operation: AgentOperation<Input, Output>, input: Input): Promise<Output>;
}

export interface AgentTaskEvent {
  executionId: string;
  taskId: string;
  parentTaskId: string | null;
  caller: string;
  agentId: string;
  capability: string;
  status: "running" | "completed" | "failed" | "cancelled";
  at: string;
}

export interface InvocationPolicy {
  maxTasks: number;
  trace?: (event: AgentTaskEvent) => void;
}

export type OperationHandler<Input, Output> = (input: Input, context: AgentInvocation) => Promise<Output>;
