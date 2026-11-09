import { ResearchAgent } from "../agents/ResearchAgent.js";
import { SQLiteCheckpointStore } from "../governance/CheckpointStore.js";
import { ExecutionGovernance } from "../governance/ExecutionGovernance.js";
import { ModelRouter } from "../models/ModelRouter.js";
import { freeModelIds, liveModelRoutes } from "../models/modelSelection.js";
import { OpenRouterFreeCatalog } from "../models/providers/OpenRouterFreeCatalog.js";
import { OpenRouterProvider, type OpenRouterDiagnostic } from "../models/providers/OpenRouterProvider.js";
import { AgentRegistry } from "../runtime/AgentRegistry.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import type { AgentContext } from "../types/context.js";
import type { ModelRoute } from "../types/model.js";
import { limitBenchmarkProvider } from "./benchmarkModels.js";

const key = process.env.OPENROUTER_API_KEY?.trim();
if (!key) throw new Error("OPENROUTER_API_KEY é obrigatória para este ensaio.");
const candidates: readonly ModelRoute[] = [
  { providerId: "openrouter", model: freeModelIds.dots, maxOutputTokens: 3200 },
  { providerId: "openrouter", model: freeModelIds.ultra, maxOutputTokens: 3200, reasoning: { effort: "none" } },
];
const catalog = new OpenRouterFreeCatalog();
await Promise.all(candidates.map(({ model, reasoning }) => catalog.assertFree(model, undefined, reasoning)));
console.log(JSON.stringify({ benchmark: "research", maximumRequests: 2, verifiedPrice: "USD 0", candidates,
  criteria: ["90% e 60%", "comparação", "fatos e inferência", "limitações da evidência", "sem alegação de pesquisa web"] }));

const diagnostics: OpenRouterDiagnostic[] = [];
const provider = new OpenRouterProvider(key, (event) => { diagnostics.push(event); }, catalog);
const bounded = limitBenchmarkProvider(provider, candidates.length, () => diagnostics.some(({ httpStatus }) => httpStatus === 429));
const router = new ModelRouter([bounded]);
const registry = new AgentRegistry();
registry.register(new ResearchAgent(router));
const store = new SQLiteCheckpointStore(":memory:");
const governance = new ExecutionGovernance(new AgentRuntime(registry), store);
const context: AgentContext = {
  executionId: "research-benchmark", permissions: new Set(), budgetLimit: 0,
  signal: AbortSignal.timeout(150_000), metadata: {
    researchNotes: "Fonte A: o cache teve 90% de acertos em 100 leituras durante carga estável. Fonte B: o cache teve 60% de acertos em 100 leituras durante carga com escritas frequentes. Nenhuma fonte mediu latência.",
  },
};
try {
  let succeeded = false;
  for (const route of candidates) {
    const before = diagnostics.length;
    const checkpoint = await governance.start({
      effort: "medium", limits: { calls: 1, steps: 1, concurrency: 1 }, context,
      modelRoutes: { ...liveModelRoutes("medium", {}), "research-agent": route },
      plan: [{ id: "research", agentId: "research-agent", dependsOn: [],
        objective: "Em português brasileiro e até 120 palavras, compare os dois resultados. Identifique a divergência, separe fatos de inferências, indique uma limitação e o que medir a seguir. Use somente as notas fornecidas." }],
    });
    const step = checkpoint.steps[0];
    const output = step?.output ?? "";
    const checks = {
      completed: step?.status === "completed",
      bothRates: /90\s*%/.test(output) && /60\s*%/.test(output),
      separatesFactsAndInference: /fato/i.test(output) && /infer[êe]ncia/i.test(output),
      limitation: /lat[êe]ncia|limita[çc][ãa]o/i.test(output),
      noWebClaim: !/pesquisei|consultei (a internet|a web)|https?:\/\//i.test(output),
    };
    succeeded ||= Object.values(checks).every(Boolean);
    console.log(JSON.stringify({ model: route.model, requestedReasoning: route.reasoning ?? null,
      calls: checkpoint.usage.callsStarted, checks, metrics: diagnostics.slice(before), output: step?.output, failure: step?.failure }));
    if (diagnostics.some(({ httpStatus }) => httpStatus === 429)) break;
  }
  if (!succeeded) process.exitCode = 1;
} finally {
  store.close();
}
