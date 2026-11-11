import type { AgentRegistry } from "../runtime/AgentRegistry.js";
import { ExecutionError } from "../types/failure.js";
import type { PlanStep } from "../types/plan.js";
import { parseModelJson } from "./parseModelJson.js";

import { isDisplaySchema, isRenderToolCall, isWindowToolCall, type BuiltinWindow, type DisplaySchema, type RenderToolCall, type LocalUiToolCall } from "../web/ui-contracts.js";

export type MainDecision = { mode: "tool"; call: LocalUiToolCall | RenderToolCall | { name: string; arguments: unknown } } | { mode: "display"; schema: DisplaySchema } | { mode: "direct"; response: string } | { mode: "delegate"; steps: PlanStep[] } | { mode: "ignore" };

function invalid(message: string, code = "decision_schema"): never {
  throw new ExecutionError({ category: "invalid_response", code, message, retryable: false });
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const hasOnly = (record: Record<string, unknown>, keys: string[]) =>
  Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(value);

export function parseDecision(content: unknown, stepLimit: number, allowIgnore = false, allowDisplay = false, windows: readonly BuiltinWindow[] = [], allowRender = false, acceptsTool?: (value: unknown) => boolean): MainDecision {
  if (typeof content !== "string") invalid("A decisão do modelo é inválida.");
  let value: unknown;
  try { value = parseModelJson(content); }
  catch { invalid("O modelo não retornou uma decisão em JSON válido.", "decision_json"); }

  if (!isRecord(value)) invalid("A decisão do modelo é inválida.");
  if (acceptsTool && content.length <= 16_000 && value.mode === "tool" && hasOnly(value, ["mode", "call"]) && acceptsTool(value.call)) {
    return { mode: "tool", call: value.call as { name: string; arguments: unknown } | { name: string; arguments: unknown } };
  }
  if (allowDisplay && content.length <= 16_000 && value.mode === "display" &&
      hasOnly(value, ["mode", "schema"]) && isDisplaySchema(value.schema)) {
    return { mode: "display", schema: value.schema };
  }
  if (value.mode === "tool" && hasOnly(value, ["mode", "call"]) && isWindowToolCall(value.call) &&
      windows.includes(value.call.arguments.component)) {
    return { mode: "tool", call: value.call };
  }
  if (allowRender && content.length <= 16_000 && value.mode === "tool" &&
      hasOnly(value, ["mode", "call"]) && isRenderToolCall(value.call)) {
    return { mode: "tool", call: value.call };
  }
  if (allowIgnore && value.mode === "ignore" && hasOnly(value, ["mode"])) return { mode: "ignore" };
  if (value.mode === "direct" && hasOnly(value, ["mode", "response"]) &&
      typeof value.response === "string" && value.response.trim()) {
    return { mode: "direct", response: value.response };
  }
  if (content.length > 64_000 || value.mode !== "delegate" || !hasOnly(value, ["mode", "steps"]) ||
      !Array.isArray(value.steps) || value.steps.length === 0) {
    invalid("A decisão do modelo não corresponde ao formato esperado.");
  }
  if (value.steps.length > stepLimit) {
    throw new ExecutionError({ category: "budget_exceeded", message: "O plano excede o limite autorizado de etapas.", retryable: false });
  }

  const steps = (value.steps as unknown[]).map((step, index): PlanStep => {
    const label = `A etapa ${index + 1}`;
    if (!isRecord(step) || !hasOnly(step, ["id", "agentId", "objective", "dependsOn", "requiredCapability"])) {
      invalid(`${label} tem campos ausentes ou não permitidos.`, "plan_invalid");
    }
    if (!identifier(step.id) || !identifier(step.agentId) || !identifier(step.requiredCapability)) {
      invalid(`${label} precisa de IDs e capacidade como texto válido.`, "plan_invalid");
    }
    if (typeof step.objective !== "string" || !step.objective.trim() || step.objective.length > 6000) {
      invalid(`${label} tem um objetivo inválido.`, "plan_invalid");
    }
    if (
        !Array.isArray(step.dependsOn) || step.dependsOn.length > stepLimit ||
        !step.dependsOn.every(identifier) || new Set(step.dependsOn).size !== step.dependsOn.length) {
      invalid(`${label} tem dependências inválidas.`, "plan_invalid");
    }
    return { id: step.id, agentId: step.agentId, requiredCapability: step.requiredCapability,
      objective: step.objective, dependsOn: [...step.dependsOn] };
  });
  return { mode: "delegate", steps };
}

export function validateDelegations(
  steps: readonly PlanStep[], agents: AgentRegistry, permissions: ReadonlySet<string>,
): void {
  for (const step of steps) {
    const agent = agents.get(step.agentId);
    if (!agent) invalid("O plano contém um especialista indisponível.", "plan_invalid");
    const capability = step.requiredCapability;
    if (!capability || !agent.definition.capabilities.includes(capability)) {
      invalid("A capacidade solicitada não existe para o especialista selecionado.", "plan_invalid");
    }
    if (!permissions.has(capability)) {
      throw new ExecutionError({ category: "permission_denied",
        message: "O plano solicita uma capacidade sem autorização.", retryable: false });
    }
  }
}
