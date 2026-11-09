export type ExecutionStatus = "running" | "completed" | "failed" | "cancelled";

export interface AgentExecution {
    id: string;
    taskId: string;
    agentId: string;
    attempt: number;
    status: ExecutionStatus;
    error: string | null;
    output: string | null;
    startedAt: Date;
    finishedAt: Date | null;
}