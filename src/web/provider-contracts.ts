export type ProviderId = "openrouter" | "elevenlabs";
export type QuotaStatus = "normal" | "near" | "exhausted" | "unknown";
export type LimitSignal = "quota" | "rate";
export type AccountIssue = "not_checked" | "not_configured" | "permission" | "rate" | "network" | "timeout" | "invalid_response" | "unavailable";

export interface Quota {
  used: number | null;
  limit: number | null;
  remaining: number | null;
  window: string | null;
  resetsAt: number | null;
  status: QuotaStatus;
}

export type Account = {
  checkedAt: number;
  httpStatus: number | null;
  issue: AccountIssue | null;
  quota: Quota | null;
  freeRequests: Quota | null;
  errorCode: "missing_permissions" | null;
  spend: { amount: number; currency: string; scope: "key" | "overage" } | null;
  dailySpend: number | null;
  freeTier: boolean | null;
};

export interface ProviderTotals {
  attempts: number;
  failed: number;
  pending: number;
  inputTokens: number | null;
  outputTokens: number | null;
  tokenReports: number;
  characters: number | null;
  credits: number | null;
  creditReports: number;
  costUsd: number | null;
  costReports: number;
}

export interface ProviderModel extends ProviderTotals {
  model: string;
  limitEvent: { kind: LimitSignal; at: number; retryAt: number | null; httpStatus: number | null; apiCode: number | null;
    evidence?: import("../models/providers/openRouterLimits.js").OpenRouterLimitEvidence } | null;
}

export interface ProviderReport {
  provider: ProviderId;
  enabled: boolean;
  totals: ProviderTotals;
  models: ProviderModel[];
  account: Account;
}

export interface ProviderDashboard {
  since: number;
  providers: ProviderReport[];
  legacy: { attempts: number; failed: number } | null;
  voiceLimits: { daily: Quota; minute: Quota; perResponse: number; concurrent: number; retryAt: number | null };
}

export function quota(used: number | null, limit: number | null, remaining: number | null,
  window: string | null, resetsAt: number | null): Quota {
  const status = limit === null || remaining === null ? "unknown"
    : remaining === 0 ? "exhausted" : remaining <= limit * 0.2 ? "near" : "normal";
  return { used, limit, remaining, window, resetsAt, status };
}
