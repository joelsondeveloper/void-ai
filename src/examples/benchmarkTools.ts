/**
 * Measures free OpenRouter models on what the default conversation mode ("tools") actually asks of them: answer in
 * Portuguese, call interface and memory tools with valid arguments, and use the memory block. Each candidate runs the
 * production prompt and tool list through MainAgent, without the host safety nets that would hide the model's own
 * behavior (no interface shortcut; the memory extractor still runs, but only tool calls made by the model count).
 *
 *   npm run benchmark:tools:live
 *   VOID_BENCH_MODELS=a:free,b:free VOID_BENCH_ROUNDS=2 npm run benchmark:tools:live
 *
 * Prints one JSON line per scenario and a summary table. Never prints the key. Costs about 10 requests per model
 * and round, paced under the free tier's per-minute limit.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { AgentRenderer } from "../agents/AgentRenderer.js";
import { DevAgent } from "../agents/DevAgent.js";
import { MainAgent, type MainMessage } from "../agents/MainAgent.js";
import { ResearchAgent } from "../agents/ResearchAgent.js";
import { SQLiteConversationStore } from "../conversation/ConversationStore.js";
import { SQLiteMemoryStore } from "../conversation/MemoryStore.js";
import { SQLiteCheckpointStore } from "../governance/CheckpointStore.js";
import { ExecutionGovernance } from "../governance/ExecutionGovernance.js";
import { ModelRouter } from "../models/ModelRouter.js";
import { liveModelRoutes } from "../models/modelSelection.js";
import { OpenRouterFreeCatalog } from "../models/providers/OpenRouterFreeCatalog.js";
import { OpenRouterProvider } from "../models/providers/OpenRouterProvider.js";
import { AgentRegistry } from "../runtime/AgentRegistry.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import { describeFailure } from "../types/failure.js";
import type { ModelProvider, ModelRoute } from "../types/model.js";
import { ComponentRegistry } from "../web/ComponentRegistry.js";
import { previewPermission } from "../web/render-contracts.js";
import { UiRuntimeService } from "../web/ui-runtime.js";

interface Candidate { id: string; reasoning: "optional" | "mandatory" | "none"; expires?: string }
interface Call { ms: number; tools: string[]; output?: number; reasoning?: number; failure?: string }
interface Outcome { scenario: string; pass: boolean; note: string; calls: number; ms: number; failures: string[] }

const zero = (value: unknown) => value === 0 || (typeof value === "string" && /^0(?:\.0+)?$/.test(value));

/** Free models that list `tools`, newest first, leaving out the router alias and anything expiring within a week. */
async function candidates(): Promise<Candidate[]> {
  const response = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error("O catálogo do OpenRouter respondeu HTTP " + response.status);
  const { data } = await response.json() as { data: Record<string, unknown>[] };
  const horizon = Date.now() + 7 * 86_400_000;
  const wanted = process.env.VOID_BENCH_MODELS?.split(",").map((id) => id.trim()).filter(Boolean);
  return data.flatMap((entry): Candidate[] => {
    const id = typeof entry.id === "string" ? entry.id : "";
    const pricing = entry.pricing && typeof entry.pricing === "object" ? Object.values(entry.pricing) : [];
    const parameters = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
    const expires = typeof entry.expiration_date === "string" ? entry.expiration_date : undefined;
    if (!id.endsWith(":free") || !pricing.length || !pricing.every(zero) || !parameters.includes("tools")) return [];
    if (wanted ? !wanted.includes(id) : expires !== undefined && !(Date.parse(expires) > horizon)) return [];
    const reasoning = entry.reasoning && typeof entry.reasoning === "object" ? entry.reasoning as { mandatory?: unknown } : undefined;
    return [{ id, ...(expires ? { expires: expires.slice(0, 10) } : {}), reasoning: !parameters.includes("reasoning") || !reasoning ? "none"
      : reasoning.mandatory === false ? "optional" : "mandatory" }];
  });
}

const portuguese = (text: string) => /(?<![\p{L}])(?:você|voce|não|que|para|pra|uma?|com|é|está|tá|bom|dia|como|aqui)(?![\p{L}])/iu.test(text) &&
  !/[぀-ヿ一-鿿Ѐ-ӿ]/.test(text);

async function measure(candidate: Candidate, key: string, directory: string, pace: () => Promise<void>): Promise<Outcome[]> {
  const filename = join(directory, candidate.id.replace(/[^a-z0-9]+/gi, "-") + "-" + Date.now() + ".sqlite");
  const calls: Call[] = [];
  const live = new OpenRouterProvider(key, () => {}, new OpenRouterFreeCatalog(), []);
  const provider: ModelProvider = { id: live.id, async generate(request) {
    await pace();
    const startedAt = performance.now();
    try {
      const response = await live.generate(request);
      calls.push({ ms: Math.round(performance.now() - startedAt), tools: response.toolCalls?.map(({ name }) => name) ?? [],
        ...(response.usage ? { output: response.usage.outputTokens, ...(response.usage.reasoningTokens === undefined ? {} : { reasoning: response.usage.reasoningTokens }) } : {}) });
      return response;
    } catch (error) {
      const { category, code, httpStatus } = describeFailure(error);
      calls.push({ ms: Math.round(performance.now() - startedAt), tools: [], failure: [category, code, httpStatus].filter(Boolean).join(":") });
      throw error;
    }
  } };
  const router = new ModelRouter([provider]);
  const defaults = { providerId: "openrouter", model: candidate.id };
  const registry = new AgentRegistry();
  const dev = new DevAgent(router, defaults);
  registry.register(dev);
  const components = new ComponentRegistry(filename);
  dev.registerUiAuthor(registry);
  const renderer = new AgentRenderer(router, components, new UiRuntimeService(), defaults);
  registry.register(renderer);
  renderer.register(registry);
  registry.register(new ResearchAgent(router, defaults));
  const runtime = new AgentRuntime(registry);
  const permissions = registry.capabilities();
  permissions.add(previewPermission);
  const conversations = new SQLiteConversationStore(filename);
  const memory = new SQLiteMemoryStore(filename);
  const checkpoints = new SQLiteCheckpointStore(filename);
  const governance = new ExecutionGovernance(runtime, checkpoints, { trustedLocalProviders: [] });
  // Same shape production uses for its known quick routes: reasoning off wherever the catalog lets it be turned off.
  const route: ModelRoute = { providerId: "openrouter", model: candidate.id, maxOutputTokens: 1600,
    ...(candidate.reasoning === "optional" ? { reasoning: { enabled: false } } : {}) };
  const definitions = registry.list().map(({ definition }) => definition);
  const main = new MainAgent(router, registry, governance, conversations, {
    ...defaults, conversationMode: "tools", memory, componentCatalog: (sessionId) => components.catalog(sessionId),
    routesForEffort: (effort) => ({ ...liveModelRoutes(effort, {}, definitions), decision: route, synthesis: route }),
    specialist: (task, context, maxDelegations) => runtime.execute(task, context, maxDelegations),
    tool: (call, resources, context, maxTasks) => runtime.invokeTool("main-agent", call, resources, context, { maxTasks }),
  });

  const outcomes: Outcome[] = [];
  async function scenario(name: string, sessionId: string, message: string,
    judge: (run: { final: string; messages: MainMessage[]; tools: string[] }) => [boolean, string]) {
    const from = calls.length;
    const startedAt = performance.now();
    const messages: MainMessage[] = [];
    await main.run({ sessionId, message, effort: "low", context: { executionId: sessionId, permissions,
      signal: AbortSignal.timeout(120_000), budgetLimit: 0, metadata: {} } }, (event) => { messages.push(event); });
    const used = calls.slice(from);
    const final = messages.find(({ type }) => type === "final")?.text ?? "";
    const error = messages.find((event) => event.type === "error");
    const [pass, note] = error ? [false, "erro: " + (error.type === "error" ? error.failure.category + (error.failure.code ? ":" + error.failure.code : "") : "")]
      : judge({ final, messages, tools: used.flatMap(({ tools }) => tools) });
    const outcome: Outcome = { scenario: name, pass, note, calls: used.length, ms: Math.round(performance.now() - startedAt),
      failures: used.flatMap(({ failure }) => failure ? [failure] : []) };
    outcomes.push(outcome);
    console.log(JSON.stringify({ model: candidate.id, ...outcome, reply: final.replace(/\s+/g, " ").slice(0, 140) }));
  }
  const action = (messages: MainMessage[]) => messages.flatMap((event) => event.type === "ui" ? [event.action] : []);

  try {
    await scenario("conversa", "a", "bom dia, tudo certo por aí?", ({ final, tools }) =>
      [!!final && portuguese(final) && tools.length === 0, tools.length ? "chamou " + tools.join(",") : portuguese(final) ? "" : "não respondeu em português"]);
    await scenario("explicação", "a", "Explique em duas frases a diferença entre concorrência e paralelismo.", ({ final, tools }) =>
      [/concorr[êe]ncia/i.test(final) && /paralelismo/i.test(final) && tools.length === 0,
        tools.length ? "delegou sem precisar: " + tools.join(",") : ""]);
    await scenario("abrir workspace", "a", "abre o workspace", ({ messages, tools }) =>
      [action(messages).some((item) => item.type === "switch_mode" && item.mode === "workspace"), tools.join(",") || "não chamou ferramenta"]);
    await scenario("abrir painel", "a", "mostra o painel de uso", ({ messages, tools }) =>
      [action(messages).some((item) => item.type === "open_panel" && item.panel === "usage"), tools.join(",") || "não chamou ferramenta"]);
    await scenario("lembrar a pedido", "a", "lembra que eu prefiro respostas curtas e diretas", ({ tools }) =>
      [tools.includes("remember"), tools.join(",") || "não chamou remember"]);
    await scenario("menção de passagem", "a", "trabalho na Florarte, mas hoje tô cansado", ({ final, tools }) =>
      [!!final, tools.includes("remember") ? "chamou remember" : /anot|salv|guard|lembr/i.test(final) ? "disse que anotou sem chamar remember" : "não chamou remember"]);
    // The host capture may have failed with the turn above; the recall scenario needs the fact either way.
    memory.remember({ kind: "profile", topic: "trabalho", text: "O usuário trabalha na Florarte.", origin: "extracted" });
    await scenario("usar a memória em sessão nova", "b", "onde eu trabalho?", ({ final }) => [/florarte/i.test(final), ""]);
    outcomes.push({ scenario: "resumo da sessão anterior", pass: memory.list("summary").length > 0, note: "", calls: 0, ms: 0, failures: [] });
  } finally {
    conversations.close(); memory.close(); checkpoints.close(); components.close();
  }
  return outcomes;
}

const key = process.env.OPENROUTER_API_KEY?.trim();
if (!key) throw new Error("Configure OPENROUTER_API_KEY para medir modelos.");
const rounds = Number(process.env.VOID_BENCH_ROUNDS ?? 1);
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 3) throw new Error("VOID_BENCH_ROUNDS deve ser 1, 2 ou 3.");
let last = 0;
// Free routes allow 20 requests per minute. 3.5 s between requests stays under it with one request at a time.
const pace = async () => { const wait = last + 3_500 - Date.now(); if (wait > 0) await sleep(wait); last = Date.now(); };
const directory = mkdtempSync(join(tmpdir(), "void-bench-tools-"));
const scored = ["conversa", "explicação", "abrir workspace", "abrir painel", "lembrar a pedido", "usar a memória em sessão nova", "resumo da sessão anterior"];
const summary: Record<string, unknown>[] = [];
try {
  for (const candidate of await candidates()) {
    const all: Outcome[] = [];
    for (let round = 0; round < rounds; round++) {
      try { all.push(...await measure(candidate, key, directory, pace)); }
      catch (error) { console.log(JSON.stringify({ model: candidate.id, aborted: describeFailure(error).category })); }
    }
    const by = (name: string) => all.filter(({ scenario }) => scenario === name);
    const turns = all.filter(({ calls }) => calls > 0);
    const latencies = turns.map(({ ms, calls }) => ms / calls).sort((a, b) => a - b);
    const mention = by("menção de passagem");
    summary.push({
      modelo: candidate.id, raciocínio: candidate.reasoning, ...(candidate.expires ? { expira: candidate.expires } : {}),
      acertos: `${all.filter(({ scenario, pass }) => pass && scored.includes(scenario)).length}/${scored.length * rounds}`,
      ...Object.fromEntries(scored.map((name) => [name, `${by(name).filter(({ pass }) => pass).length}/${rounds}`])),
      "menção: chamou remember": `${mention.filter(({ note }) => note === "chamou remember").length}/${rounds}`,
      "menção: disse que anotou sem gravar": `${mention.filter(({ note }) => note.startsWith("disse que anotou")).length}/${rounds}`,
      "ms por chamada (mediana)": latencies.length ? Math.round(latencies[Math.floor(latencies.length / 2)] ?? 0) : null,
      chamadas: all.reduce((sum, { calls }) => sum + calls, 0),
      falhas: [...new Set(all.flatMap(({ failures }) => failures))].join(" ") || "-",
    });
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ summary }));
console.table(summary);
