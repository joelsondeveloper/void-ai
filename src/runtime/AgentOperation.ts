import type { ExecutionFailure } from "../types/failure.js";
import type { AgentContext } from "../types/context.js";

export class AgentOperation<Input, Output> {
  // Keep both ends of the contract tied to the operation token.
  declare readonly contract: (input: Input) => Output;

  constructor(readonly agentId: string, readonly capability: string, readonly tools: readonly ModelTool<Input>[] = []) {}
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
  failureCategory?: ExecutionFailure["category"];
}

export interface InvocationPolicy {
  maxTasks: number;
  trace?: (event: AgentTaskEvent) => void;
}

export type OperationHandler<Input, Output> = (input: Input, context: AgentInvocation) => Promise<Output>;

// Metadata and validation travel with the operation registered for execution.
export type AgentGeneration = (agentId: string, instructions: string, prompt: string, signal: AbortSignal,
  fallbackTokens: number) => Promise<string>;

export interface ModelToolResources {
  sessionId: string;
  generate: AgentGeneration;
}

export interface ModelTool<Input = unknown> {
  name: string;
  description: string;
  example: { name: string; arguments: object };
  /** Optional JSON Schema and Portuguese summary used when the tool is offered through native tool calling. */
  parameters?: Readonly<Record<string, unknown>>;
  summary?: string;
  accepts: (value: unknown) => boolean;
  prepare: (value: unknown, resources: ModelToolResources) => Input;
}
