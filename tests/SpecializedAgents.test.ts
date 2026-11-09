import assert from "node:assert/strict";
import test from "node:test";

import { DevAgent } from "../src/agents/DevAgent.js";
import { ResearchAgent } from "../src/agents/ResearchAgent.js";
import { ModelRouter } from "../src/models/ModelRouter.js";
import { createRuntimeStepRunner } from "../src/orchestration/RuntimeStepRunner.js";
import { AgentRegistry } from "../src/runtime/AgentRegistry.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import { PlanExecutor } from "../src/runtime/PlanExecutor.js";
import type { AgentContext } from "../src/types/context.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/types/model.js";
import type { AgentTask } from "../src/types/task.js";

const config = { providerId: "test-provider", model: "test-model" };
const objective = "Analise as informações disponíveis.";
const validContent = "Resposta do provedor de teste.";

function createTask(agentId: string): AgentTask {
  const now = new Date();
  return { id: "task", agentId, objective, status: "pending", createdAt: now, updatedAt: now };
}

function createContext(signal = new AbortController().signal): AgentContext {
  return {
    executionId: "test-execution",
    permissions: new Set(),
    budgetLimit: 0,
    signal,
    metadata: {},
  };
}

function response(model: string, content = validContent): ModelResponse {
  return { model, content, usage: { inputTokens: 0, outputTokens: 0 } };
}

function createRouter(generate: ModelProvider["generate"]): ModelRouter {
  return new ModelRouter([{ id: config.providerId, generate }]);
}

test("DevAgent keeps its default route and sends code guidance with the task", async () => {
  const requests: ModelRequest[] = [];
  const router = new ModelRouter([{
    id: "openrouter",
    async generate(request) {
      requests.push(request);
      return response(request.model);
    },
  }]);
  const agent = new DevAgent(router);
  const context = createContext();
  context.metadata.researchNotes = "Private notes unrelated to development.";
  const result = await agent.execute(createTask(agent.definition.id), context);

  assert.equal(agent.definition.id, "dev-agent");
  assert.ok(agent.definition.capabilities.includes("code-analysis"));
  assert.deepEqual(result, { content: validContent });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.model, "openrouter/free");
  assert.equal(request.maxOutputTokens, 500);
  assert.equal(request.signal, context.signal);
  assert.deepEqual(request.messages.map(({ role }) => role), ["system", "user"]);
  assert.match(request.messages[0]?.content ?? "", /confirmed findings from hypotheses/i);
  assert.match(request.messages[0]?.content ?? "", /do not claim to have run commands or tests/i);
  assert.deepEqual(request.messages[1], { role: "user", content: objective });
});

test("ResearchAgent routes configured requests and forwards only supplied research notes", async () => {
  const requests: ModelRequest[] = [];
  const agent = new ResearchAgent(createRouter(async (request) => {
    requests.push(request);
    return response(request.model);
  }), config);
  const context = createContext();
  context.metadata = {
    researchNotes: "Estudo A e estudo B divergem.",
    internal: "Private runtime metadata",
  };

  const result = await agent.execute(createTask(agent.definition.id), context);

  assert.equal(agent.definition.id, "research-agent");
  assert.ok(agent.definition.capabilities.includes("evidence-synthesis"));
  assert.deepEqual(result, { content: validContent });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.model, config.model);
  assert.equal(request.signal, context.signal);
  assert.deepEqual(request.messages.map(({ role }) => role), ["system", "user"]);
  assert.match(request.messages[0]?.content ?? "", /external verification/i);
  assert.match(request.messages[0]?.content ?? "", /you have no web search/i);
  assert.match(request.messages[0]?.content ?? "", /do not invent findings, URLs, or citations/i);
  assert.deepEqual(request.messages[1], {
    role: "user",
    content: objective + "\n\nSupplied research notes:\nEstudo A e estudo B divergem.",
  });
});

for (const Agent of [DevAgent, ResearchAgent]) {
  test(`${Agent.name} preserves provider errors and rejects missing model configuration`, async () => {
    const providerError = new Error("Provider failed");
    const router = createRouter(async () => { throw providerError; });
    const agent = new Agent(router, config);
    const task = createTask(agent.definition.id);
    const context = createContext();

    await assert.rejects(agent.execute(task, context), (error) => error === providerError);
    await assert.rejects(
      new Agent(new ModelRouter([]), config).execute(task, context),
      /Model provider test-provider not found/,
    );
    await assert.rejects(
      new Agent(router, { ...config, model: " " }).execute(task, context),
      /requires a provider ID and model/,
    );
  });

  test(`${Agent.name} rejects empty and malformed provider content`, async () => {
    const agent = new Agent(createRouter(async ({ model }) => response(model, " \n\t ")), config);
    const task = createTask(agent.definition.id);
    const context = createContext();

    await assert.rejects(agent.execute(task, context), /returned empty content/);

    const malformed = new Agent(createRouter(async ({ model }) => {
      // Simulate a provider that violates ModelResponse at runtime.
      return Object.defineProperty(response(model), "content", { value: 42 });
    }), config);
    await assert.rejects(malformed.execute(task, context), /returned invalid content/);
  });

  test(`${Agent.name} checks cancellation before dispatch and after model generation`, async () => {
    const controller = new AbortController();
    const cancelled = new Error("Cancelled");
    let calls = 0;
    const agent = new Agent(createRouter(async ({ model, signal }) => {
      calls++;
      assert.equal(signal, controller.signal);
      controller.abort(cancelled);
      return response(model);
    }), config);
    const task = createTask(agent.definition.id);
    const context = createContext(controller.signal);

    await assert.rejects(agent.execute(task, context), (error) => error === cancelled);
    assert.equal(calls, 1);
    await assert.rejects(agent.execute(task, context), (error) => error === cancelled);
    assert.equal(calls, 1);
  });
}

test("runs a manual plan through both registered specialists", async () => {
  const router = createRouter(async ({ model }) => response(model, `Output from ${model}`));
  const dev = new DevAgent(router, { ...config, model: "dev-test" });
  const research = new ResearchAgent(router, { ...config, model: "research-test" });
  const registry = new AgentRegistry();
  registry.register(dev);
  registry.register(research);
  const runStep = createRuntimeStepRunner(new AgentRuntime(registry), createContext());

  const results = await new PlanExecutor().executePlan([
    { id: "A", agentId: dev.definition.id, objective: "Review code", dependsOn: [] },
    { id: "B", agentId: research.definition.id, objective: "Compare evidence", dependsOn: [] },
  ], runStep, 2);

  assert.deepEqual(
    [...results.values()].map(({ stepId, status, output, error }) => ({ stepId, status, output, error })),
    [
      { stepId: "A", status: "completed", output: "Output from dev-test", error: null },
      { stepId: "B", status: "completed", output: "Output from research-test", error: null },
    ],
  );
});
