import type { AgentTask } from "./task.js";
import type { AgentInvocation } from "../runtime/AgentOperation.js";
import type { UiAction } from "../web/ui-contracts.js";

export type AgentStatus = "enabled" | "disabled";

export interface AgentOutput {
    content: string;
    action?: UiAction;
}

export interface AgentDefinition {
    id: string;
    name: string;
    description: string;
    capabilities: string[];
    model?: { configKey: string; fallback: string };
}

export interface AgentIdentity {
    readonly definition: AgentDefinition;
}

export interface ExecutableAgent extends AgentIdentity {
    execute(task: AgentTask, context: AgentInvocation): Promise<AgentOutput>;
}
