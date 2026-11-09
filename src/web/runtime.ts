import { setTimeout } from "node:timers/promises";
import { MainAgent } from "../agents/MainAgent.js";
import { DevAgent } from "../agents/DevAgent.js";
import { ResearchAgent } from "../agents/ResearchAgent.js";
import { SQLiteConversationStore } from "../conversation/ConversationStore.js";
import { SQLiteCheckpointStore } from "../governance/CheckpointStore.js";
import { ExecutionGovernance } from "../governance/ExecutionGovernance.js";
import { resolveEffort, type ExplicitEffort } from "../governance/effort.js";
import { logGeneration } from "../models/generationTrace.js";
import { ModelRouter } from "../models/ModelRouter.js";
import { freeFallbackModels, liveModelRoutes } from "../models/modelSelection.js";
import { OpenRouterFreeCatalog } from "../models/providers/OpenRouterFreeCatalog.js";
import { OpenRouterProvider } from "../models/providers/OpenRouterProvider.js";
import { AgentRegistry } from "../runtime/AgentRegistry.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import type { ModelProvider, ModelRoutes } from "../types/model.js";
import { UsageWindows } from "../governance/UsageWindows.js";
import type { SystemInfo } from "./contracts.js";
import { ProviderUsage } from "./provider-usage.js";
import { createAccountReader, emptyAccount } from "./provider-accounts.js";
import type { ProviderDashboard } from "./provider-contracts.js";
import { createVoiceService, voiceConfiguration } from "./voice.js";

export const mockProviderId = "web-demo";

function demoProvider(delay: number): ModelProvider {
  return {
    id: mockProviderId,
    async generate({ model, messages, signal }) {
      const input = messages.at(-1)?.content ?? "";
      const system = messages[0]?.content ?? "";
      if (delay) await setTimeout(delay, undefined, { signal });
      signal?.throwIfAborted();
      let content: string;
      if (system.startsWith("VOID_DECISION")) {
        content = JSON.stringify(/analis[ea]|compare|função|falha simulada/i.test(input) ? {
          mode: "delegate",
          steps: [
            { id: "A", agentId: "dev-agent", requiredCapability: "code-analysis", objective: input, dependsOn: [] },
            { id: "B", agentId: "research-agent", requiredCapability: "comparative-analysis", objective: input, dependsOn: ["A"] },
          ],
        } : {
          mode: "direct",
          response: /concorr[êe]ncia/i.test(input) && /paralelismo/i.test(input)
            ? "Concorrência é fazer várias tarefas progredirem no mesmo período, por exemplo, alternando entre elas em um único núcleo. Paralelismo é executá-las de fato ao mesmo tempo, por exemplo, usando dois núcleos."
            : "O modo simulado tem cenários fixos. Experimente perguntar sobre concorrência e paralelismo ou pedir uma análise com os especialistas.",
        });
      } else if (system.startsWith("VOID_SYNTHESIS")) {
        const { evidence }: { evidence: Record<string, string> } = JSON.parse(input);
        content = JSON.stringify({ answer: Object.values(evidence).join("\n\n"),
          sources: Object.fromEntries(Object.entries(evidence).map(([id, output]) => [id, output.slice(0, 120)])) });
      } else if (model === "research-local") {
        if (/falha simulada/i.test(input)) throw new Error("Simulated specialist failure");
        content = "Comparação simulada: validar a correção com casos-limite é mais rápido que refatorar a função inteira. A refatoração ganha valor se houver outros problemas recorrentes.";
      } else {
        content = "Análise simulada: defina o comportamento para entradas vazias e cubra esse caso com um teste. Verifique também se o retorno preserva o tipo esperado.";
      }
      return { model, content, usage: { inputTokens: 12, outputTokens: 20 } };
    },
  };
}

export function createWebRuntime(options: {
  filename: string; live?: boolean; key?: string; maxCalls?: number; mockDelay?: number; mock?: ModelProvider;
  voiceEnv?: NodeJS.ProcessEnv; accountFetch?: typeof fetch;
}) {
  const mode: SystemInfo["mode"] = options.live ? "LIVE" : "MOCK";
  const local = options.mock ?? demoProvider(options.mockDelay ?? 850);
  const usage = options.live ? new UsageWindows(options.filename) : undefined;
  const providerUsage = new ProviderUsage(options.filename);
  const voiceEnv = options.voiceEnv ?? {};
  const voiceConfig = voiceConfiguration(voiceEnv);
  const voiceEnabled = voiceEnv.VOID_ELEVENLABS_TTS === "1" && voiceConfig.valid;
  const account = createAccountReader({
    ...(options.key ? { openrouter: options.key } : {}),
    ...(voiceConfig.key ? { elevenlabs: voiceConfig.key } : {}),
  }, options.accountFetch);
  const voice = voiceEnabled ? createVoiceService(voiceEnv, fetch, Date.now, providerUsage) : undefined;
  const live = options.live && options.key
    ? new OpenRouterProvider(options.key, (event) => {
      logGeneration("provider", event);
      if (event.elapsedMs !== undefined) usage?.record(event.usage, event.failure !== undefined);
      providerUsage.openRouter(event);
    }, new OpenRouterFreeCatalog(), freeFallbackModels) : undefined;
  const provider = options.live ? live : local;
  const routes = (effort: ExplicitEffort): ModelRoutes => {
    if (options.live) return liveModelRoutes(effort);
    const route = (model: string) => ({ providerId: local.id, model, maxOutputTokens: 1600 });
    return { decision: route("main-local"), synthesis: route("main-local"),
      "dev-agent": route("dev-local"), "research-agent": route("research-local") };
  };
  const limits = options.maxCalls === undefined ? {} : { calls: options.maxCalls };
  resolveEffort("auto", limits);
  const router = new ModelRouter(provider ? [provider] : []);
  const registry = new AgentRegistry();
  const defaults = { providerId: options.live ? "openrouter" : local.id, model: options.live ? "openrouter/free" : "main-local" };
  registry.register(new DevAgent(router, defaults));
  registry.register(new ResearchAgent(router, defaults));
  const permissions = new Set(registry.list().flatMap(({ definition }) => definition.capabilities));
  const conversations = new SQLiteConversationStore(options.filename);
  const checkpoints = new SQLiteCheckpointStore(options.filename);
  const governance = new ExecutionGovernance(new AgentRuntime(registry), checkpoints, {
    trustedLocalProviders: options.live ? [] : [local.id],
  });
  const main = new MainAgent(router, registry, governance, conversations, { ...defaults, routesForEffort: routes });
  function providerDashboard(): ProviderDashboard {
    const at = Date.now();
    const routerAccount = emptyAccount(options.key ? "not_checked" : "not_configured", at);
    const voiceAccount = emptyAccount(voiceConfig.key ? "not_checked" : "not_configured", at);
    const configured = new Set<string>(freeFallbackModels);
    for (const effort of ["low", "medium", "high", "max"] as const) {
      try { for (const route of Object.values(liveModelRoutes(effort))) configured.add(route.model); }
      catch { /* Invalid route settings are already reported by system(). */ }
    }
    const since = providerUsage.since();
    const routerReport = providerUsage.report("openrouter", [...configured], since);
    const legacy = usage?.snapshot().find(({ hours }) => hours === 168);
    return {
      since, voiceLimits: providerUsage.voiceLimits(),
      legacy: legacy ? { attempts: Math.max(0, legacy.attempts - routerReport.totals.attempts),
        failed: Math.max(0, legacy.failed - routerReport.totals.failed) } : null,
      providers: [
        { provider: "openrouter", enabled: !!live, account: routerAccount, ...routerReport },
        { provider: "elevenlabs", enabled: voiceEnabled, account: voiceAccount,
          ...providerUsage.report("elevenlabs", voiceConfig.model ? [voiceConfig.model] : [], since) },
      ],
    };
  }
  return {
    main, conversations, permissions, limits, live: !!options.live, available: !!provider,
    usage: () => ({ mode: "observe", windows: usage?.snapshot() ?? [] }),
    voice,
    providerDashboard,
    async refreshProviderDashboard(): Promise<ProviderDashboard> {
      const dashboard = providerDashboard();
      await Promise.all(dashboard.providers.map(async (report) => {
        try { report.account = await account(report.provider); }
        catch { report.account = emptyAccount("unavailable", Date.now()); }
      }));
      return dashboard;
    },
    system(requested: Parameters<typeof resolveEffort>[0]): SystemInfo {
      const { effort } = governance.effortLimits(requested, limits);
      try {
        const models = routes(effort);
        return { mode, available: !!provider, issue: provider ? null : "Configure OPENROUTER_API_KEY no servidor para usar o modo LIVE.",
          models, effort, demoCap: mode === "MOCK" ? options.maxCalls ?? null : null };
      } catch {
        return { mode, available: false, issue: "A configuração dos modelos para este esforço é inválida ou inclui uma rota paga.",
          models: null, effort, demoCap: null };
      }
    },
    close() { conversations.close(); checkpoints.close(); usage?.close(); providerUsage.close(); },
  };
}

export type WebRuntime = ReturnType<typeof createWebRuntime>;
