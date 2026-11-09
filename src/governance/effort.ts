export type ExplicitEffort = "low" | "medium" | "high" | "max";
export type Effort = ExplicitEffort | "auto";

export interface ExecutionLimits {
  calls: number;
  steps: number;
  concurrency: number;
  warnAfterMs: number;
  pauseAfterMs?: number;
  outputTokens?: number;
}

export const safetyCaps = Object.freeze({ calls: 1000, steps: 1000, concurrency: 32, milliseconds: 86_400_000, outputTokens: 10_000_000 });

const profiles: Record<ExplicitEffort, ExecutionLimits> = {
  low: { calls: 5, steps: 4, concurrency: 2, warnAfterMs: 120_000 },
  medium: { calls: 15, steps: 12, concurrency: 3, warnAfterMs: 420_000 },
  high: { calls: 30, steps: 25, concurrency: 3, warnAfterMs: 900_000 },
  max: { calls: 60, steps: 40, concurrency: 4, warnAfterMs: 1_800_000 },
};

export function positiveInteger(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
}

export function validateLimits(limits: ExecutionLimits): void {
  if (!positiveInteger(limits.calls, safetyCaps.calls) ||
      !positiveInteger(limits.steps, safetyCaps.steps) ||
      !positiveInteger(limits.concurrency, safetyCaps.concurrency) ||
      !positiveInteger(limits.warnAfterMs, safetyCaps.milliseconds) ||
      (limits.pauseAfterMs !== undefined && !positiveInteger(limits.pauseAfterMs, safetyCaps.milliseconds)) ||
      (limits.outputTokens !== undefined && !positiveInteger(limits.outputTokens, safetyCaps.outputTokens))) {
    throw new Error("Invalid execution limits.");
  }
}

export function resolveEffort(
  effort: Effort = "auto", overrides: Partial<ExecutionLimits> = {}, auto: ExplicitEffort = "low",
): { effort: ExplicitEffort; limits: ExecutionLimits } {
  const resolved = effort === "auto" ? auto : effort;
  if (!Object.hasOwn(profiles, resolved)) throw new Error("Invalid effort level.");
  const limits = { ...profiles[resolved], ...overrides };
  validateLimits(limits);
  return { effort: resolved, limits };
}
