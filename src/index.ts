
import { AgentRegistry } from "./runtime/AgentRegistry.js";
import { AgentRuntime } from "./runtime/AgentRuntime.js";

import { DevAgent } from "./agents/DevAgent.js";
import { ModelRouter } from "./models/ModelRouter.js";
import { MockModelProvider } from "./models/providers/MockModelProvider.js";
import { OpenRouterFreeCatalog } from "./models/providers/OpenRouterFreeCatalog.js";
import { OpenRouterProvider } from "./models/providers/OpenRouterProvider.js";

import type { ExecutableAgent } from "./types/agent.js";
import type { AgentTask } from "./types/task.js";
import type { AgentContext } from "./types/context.js";

// ======================================
// 1. Configuração dos modelos
// ======================================

const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
  throw new Error("OPENROUTER_API_KEY is missing.");
}

const mockProvider = new MockModelProvider();
const openRouterProvider = new OpenRouterProvider(apiKey, undefined, new OpenRouterFreeCatalog());

const modelRouter = new ModelRouter([
  mockProvider,
  openRouterProvider,
]);

// ======================================
// 2. Teste do MockModelProvider
// ======================================

const mockResponse = await modelRouter.generate("mock", {
  model: "mock-model",
  messages: [
    {
      role: "user",
      content: "Explique o que é uma API.",
    },
  ],
});

console.log("MOCK RESPONSE:", mockResponse);

// ======================================
// 3. Teste real do OpenRouter
// ======================================

try {
  const openRouterResponse = await modelRouter.generate("openrouter", {
    model: "openrouter/free",
    messages: [
      {
        role: "user",
        content: "Olá! Responda em português e explique o que é uma API em uma frase.",
      },
    ],
    maxOutputTokens: 500,
  });

  console.log("OPENROUTER RESPONSE:", openRouterResponse);
} catch (error) {
  console.error("OPENROUTER ERROR:", error);
}

// ======================================
// 4. Configuração dos agentes
// ======================================

const agentRegistry = new AgentRegistry();

const devAgent: ExecutableAgent = new DevAgent(modelRouter);

agentRegistry.register(devAgent);

const runtime = new AgentRuntime(agentRegistry);

// ======================================
// 5. Criação da tarefa
// ======================================

const task: AgentTask = {
  id: crypto.randomUUID(),
  agentId: devAgent.definition.id,
  objective: "Explique a diferença entre let e const em JavaScript, com um exemplo curto.",
  status: "pending",
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ======================================
// 6. Contexto de execução
// ======================================

const context: AgentContext = {
  executionId: crypto.randomUUID(),
  permissions: new Set([
    "code-analysis",
    "debugging",
    "testing",
  ]),
  budgetLimit: 1000,
  signal: new AbortController().signal,
  metadata: {},
};

// ======================================
// 7. Execução do agente
// ======================================

const result = await runtime.execute(task, context);

console.log("AGENT RESULT:", result);
