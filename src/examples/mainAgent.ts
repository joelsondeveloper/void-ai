import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setImmediate } from "node:timers/promises";
import { DevAgent } from "../agents/DevAgent.js";
import { MainAgent, type MainMessage, type MainResult } from "../agents/MainAgent.js";
import { ResearchAgent } from "../agents/ResearchAgent.js";
import { SQLiteConversationStore } from "../conversation/ConversationStore.js";
import { SQLiteCheckpointStore } from "../governance/CheckpointStore.js";
import { ExecutionGovernance } from "../governance/ExecutionGovernance.js";
import type { Extension } from "../governance/checkpoint.js";
import { resolveEffort, type Effort } from "../governance/effort.js";
import { isFreeOpenRouterRoute } from "../models/costAuthorization.js";
import { logGeneration } from "../models/generationTrace.js";
import { ModelRouter } from "../models/ModelRouter.js";
import { freeFallbackModels, liveModelRoutes } from "../models/modelSelection.js";
import { OpenRouterFreeCatalog } from "../models/providers/OpenRouterFreeCatalog.js";
import { OpenRouterProvider, type OpenRouterDiagnostic } from "../models/providers/OpenRouterProvider.js";
import { AgentRegistry } from "../runtime/AgentRegistry.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import type { AgentContext } from "../types/context.js";
import type { ModelProvider, ModelRoutes } from "../types/model.js";
import { limitBenchmarkProvider, runModelBenchmark } from "./benchmarkModels.js";

const flags = process.argv.slice(2);
const promptFlag = flags.indexOf("--prompt-file");
const promptFile = promptFlag === -1 ? undefined : flags.splice(promptFlag, 2)[1];
const benchmark = flags.length === 1 && flags[0] === "--benchmark";
const live = benchmark || (flags.length === 1 && flags[0] === "--live");
const demo = flags.length === 1 && flags[0] === "--demo";
const mock = flags.length === 1 && flags[0] === "--mock";
if ((flags.length && !live && !demo && !mock) ||
    (promptFlag !== -1 && (!promptFile || benchmark || demo))) {
  throw new Error("Usage: chat:void [--mock|--live|--demo|--benchmark] [--prompt-file path]");
}
const mode = live ? "live" : "mock";

const local: ModelProvider = {
  id: "main-demo",
  async generate({ model, messages, signal }) {
    signal?.throwIfAborted();
    const objective = messages.at(-1)?.content ?? "";
    const system = messages[0]?.content ?? "";
    let content: string;
    if (system.startsWith("VOID_DECISION")) {
      content = JSON.stringify(/analise|compare|função|falha/i.test(objective) ? {
        mode: "delegate",
        steps: [
          { id: "A", agentId: "dev-agent", requiredCapability: "code-analysis", objective, dependsOn: [] },
          { id: "B", agentId: "research-agent", requiredCapability: "comparative-analysis", objective, dependsOn: [] },
        ],
      } : {
        mode: "direct",
        response: /concorr[êe]ncia/i.test(objective) && /paralelismo/i.test(objective)
          ? "Concorrência é fazer tarefas progredirem no mesmo período, inclusive alternando entre elas em um núcleo. Paralelismo é executar tarefas simultaneamente, por exemplo, em dois núcleos."
          : "O modo simulado não tem uma resposta para essa pergunta. Para conversar com um modelo real, inicie npm run chat:void:live.",
      });
    } else if (system.startsWith("VOID_SYNTHESIS")) {
      const { evidence }: { evidence: Record<string, string> } = JSON.parse(objective);
      content = JSON.stringify({ answer: Object.values(evidence).join("\n\n"),
        sources: Object.fromEntries(Object.entries(evidence).map(([id, output]) => [id, output.slice(0, 120)])) });
    } else if (model === "research-local") {
      await setImmediate(undefined, { signal });
      if (/falha simulada/i.test(objective)) throw new Error("Simulated specialist failure.");
      content = "Comparação local simulada. Uma mudança pequena facilita validar o impacto antes de uma refatoração.";
    } else {
      content = "Análise local simulada. Teste o caso limite antes de alterar a função.";
    }
    return { model, content, usage: { inputTokens: 12, outputTokens: 20 } };
  },
};

const maxRequests = benchmark ? Number(process.env.VOID_BENCH_MAX_CALLS ?? 5) : 0;
const benchmarkScenario = benchmark ? (process.env.VOID_BENCH_SCENARIO ?? "both") : "both";
if (benchmarkScenario !== "both" && benchmarkScenario !== "delegated") {
  throw new Error("VOID_BENCH_SCENARIO deve ser both ou delegated.");
}
if (benchmark && (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 5)) {
  throw new Error("VOID_BENCH_MAX_CALLS deve ser um inteiro entre 1 e 5.");
}
const diagnostics: OpenRouterDiagnostic[] = [];
const communicationIssues: string[] = [];
const catalog = live ? new OpenRouterFreeCatalog() : undefined;
let rateLimited = false;
let provider: ModelProvider = local;
if (live) {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  if (!key) throw new Error("OPENROUTER_API_KEY é obrigatória no modo real.");
  const openRouter = new OpenRouterProvider(key, (event) => {
    if (benchmark) {
      diagnostics.push(event);
      if (event.httpStatus === 429 || event.apiErrorType === "rate_limit_exceeded") rateLimited = true;
      console.error(JSON.stringify({ benchmark: "model", ...event }));
    } else if (process.env.VOID_GENERATION_DIAGNOSTICS === "1") {
      logGeneration("provider", event);
    } else {
      console.error(`VOID [live model] ${event.requestedModel ?? "?"} → ${event.returnedModel ?? "indisponível"}` +
        (event.finishReason ? ` (${event.finishReason})` : ""));
    }
  }, catalog, benchmark ? [] : freeFallbackModels);
  provider = benchmark ? limitBenchmarkProvider(openRouter, maxRequests, () => rateLimited) : openRouter;
}
function selectModel(environment: string, fallback: string): string {
  if (!live) return fallback;
  const model = process.env[environment]?.trim() || "openrouter/free";
  if (!isFreeOpenRouterRoute(model)) throw new Error(`${environment} deve selecionar um modelo gratuito.`);
  return model;
}
const router = new ModelRouter([provider]);
const registry = new AgentRegistry();
registry.register(new DevAgent(router, {
  providerId: provider.id, model: selectModel("VOID_DEV_MODEL", "dev-local"), maxOutputTokens: 900,
}));
registry.register(new ResearchAgent(router, {
  providerId: provider.id, model: selectModel("VOID_RESEARCH_MODEL", "research-local"), maxOutputTokens: 800,
}));
const permissions = new Set(registry.list().flatMap(({ definition }) => definition.capabilities));
let effort = (process.env.VOID_EFFORT ?? "auto") as Effort;
const initialLimits = !demo && !benchmark && process.env.VOID_CHAT_MAX_CALLS !== undefined
  ? { calls: Number(process.env.VOID_CHAT_MAX_CALLS) } : {};
const resolved = resolveEffort(effort, initialLimits);
function routesForEffort(level: typeof resolved.effort): ModelRoutes {
  if (live) return liveModelRoutes(level, process.env, registry.list().map(({ definition }) => definition));
  const route = (model: string) => ({ providerId: local.id, model, maxOutputTokens: 1600 });
  return { decision: route("main-local"), synthesis: route("main-local"),
    ...Object.fromEntries(registry.list().flatMap(({ definition: { id, model } }) =>
      model ? [[id, route(model.configKey.toLowerCase() + "-local")]] : [])) };
}
const selectedRoutes = routesForEffort(resolved.effort);
const filename = demo || benchmark || promptFile ? ":memory:" : process.env.VOID_CHAT_DB ??
  (live ? "void-chat-live.sqlite" : "void-chat.sqlite");
const sessionId = demo ? "demo" : process.env.VOID_CHAT_SESSION ?? "terminal";
const checkpoints = new SQLiteCheckpointStore(filename);
const conversations = new SQLiteConversationStore(filename);
const governance = new ExecutionGovernance(new AgentRuntime(registry), checkpoints, {
  trustedLocalProviders: live ? [] : [local.id],
});
const main = new MainAgent(router, registry, governance, conversations, {
  providerId: provider.id, model: selectModel("VOID_MAIN_MODEL", "main-local"), effort, routesForEffort,
  onCommunicationIssue: (kind) => {
    if (benchmark) communicationIssues.push(kind);
    console.error(`VOID [communication] ${kind}`);
  },
});

function context(signal = new AbortController().signal): AgentContext {
  return { executionId: sessionId, permissions, budgetLimit: 0, signal, metadata: {} };
}

function print(message: MainMessage): void {
  console.log(`VOID [${mode}] [${message.type}] ${message.text}`);
  if (message.type === "approval_required") {
    console.log(`  ID ${message.executionId} · ações ${message.actions.join(", ")}`);
  }
}

async function scriptedDemo(): Promise<void> {
  const direct = await main.run({ sessionId, message: "Qual a diferença entre concorrência e paralelismo?", context: context() }, print);
  const delegated = await main.run({ sessionId, message: "Analise esta função e compare estratégias.", context: context() }, print);
  const paused = await main.run({ sessionId, message: "Analise esta função com orçamento reduzido.",
    context: context(), limits: { calls: 2, concurrency: 1 } }, print);
  if (direct.kind !== "direct" || delegated.kind !== "finished" || delegated.checkpoint.status !== "completed" ||
      paused.kind !== "paused") throw new Error("A demonstração não atingiu os estados esperados.");
  const id = paused.checkpoint.id;
  console.log(main.partial(sessionId, id).text);
  const resumed = await main.resume(sessionId, id, context(), { calls: 2 }, print);
  const failed = await main.run({ sessionId, message: "Analise esta função e inclua uma falha simulada.",
    context: context() }, print);
  if (resumed.kind !== "finished" || resumed.checkpoint.status !== "completed" ||
      failed.kind !== "finished" || failed.checkpoint.status !== "failed") {
    throw new Error("A demonstração não comprovou retomada e falha parcial.");
  }
}

function extension(args: string[]): Extension {
  const result: Extension = {};
  for (const arg of args) {
    const match = /^(calls|steps|timeMs|outputTokens)=(\d+)$/.exec(arg);
    const key = match?.[1] as keyof Extension | undefined;
    const value = Number(match?.[2]);
    if (!key || Object.hasOwn(result, key) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error("Use /approve calls=1 steps=1 timeMs=1000 outputTokens=500, conforme necessário.");
    }
    result[key] = value;
  }
  return result;
}

async function interactive(): Promise<void> {
  const input = createInterface({ input: process.stdin, output: process.stdout, prompt: "Você > " });
  let selected = main.pending(sessionId)[0];
  let active: { result: Promise<MainResult>; controller: AbortController; executionId?: string } | undefined;
  const sink = (message: MainMessage) => {
    if (message.executionId) {
      selected = message.executionId;
      if (active) active.executionId = message.executionId;
    }
    print(message);
  };
  const launch = (run: (signal: AbortSignal) => Promise<MainResult>, executionId?: string) => {
    if (active) throw new Error("Já existe uma solicitação em andamento nesta sessão.");
    const controller = new AbortController();
    const current = { controller, result: run(controller.signal), ...(executionId ? { executionId } : {}) };
    active = current;
    void current.result.then(() => { if (active === current) active = undefined; });
  };
  const selectedId = (): string => {
    if (!selected) throw new Error("Nenhuma execução selecionada. Use /pending e /use ID.");
    return selected;
  };

  console.log(live ? "VOID LIVE · OpenRouter gratuito. Não envie dados pessoais ou confidenciais."
    : "VOID MOCK · Respostas simuladas. Para usar IA real, rode npm run chat:void:live.");
  console.log("Digite uma mensagem ou /help.");
  input.prompt();
  for await (const line of input) {
    const text = line.trim();
    try {
      if (text.startsWith("/")) {
        const [command, ...args] = text.split(/\s+/);
        switch (command) {
          case "/quit": input.close(); active?.controller.abort(); break;
          case "/help": console.log("/mode · /effort [nível] · /models · /pending · /use ID · /partial · /pause · /resume · /approve calls=1 · /cancel · /quit"); break;
          case "/mode": console.log(`Modo ${mode.toUpperCase()} · provedor ${provider.id}`); break;
          case "/effort": {
            const next = (args[0] ?? effort) as Effort;
            const policy = governance.effortLimits(next, initialLimits);
            routesForEffort(policy.effort);
            effort = next;
            console.log(JSON.stringify({ selected: effort, ...policy }));
            break;
          }
          case "/models": {
            const policy = governance.effortLimits(effort, initialLimits);
            console.log(JSON.stringify({ mode, effort: policy.effort, routes: routesForEffort(policy.effort) }, null, 2));
            if (selected) {
              const checkpoint = main.partial(sessionId, selected).checkpoint;
              console.log(JSON.stringify({ executionId: selected, routes: checkpoint.modelRoutes,
                served: checkpoint.servedModels }, null, 2));
            }
            break;
          }
          case "/pending": console.log(main.pending(sessionId).join("\n") || "Nenhuma execução pendente."); break;
          case "/use": {
            const id = args[0];
            if (!id) throw new Error("Use /use ID.");
            console.log(main.partial(sessionId, id).text);
            selected = id;
            break;
          }
          case "/partial": console.log(main.partial(sessionId, selectedId()).text); break;
          case "/pause": main.pause(sessionId, selectedId()); break;
          case "/resume":
          case "/approve": {
            const id = selectedId();
            const approved = command === "/approve" ? extension(args) : {};
            launch((signal) => main.resume(sessionId, id, context(signal), approved, sink), id);
            break;
          }
          case "/cancel":
            if (active && !active.executionId) active.controller.abort();
            else console.log(main.cancel(sessionId, active?.executionId ?? selectedId()));
            break;
          default: console.log("Comando desconhecido. Use /help.");
        }
        if (command === "/quit") break;
      } else if (text) {
        launch((signal) => main.run({ sessionId, message: text, context: context(signal), effort, limits: initialLimits }, sink));
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Operação indisponível.");
    }
    input.prompt();
  }
  await active?.result;
}

try {
  if (benchmark) {
    const models = [...new Set(Object.values(selectedRoutes).map(({ model }) => model))];
    await Promise.all(Object.values(selectedRoutes).map(({ model, reasoning }) => catalog?.assertFree(model, undefined, reasoning)));
    console.log(JSON.stringify({ benchmark: "preflight", scenario: benchmarkScenario, effort: resolved.effort, models, routes: selectedRoutes,
      maximumRequests: maxRequests, verifiedPrice: "USD 0", criteria: "direct Portuguese answer, valid JSON plan, DAG, progressive events, grounded synthesis" }));
    await runModelBenchmark(main, context(), resolved.effort, maxRequests, diagnostics, benchmarkScenario, communicationIssues);
  } else if (promptFile) {
    const result = await main.run({ sessionId, message: await readFile(promptFile, "utf8"),
      context: context(), effort, limits: initialLimits }, print);
    if (result.kind === "error" || (result.kind === "finished" && result.checkpoint.status !== "completed")) process.exitCode = 1;
  } else if (demo) await scriptedDemo();
  else await interactive();
} finally {
  conversations.close();
  checkpoints.close();
}
