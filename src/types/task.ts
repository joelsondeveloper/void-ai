import type { ExecutionFailure } from "./failure.js";

export type TaskStatus = "running" | "pending" | "completed" | "failed" | "cancelled";
type resultStatus = "completed" | "failed";

export interface AgentTask {
    id: string;
    agentId: string;
    objective: string;
    status: TaskStatus;
    createdAt: Date;
    updatedAt: Date;
}

export interface AgentResult {
    id: string;
    taskId: string;
    agentId: string;
    result: unknown;
    status: resultStatus;
    error?: string;
    failure?: ExecutionFailure;
    createdAt: Date;
    updatedAt: Date;
}
