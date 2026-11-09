import assert from "node:assert/strict";
import test from "node:test";

import { DevAgent } from "../src/agents/DevAgent.js";
import { ModelRouter } from "../src/models/ModelRouter.js";
import { AgentRegistry } from "../src/runtime/AgentRegistry.js";
import { AgentRuntime } from "../src/runtime/AgentRuntime.js";

import type { ExecutableAgent } from "../src/types/agent.js";
import type { AgentContext } from "../src/types/context.js";
import type { ModelProvider, ModelRequest } from "../src/types/model.js";
import type { AgentTask, TaskStatus } from "../src/types/task.js";

const simulatedContent = "Simulated analysis of the code";

const generateResponse: ModelProvider["generate"] = async ({ model }) => ({
  content: simulatedContent,
  model,
  usage: { inputTokens: 12, outputTokens: 6 },
});

function createTask(agentId = "dev-agent"): AgentTask {
  return {
    id: crypto.randomUUID(),
    agentId,
    objective: "Find a bug in the code",
    status: "pending",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function createContext(signal = new AbortController().signal): AgentContext {
  return {
    executionId: crypto.randomUUID(),
    permissions: new Set(["code-analysis", "debugging", "testing"]),
    budgetLimit: 1000,
    signal,
    metadata: {},
  };
}

function createDevAgent(generate = generateResponse): DevAgent {
  const provider: ModelProvider = { id: "openrouter", generate };
  return new DevAgent(new ModelRouter([provider]));
}

function createRuntime(agent: ExecutableAgent = createDevAgent()): AgentRuntime {
  const registry = new AgentRegistry();
  registry.register(agent);
  return new AgentRuntime(registry);
}

function createGate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

test("should execute a task successfully", async () => {
  const requests: ModelRequest[] = [];
  const agent = createDevAgent(async (request) => {
    requests.push(request);
    return generateResponse(request);
  });
  const runtime = createRuntime(agent);
  const task = createTask();
  const context = createContext();

  const result = await runtime.execute(task, context);

  assert.equal(result.status, "completed");
  assert.equal(task.status, "completed");
  assert.equal(result.taskId, task.id);
  assert.equal(result.agentId, task.agentId);
  assert.equal(result.result, simulatedContent);
  assert.equal(result.error, undefined);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.messages.map(({ role }) => role), ["system", "user"]);
  assert.deepEqual(requests[0]?.messages[1], { role: "user", content: task.objective });
  assert.equal(requests[0]?.signal, context.signal);
});

test("should fail when agent does not exist", async () => {
  const runtime = new AgentRuntime(new AgentRegistry());
  const task = createTask("unknown-agent");

  const result = await runtime.execute(task, createContext());

  assert.equal(result.status, "failed");
  assert.equal(task.status, "failed");
  assert.equal(result.taskId, task.id);
  assert.equal(result.agentId, task.agentId);
  assert.equal(result.result, null);
  assert.match(result.error ?? "", /not found/i);
});

test("should reject an already completed task", async () => {
  const runtime = createRuntime();
  const task = createTask();

  const result = await runtime.execute(task, createContext());
  assert.equal(result.status, "completed");

  await assert.rejects(runtime.execute(task, createContext()), /not pending/i);
  assert.equal(task.status, "completed");
});

test("should fail when execution is aborted before the agent starts", async () => {
  let modelCalls = 0;
  const agent = createDevAgent((request) => {
    modelCalls++;
    return generateResponse(request);
  });
  const runtime = createRuntime(agent);
  const task = createTask();
  const controller = new AbortController();
  controller.abort(new Error("Cancelled before execution"));

  const result = await runtime.execute(task, createContext(controller.signal));

  assert.equal(result.status, "failed");
  assert.equal(task.status, "failed");
  assert.equal(result.result, null);
  assert.equal(result.error, "Cancelled before execution");
  assert.equal(modelCalls, 0);
});

test("should handle agent execution errors", async () => {
  const agent = createDevAgent(async () => {
    throw new Error("Simulated agent failure");
  });
  const runtime = createRuntime(agent);
  const task = createTask();

  const result = await runtime.execute(task, createContext());

  assert.equal(result.status, "failed");
  assert.equal(task.status, "failed");
  assert.equal(result.taskId, task.id);
  assert.equal(result.agentId, task.agentId);
  assert.equal(result.result, null);
  assert.equal(result.error, "Simulated agent failure");
});

test("should reject non-pending tasks before invoking the agent", async () => {
  let modelCalls = 0;
  const agent = createDevAgent((request) => {
    modelCalls++;
    return generateResponse(request);
  });
  const runtime = createRuntime(agent);
  const statuses: TaskStatus[] = ["running", "failed", "cancelled"];

  for (const status of statuses) {
    const task = createTask();
    task.status = status;
    await assert.rejects(runtime.execute(task, createContext()), /not pending/i);
    assert.equal(task.status, status);
  }
  assert.equal(modelCalls, 0);
});

test("should reject a pending copy of an active task with the same ID", async () => {
  const gate = createGate();
  let modelCalls = 0;
  const agent = createDevAgent(async (request) => {
    modelCalls++;
    await gate.promise;
    return generateResponse(request);
  });
  const runtime = createRuntime(agent);
  const task = createTask();
  const duplicate = { ...task };
  const active = runtime.execute(task, createContext());

  try {
    assert.equal(task.status, "running");
    await assert.rejects(
      runtime.execute(duplicate, createContext()),
      /already running/i,
    );
    assert.equal(duplicate.status, "pending");
    assert.equal(modelCalls, 1);
  } finally {
    gate.open();
    await active;
  }
  assert.equal(task.status, "completed");
});

test("should preserve each context and isolate an asynchronous agent failure", async () => {
  const gate = createGate();
  const failingTask = createTask("test-agent");
  const successfulTask = createTask("test-agent");
  const failingContext = createContext();
  const successfulContext = createContext();
  const observedContexts = new Map<string, AgentContext>();
  const runtime = createRuntime({
    definition: {
      id: "test-agent",
      name: "Test agent",
      description: "Exercises concurrent task execution",
      capabilities: [],
    },
    async execute(task, context) {
      observedContexts.set(task.id, context);
      if (task.id === failingTask.id) {
        await gate.promise;
        throw new Error("Asynchronous agent failure");
      }
      return { content: "Independent result" };
    },
  });
  const pendingFailure = runtime.execute(failingTask, failingContext);
  const pendingSuccess = runtime.execute(successfulTask, successfulContext);

  try {
    const success = await pendingSuccess;
    assert.equal(failingTask.status, "running");
    assert.equal(successfulTask.status, "completed");
    assert.equal(observedContexts.get(failingTask.id), failingContext);
    assert.equal(observedContexts.get(successfulTask.id), successfulContext);
    assert.equal(success.status, "completed");
    assert.equal(success.taskId, successfulTask.id);
    assert.equal(success.agentId, successfulTask.agentId);
    assert.equal(success.result, "Independent result");
    assert.equal(success.error, undefined);
  } finally {
    gate.open();
  }

  const failure = await pendingFailure;
  assert.equal(failingTask.status, "failed");
  assert.equal(failure.status, "failed");
  assert.equal(failure.taskId, failingTask.id);
  assert.equal(failure.agentId, failingTask.agentId);
  assert.equal(failure.error, "Asynchronous agent failure");
  assert.equal(failure.result, null);
});

test("should discard a model response if the execution is aborted while running", async () => {
  const gate = createGate();
  const agent = createDevAgent(async (request) => {
    await gate.promise;
    return generateResponse(request);
  });
  const runtime = createRuntime(agent);
  const task = createTask();
  const controller = new AbortController();
  const execution = runtime.execute(task, createContext(controller.signal));

  controller.abort(new Error("Cancelled while running"));
  gate.open();

  const result = await execution;
  assert.equal(task.status, "failed");
  assert.equal(result.status, "failed");
  assert.equal(result.error, "Cancelled while running");
  assert.equal(result.result, null);
});
