import { DevAgent } from "../agents/DevAgent.js";
import { ResearchAgent } from "../agents/ResearchAgent.js";
import { SQLiteCheckpointStore } from "../governance/CheckpointStore.js";
import { ExecutionGovernance } from "../governance/ExecutionGovernance.js";
import { ModelRouter } from "../models/ModelRouter.js";
import { AgentRegistry } from "../runtime/AgentRegistry.js";
import { AgentRuntime } from "../runtime/AgentRuntime.js";
import type { AgentContext } from "../types/context.js";
import type { PlanStep } from "../types/plan.js";

const [command, filename, ...extra] = process.argv.slice(2);
if ((command !== "start" && command !== "resume") || !filename || extra.length) {
  throw new Error("Usage: npm run demo:governance -- <start|resume> <checkpoint.sqlite>");
}

const executionId = "governance-demo";
let now = 0;
const invoked: string[] = [];
const router = new ModelRouter([{
  id: "demo-local",
  async generate({ model, messages, signal }) {
    signal?.throwIfAborted();
    const objective = messages.at(-1)?.content ?? "";
    invoked.push(objective);
    now += 10;
    return { model, content: `Simulação concluída: ${objective}`, usage: { inputTokens: 12, outputTokens: 6 } };
  },
}]);
const registry = new AgentRegistry();
registry.register(new DevAgent(router, { providerId: "demo-local", model: "dev-demo" }));
registry.register(new ResearchAgent(router, { providerId: "demo-local", model: "research-demo" }));

const context: AgentContext = {
  executionId,
  signal: new AbortController().signal,
  permissions: new Set(),
  budgetLimit: 0,
  metadata: {},
};
const plan: PlanStep[] = [
  { id: "A", agentId: "dev-agent", objective: "Revisar a função.", dependsOn: [] },
  { id: "B", agentId: "research-agent", objective: "Comparar evidências.", dependsOn: [] },
  { id: "C", agentId: "dev-agent", objective: "Registrar os próximos testes.", dependsOn: ["A", "B"] },
];
const store = new SQLiteCheckpointStore(filename);
try {
  const governance = new ExecutionGovernance(new AgentRuntime(registry), store, {
    trustedLocalProviders: ["demo-local"],
    now: () => now,
    onProgress: ({ type, status, stepId, reason, usage }) => {
      if (type !== "checkpoint_saved") {
        console.log(JSON.stringify({ type, status, stepId, reason, calls: usage.callsStarted }));
      }
    },
  });
  const result = command === "start"
    ? await governance.start({ id: executionId, plan, context, effort: "low",
      limits: { steps: 2, calls: 2, warnAfterMs: 5 } })
    : await governance.resume(executionId, context, { steps: 1, calls: 1 });
  console.log(JSON.stringify({
    pid: process.pid,
    effort: result.effort,
    status: result.status,
    pauseReason: result.pauseReason,
    calls: result.usage.callsStarted,
    extensions: result.extensions,
    invoked,
    results: result.steps.map(({ stepId, status, output }) => ({ stepId, status, output })),
  }, null, 2));
  if (result.status !== (command === "start" ? "awaiting_approval" : "completed")) process.exitCode = 1;
} finally {
  store.close();
}
