import { randomUUID } from "node:crypto";
import type { ModelTool } from "../runtime/AgentOperation.js";
import type { AgentRegistry } from "../runtime/AgentRegistry.js";
import type { AgentContext } from "../types/context.js";
import { ExecutionError, type ExecutionFailure } from "../types/failure.js";
import type { AgentResult, AgentTask } from "../types/task.js";
import { isRecord } from "./mainDecision.js";
import { isUiAction, type UiAction } from "../web/ui-contracts.js";
import { ToolInputError, type LoopTool } from "./toolLoop.js";

/** Runs one specialist task with permission checks, tracing and action validation (AgentRuntime.execute). */
export type SpecialistRunner = (task: AgentTask, context: AgentContext, maxDelegations: number) => Promise<AgentResult>;

/** Everything a turn produced for the interface, in the order the tools ran. */
export interface TurnAction {
  readonly text: string;
  readonly action: UiAction;
}

/** Model calls this turn may still make. Specialists and the conversation draw from the same pool. */
export interface CallBudget {
  readonly remaining: number;
  /** Takes one call unless that would leave fewer than `reserve` calls. */
  take(reserve?: number): boolean;
}

export function callBudget(calls: number): CallBudget {
  let remaining = calls;
  return {
    get remaining() { return remaining; },
    take(reserve = 0) {
      if (remaining - 1 < reserve) return false;
      remaining--;
      return true;
    },
  };
}

const taskLimit = 6_000;
const wireName = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 56);

/** "dev-agent" becomes ask_dev, "agent-renderer" becomes ask_renderer. */
function specialistName(id: string, used: Set<string>): string {
  const base = "ask_" + (wireName(id.replace(/(^agent-|-agent$)/g, "")) || "specialist");
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  used.add(name);
  return name;
}

const fallbackFailure: ExecutionFailure = { category: "internal_error", message: "O especialista não conseguiu concluir.", retryable: false };

export function specialistTools(input: {
  agents: AgentRegistry;
  permissions: ReadonlySet<string>;
  run: SpecialistRunner;
  context: () => AgentContext;
  budget: CallBudget;
  maxDelegations: number;
  actions: TurnAction[];
}): LoopTool[] {
  const used = new Set<string>();
  const tools: LoopTool[] = [];
  for (const entry of input.agents.catalog("main-agent", input.permissions)) {
    const capability = entry.planCapabilities[0];
    if (!capability || !input.agents.get(entry.id)) continue;
    tools.push({
      label: entry.name,
      status: `Consultando ${entry.name}…`,
      spec: {
        name: specialistName(entry.id, used),
        description: `${entry.description}. Capacidades: ${entry.planCapabilities.join(", ")}. ` +
          "Entrega a tarefa a este especialista e devolve a resposta dele. Use só quando o trabalho dele melhorar a resposta; " +
          "conversa, opinião e explicações simples você responde direto.",
        parameters: {
          type: "object", additionalProperties: false, required: ["task"],
          properties: { task: { type: "string", maxLength: taskLimit,
            description: "O que o especialista deve fazer, com todo o contexto e a evidência necessários. Ele não vê a conversa." } },
        },
      },
      async run(args) {
        if (!isRecord(args) || typeof args.task !== "string" || !args.task.trim() || args.task.length > taskLimit) {
          throw new ToolInputError(`O argumento task precisa ser um texto de 1 a ${taskLimit} caracteres.`);
        }
        // Keep one call in reserve: the conversation still has to write the final answer.
        if (!input.budget.take(1)) throw new ToolInputError("O limite de chamadas deste turno acabou. Responda com o que já tem.");
        const now = new Date();
        const result = await input.run({ id: randomUUID(), agentId: entry.id, objective: args.task.trim(),
          requiredCapability: capability, status: "pending", createdAt: now, updatedAt: now },
        input.context(), input.maxDelegations);
        if (result.status !== "completed") throw new ExecutionError(result.failure ?? fallbackFailure);
        const text = typeof result.result === "string" ? result.result : JSON.stringify(result.result ?? "");
        if (result.action) input.actions.push({ text, action: result.action });
        return text;
      },
    });
  }
  return tools;
}

/** Exposes registered operations (for example reopening a saved interface) as model tools. */
export function operationTools(input: {
  tools: readonly ModelTool[];
  invoke: (call: { name: string; arguments: unknown }) => Promise<unknown>;
  actions: TurnAction[];
}): LoopTool[] {
  const used = new Set<string>();
  return input.tools.map((tool): LoopTool => {
    let name = wireName(tool.name);
    for (let n = 2; used.has(name); n++) name = `${wireName(tool.name)}_${n}`;
    used.add(name);
    return {
      label: tool.name,
      spec: {
        name,
        description: `${tool.summary ?? tool.description} Exemplo de argumentos: ${JSON.stringify(tool.example.arguments)}`,
        parameters: tool.parameters ?? { type: "object", additionalProperties: true, properties: {} },
      },
      async run(args) {
        const call = { name: tool.name, arguments: args };
        if (!tool.accepts(call)) {
          throw new ToolInputError(`Argumentos inválidos. Exemplo: ${JSON.stringify(tool.example.arguments)}`);
        }
        const result = await input.invoke(call);
        if (!isRecord(result) || typeof result.response !== "string" ||
            ("action" in result && !isUiAction(result.action))) {
          throw new ToolInputError("A ferramenta retornou um resultado inválido.");
        }
        if ("action" in result) input.actions.push({ text: result.response, action: result.action as UiAction });
        return result.response;
      },
    };
  });
}
