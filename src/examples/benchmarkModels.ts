import type { MainAgent, MainMessage } from "../agents/MainAgent.js";
import type { ExplicitEffort } from "../governance/effort.js";
import type { OpenRouterDiagnostic } from "../models/providers/OpenRouterProvider.js";
import type { AgentContext } from "../types/context.js";
import type { ModelProvider } from "../types/model.js";
import { ExecutionError } from "../types/failure.js";

const directQuestion = "Explique em português brasileiro a diferença entre concorrência e paralelismo em programação. Dê um exemplo com um núcleo e outro com vários núcleos.";
const delegationQuestion = [
  "Responda em português brasileiro e delegue um plano de duas etapas.",
  "Primeiro, peça ao DevAgent uma análise em até 120 palavras desta função TypeScript que agrega medições de latência do cache, com um teste para lista vazia:",
  "function average(xs: number[]) { return xs.reduce((sum, x) => sum + x, 0) / xs.length; }",
  "Depois, peça ao ResearchAgent para comparar as evidências abaixo e explicar o cuidado com a agregação antes de concluir sobre latência. Essa etapa depende da análise do DevAgent.",
  "Fonte A: em um ensaio, a taxa de acerto do cache foi 90%. Fonte B: em outra carga, foi 60%.",
  "Inclua os dados e as porcentagens no objetivo da segunda etapa. Peça uma análise em até 120 palavras, separando fatos e inferências, sem pesquisa externa.",
].join(" ");

export function limitBenchmarkProvider(provider: ModelProvider, maxRequests: number,
  rateLimited: () => boolean): ModelProvider {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 5) throw new Error("Invalid benchmark call limit.");
  let attempts = 0;
  return {
    id: provider.id,
    async generate(request) {
      const stopped = rateLimited();
      if (stopped || attempts >= maxRequests) throw new ExecutionError({
        category: stopped ? "rate_limited" : "budget_exceeded",
        message: "O ensaio foi interrompido pela cota ou pelo limite de chamadas.", retryable: false,
      });
      attempts++;
      return provider.generate(request);
    },
  };
}

export async function runModelBenchmark(main: MainAgent, context: AgentContext, effort: ExplicitEffort,
  maxRequests: number, diagnostics: OpenRouterDiagnostic[], scenario: "both" | "delegated",
  communicationIssues: readonly string[]): Promise<void> {
  if (scenario === "both") {
    const directMessages: MainMessage[] = [];
    const direct = await main.run({ sessionId: "benchmark-direct", context, effort, message: directQuestion,
      limits: { calls: 1, concurrency: 1 } }, (event) => { directMessages.push(event); });
    const answer = directMessages.find(({ type }) => type === "final")?.text ?? "";
    const directChecks = {
      directDecision: direct.kind === "direct",
      distinguishesTerms: /concorr[êe]ncia/i.test(answer) && /paralelismo/i.test(answer) &&
        /simultan|mesmo tempo/i.test(answer) && /altern|intercal|progred/i.test(answer),
      coreExamples: /n[úu]cleo/i.test(answer) && /v[áa]rios|m[úu]ltiplos|dois|m[au]is de um/i.test(answer),
    };
    console.log(JSON.stringify({ scenario: "direct", checks: directChecks, messages: directMessages }));
    if (!Object.values(directChecks).every(Boolean)) {
      process.exitCode = 1;
      return;
    }
    if (maxRequests === 1) return;
  }

  const messages: MainMessage[] = [];
  const result = await main.run({ sessionId: "benchmark-plan", context, effort, message: delegationQuestion,
    limits: { calls: Math.min(maxRequests - (scenario === "both" ? 1 : 0), 4), concurrency: 1 } },
  (message) => {
    messages.push(message);
    console.log(JSON.stringify({ scenario: "delegated", event: message }));
  });
  const checkpoint = result.kind === "finished" || result.kind === "paused" ? result.checkpoint : undefined;
  const dev = checkpoint?.plan.find(({ agentId }) => agentId === "dev-agent");
  const research = checkpoint?.plan.find(({ agentId }) => agentId === "research-agent");
  const devOutput = checkpoint?.steps.find(({ stepId }) => stepId === dev?.id)?.output ?? "";
  const researchOutput = checkpoint?.steps.find(({ stepId }) => stepId === research?.id)?.output ?? "";
  const devProgress = messages.findIndex((event) => event.type === "progress" && event.agentId === "dev-agent" && /concluiu/.test(event.text));
  const researchProgress = messages.findIndex((event) => event.type === "progress" && event.agentId === "research-agent" && /concluiu/.test(event.text));
  const finalIndex = messages.findIndex(({ type }) => type === "final");
  const finalText = messages[finalIndex]?.text ?? "";
  const checks = {
    initialBeforeProgress: messages[0]?.type === "initial" && devProgress > 0,
    specialistsAndDependency: !!dev && !!research?.dependsOn.includes(dev.id),
    progressBeforeLastCompletion: devProgress >= 0 && researchProgress > devProgress && finalIndex > researchProgress,
    emptyArrayBug: /NaN|divis[aã]o por zero/i.test(devOutput) && /vazi[ao]|\[\]/i.test(devOutput),
    conflictingEvidence: /90\s*%/.test(researchOutput) && /60\s*%/.test(researchOutput),
    finalUsesBoth: /NaN|divis[aã]o por zero/i.test(finalText) && /90\s*%/.test(finalText) && /60\s*%/.test(finalText),
    synthesisValidated: (checkpoint?.servedModels?.some(({ role }) => role === "synthesis") ?? false) &&
      !communicationIssues.includes("synthesis"),
  };
  console.log(JSON.stringify({
    scenario: "delegated-summary", effort, status: checkpoint?.status ?? result.kind, checks,
    served: checkpoint?.servedModels, failures: checkpoint?.steps.flatMap(({ failure }) => failure ? [failure.category] : []),
    httpGenerations: diagnostics.filter(({ httpStatus }) => httpStatus !== undefined).length,
  }));
  if (result.kind !== "finished" || checkpoint?.status !== "completed" || !Object.values(checks).every(Boolean)) {
    process.exitCode = 1;
  }
}
