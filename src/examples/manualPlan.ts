import { DevAgent } from "../agents/DevAgent.js";
import { ResearchAgent } from "../agents/ResearchAgent.js";
import { defaultAgentModel, type AgentModelConfig } from "../agents/generateAgentOutput.js";
import { ModelRouter } from "../models/ModelRouter.js";
import { OpenRouterFreeCatalog } from "../models/providers/OpenRouterFreeCatalog.js";
import { OpenRouterProvider } from "../models/providers/OpenRouterProvider.js";
import { createRuntimeStepRunner } from "../orchestration/RuntimeStepRunner.js";
import { AgentRegistry } from "../runtime/AgentRegistry.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { PlanExecutor } from "../runtime/PlanExecutor.js";
import type { AgentContext } from "../types/context.js";
import type { ModelProvider } from "../types/model.js";
import type { PlanStep } from "../types/plan.js";

const args = process.argv.slice(2);
const flags = new Set(args);
if (flags.size !== args.length || args.some((arg) => arg !== "--live" && arg !== "--diagnostics")) {
  throw new Error("Usage: npm run demo:plan [-- --diagnostics] or npm run demo:plan:live [-- --diagnostics]");
}
const live = flags.has("--live");

function liveConfig(agent: "DEV" | "RESEARCH", defaultLimit: number): AgentModelConfig {
  const prefix = `OPENROUTER_${agent}`;
  const model = process.env[`${prefix}_MODEL`]?.trim() ?? defaultAgentModel.model;
  if (model !== "openrouter/free" && !/^[a-z0-9_.-]+\/[a-z0-9_.-]+:free$/i.test(model)) {
    throw new Error(`${prefix}_MODEL must select openrouter/free or an explicit :free model.`);
  }
  const maxOutputTokens = Number(process.env[`${prefix}_MAX_OUTPUT_TOKENS`] ?? defaultLimit);
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 2048) {
    throw new Error(`${prefix}_MAX_OUTPUT_TOKENS must be an integer between 1 and 2048.`);
  }
  return { providerId: defaultAgentModel.providerId, model, maxOutputTokens };
}

const localResponses = new Map([
  ["dev-demo", "Simulação: trate a lista vazia antes de dividir para evitar NaN."],
  ["research-demo", "Simulação: TTL curto favorece atualização; TTL longo reduz leituras. Meça ambos com tráfego representativo."],
]);
let provider: ModelProvider = {
  id: "demo-local",
  async generate({ model, signal }) {
    signal?.throwIfAborted();
    const content = localResponses.get(model);
    if (content === undefined) {
      throw new Error(`Modelo local desconhecido: ${model}`);
    }
    return { content, model };
  },
};

if (live) {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) {
    throw new Error("OPENROUTER_API_KEY é obrigatória para --live.");
  }
  provider = new OpenRouterProvider(
    key,
    flags.has("--diagnostics")
      ? (event) => console.error(`OpenRouter diagnostic: ${JSON.stringify(event)}`)
      : undefined,
    new OpenRouterFreeCatalog(),
  );
}

const router = new ModelRouter([provider]);
const devConfig = live ? liveConfig("DEV", 900) : { providerId: provider.id, model: "dev-demo" };
const researchConfig = live ? liveConfig("RESEARCH", 800) : { providerId: provider.id, model: "research-demo" };
const dev = new DevAgent(router, devConfig);
const research = new ResearchAgent(router, researchConfig);

const registry = new AgentRegistry();
registry.register(dev);
registry.register(research);

const context: AgentContext = {
  executionId: crypto.randomUUID(),
  permissions: new Set(),
  budgetLimit: 0,
  signal: AbortSignal.timeout(30_000),
  metadata: {
    researchNotes: "Os dados mudam a cada minuto. Leituras ao banco têm custo alto. Ainda não há medições de tráfego.",
  },
};
const steps: PlanStep[] = [
  {
    id: "A",
    agentId: dev.definition.id,
    objective: "Em até 80 palavras, revise a função e sugira dois casos de teste, sem escrever a suíte: function media(xs: number[]) { return xs.reduce((s, x) => s + x, 0) / xs.length; }",
    dependsOn: [],
  },
  {
    id: "B",
    agentId: research.definition.id,
    objective: "Em até 80 palavras, compare TTL de cache de 30 segundos e de 5 minutos com base nas notas e indique o que medir.",
    dependsOn: [],
  },
];

const runner = createRuntimeStepRunner(new AgentRuntime(registry), context);
const executions = await new PlanExecutor().executePlan(steps, runner, 2);
const results = [...executions.values()].map(({ stepId, status, output, error }) => ({
  stepId,
  status,
  output,
  error,
}));
console.log(JSON.stringify({
  provider: provider.id,
  models: { [dev.definition.id]: devConfig.model, [research.definition.id]: researchConfig.model },
  results,
}, null, 2));
if (results.some(({ status }) => status !== "completed")) {
  process.exitCode = 1;
}
