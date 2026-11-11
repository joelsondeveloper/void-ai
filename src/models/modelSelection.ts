import type { ExplicitEffort } from "../governance/effort.js";
import { isFreeOpenRouterRoute } from "./costAuthorization.js";
import { isModelReasoning } from "./reasoning.js";
import type { ModelRoute, ModelRoutes } from "../types/model.js";

export const freeModelIds = {
  superVl: "nvidia/nemotron-3.5-super-vl:free",
  gemma: "google/gemma-4-26b-a4b-it:free",
  lightning: "nvidia/nemotron-3.5-lightning:free",
  dots: "dots-studio/dots-3-note-preview:free",
  ultra: "nvidia/nemotron-3-ultra-550b-a55b:free",
  north: "cohere/north-mini-code:free",
} as const;

export const freeFallbackModels = [freeModelIds.superVl, freeModelIds.dots, freeModelIds.gemma] as const;

type AgentRouteDefinition = { id: string; model?: { configKey: string; fallback: string } };

// Defaults for standalone callers that do not supply a channel registry.
const standaloneAgents = [
  { id: "dev-agent", model: { configKey: "DEV", fallback: freeModelIds.north } },
  { id: "research-agent", model: { configKey: "RESEARCH", fallback: freeModelIds.ultra } },
];

export function isModelLabel(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9_.:-]+(?:\/[a-z0-9_.:-]+)?$/i.test(value) && value.length <= 160;
}

function isRoute(value: unknown): value is ModelRoute {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  return Object.keys(route).every((key) => ["providerId", "model", "maxOutputTokens", "temperature", "reasoning"].includes(key)) &&
    isModelLabel(route.providerId) && isModelLabel(route.model) &&
    (route.maxOutputTokens === undefined || (typeof route.maxOutputTokens === "number" &&
      Number.isSafeInteger(route.maxOutputTokens) && route.maxOutputTokens > 0)) &&
    (route.temperature === undefined || (typeof route.temperature === "number" &&
      Number.isFinite(route.temperature) && route.temperature >= 0 && route.temperature <= 2)) &&
    (route.reasoning === undefined || isModelReasoning(route.reasoning, route.maxOutputTokens));
}

export function isModelRoutes(value: unknown): value is ModelRoutes {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const routes = value as Record<string, unknown>;
  return isRoute(routes.decision) && isRoute(routes.synthesis) &&
    Object.entries(routes).every(([key, value]) => isModelLabel(key) && isRoute(value));
}

export function selectOpenRouterRoutes(effort: ExplicitEffort, env: NodeJS.ProcessEnv, agents: readonly AgentRouteDefinition[] = standaloneAgents): ModelRoutes {
  if (!["low", "medium", "high", "max"].includes(effort)) throw new Error("Nível de esforço inválido.");
  const route = (role: string, fallback: string): ModelRoute => {
    const config = (field: string) => env[`VOID_${role}_${field}_${effort.toUpperCase()}`] ??
      env[`VOID_${role}_${field}`];
    const model = config("MODEL")?.trim() ?? fallback;
    const configuredOutput = config("MAX_OUTPUT_TOKENS");
    const maxOutputTokens = configuredOutput === undefined ? undefined : Number(configuredOutput);
    const reasoningMax = config("REASONING_MAX_TOKENS");
    const suppressReasoning = model === freeModelIds.ultra &&
      (role === "RESEARCH" || (role === "SYNTHESIS" && effort === "medium"));
    const requestedEffort = config("REASONING_EFFORT");
    const quickStructuredRoute = (role === "MAIN" || role === "SYNTHESIS") &&
      (model === freeModelIds.superVl || ((effort === "low" || effort === "medium") &&
        (model === freeModelIds.dots || model === freeModelIds.lightning)));
    const disableReasoning = quickStructuredRoute && requestedEffort === undefined && reasoningMax === undefined;
    const reasoningEffort = requestedEffort ??
      (suppressReasoning && reasoningMax === undefined ? "none" : undefined);
    const reasoningExclude = config("REASONING_EXCLUDE");
    const reasoning = {
      ...(disableReasoning ? { enabled: false } : {}),
      ...(reasoningEffort === undefined || reasoningEffort === "default" ? {} : { effort: reasoningEffort }),
      ...(reasoningMax === undefined ? {} : { maxTokens: Number(reasoningMax) }),
      ...(reasoningExclude === undefined ? {} : { exclude: reasoningExclude === "true" ? true
        : reasoningExclude === "false" ? false : reasoningExclude }),
    };
    const value = { providerId: "openrouter", model,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(Object.keys(reasoning).length === 0 ? {} : { reasoning }) };
    if (Object.keys(reasoning).length > 0 && !isModelReasoning(reasoning, maxOutputTokens)) {
      throw new Error(`Configuração de raciocínio inválida para VOID_${role}.`);
    }
    if (!isRoute(value)) throw new Error(`VOID_${role}_MAX_OUTPUT_TOKENS deve ser um inteiro positivo.`);
    return value;
  };
  const decision = route("MAIN", freeModelIds.superVl);
  return {
    decision,
    synthesis: route("SYNTHESIS", freeModelIds.superVl),
    ...Object.fromEntries(agents.flatMap(({ id, model }) => model
      ? [[id, route(model.configKey, model.fallback)]] : [])),
  };
}

export function liveModelRoutes(effort: ExplicitEffort, env: NodeJS.ProcessEnv = process.env, agents?: readonly AgentRouteDefinition[]): ModelRoutes {
  const routes = selectOpenRouterRoutes(effort, env, agents);
  for (const [role, route] of Object.entries(routes)) {
    if (!isFreeOpenRouterRoute(route.model)) {
      throw new Error(`A rota ${role} deve selecionar openrouter/free ou um modelo :free.`);
    }
  }
  return routes;
}
