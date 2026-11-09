
import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { AgentRegistry } from "../src/runtime/AgentRegistry.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";
import { PlanExecutor } from "../src/runtime/PlanExecutor.js";
import { createRuntimeStepRunner } from "../src/orchestration/RuntimeStepRunner.js";

import type { ExecutableAgent } from "../src/types/agent.js";
import type { AgentContext } from "../src/types/context.js";
import type { PlanStep } from "../src/types/plan.js";

function createContext(): AgentContext {
  return {
    executionId: "execucao-de-teste",
    permissions: new Set(["testing"]),
    budgetLimit: 100,
    signal: new AbortController().signal,
    metadata: { source: "integration-test" },
  };
}

function createStep(id: string, agentId: string, dependsOn: string[] = []): PlanStep {
  return { id, agentId, objective: `Executar etapa ${id}`, dependsOn };
}

function createAgent(id: string, execute: ExecutableAgent["execute"]): ExecutableAgent {
  return {
    definition: {
      id,
      name: id,
      description: "Agente simulado para testes de integração",
      capabilities: ["testing"],
    },
    execute,
  };
}

test("Deve registrar falha quando o agente não existe", async () => {
  const registry = new AgentRegistry();
  const runtime = new AgentRuntime(registry);
  const executor = new PlanExecutor();

  const context = createContext();
  const step = createStep("A", "agente-inexistente");
  const error = "Agent with ID agente-inexistente not found";
  const now = new Date();
  const result = await runtime.execute(
    {
      id: `${context.executionId}:${step.id}`,
      agentId: step.agentId,
      objective: step.objective,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    },
    context,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.error, error);

  const runner = createRuntimeStepRunner(runtime, context);
  await assert.rejects(runner(step), { message: error });

  const executions = await executor.executePlan([step], runner);

  assert.equal(executions.get("A")?.status, "failed");
  assert.match(
    executions.get("A")?.error ?? "",
    /Agent with ID agente-inexistente not found/,
  );
});

test("Deve converter a etapa em tarefa, preservar o contexto e retornar a saída do agente", async () => {
  const registry = new AgentRegistry();
  const context = createContext();
  const signal = context.signal;
  const step = createStep("A", "agente-a");
  const received: Parameters<ExecutableAgent["execute"]>[] = [];
  const statuses: string[] = [];
  registry.register(createAgent(step.agentId, async (task, agentContext) => {
    received.push([task, agentContext]);
    statuses.push(task.status);
    return { content: "Resultado do agente A" };
  }));

  const runner = createRuntimeStepRunner(new AgentRuntime(registry), context);
  const executions = await new PlanExecutor().executePlan([step], runner);

  assert.equal(received.length, 1);
  const call = received[0];
  assert.ok(call);
  const [task, agentContext] = call;
  assert.equal(task.id, "execucao-de-teste:A");
  assert.equal(task.agentId, step.agentId);
  assert.equal(task.objective, step.objective);
  assert.deepEqual(statuses, ["running"]);
  assert.equal(task.status, "completed");
  assert.equal(agentContext, context);
  assert.equal(agentContext.executionId, "execucao-de-teste");
  assert.deepEqual(agentContext.permissions, new Set(["testing"]));
  assert.equal(agentContext.budgetLimit, 100);
  assert.deepEqual(agentContext.metadata, { source: "integration-test" });
  assert.equal(agentContext.signal, signal);
  assert.equal(executions.get("A")?.status, "completed");
  assert.equal(executions.get("A")?.output, "Resultado do agente A");
  assert.equal(executions.get("A")?.error, null);
});

test("Deve manter a dependente pendente e executar a etapa independente após a falha", async () => {
  const registry = new AgentRegistry();
  const called: string[] = [];
  const error = "Falha simulada no agente A";
  registry.register(createAgent("agente-a", async (task) => {
    called.push(task.agentId);
    throw new Error(error);
  }));
  registry.register(createAgent("agente-b", async (task) => {
    called.push(task.agentId);
    return { content: "Resultado de B" };
  }));
  registry.register(createAgent("agente-c", async (task) => {
    called.push(task.agentId);
    return { content: "Resultado de C" };
  }));
  const steps = [
    createStep("A", "agente-a"),
    createStep("B", "agente-b", ["A"]),
    createStep("C", "agente-c"),
  ];
  const runner = createRuntimeStepRunner(new AgentRuntime(registry), createContext());
  const executions = await new PlanExecutor().executePlan(steps, runner, 1);

  assert.equal(executions.get("A")?.status, "failed");
  assert.equal(executions.get("A")?.error, error);
  assert.equal(executions.get("A")?.output, null);
  assert.equal(executions.get("B")?.status, "pending");
  assert.equal(executions.get("B")?.startedAt, null);
  assert.equal(executions.get("C")?.status, "completed");
  assert.equal(executions.get("C")?.output, "Resultado de C");
  assert.deepEqual(called, ["agente-a", "agente-c"]);
});

test("Deve iniciar duas etapas independentes antes de concluir qualquer uma", { timeout: 3000 }, async () => {
  const registry = new AgentRegistry();
  const started: string[] = [];
  const finished: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execute: ExecutableAgent["execute"] = async (task) => {
    started.push(task.id);
    await barrier;
    finished.push(task.id);
    return { content: `Resultado de ${task.agentId}` };
  };
  registry.register(createAgent("agente-a", execute));
  registry.register(createAgent("agente-b", execute));
  const steps = [createStep("A", "agente-a"), createStep("B", "agente-b")];
  const runner = createRuntimeStepRunner(new AgentRuntime(registry), createContext());
  const plan = new PlanExecutor().executePlan(steps, runner, 2);

  const checkOverlap = async (): Promise<void> => {
    try {
      // Let scheduling microtasks run without waiting for both arrivals.
      await setImmediate();
      assert.deepEqual([...started].sort(), ["execucao-de-teste:A", "execucao-de-teste:B"]);
      assert.deepEqual(finished, []);
    } finally {
      release();
    }
  };
  const [executions] = await Promise.all([plan, checkOverlap()]);

  assert.deepEqual([...finished].sort(), ["execucao-de-teste:A", "execucao-de-teste:B"]);
  assert.equal(executions.get("A")?.status, "completed");
  assert.equal(executions.get("A")?.output, "Resultado de agente-a");
  assert.equal(executions.get("B")?.status, "completed");
  assert.equal(executions.get("B")?.output, "Resultado de agente-b");
});

test("Deve executar uma cadeia de dependências na ordem correta", async () => {
  const registry = new AgentRegistry();
  const events: string[] = [];
  registry.register(createAgent("agente", async (task) => {
    events.push(`inicio:${task.id}`);
    await Promise.resolve();
    events.push(`fim:${task.id}`);
    return { content: task.objective };
  }));
  const steps = [
    createStep("C", "agente", ["B"]),
    createStep("B", "agente", ["A"]),
    createStep("A", "agente"),
  ];
  const runner = createRuntimeStepRunner(new AgentRuntime(registry), createContext());
  const executions = await new PlanExecutor().executePlan(steps, runner, 3);

  assert.deepEqual(events, [
    "inicio:execucao-de-teste:A",
    "fim:execucao-de-teste:A",
    "inicio:execucao-de-teste:B",
    "fim:execucao-de-teste:B",
    "inicio:execucao-de-teste:C",
    "fim:execucao-de-teste:C",
  ]);
  for (const step of steps) {
    assert.equal(executions.get(step.id)?.status, "completed");
    assert.equal(executions.get(step.id)?.output, step.objective);
  }
});
