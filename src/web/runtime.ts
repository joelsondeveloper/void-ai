import { demoProvider } from "./demo-provider.js";
import { MainAgent } from "../agents/MainAgent.js";
import { AgentRenderer } from "../agents/AgentRenderer.js";
import { DevAgent } from "../agents/DevAgent.js";
import { ResearchAgent } from "../agents/ResearchAgent.js";
import { SQLiteConversationStore } from "../conversation/ConversationStore.js";
import { SQLiteMemoryStore } from "../conversation/MemoryStore.js";
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

import { UiRuntimeService } from "./ui-runtime.js";
import { ComponentRegistry } from "./ComponentRegistry.js";
import { previewPermission } from "./render-contracts.js";

export { mockProviderId } from "./demo-provider.js";

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
  const voiceAllowed = voiceEnv.VOID_ELEVENLABS_TTS?.trim() === "1";
  const voiceEnabled = voiceAllowed && voiceConfig.valid;
  const voiceStatus = { enabled: voiceEnabled, issue: voiceEnabled ? null : voiceAllowed
    ? "Confira a chave, o ID da voz e o modelo da ElevenLabs no servidor."
    : "ElevenLabs desativada no servidor. Para usar a síntese externa, configure VOID_ELEVENLABS_TTS=1." };
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
    const definitions = registry.list().map(({ definition }) => definition);
    if (options.live) return liveModelRoutes(effort, process.env, definitions);
    const route = (model: string) => ({ providerId: local.id, model, maxOutputTokens: 1600 });
    return { decision: route("main-local"), synthesis: route("main-local"),
      ...Object.fromEntries(definitions.flatMap(({ id, model }) => model ? [[id, route(model.configKey.toLowerCase() + "-local")]] : [])) };
  };
  const limits = options.maxCalls === undefined ? {} : { calls: options.maxCalls };
  resolveEffort("auto", limits);
  const router = new ModelRouter(provider ? [provider] : []);
  const registry = new AgentRegistry();
  const defaults = { providerId: options.live ? "openrouter" : local.id, model: options.live ? "openrouter/free" : "main-local" };
  const dev = new DevAgent(router, defaults);
  registry.register(dev);
  const ui = new UiRuntimeService();
  const components = new ComponentRegistry(options.filename);
  dev.registerUiAuthor(registry);
  const renderer = new AgentRenderer(router, components, ui, defaults);
  registry.register(renderer);
  renderer.register(registry);
  registry.register(new ResearchAgent(router, defaults));
  const agentRuntime = new AgentRuntime(registry, (event) => components.trace(event));
  const permissions = registry.capabilities();
  permissions.add(previewPermission);
  const conversations = new SQLiteConversationStore(options.filename);
  // The user's memory: local to this host, in the same SQLite file, plain text. Only the "tools" mode reads it.
  const memory = new SQLiteMemoryStore(options.filename);
  const checkpoints = new SQLiteCheckpointStore(options.filename);
  const governance = new ExecutionGovernance(agentRuntime, checkpoints, {
    trustedLocalProviders: options.live ? [] : [local.id],
  });
  const main = new MainAgent(router, registry, governance, conversations, {
    // The live server talks in free text with tool calling by default. VOID_CONVERSATION_MODE=decision restores the
    // strict-JSON coordinator. MOCK keeps the coordinator because its local provider only understands that format.
    ...(options.live && !process.env.VOID_CONVERSATION_MODE ? { conversationMode: "tools" as const } : {}),
    ...defaults, routesForEffort: routes, componentCatalog: (sessionId) => components.catalog(sessionId), memory,
    specialist: (task, context, maxDelegations) => agentRuntime.execute(task, context, maxDelegations),
    tool: (call, resources, context, maxTasks) => agentRuntime.invokeTool("main-agent", call, resources, context, {
      maxTasks,
    }),
  });
  function providerDashboard(): ProviderDashboard {
    const at = Date.now();
    const routerAccount = emptyAccount(options.key ? "not_checked" : "not_configured", at);
    const voiceAccount = emptyAccount(voiceConfig.key ? "not_checked" : "not_configured", at);
    const configured = new Set<string>(freeFallbackModels);
    for (const effort of ["low", "medium", "high", "max"] as const) {
      try { for (const route of Object.values(liveModelRoutes(effort, process.env, registry.list().map(({ definition }) => definition)))) {
        configured.add(route.model);
      } }
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
    main, ui, conversations, memory, components, permissions, limits, live: !!options.live, available: !!provider,
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
        return { mode, voice: voiceStatus, available: !!provider, issue: provider ? null : "Configure OPENROUTER_API_KEY no servidor para usar o modo LIVE.",
          models, effort, demoCap: mode === "MOCK" ? options.maxCalls ?? null : null };
      } catch {
        return { mode, voice: voiceStatus, available: false, issue: "A configuração dos modelos para este esforço é inválida ou inclui uma rota paga.",
          models: null, effort, demoCap: null };
      }
    },
    close() { conversations.close(); memory.close(); checkpoints.close(); usage?.close(); providerUsage.close(); components.close(); },
  };
}

export type WebRuntime = ReturnType<typeof createWebRuntime>;
