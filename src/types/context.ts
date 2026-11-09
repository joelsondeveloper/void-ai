import type { ModelRoute } from "./model.js";

export interface AgentContext {
    executionId: string
    permissions: ReadonlySet<string>
    budgetLimit: number
    signal: AbortSignal
    metadata: Record<string, unknown>
    modelRoute?: ModelRoute
}
