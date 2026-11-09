import type { ExecutionFailure } from "./failure.js";

export type PlanStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type PlanStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface DependencyResult {
  stepId: string;
  output: string;
}

export type StepRunner = (step: PlanStep, dependencies?: readonly DependencyResult[]) => Promise<string>;

export interface PlanStepExecution {
  stepId: string;
  status: PlanStepStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  output: string | null;
  error: string | null;
  failure?: ExecutionFailure;
}

export interface Plan {
  id: string;
  objective: string;
  steps: PlanStep[];
  status: PlanStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlanStep {
  id: string;
  agentId: string;
  objective: string;
  dependsOn: string[];
  requiredCapability?: string;
}
