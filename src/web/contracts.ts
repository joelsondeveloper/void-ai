import type { Extension, PauseReason, RunStatus } from "../governance/checkpoint.js";
import type { Effort, ExecutionLimits, ExplicitEffort } from "../governance/effort.js";
import type { FailureCategory } from "../types/failure.js";
import type { ModelRoutes, ServedModel } from "../types/model.js";

import type { UiEvent } from "./ui-contracts.js";

export type { Effort, Extension };
export const efforts = ["auto", "low", "medium", "high", "max"] as const;

export interface Session { id: string; title: string }
export interface Turn {
  ui?: true;
  id: string;
  request: string;
  response: string | null;
  introduction?: string;
  executionId: string | null;
  failure: FailureCategory | null;
  failureDetail?: FailureDetail;
  model: string | null;
}
export interface Notice {
  id: string;
  turnId: string;
  at: string;
  type: "initial" | "progress" | "approval_required" | "action" | "generation_warning" | "memory";
  text: string;
  executionId?: string;
  stepId?: string;
  chatText?: string;
}
export interface Execution {
  id: string;
  revision: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  effort: ExplicitEffort;
  reason: PauseReason | null;
  extension: keyof Extension | null;
  actions: ActionName[];
  limits: ExecutionLimits;
  usage: { calls: number; steps: number; elapsedMs: number; outputTokens: number };
  steps: Array<{
    id: string; agentId: string; objective: string; dependsOn: string[];
    status: "pending" | "running" | "completed" | "failed" | "cancelled";
    output: string | null; failure: FailureCategory | null; failureDetail?: FailureDetail;
    startedAt: string | null; finishedAt: string | null;
  }>;
  routes: ModelRoutes | null;
  served: ServedModel[];
}
export interface Snapshot {
  sessionId: string;
  turns: Turn[];
  executions: Execution[];
  notices: Notice[];
  ui?: UiEvent;
  active: { turnId: string; executionId: string | null; draft?: string } | null;
}
export type ActionName = "pause" | "cancel" | "resume" | "approve";
export interface ExecutionAction { action: ActionName; revision: string; extension?: Extension }
export interface SendMessage { id: string; message: string; effort: Effort }
export interface VoiceAvailability { enabled: boolean; issue: string | null }
export interface SystemInfo {
  voice: VoiceAvailability;
  mode: "MOCK" | "LIVE";
  available: boolean;
  issue: string | null;
  models: ModelRoutes | null;
  effort: ExplicitEffort;
  demoCap: number | null;
}
export interface UsageWindow {
  hours: number;
  since: string;
  attempts: number;
  failed: number;
  unknownUsage: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}
export interface ApiError { error: { code: string; message: string } }

export const failureLabels: Record<FailureCategory, string> = {
  transport: "Não foi possível conectar ao provedor.",
  http: "O provedor recusou a solicitação.",
  api: "O modelo ou serviço está indisponível.",
  rate_limited: "O provedor atingiu o limite de requisições.",
  invalid_response: "A resposta recebida tem um formato inválido.",
  missing_content: "O modelo retornou uma resposta vazia.",
  incomplete: "A geração foi interrompida antes da conclusão.",
  timeout: "O tempo de execução se esgotou.",
  cancelled: "A solicitação foi cancelada.",
  budget_exceeded: "A solicitação excedeu o limite autorizado.",
  permission_denied: "A operação ou o modelo não foi autorizado.",
  agent_not_found: "O especialista solicitado não está disponível.",
  interrupted: "A execução foi interrompida.",
  internal_error: "O servidor não conseguiu concluir a solicitação.",
};



const failureDetails = {
  decision_json: "A decisão do MainAgent não veio em JSON válido.",
  decision_schema: "A decisão do MainAgent não corresponde ao formato esperado.",
  plan_invalid: "O plano recebido tem etapas, dependências ou especialistas inválidos.",
  context_limit: "A solicitação excedeu o contexto disponível para o modelo.",
  output_limit: "A geração atingiu o limite de saída antes de concluir.",
  content_filter: "O provedor interrompeu a geração pelo filtro de conteúdo.",
  tool_calls: "O provedor encerrou a geração solicitando ferramentas.",
  model_unavailable: "O modelo ou sua rota está indisponível no provedor.",
} as const;

export type FailureDetail = keyof typeof failureDetails;

export function isFailureDetail(value: unknown): value is FailureDetail {
  return typeof value === "string" && Object.hasOwn(failureDetails, value);
}

export function failureText(category: FailureCategory, detail?: FailureDetail): string {
  return detail ? failureDetails[detail] : failureLabels[category];
}
