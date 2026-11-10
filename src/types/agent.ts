import type { AgentTask } from "./task.js";
import type { AgentContext } from "./context.js";

export type AgentStatus = "enabled" | "disabled";

export interface AgentOutput {
    content: string;
}

export interface AgentDefinition {
    id: string;
    name: string;
    description: string;
    capabilities: string[];
}

export interface AgentIdentity {
    readonly definition: AgentDefinition;
}

export interface ExecutableAgent extends AgentIdentity {
    execute(task: AgentTask, context: AgentContext): Promise<AgentOutput>;
}
